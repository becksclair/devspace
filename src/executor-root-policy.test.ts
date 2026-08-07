import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { LocalExecutor } from "./executor.js";

const root = await mkdtemp(join(tmpdir(), "devspace-executor-policy-test-"));
try {
  const project = join(root, "project");
  const external = join(root, "external");
  const undeclared = join(root, "undeclared");
  const stateDir = join(root, "state");
  await mkdir(project);
  await mkdir(external);
  await mkdir(undeclared);
  await mkdir(stateDir);
  await writeFile(join(external, "config.txt"), "external-value\n");
  await writeFile(join(undeclared, "secret.txt"), "nope\n");
  await symlink(external, join(project, "external"), "dir");
  await symlink(undeclared, join(project, "escape"), "dir");

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "empty-config"),
    DEVSPACE_ROOTS: JSON.stringify([
      { path: project, access: "read-write" },
      { path: external, access: "read-only" },
    ]),
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_WORKTREE_ROOT: join(root, "worktrees"),
    DEVSPACE_AGENT_DIR: join(root, "agent"),
    DEVSPACE_GLOBAL_INSTRUCTIONS_FILE: join(root, "missing-global-instructions.md"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  config.shell.environment = {
    DEVSPACE_OAUTH_OWNER_TOKEN: "must-not-leak",
    USER_DEVELOPMENT_VALUE: "visible",
  };

  const executor = new LocalExecutor({ config });
  try {
    const opened = await executor.execute("open_workspace", { path: project }, { requestId: "open" });
    const workspaceId = String(opened.structuredContent?.workspaceId);
    assert.ok(workspaceId);

    const read = await executor.execute("read_file", { workspaceId, path: "external/config.txt" }, { requestId: "read" });
    assert.match(read.content.map((entry) => entry.type === "text" ? entry.text : "").join("\n"), /external-value/);

    await assert.rejects(
      () => executor.execute("write_file", { workspaceId, path: "external/new.txt", content: "forbidden\n" }, { requestId: "write-ro" }),
      /outside permitted write roots/,
    );
    await assert.rejects(
      () => executor.execute("read_file", { workspaceId, path: "escape/secret.txt" }, { requestId: "read-escape" }),
      /outside permitted read roots/,
    );

    await executor.execute("write_file", { workspaceId, path: "created.txt", content: "created\n" }, { requestId: "write" });
    assert.equal(await readFile(join(project, "created.txt"), "utf8"), "created\n");

    const shell = await executor.execute(
      "run_shell",
      { workspaceId, command: "printf 'oauth=%s dev=%s' \"${DEVSPACE_OAUTH_OWNER_TOKEN-unset}\" \"${USER_DEVELOPMENT_VALUE-unset}\"" },
      { requestId: "shell" },
    );
    const shellText = shell.content.map((entry) => entry.type === "text" ? entry.text : "").join("\n");
    assert.match(shellText, /oauth=unset dev=visible/);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...values: unknown[]) => { warnings.push(values.map(String).join(" ")); };
    try {
      const failedShell = await executor.execute(
        "run_shell",
        { workspaceId, command: "printf 'super-secret-output\n'; exit 9" },
        { requestId: "shell-failure" },
      );
      assert.equal(failedShell.isError, true);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.some((line) => line.includes("super-secret-output")), false);
    assert.equal(warnings.some((line) => line.includes("execution failed")), true);

    const status = await executor.execute("workspace_status", { workspaceId }, { requestId: "status" });
    assert.equal(status.structuredContent?.canonicalRoot, project);
    assert.equal((status.structuredContent?.capabilities as { fileAccess?: string })?.fileAccess, "read-write");
  } finally {
    executor.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
