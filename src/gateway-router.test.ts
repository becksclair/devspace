import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GatewayExecutionRouter,
  GatewayRoutingError,
  type ExecutionTarget,
  type ExecutorResult,
} from "./gateway-router.js";
import type { GatewayWorkspaceStore, PublicWorkspaceBinding } from "./gateway-workspace-store.js";
import { SqliteGatewayWorkspaceStore } from "./gateway-workspace-store.js";

class MemoryStore implements GatewayWorkspaceStore {
  readonly rows = new Map<string, PublicWorkspaceBinding>();
  save(binding: PublicWorkspaceBinding): void { this.rows.set(binding.publicWorkspaceId, binding); }
  get(id: string): PublicWorkspaceBinding | undefined { return this.rows.get(id); }
  findByExecutor(machineId: string, executorWorkspaceId: string): PublicWorkspaceBinding | undefined {
    return Array.from(this.rows.values()).find((row) => row.machineId === machineId && row.executorWorkspaceId === executorWorkspaceId);
  }
  touch(id: string): void {
    const row = this.rows.get(id);
    if (row) row.lastUsedAt = new Date().toISOString();
  }
  delete(id: string): void { this.rows.delete(id); }
  deleteByExecutor(machineId: string, executorWorkspaceId: string): void {
    for (const [id, row] of this.rows) {
      if (row.machineId === machineId && row.executorWorkspaceId === executorWorkspaceId) this.rows.delete(id);
    }
  }
  ping(): void {}
  close(): void {}
}

function fakeTarget(privateId: string): ExecutionTarget & { calls: Array<{tool:string;args:Record<string,unknown>}> } {
  const calls: Array<{tool:string;args:Record<string,unknown>}> = [];
  return {
    calls,
    async execute(tool, args): Promise<ExecutorResult> {
      calls.push({ tool, args });
      const workspaceId = tool === "open_workspace" ? privateId : String(args.workspaceId);
      return {
        content: [{ type: "text", text: `workspace ${workspaceId}` }],
        structuredContent: tool === "close_workspace"
          ? { workspaceId, workspace: { closed: true }, nested: [workspaceId] }
          : { workspaceId, nested: [workspaceId] },
      };
    },
  };
}

const asgard = fakeTarget("private-asgard");
const saga = fakeTarget("private-saga");
const store = new MemoryStore();
const router = new GatewayExecutionRouter(
  [
    { id: "asgard", displayName: "Asgard", aliases: ["home"], canonical: true },
    { id: "saga", displayName: "Saga", aliases: ["cloud"], canonical: false },
  ],
  new Map([["asgard", asgard], ["saga", saga]]),
  store,
);
const options = { requestId: "request-1", signal: new AbortController().signal };

const defaultOpen = await router.execute("open_workspace", { path: "/a" }, options);
assert.equal(asgard.calls.length, 1);
assert.equal(saga.calls.length, 0);
assert.deepEqual(defaultOpen.machine, { id: "asgard", displayName: "Asgard" });
assert.notEqual(defaultOpen.publicWorkspaceId, "private-asgard");
assert.equal(JSON.stringify(defaultOpen.result).includes("private-asgard"), false);
assert.deepEqual(defaultOpen.result.structuredContent?.machine, { id: "asgard", displayName: "Asgard" });

const sagaOpen = await router.execute("open_workspace", { path: "/b", machine: " CLOUD " }, options);
assert.equal(saga.calls.length, 1);
assert.deepEqual(sagaOpen.machine, { id: "saga", displayName: "Saga" });
await router.execute("read_file", { workspaceId: sagaOpen.publicWorkspaceId, path: "x" }, options);
assert.equal(saga.calls.length, 2);
assert.equal(asgard.calls.length, 1);
assert.equal(saga.calls[1]?.args.workspaceId, "private-saga");
await router.execute("close_workspace", { workspaceId: sagaOpen.publicWorkspaceId }, options);
assert.equal(saga.calls[2]?.tool, "close_workspace");
assert.equal(store.get(sagaOpen.publicWorkspaceId), undefined);
await assert.rejects(
  router.execute("workspace_status", { workspaceId: sagaOpen.publicWorkspaceId }, options),
  (error: unknown) => error instanceof GatewayRoutingError && error.code === "unknown_workspace",
);

await assert.rejects(
  router.execute("open_workspace", { path: "/x", machine: "unknown" }, options),
  (error: unknown) => error instanceof GatewayRoutingError && error.code === "unknown_machine",
);
assert.equal(asgard.calls.length, 1);
assert.equal(saga.calls.length, 3);

const reuseTarget = fakeTarget("private-reused");
const reuseStore = new MemoryStore();
const reuseRouter = new GatewayExecutionRouter(
  [{ id: "saga", displayName: "Saga", aliases: [], canonical: true }],
  new Map([["saga", reuseTarget]]),
  reuseStore,
);
const reuseFirst = await reuseRouter.execute("open_workspace", { path: "/same" }, options);
const reuseSecond = await reuseRouter.execute("open_workspace", { path: "/same" }, options);
assert.equal(reuseSecond.publicWorkspaceId, reuseFirst.publicWorkspaceId);
assert.equal(reuseStore.rows.size, 1);

const unavailableRouter = new GatewayExecutionRouter(
  [
    { id: "asgard", displayName: "Asgard", aliases: [], canonical: true },
    { id: "saga", displayName: "Saga", aliases: [], canonical: false },
  ],
  new Map([["saga", saga]]),
  new MemoryStore(),
);
await assert.rejects(
  unavailableRouter.execute("open_workspace", { path: "/x" }, options),
  (error: unknown) => error instanceof GatewayRoutingError && error.code === "target_unavailable",
);
assert.equal(saga.calls.length, 3, "canonical failure must never fall back to Saga");

const prunedStore = new MemoryStore();
const prunedTarget: ExecutionTarget = {
  async execute(tool, args): Promise<ExecutorResult> {
    if (tool === "open_workspace") {
      return { content: [{ type: "text", text: "opened private-pruned" }], structuredContent: { workspaceId: "private-pruned" } };
    }
    throw new Error(`Unknown workspaceId: ${String(args.workspaceId)}. Call open_workspace first.`);
  },
};
const prunedRouter = new GatewayExecutionRouter(
  [{ id: "saga", displayName: "Saga", aliases: [], canonical: true }],
  new Map([["saga", prunedTarget]]),
  prunedStore,
);
const prunedOpen = await prunedRouter.execute("open_workspace", { path: "/pruned" }, options);
await assert.rejects(
  prunedRouter.execute("workspace_status", { workspaceId: prunedOpen.publicWorkspaceId }, options),
  (error: unknown) => error instanceof GatewayRoutingError && error.code === "unknown_workspace",
);
assert.equal(prunedStore.get(prunedOpen.publicWorkspaceId), undefined);

// A reconstructed router must honor the persisted machine affinity and hide the
// executor's private workspace ID on the next operation.
const restartState = mkdtempSync(join(tmpdir(), "devspace-gateway-router-restart-"));
try {
  const firstAsgard = fakeTarget("restart-private-asgard");
  const firstStore = new SqliteGatewayWorkspaceStore(restartState);
  const firstRouter = new GatewayExecutionRouter(
    [{ id: "asgard", displayName: "Asgard", aliases: [], canonical: true }, { id: "saga", displayName: "Saga", aliases: [], canonical: false }],
    new Map([["asgard", firstAsgard]]),
    firstStore,
  );
  const opened = await firstRouter.execute("open_workspace", { path: "/persisted" }, options);
  assert.equal(opened.machine.id, "asgard");
  assert.equal(firstAsgard.calls.length, 1);
  firstStore.close();

  const restartedAsgard = fakeTarget("restart-private-asgard");
  const restartedSaga = fakeTarget("restart-private-saga");
  const restartedStore = new SqliteGatewayWorkspaceStore(restartState);
  const restartedRouter = new GatewayExecutionRouter(
    [{ id: "asgard", displayName: "Asgard", aliases: [], canonical: true }, { id: "saga", displayName: "Saga", aliases: [], canonical: false }],
    new Map([["asgard", restartedAsgard], ["saga", restartedSaga]]),
    restartedStore,
  );
  const next = await restartedRouter.execute("read_file", { workspaceId: opened.publicWorkspaceId, path: "README.md" }, options);
  assert.equal(restartedAsgard.calls.length, 1);
  assert.equal(restartedSaga.calls.length, 0);
  assert.equal(restartedAsgard.calls[0]?.args.workspaceId, "restart-private-asgard");
  assert.equal(JSON.stringify(next.result).includes("restart-private-asgard"), false);
  restartedStore.close();
} finally {
  rmSync(restartState, { recursive: true, force: true });
}
