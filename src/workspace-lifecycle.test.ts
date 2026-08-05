import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { LocalExecutor } from "./executor.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-lifecycle-test-"));
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
config.widgets = "changes";
const executor = new LocalExecutor({ config });
let dirtyPath: string | undefined;
let replacementPath: string | undefined;
let movedManagedPath: string | undefined;

try {
  const cleanOpen = await executor.execute("open_workspace", { path: source, mode: "isolated" }, { requestId: "open-clean" });
  const cleanId = String(cleanOpen.structuredContent?.workspaceId);
  const cleanPath = String(cleanOpen.structuredContent?.root);
  const publicWorktree = cleanOpen.structuredContent?.worktree as Record<string, unknown>;
  assert.equal("rootDevice" in publicWorktree, false);
  assert.equal("rootInode" in publicWorktree, false);
  const cleanStatus = await executor.execute("workspace_status", { workspaceId: cleanId }, { requestId: "status-clean" });
  assert.equal("shadowGitDir" in (cleanStatus.structuredContent?.review as Record<string, unknown>), false);
  assert.equal((executor.reviewCheckpoints.status({ workspaceId: cleanId })).initialized, true);
  const cleanClose = await executor.execute("close_workspace", { workspaceId: cleanId }, { requestId: "close-clean" });
  assert.equal((cleanClose.structuredContent?.workspace as { removed?: boolean })?.removed, true);
  await assert.rejects(() => access(cleanPath));
  assert.equal(executor.reviewCheckpoints.status({ workspaceId: cleanId }).initialized, false);
  await assert.rejects(() => executor.execute("workspace_status", { workspaceId: cleanId }, { requestId: "closed-status" }), /not active|Unknown workspaceId/);

  const replacedOpen = await executor.execute("open_workspace", { path: source, mode: "isolated" }, { requestId: "open-replaced" });
  const replacedId = String(replacedOpen.structuredContent?.workspaceId);
  replacementPath = String(replacedOpen.structuredContent?.root);
  movedManagedPath = `${replacementPath}-moved`;
  await rename(replacementPath, movedManagedPath);
  await mkdir(replacementPath);
  await writeFile(join(replacementPath, "sentinel.txt"), "do not delete\n");
  const replacedClose = await executor.execute("close_workspace", { workspaceId: replacedId }, { requestId: "close-replaced" });
  const replacedResult = replacedClose.structuredContent?.workspace as { removed?: boolean; retainedPath?: string; reason?: string };
  assert.equal(replacedResult.removed, false);
  assert.equal(replacedResult.retainedPath, replacementPath);
  assert.match(replacedResult.reason ?? "", /filesystem identity changed/);
  await access(join(replacementPath, "sentinel.txt"));
  await access(movedManagedPath);

  const retainedOpen = await executor.execute("open_workspace", { path: source }, { requestId: "open-retained" });
  const retainedWorkspaceId = String(retainedOpen.structuredContent?.workspaceId);
  const retainedTerminal = await executor.execute(
    "terminal_start",
    { workspaceId: retainedWorkspaceId, command: "cat", retainOnWorkspaceClose: true },
    { requestId: "terminal-retained" },
  );
  const retainedTerminalId = String((retainedTerminal.structuredContent?.terminal as { terminalId?: string })?.terminalId);
  const blockedClose = await executor.execute("close_workspace", { workspaceId: retainedWorkspaceId }, { requestId: "close-blocked" });
  assert.equal((blockedClose.structuredContent?.workspace as { closed?: boolean })?.closed, false);
  await executor.execute("workspace_status", { workspaceId: retainedWorkspaceId }, { requestId: "still-open" });
  await executor.execute("terminal_close", { workspaceId: retainedWorkspaceId, terminalId: retainedTerminalId, force: true }, { requestId: "terminal-close" });
  const completedClose = await executor.execute("close_workspace", { workspaceId: retainedWorkspaceId }, { requestId: "close-complete" });
  assert.equal((completedClose.structuredContent?.workspace as { closed?: boolean })?.closed, true);

  const busyOpen = await executor.execute("open_workspace", { path: source, fresh: true }, { requestId: "open-busy" });
  const busyId = String(busyOpen.structuredContent?.workspaceId);
  const busyShell = executor.execute(
    "run_shell",
    { workspaceId: busyId, command: "sleep 0.25" },
    { requestId: "busy-shell" },
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  const busyClose = await executor.execute("close_workspace", { workspaceId: busyId }, { requestId: "busy-close" });
  const busyResult = busyClose.structuredContent?.workspace as { closed?: boolean; reason?: string };
  assert.equal(busyResult.closed, false);
  assert.match(busyResult.reason ?? "", /operations are still active/);
  await busyShell;
  const quietClose = await executor.execute("close_workspace", { workspaceId: busyId }, { requestId: "quiet-close" });
  assert.equal((quietClose.structuredContent?.workspace as { closed?: boolean }).closed, true);

  const dirtyOpen = await executor.execute("open_workspace", { path: source, mode: "isolated" }, { requestId: "open-dirty" });
  const dirtyId = String(dirtyOpen.structuredContent?.workspaceId);
  dirtyPath = String(dirtyOpen.structuredContent?.root);
  await executor.execute("write_file", { workspaceId: dirtyId, path: "dirty.txt", content: "retain me\n" }, { requestId: "dirty-write" });
  const dirtyClose = await executor.execute("close_workspace", { workspaceId: dirtyId }, { requestId: "close-dirty" });
  const dirtyResult = dirtyClose.structuredContent?.workspace as { removed?: boolean; dirty?: boolean; retainedPath?: string };
  assert.equal(dirtyResult.removed, false);
  assert.equal(dirtyResult.dirty, true);
  assert.equal(dirtyResult.retainedPath, dirtyPath);
  assert.equal((await stat(dirtyPath)).isDirectory(), true);
} finally {
  executor.close();
  if (dirtyPath) await rm(dirtyPath, { recursive: true, force: true });
  if (replacementPath) await rm(replacementPath, { recursive: true, force: true });
  if (movedManagedPath) await rm(movedManagedPath, { recursive: true, force: true });
  await git(source, ["worktree", "prune"]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
