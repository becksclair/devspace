import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { GitWorktreeError } from "./git-worktrees.js";
import { SqliteWorkspaceStore, type WorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-workspace-test-"));

try {
  const agentDir = join(root, ".pi", "agent");
  const globalInstructionsFile = join(root, ".devspace", "AGENTS.md");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(root, ".devspace"), { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "legacy agent-dir instructions must not load\n");
  await writeFile(globalInstructionsFile, "global instructions\n");
  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(root, "nested", "file.txt"), "hello\n");

  const config = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_GLOBAL_INSTRUCTIONS_FILE: globalInstructionsFile,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);
  const { workspace, capabilities, agentsFiles, availableAgentsFiles } = await registry.openWorkspace(root);
  const reused = await registry.openWorkspace(root);
  const fresh = await registry.openWorkspace({ path: root, fresh: true });

  assert.equal(reused.workspace.id, workspace.id);
  assert.notEqual(fresh.workspace.id, workspace.id);
  assert.equal(workspace.mode, "checkout");
  assert.equal(workspace.canonicalRoot, root);
  assert.equal(capabilities.logicalRoot, root);
  assert.equal(capabilities.canonicalRoot, root);
  assert.equal(capabilities.fileAccess, "read-write");
  assert.deepEqual(
    agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );
  assert.equal(agentsFiles.some((file) => file.content.includes("legacy agent-dir")), false);
  assert.deepEqual(
    availableAgentsFiles.map((file) => file.path),
    [join(root, "nested", "AGENTS.md")],
  );
  const globalDirectoryOpen = await registry.openWorkspace(join(root, ".devspace"));
  assert.equal(
    globalDirectoryOpen.agentsFiles.filter((file) => file.content === "global instructions\n").length,
    1,
    "the global file is not duplicated when it is also the project root instruction file",
  );

  const noGlobalProject = join(root, "no-global-project");
  await mkdir(noGlobalProject);
  const noGlobalConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "no-global-config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "no-global-worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_GLOBAL_INSTRUCTIONS_FILE: join(root, "missing-global-AGENTS.md"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_LOG_LEVEL: "silent",
    PORT: "1",
  });
  const noGlobalOpen = await new WorkspaceRegistry(noGlobalConfig).openWorkspace(noGlobalProject);
  assert.deepEqual(noGlobalOpen.agentsFiles, [], "a missing global instruction file is valid and adds no context");

  if (platform() !== "win32") {
    const instructionProject = join(root, "instruction-project");
    const externalInstructions = join(root, "external-instructions");
    await mkdir(instructionProject);
    await mkdir(externalInstructions);
    await writeFile(join(externalInstructions, "AGENTS.md"), "must not auto-load\n");
    await symlink(join(externalInstructions, "AGENTS.md"), join(instructionProject, "AGENTS.md"));
    const instructionConfig = loadConfig({
      DEVSPACE_CONFIG_DIR: join(root, "instruction-config"),
      DEVSPACE_ROOTS: JSON.stringify([
        { path: instructionProject, access: "read-write" },
        { path: externalInstructions, access: "read-only" },
      ]),
      DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "instruction-worktrees"),
      DEVSPACE_AGENT_DIR: join(root, "missing-agent"),
      DEVSPACE_GLOBAL_INSTRUCTIONS_FILE: globalInstructionsFile,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      DEVSPACE_LOG_LEVEL: "silent",
      PORT: "1",
    });
    const instructionOpen = await new WorkspaceRegistry(instructionConfig).openWorkspace(instructionProject);
    assert.equal(instructionOpen.agentsFiles.some((file) => file.content.includes("must not auto-load")), false);
  }

  const missingWorkspaceRoot = join(root, "missing", "workspace");
  await assert.rejects(
    () => registry.openWorkspace(missingWorkspaceRoot),
    /Pass create=true/,
  );
  const missingWorkspace = await registry.openWorkspace({ path: missingWorkspaceRoot, create: true });
  assert.equal(missingWorkspace.workspace.root, missingWorkspaceRoot);
  assert.equal(missingWorkspace.workspace.mode, "checkout");
  assert.equal((await stat(missingWorkspaceRoot)).isDirectory(), true);

  await assert.rejects(
    () => registry.openWorkspace({ path: root, mode: "worktree" }),
    (error: unknown) =>
      error instanceof GitWorktreeError && error.code === "GIT_REPOSITORY_NOT_FOUND",
  );

  const gitRoot = join(root, "git-project");
  await mkdir(gitRoot);
  await writeFile(join(gitRoot, "AGENTS.md"), "git root instructions\n");
  await writeFile(join(gitRoot, "README.md"), "hello\n");
  await git(gitRoot, ["init"]);
  await git(gitRoot, ["config", "user.email", "devspace@example.com"]);
  await git(gitRoot, ["config", "user.name", "DevSpace Test"]);
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Initial commit"]);
  await writeFile(join(gitRoot, "dirty.txt"), "not copied\n");

  const worktreeWorkspace = await registry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  assert.equal(worktreeWorkspace.workspace.mode, "worktree");
  assert.notEqual(worktreeWorkspace.workspace.root, gitRoot);
  assert.match(worktreeWorkspace.workspace.root, /git-project-[a-f0-9]{8}$/);
  assert.equal(worktreeWorkspace.workspace.sourceRoot, gitRoot);
  assert.equal(worktreeWorkspace.workspace.worktree?.baseRef, "HEAD");
  assert.equal(worktreeWorkspace.workspace.worktree?.dirtySource, true);
  assert.equal(worktreeWorkspace.workspace.worktree?.managed, true);
  assert.equal((await stat(worktreeWorkspace.workspace.root)).isDirectory(), true);
  assert.match(worktreeWorkspace.agentsFiles.map((file) => file.content).join("\n"), /global instructions/);
  assert.match(worktreeWorkspace.agentsFiles.map((file) => file.content).join("\n"), /git root instructions/);

  const worktreeReadmePath = registry.resolvePath(worktreeWorkspace.workspace, "README.md");
  assert.equal(worktreeReadmePath.startsWith(worktreeWorkspace.workspace.root), true);

  const failingManagedRoot = join(root, ".devspace", "failing-managed");
  const failingConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "failing-config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: failingManagedRoot,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_GLOBAL_INSTRUCTIONS_FILE: globalInstructionsFile,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_LOG_LEVEL: "silent",
    PORT: "1",
  });
  const failingStore: WorkspaceStore = {
    createSession: () => { throw new Error("forced workspace persistence failure"); },
    getSession: () => undefined,
    touchSession: () => undefined,
    closeSession: () => undefined,
    listSessions: () => [],
    deleteSession: () => undefined,
    checkpoint: () => undefined,
  };
  await assert.rejects(
    () => new WorkspaceRegistry(failingConfig, failingStore).openWorkspace({ path: gitRoot, mode: "isolated" }),
    /forced workspace persistence failure/,
  );
  assert.deepEqual(await readdir(failingManagedRoot), []);
  const registeredWorktrees = (await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: gitRoot })).stdout;
  assert.equal(registeredWorktrees.includes(failingManagedRoot), false);

  const isolatedWorktree = await registry.openWorkspace({ path: gitRoot, mode: "isolated" });
  assert.equal(isolatedWorktree.workspace.mode, "isolated");
  assert.equal(isolatedWorktree.workspace.worktree?.strategy, "worktree");
  assert.equal(isolatedWorktree.workspace.worktree?.sourceCanonicalRoot, gitRoot);

  const readOnlyConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(tmpdir(), `devspace-readonly-config-${process.pid}`),
    DEVSPACE_ROOTS: JSON.stringify([{ path: root, access: "read-only" }]),
    DEVSPACE_WORKTREE_ROOT: join(tmpdir(), `devspace-readonly-isolated-${process.pid}`),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_GLOBAL_INSTRUCTIONS_FILE: globalInstructionsFile,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const readOnlyRegistry = new WorkspaceRegistry(readOnlyConfig);
  await assert.rejects(
    () => readOnlyRegistry.openWorkspace({ path: gitRoot, mode: "worktree" }),
    /outside permitted write roots/,
  );
  const readOnlyIsolated = await readOnlyRegistry.openWorkspace({ path: gitRoot, mode: "isolated" });
  assert.equal(readOnlyIsolated.workspace.worktree?.strategy, "clone");
  await rm(readOnlyConfig.worktreeRoot, { recursive: true, force: true });

  await chmod(join(gitRoot, ".git"), 0o555);
  let isolatedClone;
  try {
    isolatedClone = await registry.openWorkspace({ path: gitRoot, mode: "isolated" });
  } finally {
    await chmod(join(gitRoot, ".git"), 0o755);
  }
  assert.equal(isolatedClone.workspace.mode, "isolated");
  assert.equal(isolatedClone.workspace.worktree?.strategy, "clone");
  assert.equal(isolatedClone.workspace.worktree?.sourceCanonicalRoot, gitRoot);
  await assert.rejects(
    () => execFileAsync("git", ["remote", "get-url", "origin"], { cwd: isolatedClone.workspace.root }),
  );
  await assert.rejects(() => access(join(isolatedClone.workspace.root, "dirty.txt")));
  await writeFile(join(isolatedClone.workspace.root, "clone-write.txt"), "writable\n");
  assert.equal((await stat(join(isolatedClone.workspace.root, ".git"))).isDirectory(), true);

  const stateDir = join(root, ".state");
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const persistentRegistry = new WorkspaceRegistry(config, firstStore);
  const persistentWorkspace = await persistentRegistry.openWorkspace(root);
  const persistentWorktree = await persistentRegistry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  await chmod(join(gitRoot, ".git"), 0o555);
  let persistentIsolated;
  let tamperedIsolated;
  try {
    persistentIsolated = await persistentRegistry.openWorkspace({ path: gitRoot, mode: "isolated" });
    tamperedIsolated = await persistentRegistry.openWorkspace({ path: gitRoot, mode: "isolated" });
  } finally {
    await chmod(join(gitRoot, ".git"), 0o755);
  }
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  const restoredRegistry = new WorkspaceRegistry(config, secondStore);
  const restoredWorkspace = restoredRegistry.getWorkspace(persistentWorkspace.workspace.id);
  assert.equal(restoredWorkspace.root, root);
  assert.equal(restoredWorkspace.mode, "checkout");

  const restoredWorktree = restoredRegistry.getWorkspace(persistentWorktree.workspace.id);
  assert.equal(restoredWorktree.mode, "worktree");
  assert.equal(restoredWorktree.sourceRoot, gitRoot);
  assert.equal(restoredWorktree.root, persistentWorktree.workspace.root);
  assert.equal(restoredWorktree.worktree?.managed, true);

  const restoredIsolated = restoredRegistry.getWorkspace(persistentIsolated.workspace.id);
  assert.equal(restoredIsolated.mode, "isolated");
  assert.equal(restoredIsolated.worktree?.strategy, "clone");
  assert.equal(restoredIsolated.worktree?.sourceCanonicalRoot, gitRoot);

  const tamperedPath = tamperedIsolated.workspace.root;
  const movedTamperedPath = `${tamperedPath}-moved`;
  await rename(tamperedPath, movedTamperedPath);
  await mkdir(tamperedPath);
  assert.throws(
    () => restoredRegistry.getWorkspace(tamperedIsolated.workspace.id),
    /filesystem identity changed/,
  );
  await rm(tamperedPath, { recursive: true, force: true });
  await rm(movedTamperedPath, { recursive: true, force: true });
  secondStore.close();

  if (platform() !== "win32") {
    const aliasRoot = join(root, "alias-root");
    await symlink(root, aliasRoot, "dir");
    const aliasConfig = loadConfig({
      DEVSPACE_ALLOWED_ROOTS: aliasRoot,
      DEVSPACE_WORKTREE_ROOT: join(aliasRoot, ".devspace", "alias-worktrees"),
      DEVSPACE_AGENT_DIR: agentDir,
      DEVSPACE_GLOBAL_INSTRUCTIONS_FILE: globalInstructionsFile,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const aliasWorkspace = await new WorkspaceRegistry(aliasConfig).openWorkspace({
      path: join(aliasRoot, "git-project"),
      mode: "worktree",
    });
    assert.equal(aliasWorkspace.workspace.sourceRoot, join(aliasRoot, "git-project"));

    const policyAliasConfig = loadConfig({
      DEVSPACE_CONFIG_DIR: join(root, "policy-alias-config"),
      DEVSPACE_ROOTS: JSON.stringify([{ path: root, aliases: [aliasRoot], access: "read-write" }]),
      DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "policy-alias-worktrees"),
      DEVSPACE_AGENT_DIR: agentDir,
      DEVSPACE_GLOBAL_INSTRUCTIONS_FILE: globalInstructionsFile,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const policyAliasWorkspace = await new WorkspaceRegistry(policyAliasConfig).openWorkspace(join(aliasRoot, "git-project"));
    assert.equal(policyAliasWorkspace.workspace.root, join(aliasRoot, "git-project"));
    assert.equal(policyAliasWorkspace.workspace.canonicalRoot, gitRoot);
    assert.equal(policyAliasWorkspace.capabilities.logicalRoot, join(aliasRoot, "git-project"));
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
