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

// --- Plan 002: gateway deep rewrite corruption tests ---
{
  // Test: does not corrupt file content containing private id substring
  const privateId = "private-file-content-123";
  const fileTarget: ExecutionTarget = {
    async execute(tool, args): Promise<ExecutorResult> {
      if (tool === "open_workspace") {
        return { content: [{ type: "text", text: `Opened workspace ${privateId}` }], structuredContent: { workspaceId: privateId } };
      }
      return {
        content: [{ type: "text", text: `hello ${privateId} world` }],
        structuredContent: { result: "ok" },
        isError: false,
      };
    },
  };
  const fileStore = new MemoryStore();
  const fileRouter = new GatewayExecutionRouter(
    [{ id: "saga", displayName: "Saga", aliases: [], canonical: true }],
    new Map([["saga", fileTarget]]),
    fileStore,
  );
  const fileOpen = await fileRouter.execute("open_workspace", { path: "/file-test" }, options);
  const fileResult = await fileRouter.execute("read_file", { workspaceId: fileOpen.publicWorkspaceId, path: "x.txt" }, options);
  assert.equal((fileResult.result.content[0] as { text: string }).text, `hello ${privateId} world`, "file content must remain byte-identical, not rewritten");
  assert.equal(JSON.stringify(fileResult.result).includes(privateId), true, "file content leak is expected file data, but JSON check for this test should still show privateId in content (not corrupted to publicId)");
  // Ensure structuredContent not corrupted to publicId
  assert.equal(fileResult.publicWorkspaceId, fileOpen.publicWorkspaceId);
}

{
  // Test: does not rewrite patch/diff fields
  const privateId = "private-patch-xyz";
  const patchText = `diff contains ${privateId} as code`;
  const patchTarget: ExecutionTarget = {
    async execute(tool, args): Promise<ExecutorResult> {
      if (tool === "open_workspace") {
        return { content: [{ type: "text", text: `Opened workspace ${privateId}` }], structuredContent: { workspaceId: privateId } };
      }
      return {
        content: [{ type: "text", text: "review" }],
        structuredContent: { result: "ok", patch: patchText, details: { patch: patchText } } as unknown as Record<string, unknown>,
      };
    },
  };
  const patchStore = new MemoryStore();
  const patchRouter = new GatewayExecutionRouter(
    [{ id: "saga", displayName: "Saga", aliases: [], canonical: true }],
    new Map([["saga", patchTarget]]),
    patchStore,
  );
  const patchOpen = await patchRouter.execute("open_workspace", { path: "/patch" }, options);
  const patchResult = await patchRouter.execute("show_changes", { workspaceId: patchOpen.publicWorkspaceId }, options);
  const sc = patchResult.result.structuredContent as Record<string, unknown>;
  assert.equal(sc["patch"], patchText, "patch field must not be rewritten");
  assert.equal((sc["details"] as Record<string, unknown>)["patch"], patchText, "nested patch unchanged");
  // Also ensure workspaceId mapping still works if present? In this result, workspaceId not present, so no leak check
}

{
  // Test: rewrites only workspaceId fields and leaks no private id
  const privateId = "private-workspace-only-789";
  const wsTarget: ExecutionTarget = {
    async execute(tool, args): Promise<ExecutorResult> {
      if (tool === "open_workspace") {
        return { content: [{ type: "text", text: `Opened workspace ${privateId}` }], structuredContent: { workspaceId: privateId, root: "/tmp", canonicalRoot: "/tmp" } };
      }
      return {
        content: [{ type: "text", text: "ok" }],
        structuredContent: { workspaceId: privateId, root: "/tmp", canonicalRoot: "/tmp" },
      };
    },
  };
  const wsStore = new MemoryStore();
  const wsRouter = new GatewayExecutionRouter(
    [{ id: "saga", displayName: "Saga", aliases: [], canonical: true }],
    new Map([["saga", wsTarget]]),
    wsStore,
  );
  const wsOpen = await wsRouter.execute("open_workspace", { path: "/ws" }, options);
  const wsResult = await wsRouter.execute("workspace_status", { workspaceId: wsOpen.publicWorkspaceId }, options);
  assert.equal((wsResult.result.structuredContent as Record<string, unknown>)["workspaceId"], wsOpen.publicWorkspaceId, "workspaceId should be rewritten to publicId");
  assert.equal(JSON.stringify(wsResult.result).includes(privateId), false, "privateId must not leak in rewritten result");
}

{
  // Test: error message rewrite preserves integrity
  const privateId = "private-error-456";
  const errorTarget: ExecutionTarget = {
    async execute(tool, args): Promise<ExecutorResult> {
      if (tool === "open_workspace") {
        return { content: [{ type: "text", text: `Opened workspace ${privateId}` }], structuredContent: { workspaceId: privateId } };
      }
      throw new Error(`something with ${privateId} and other context`);
    },
  };
  const errorStore = new MemoryStore();
  const errorRouter = new GatewayExecutionRouter(
    [{ id: "saga", displayName: "Saga", aliases: [], canonical: true }],
    new Map([["saga", errorTarget]]),
    errorStore,
  );
  const errorOpen = await errorRouter.execute("open_workspace", { path: "/err" }, options);
  // Non-workspace error should not corrupt file content portion containing privateId, and should not leak via substring replacement.
  // After fix, error is rethrown without naive split/join; message should remain containing privateId (original error) OR be preserved.
  // The gateway should NOT rewrite arbitrary error messages with split/join. We assert that the thrown error does not have publicId substituted in file-content position.
  // For generic errors, gateway rethrows original; for unknown_workspace errors, it maps to GatewayRoutingError with publicId.
  try {
    await errorRouter.execute("read_file", { workspaceId: errorOpen.publicWorkspaceId, path: "x" }, options);
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof Error);
    // Should not have publicId injected into the arbitrary file-content part via split/join
    // The original privateId substring should remain (since we don't do substring replace), or if we do exact-match only, it remains
    assert.equal((err as Error).message.includes(privateId), true, "generic error message should preserve privateId substring (no naive rewrite) or at least not be corrupted to publicId");
    assert.equal((err as Error).message.includes(errorOpen.publicWorkspaceId), false, "generic error should not have publicId substituted for file content substring");
  }

  // Unknown workspace error mapping should use publicId without leaking privateId
  const unknownTarget: ExecutionTarget = {
    async execute(tool, args): Promise<ExecutorResult> {
      if (tool === "open_workspace") {
        return { content: [{ type: "text", text: `Opened workspace ${privateId}` }], structuredContent: { workspaceId: privateId } };
      }
      throw new Error(`Unknown workspaceId: ${privateId}. Call open_workspace first.`);
    },
  };
  const unknownStore = new MemoryStore();
  const unknownRouter = new GatewayExecutionRouter(
    [{ id: "saga", displayName: "Saga", aliases: [], canonical: true }],
    new Map([["saga", unknownTarget]]),
    unknownStore,
  );
  const unknownOpen = await unknownRouter.execute("open_workspace", { path: "/unknown" }, options);
  await assert.rejects(
    unknownRouter.execute("workspace_status", { workspaceId: unknownOpen.publicWorkspaceId }, options),
    (error: unknown) => {
      assert.ok(error instanceof GatewayRoutingError && error.code === "unknown_workspace");
      assert.equal((error as Error).message.includes(unknownOpen.publicWorkspaceId), true);
      assert.equal((error as Error).message.includes(privateId), false, "unknown_workspace message must not leak privateId");
      return true;
    },
  );
}

{
  // Test: large payload patch not mutated (performance/correctness)
  const privateId = "private-large-999";
  const largePatch = "a".repeat(1024 * 1024); // 1 MB
  const largeTarget: ExecutionTarget = {
    async execute(tool, args): Promise<ExecutorResult> {
      if (tool === "open_workspace") {
        return { content: [{ type: "text", text: `Opened workspace ${privateId}` }], structuredContent: { workspaceId: privateId } };
      }
      return {
        content: [{ type: "text", text: "ok" }],
        structuredContent: { patch: largePatch } as unknown as Record<string, unknown>,
      };
    },
  };
  const largeStore = new MemoryStore();
  const largeRouter = new GatewayExecutionRouter(
    [{ id: "saga", displayName: "Saga", aliases: [], canonical: true }],
    new Map([["saga", largeTarget]]),
    largeStore,
  );
  const largeOpen = await largeRouter.execute("open_workspace", { path: "/large" }, options);
  const largeResult = await largeRouter.execute("show_changes", { workspaceId: largeOpen.publicWorkspaceId }, options);
  assert.equal((largeResult.result.structuredContent as Record<string, unknown>)["patch"], largePatch, "large patch must be returned without mutation");
}

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
