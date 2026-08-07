import assert from "node:assert/strict";
import { createNodeServer } from "./node-server.js";
import { TOOL_CONTRACT_HASH } from "./tool-contract.js";
import { PROTOCOL_MAJOR } from "./build-metadata.js";

process.env.NODE_SERVER_TEST_TOKEN = "secret-token";
const calls: Array<{ tool: string; requestId: string; signal: AbortSignal }> = [];
const executor = {
  async execute(tool: string, _args: unknown, context: { requestId: string; signal: AbortSignal }) {
    calls.push({ tool, requestId: context.requestId, signal: context.signal });
    if (context.requestId.startsWith("slow-")) {
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    return { content: [{ type: "text", text: "ok" }] };
  },
};
const config = {
  role: "node" as const,
  host: "127.0.0.1" as const,
  port: 0,
  machineId: "m1",
  allowedRoots: [process.cwd()],
  stateDir: process.cwd(),
  worktreeRoot: process.cwd(),
  nodeTokenEnv: "NODE_SERVER_TEST_TOKEN",
};
const { app } = createNodeServer(config, executor, {
  allowedTools: ["read_file"],
  resultRetentionMs: 100,
  operationRetentionMs: 60_000,
  maxRunningOperations: 1,
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const address = server.address();
assert.ok(address && typeof address !== "string");
const url = `http://127.0.0.1:${address.port}`;
const headers = { "content-type": "application/json", "X-DevSpace-Node-Token": "secret-token" };

const hello = await fetch(`${url}/internal/v1/hello`, { headers });
assert.equal(hello.status, 200);
const helloBody = await hello.json() as { machineId?: string; resumableCalls?: boolean; nodeInstanceId?: string };
assert.equal(helloBody.machineId, "m1");
assert.equal(helloBody.resumableCalls, true);
assert.match(helloBody.nodeInstanceId ?? "", /^[0-9a-f-]{36}$/);

const call = async (body: unknown, token = "secret-token") => fetch(`${url}/internal/v1/call`, {
  method: "POST",
  headers: { ...headers, "X-DevSpace-Node-Token": token },
  body: JSON.stringify(body),
});
const cancel = async (requestId: string) => fetch(`${url}/internal/v1/cancel`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    protocolMajor: PROTOCOL_MAJOR,
    toolContractHash: TOOL_CONTRACT_HASH,
    machineId: "m1",
    requestId,
    nodeInstanceId: helloBody.nodeInstanceId,
  }),
});
const valid = {
  protocolMajor: PROTOCOL_MAJOR,
  toolContractHash: TOOL_CONTRACT_HASH,
  machineId: "m1",
  requestId: "r1",
  tool: "read_file",
  arguments: { workspaceId: "w", path: "x" },
};

assert.equal((await call(valid)).status, 200);
assert.equal(calls.length, 1);
assert.equal((await call(valid, "bad")).status, 401);
assert.equal(calls.length, 1);
assert.equal((await call({ ...valid, machineId: "wrong" })).status, 409);
assert.equal(calls.length, 1);
for (const body of [
  { ...valid, protocolMajor: 999 },
  { ...valid, toolContractHash: "bad" },
  { ...valid, requestId: "" },
  { ...valid, tool: "run_shell" },
  { ...valid, arguments: {} },
  { ...valid, resumable: "yes" },
]) {
  assert.equal((await call(body)).status, 400);
}
assert.equal(calls.length, 1);
assert.equal(
  (await call({ ...valid, requestId: "wrong-epoch", resumable: true, nodeInstanceId: "00000000-0000-0000-0000-000000000000" })).status,
  409,
  "a resumable call from a previous node instance must fail closed",
);
assert.equal(calls.length, 1);

const replay = { ...valid, requestId: "replay", resumable: true, nodeInstanceId: helloBody.nodeInstanceId };
assert.equal((await call(replay)).status, 200);
assert.equal((await call(replay)).status, 200);
assert.equal(calls.filter((entry) => entry.requestId === "replay").length, 1, "completed resumable requests replay without re-execution");
assert.equal(
  (await call({ ...replay, arguments: { workspaceId: "w", path: "different" } })).status,
  409,
  "one requestId cannot be rebound to different arguments",
);
assert.equal(calls.filter((entry) => entry.requestId === "replay").length, 1);

const expiring = { ...replay, requestId: "expiring" };
assert.equal((await call(expiring)).status, 200);
await new Promise((resolve) => setTimeout(resolve, 125));
assert.equal((await call(expiring)).status, 410, "expired replay data becomes a tombstone instead of re-executing");
assert.equal(calls.filter((entry) => entry.requestId === "expiring").length, 1);

const legacyAbortController = new AbortController();
const legacyPending = fetch(`${url}/internal/v1/call`, {
  method: "POST",
  headers,
  body: JSON.stringify({ ...valid, requestId: "slow-legacy" }),
  signal: legacyAbortController.signal,
}).catch(() => undefined);
await waitUntil(() => calls.some((entry) => entry.requestId === "slow-legacy"));
const legacyCall = calls.find((entry) => entry.requestId === "slow-legacy");
assert.ok(legacyCall);
legacyAbortController.abort();
await legacyPending;
await waitUntil(() => legacyCall.signal.aborted);
assert.equal(legacyCall.signal.aborted, true, "legacy callers retain disconnect-cancels-execution semantics");

const resumableAbortController = new AbortController();
const resumablePending = fetch(`${url}/internal/v1/call`, {
  method: "POST",
  headers,
  body: JSON.stringify({ ...valid, requestId: "slow-resumable", resumable: true, nodeInstanceId: helloBody.nodeInstanceId }),
  signal: resumableAbortController.signal,
}).catch(() => undefined);
await waitUntil(() => calls.some((entry) => entry.requestId === "slow-resumable"));
const resumableCall = calls.find((entry) => entry.requestId === "slow-resumable");
assert.ok(resumableCall);
resumableAbortController.abort();
await resumablePending;
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(resumableCall.signal.aborted, false, "transport loss must not cancel a resumable executor operation");
const capacityResponse = await call({ ...replay, requestId: "blocked-by-capacity" });
assert.equal(capacityResponse.status, 503, "a saturated node refuses a new resumable operation instead of oversubscribing");
assert.equal(calls.some((entry) => entry.requestId === "blocked-by-capacity"), false);

const reattached = call({ ...valid, requestId: "slow-resumable", resumable: true, nodeInstanceId: helloBody.nodeInstanceId });
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(
  calls.filter((entry) => entry.requestId === "slow-resumable").length,
  1,
  "reattaching to a running requestId must not invoke the executor twice",
);
const cancelResponse = await cancel("slow-resumable");
assert.equal(cancelResponse.status, 200);
assert.equal((await cancelResponse.json() as { state?: string }).state, "cancelling");
assert.equal((await reattached).status, 200);
await waitUntil(() => resumableCall.signal.aborted);
assert.equal(resumableCall.signal.aborted, true);
assert.equal((await call({ ...valid, requestId: "slow-resumable", resumable: true, nodeInstanceId: helloBody.nodeInstanceId })).status, 200);
assert.equal(calls.filter((entry) => entry.requestId === "slow-resumable").length, 1);
assert.equal((await cancel("missing-operation")).status, 404);

await new Promise<void>((resolve) => server.close(() => resolve()));

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached before timeout");
}
