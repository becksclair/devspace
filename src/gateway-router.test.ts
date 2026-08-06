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
const readActivity = await router.waitForActivity(sagaOpen.publicWorkspaceId, 0, 20, 0);
assert.equal(readActivity.totalOperations, 1);
assert.deepEqual(readActivity.events.map((event) => [event.tool, event.status, event.label]), [
  ["read_file", "running", "x"],
  ["read_file", "success", "x"],
]);
assert.equal(readActivity.events[1]?.detail, "1 line");
await router.execute("close_workspace", { workspaceId: sagaOpen.publicWorkspaceId }, options);
assert.equal(saga.calls[2]?.tool, "close_workspace");
assert.equal(store.get(sagaOpen.publicWorkspaceId), undefined);
const closedActivity = await router.waitForActivity(sagaOpen.publicWorkspaceId, 0, 20, 0);
assert.equal(closedActivity.totalOperations, 2);
assert.equal(closedActivity.events.at(-1)?.tool, "close_workspace");
assert.equal(closedActivity.events.at(-1)?.status, "success");
await assert.rejects(
  router.execute("workspace_status", { workspaceId: sagaOpen.publicWorkspaceId }, options),
  (error: unknown) => error instanceof GatewayRoutingError && error.code === "unknown_workspace",
);

const retainedStore = new MemoryStore();
const retainedTarget: ExecutionTarget = {
  async execute(tool, args): Promise<ExecutorResult> {
    if (tool === "open_workspace") {
      return {
        content: [{ type: "text", text: "opened" }],
        structuredContent: { workspaceId: "private-retained" },
      };
    }
    if (tool === "close_workspace") {
      return {
        content: [{ type: "text", text: "workspace remains open" }],
        structuredContent: { workspace: { closed: false, reason: "retained terminal" } },
      };
    }
    return { content: [{ type: "text", text: String(args.workspaceId ?? "") }] };
  },
};
const retainedRouter = new GatewayExecutionRouter(
  [{ id: "saga", displayName: "Saga", aliases: [], canonical: true }],
  new Map([["saga", retainedTarget]]),
  retainedStore,
);
const retainedOpen = await retainedRouter.execute("open_workspace", { path: "/retained" }, options);
await retainedRouter.execute("close_workspace", { workspaceId: retainedOpen.publicWorkspaceId }, options);
assert.ok(retainedStore.get(retainedOpen.publicWorkspaceId), "a refused close must preserve the public binding");
const retainedActivity = await retainedRouter.waitForActivity(retainedOpen.publicWorkspaceId, 0, 20, 0);
assert.equal(retainedActivity.events.at(-1)?.detail, "remains open · retained terminal");

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

const liveTarget = fakeTarget("private-live");
const liveStore = new MemoryStore();
const liveRouter = new GatewayExecutionRouter(
  [{ id: "saga", displayName: "Saga", aliases: [], canonical: true }],
  new Map([["saga", liveTarget]]),
  liveStore,
);
const liveOpen = await liveRouter.execute("open_workspace", { path: "/live" }, options);
const liveWait = liveRouter.waitForActivity(liveOpen.publicWorkspaceId, 0, 20, 1_000);
const liveRead = liveRouter.execute("read_file", { workspaceId: liveOpen.publicWorkspaceId, path: "live.txt" }, options);
const livePage = await liveWait;
assert.equal(livePage.events[0]?.tool, "read_file");
assert.equal(livePage.events[0]?.status, "running");
await liveRead;

const boundedTarget = fakeTarget("private-bounded");
const boundedStore = new MemoryStore();
const boundedRouter = new GatewayExecutionRouter(
  [{ id: "saga", displayName: "Saga", aliases: [], canonical: true }],
  new Map([["saga", boundedTarget]]),
  boundedStore,
);
const boundedOpen = await boundedRouter.execute("open_workspace", { path: "/bounded" }, options);
for (let index = 0; index < 205; index += 1) {
  await boundedRouter.execute(
    "read_file",
    { workspaceId: boundedOpen.publicWorkspaceId, path: `file-${index}.txt` },
    options,
  );
}
const boundedPage = await boundedRouter.waitForActivity(boundedOpen.publicWorkspaceId, 0, 200, 0);
assert.equal(boundedPage.events.length, 200, "activity pages stay bounded");
assert.equal(boundedPage.totalOperations, 205, "operation count remains monotonic after old events are pruned");

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
