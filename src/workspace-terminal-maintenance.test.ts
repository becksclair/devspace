import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { loadConfig } from "./config.js";
import { LocalExecutor } from "./executor.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-terminal-maintenance-test-"));
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
  DEVSPACE_GLOBAL_INSTRUCTIONS_FILE: join(root, "missing-global-instructions.md"),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_TERMINAL_USER_SYSTEMD: "0",
  DEVSPACE_TERMINAL_IDLE_TTL_SECONDS: "1",
  DEVSPACE_MAINTENANCE_INTERVAL_SECONDS: "3600",
  DEVSPACE_CLOSED_SESSION_TTL_SECONDS: "1",
  DEVSPACE_CHECKOUT_IDLE_TTL_SECONDS: "1",
  DEVSPACE_ISOLATED_IDLE_TTL_SECONDS: "1",
  PORT: "1",
});
const executor = new LocalExecutor({ config });
let managedPath: string | undefined;

try {
  const opened = await executor.execute("open_workspace", { path: source, mode: "isolated" }, { requestId: "open" });
  const workspaceId = String(opened.structuredContent?.workspaceId);
  managedPath = String(opened.structuredContent?.root);
  const started = await executor.execute(
    "terminal_start",
    { workspaceId, command: "cat", retainOnWorkspaceClose: true },
    { requestId: "terminal-start" },
  );
  const terminalId = String((started.structuredContent?.terminal as { terminalId?: string })?.terminalId);

  const sqlite = new Database(join(state, "devspace.sqlite"));
  const old = new Date(Date.now() - 60_000).toISOString();
  sqlite.prepare("update workspace_sessions set last_used_at = ? where id = ?").run(old, workspaceId);
  sqlite.close();

  const pinned = await executor.runMaintenance(Date.now());
  assert.equal(pinned.terminals.activeWorkspaceIds.includes(workspaceId), true);
  assert.equal(pinned.workspaces.prunedWorkspaceIds.includes(workspaceId), false);
  await executor.execute("workspace_status", { workspaceId }, { requestId: "status" });
  await access(managedPath);

  await executor.execute("terminal_close", { workspaceId, terminalId, force: true }, { requestId: "terminal-close" });
  const sqliteAfterClose = new Database(join(state, "devspace.sqlite"));
  sqliteAfterClose.prepare("update workspace_sessions set last_used_at = ? where id = ?").run(old, workspaceId);
  sqliteAfterClose.prepare("update terminal_sessions set last_used_at = ? where id = ?").run(old, terminalId);
  sqliteAfterClose.close();

  const pruned = await executor.runMaintenance(Date.now() + 2_000);
  assert.equal(pruned.terminals.pruned >= 1, true);
  assert.equal(pruned.workspaces.prunedWorkspaceIds.includes(workspaceId), true);
  await assert.rejects(() => access(managedPath!));

  const orphanOpen = await executor.execute("open_workspace", { path: source }, { requestId: "orphan-open" });
  const orphanWorkspaceId = String(orphanOpen.structuredContent?.workspaceId);
  const orphanTerminal = await executor.execute(
    "terminal_start",
    { workspaceId: orphanWorkspaceId, command: "cat", retainOnWorkspaceClose: true },
    { requestId: "orphan-terminal" },
  );
  const orphanTerminalId = String((orphanTerminal.structuredContent?.terminal as { terminalId?: string })?.terminalId);
  const orphanDb = new Database(join(state, "devspace.sqlite"));
  orphanDb.prepare("delete from workspace_sessions where id = ?").run(orphanWorkspaceId);
  orphanDb.close();

  const orphanCleanup = await executor.runMaintenance(Date.now());
  assert.equal(orphanCleanup.terminals.orphaned, 1);
  assert.equal(orphanCleanup.terminals.activeWorkspaceIds.includes(orphanWorkspaceId), false);
  const verifyOrphan = new Database(join(state, "devspace.sqlite"));
  const orphanRow = verifyOrphan.prepare("select status from terminal_sessions where id = ?").get(orphanTerminalId) as { status?: string } | undefined;
  assert.equal(orphanRow?.status, "closed");
  verifyOrphan.close();
} finally {
  executor.close();
  if (managedPath) await rm(managedPath, { recursive: true, force: true });
  await git(source, ["worktree", "prune"]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
