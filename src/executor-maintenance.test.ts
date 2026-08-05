import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { LocalExecutor } from "./executor.js";

const root = await mkdtemp(join(tmpdir(), "devspace-executor-maintenance-test-"));
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_STATE_DIR: join(root, "state"),
  DEVSPACE_WORKTREE_ROOT: join(root, "managed"),
  DEVSPACE_AGENT_DIR: join(root, "agent"),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_LOG_LEVEL: "silent",
  DEVSPACE_TERMINAL_USER_SYSTEMD: "0",
  DEVSPACE_MAINTENANCE_INTERVAL_SECONDS: "3600",
  PORT: "1",
});
const executor = new LocalExecutor({ config });

try {
  await executor.runMaintenance();
  let terminalCalls = 0;
  let workspaceCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  executor.terminals.maintenance = async () => {
    terminalCalls += 1;
    await gate;
    return { dead: 0, expired: 0, orphaned: 0, pruned: 0, activeWorkspaceIds: [] };
  };
  executor.workspaces.maintenance = async () => {
    workspaceCalls += 1;
    return { prunedWorkspaceIds: [], removedPaths: [], retainedDirty: [], retainedUnsafe: [] };
  };

  const first = executor.runMaintenance(1000);
  const second = executor.runMaintenance(2000);
  assert.equal(first, second);
  executor.close();
  release();
  await first;
  assert.equal(terminalCalls, 1);
  assert.equal(workspaceCalls, 1);
  await assert.rejects(() => executor.runMaintenance(), /Executor is closed/);
  await assert.rejects(
    () => executor.execute("open_workspace", { path: root }, { requestId: "closed" }),
    /Executor is closed/,
  );
} finally {
  executor.close();
  await rm(root, { recursive: true, force: true });
}
