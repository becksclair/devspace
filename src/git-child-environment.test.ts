import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { git as gitWrapper } from "./git.js";
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
// A caller that passes a whole environment as the overrides must not put the secrets back.
const fromFullEnvironment = gitChildEnvironment({ ...base, GIT_DIR: "/tmp/shadow" }, base);
assert.equal(fromFullEnvironment.GIT_DIR, "/tmp/shadow");
for (const name of ["DEVSPACE_OAUTH_OWNER_TOKEN", "DEVSPACE_TEST_NODE_BEARER"]) {
  assert.equal(Object.hasOwn(fromFullEnvironment, name), false, `${name} must not return through overrides`);
}

// A repository hook run by `git worktree add` records the variable names it can see.
const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

const root = await mkdtemp(join(tmpdir(), "devspace-git-env-test-"));
const source = join(root, "source");
const hookOutput = join(root, "hook-env.txt");
let registry: WorkspaceRegistry | undefined;
let workspaceId: string | undefined;
try {
  await mkdir(source);
  await git(source, ["init"]);
  await git(source, ["config", "user.email", "devspace@example.com"]);
  await git(source, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(source, "README.md"), "hello\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "initial"]);
  const hooks = join(source, ".git", "hooks");
  // `git init` creates no hooks directory when the template directory is empty.
  await mkdir(hooks, { recursive: true });
  await git(source, ["config", "core.hooksPath", hooks]);
  const hook = join(hooks, "post-checkout");
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
  registry = new WorkspaceRegistry(config);
  const opened = await registry.openWorkspace({ path: source, mode: "isolated" });
  workspaceId = opened.workspace.id;
  assert.equal(opened.workspace.worktree?.strategy, "worktree");
  const names = (await readFile(hookOutput, "utf8")).split("\n");
  assert.ok(names.includes("PATH"), "the hook ran and saw the ordinary environment");
  assert.ok(names.includes("GH_TOKEN"), "development credentials still reach git children");
  assert.equal(names.includes("DEVSPACE_OAUTH_OWNER_TOKEN"), false, "owner token must not reach git hooks");
  assert.equal(names.includes("DEVSPACE_TEST_GATEWAY_BEARER"), false, "configured secret names must not reach git hooks");

  async function assertFilteredNames(file: string, path: string): Promise<void> {
    const seen = (await readFile(file, "utf8")).split("\n");
    assert.ok(seen.includes("PATH"), `${path}: the probe ran and saw the ordinary environment`);
    assert.equal(seen.includes("DEVSPACE_OAUTH_OWNER_TOKEN"), false, `${path}: owner token must not reach git children`);
    assert.equal(seen.includes("DEVSPACE_TEST_GATEWAY_BEARER"), false, `${path}: configured secret names must not reach git children`);
  }

  // `git status` paths: an fsmonitor hook records the names it can see, then fails so git
  // falls back to a normal scan. The managed worktree shares the source repository's config.
  const fsmonitorOutput = join(root, "fsmonitor-env.txt");
  const fsmonitor = join(root, "fsmonitor.sh");
  await writeFile(fsmonitor, `#!/bin/sh\nenv | cut -d= -f1 > ${JSON.stringify(fsmonitorOutput)}\nexit 1\n`);
  await chmod(fsmonitor, 0o755);
  await git(source, ["config", "core.fsmonitor", fsmonitor]);
  await registry.workspaceStatus(workspaceId);
  await assertFilteredNames(fsmonitorOutput, "workspace status probe");
  await rm(fsmonitorOutput, { force: true });
  await registry.closeWorkspace(workspaceId);
  workspaceId = undefined;
  await assertFilteredNames(fsmonitorOutput, "close workspace status");

  // The src/git.ts wrapper: a shell alias records the names it can see.
  const wrapperOutput = join(root, "wrapper-env.txt");
  await gitWrapper(source, ["-c", `alias.devspace-env=!env | cut -d= -f1 > '${wrapperOutput}'`, "devspace-env"]);
  await assertFilteredNames(wrapperOutput, "git.ts wrapper");
} finally {
  if (registry && workspaceId) await registry.closeWorkspace(workspaceId).catch(() => undefined);
  await git(source, ["worktree", "prune"]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
  delete process.env.DEVSPACE_TEST_GATEWAY_BEARER;
}
console.log("git-child-environment checks passed");
