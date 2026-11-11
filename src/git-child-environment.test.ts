import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { gitChildEnvironment, registerGitChildSecretNames } from "./shell-environment.js";

registerGitChildSecretNames(["DEVSPACE_TEST_NODE_BEARER"]);
const base = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  GH_TOKEN: "development-credential",
  DEVSPACE_OAUTH_OWNER_TOKEN: "owner",
  DEVSPACE_TEST_NODE_BEARER: "bearer",
  UNDEFINED_VALUE: undefined,
};
const env = gitChildEnvironment({ GIT_DIR: "/tmp/shadow" }, base);
assert.equal(env.PATH, "/usr/bin");
assert.equal(env.GH_TOKEN, "development-credential", "development credentials are kept");
assert.equal(env.GIT_DIR, "/tmp/shadow", "overrides are applied");
for (const name of ["DEVSPACE_OAUTH_OWNER_TOKEN", "DEVSPACE_TEST_NODE_BEARER", "UNDEFINED_VALUE"]) {
  assert.equal(Object.hasOwn(env, name), false, `${name} must not reach git children`);
}
assert.throws(() => registerGitChildSecretNames(["BAD-NAME"]), /Invalid DevSpace infrastructure secret name/);

// A repository hook run by `git worktree add` records the variable names it can see.
const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

const root = await mkdtemp(join(tmpdir(), "devspace-git-env-test-"));
const source = join(root, "source");
const hookOutput = join(root, "hook-env.txt");
await mkdir(source);
await git(source, ["init"]);
await git(source, ["config", "user.email", "devspace@example.com"]);
await git(source, ["config", "user.name", "DevSpace Test"]);
await writeFile(join(source, "README.md"), "hello\n");
await git(source, ["add", "."]);
await git(source, ["commit", "-m", "initial"]);
await git(source, ["config", "core.hooksPath", join(source, ".git", "hooks")]);
const hook = join(source, ".git", "hooks", "post-checkout");
await writeFile(hook, `#!/bin/sh\nenv | cut -d= -f1 > ${JSON.stringify(hookOutput)}\n`);
await chmod(hook, 0o755);

process.env.DEVSPACE_OAUTH_OWNER_TOKEN = "test-owner-token-that-is-long-enough";
process.env.DEVSPACE_TEST_GATEWAY_BEARER = "must-not-reach-hooks";
process.env.GH_TOKEN ??= "development-credential";
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_STATE_DIR: join(root, "state"),
  DEVSPACE_WORKTREE_ROOT: join(root, "managed"),
  DEVSPACE_AGENT_DIR: join(root, "agent"),
  DEVSPACE_GLOBAL_INSTRUCTIONS_FILE: join(root, "missing-global-instructions.md"),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_TERMINAL_USER_SYSTEMD: "0",
  PORT: "1",
  DEVSPACE_INFRA_SECRET_NAMES: "DEVSPACE_TEST_GATEWAY_BEARER",
});
const registry = new WorkspaceRegistry(config);
const opened = await registry.openWorkspace({ path: source, mode: "isolated" });
try {
  assert.equal(opened.workspace.worktree?.strategy, "worktree");
  const names = (await readFile(hookOutput, "utf8")).split("\n");
  assert.ok(names.includes("PATH"), "the hook ran and saw the ordinary environment");
  assert.ok(names.includes("GH_TOKEN"), "development credentials still reach git children");
  assert.equal(names.includes("DEVSPACE_OAUTH_OWNER_TOKEN"), false, "owner token must not reach git hooks");
  assert.equal(names.includes("DEVSPACE_TEST_GATEWAY_BEARER"), false, "configured secret names must not reach git hooks");
} finally {
  await registry.closeWorkspace(opened.workspace.id).catch(() => undefined);
  await git(source, ["worktree", "prune"]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
  delete process.env.DEVSPACE_TEST_GATEWAY_BEARER;
}
console.log("git-child-environment checks passed");
