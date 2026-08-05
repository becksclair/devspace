import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { loadConfig } from "./config.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-maintenance-test-"));
const source = join(root, "source");
const state = join(root, "state");
await mkdir(source);
await git(source, ["init"]);
await git(source, ["config", "user.email", "devspace@example.com"]);
await git(source, ["config", "user.name", "DevSpace Test"]);
await writeFile(join(source, "README.md"), "hello\n");
await git(source, ["add", "."]);
await git(source, ["commit", "-m", "initial"]);

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_STATE_DIR: state,
  DEVSPACE_WORKTREE_ROOT: join(root, "managed"),
  DEVSPACE_AGENT_DIR: join(root, "agent"),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_TERMINAL_USER_SYSTEMD: "0",
  PORT: "1",
});
const firstStore = new SqliteWorkspaceStore(state);
const firstRegistry = new WorkspaceRegistry(config, firstStore);
const checkout = await firstRegistry.openWorkspace(source);
const clean = await firstRegistry.openWorkspace({ path: source, mode: "isolated" });
const dirty = await firstRegistry.openWorkspace({ path: source, mode: "isolated" });
await writeFile(join(dirty.workspace.root, "dirty.txt"), "retain\n");
const replaced = await firstRegistry.openWorkspace({ path: source, mode: "isolated" });
const movedReplacedPath = `${replaced.workspace.root}-moved`;
firstStore.close();
await rename(replaced.workspace.root, movedReplacedPath);
await mkdir(replaced.workspace.root);
await writeFile(join(replaced.workspace.root, "sentinel.txt"), "replacement\n");

const old = new Date(Date.now() - 60_000).toISOString();
const sqlite = new Database(join(state, "devspace.sqlite"));
sqlite.prepare("update workspace_sessions set last_used_at = ?").run(old);
sqlite.close();

const secondStore = new SqliteWorkspaceStore(state);
const secondRegistry = new WorkspaceRegistry(config, secondStore);
try {
  const result = await secondRegistry.maintenance({
    intervalSeconds: 1,
    closedSessionTtlSeconds: 1,
    checkoutIdleTtlSeconds: 1,
    isolatedIdleTtlSeconds: 1,
  });
  assert.ok(result.prunedWorkspaceIds.includes(checkout.workspace.id));
  assert.ok(result.prunedWorkspaceIds.includes(clean.workspace.id));
  assert.ok(result.removedPaths.includes(clean.workspace.root));
  assert.deepEqual(result.retainedDirty, [{ workspaceId: dirty.workspace.id, path: dirty.workspace.root }]);
  assert.equal(result.retainedUnsafe.length, 1);
  assert.equal(result.retainedUnsafe[0]?.workspaceId, replaced.workspace.id);
  assert.match(result.retainedUnsafe[0]?.reason ?? "", /filesystem identity changed/);
  await assert.rejects(() => access(clean.workspace.root));
  await access(dirty.workspace.root);
  await access(join(replaced.workspace.root, "sentinel.txt"));
  await access(movedReplacedPath);
} finally {
  secondStore.close();
  await rm(replaced.workspace.root, { recursive: true, force: true });
  await rm(movedReplacedPath, { recursive: true, force: true });
  await git(source, ["worktree", "prune"]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
