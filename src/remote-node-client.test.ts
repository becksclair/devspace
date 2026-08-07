import assert from "node:assert/strict";
import { RemoteNodeClient, remoteToolTimeoutMs } from "./remote-node-client.js";
import { PROTOCOL_MAJOR, getBuildMetadata } from "./build-metadata.js";
import { TOOL_CONTRACT_HASH } from "./tool-contract.js";

assert.throws(() => new RemoteNodeClient({ machineId: "m", url: "http://localhost", nodeToken: "t" }), /HTTPS/);
assert.equal(remoteToolTimeoutMs("read_file", {}), 30_000);
assert.equal(remoteToolTimeoutMs("terminal_read", {}), 30_000);
assert.equal(remoteToolTimeoutMs("run_shell", { timeout: 90 }), 100_000);
assert.equal(remoteToolTimeoutMs("run_shell", { timeout: 90 }, 5), 5);

const originalFetch = globalThis.fetch;
const nodeInstanceId = "11111111-1111-4111-8111-111111111111";
let count = 0;
let lastInit: RequestInit | undefined;
const headerValue = (name: string) => lastInit?.headers instanceof Headers
  ? lastInit.headers.get(name)
  : (lastInit?.headers as Record<string, string> | undefined)?.[name] ?? null;

try {
  globalThis.fetch = (async (_input, init) => {
    count += 1;
    lastInit = init;
    return new Response(JSON.stringify({
      ...resumableHello(),
      packageVersion: getBuildMetadata("node").packageVersion,
    }), { status: 200, headers: { "content-length": "999999999" } });
  }) as typeof fetch;
  const client = new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t", maxBodyBytes: 100 });
  await assert.rejects(
    client.hello(new AbortController().signal),
    (error: unknown) => error instanceof Error && error.name === "TargetUnavailableError",
  );
  assert.equal(count, 1);
  assert.equal(lastInit?.redirect, "manual");

  globalThis.fetch = (async () => {
    count += 1;
    return new Response("", { status: 302, headers: { location: "https://elsewhere" } });
  }) as typeof fetch;
  await assert.rejects(client.hello(new AbortController().signal), /redirect rejected/);
  assert.equal(count, 2);

  count = 0;
  const resumableBodies: string[] = [];
  globalThis.fetch = (async (input, init) => {
    count += 1;
    lastInit = init;
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/hello")) return jsonResponse(resumableHello());
    resumableBodies.push(String(init?.body ?? ""));
    if (resumableBodies.length === 1) throw new TypeError("simulated hotspot reset");
    return jsonResponse(successEnvelope());
  }) as typeof fetch;
  const resumableResult = await new RemoteNodeClient({
    machineId: "m",
    url: "https://remote.test",
    nodeToken: "t",
    maxBodyBytes: 1000,
  }).execute("read_file", { workspaceId: "w", path: "x" }, {
    requestId: "stable-request",
    signal: new AbortController().signal,
  });
  assert.equal(textResult(resumableResult), "ok");
  assert.equal(count, 3, "one hello plus a transport reattach using the same call envelope");
  assert.equal(resumableBodies.length, 2);
  assert.equal(resumableBodies[0], resumableBodies[1]);
  const resumableEnvelope = JSON.parse(resumableBodies[0]!) as Record<string, unknown>;
  assert.match(String(resumableEnvelope.requestId ?? ""), /^[0-9a-f-]{36}$/);
  assert.notEqual(resumableEnvelope.requestId, "stable-request", "MCP-scoped IDs must not become node dedupe keys");
  assert.deepEqual({ ...resumableEnvelope, requestId: "<generated>" }, {
    protocolMajor: PROTOCOL_MAJOR,
    toolContractHash: TOOL_CONTRACT_HASH,
    machineId: "m",
    requestId: "<generated>",
    tool: "read_file",
    arguments: { workspaceId: "w", path: "x" },
    resumable: true,
    nodeInstanceId,
  });
  assert.equal(headerValue("X-DevSpace-Node-Token"), "t");
  assert.equal(headerValue("CF-Access-Client-Id"), null);
  assert.equal(headerValue("CF-Access-Client-Secret"), null);

  const independentRequestIds: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/hello")) return jsonResponse(resumableHello());
    independentRequestIds.push(String((JSON.parse(String(init?.body ?? "{}")) as { requestId?: unknown }).requestId ?? ""));
    return jsonResponse(successEnvelope());
  }) as typeof fetch;
  const independentClient = new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t" });
  await independentClient.execute("read_file", { workspaceId: "w", path: "a" }, { requestId: "1", signal: new AbortController().signal });
  await independentClient.execute("read_file", { workspaceId: "w", path: "b" }, { requestId: "1", signal: new AbortController().signal });
  assert.equal(independentRequestIds.length, 2);
  assert.notEqual(independentRequestIds[0], independentRequestIds[1], "reused MCP rpcId values must map to distinct node operations");

  let cloudflareCalls = 0;
  globalThis.fetch = (async (input) => {
    cloudflareCalls += 1;
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/hello")) return jsonResponse(resumableHello());
    if (cloudflareCalls === 2) return new Response("edge timeout", { status: 524 });
    return jsonResponse(successEnvelope());
  }) as typeof fetch;
  assert.equal(
    textResult(await new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t" })
      .execute("read_file", { workspaceId: "w", path: "x" }, { requestId: "cloudflare-524", signal: new AbortController().signal })),
    "ok",
  );
  assert.equal(cloudflareCalls, 3, "Cloudflare 524 is treated as reattachable transport uncertainty");

  let legacyCalls = 0;
  globalThis.fetch = (async (input) => {
    legacyCalls += 1;
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/hello")) return jsonResponse({
      protocolMajor: PROTOCOL_MAJOR,
      machineId: "m",
      packageVersion: "v",
      sourceCommit: "old",
      toolContractHash: TOOL_CONTRACT_HASH,
    });
    throw new TypeError("legacy node connection dropped");
  }) as typeof fetch;
  await assert.rejects(
    new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t" })
      .execute("read_file", { workspaceId: "w", path: "x" }, { requestId: "legacy", signal: new AbortController().signal }),
    /Remote node transport failed/,
  );
  assert.equal(legacyCalls, 2, "a node without resumable capability is never replayed after uncertainty");

  let epochCalls = 0;
  globalThis.fetch = (async (input) => {
    epochCalls += 1;
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/hello")) return jsonResponse(resumableHello());
    if (epochCalls === 2) throw new TypeError("connection dropped during node restart");
    return jsonResponse({
      ok: false,
      error: {
        code: "operation_epoch_mismatch",
        message: "Remote node instance changed while the operation result was uncertain",
      },
    }, 409);
  }) as typeof fetch;
  await assert.rejects(
    new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t" })
      .execute("write_file", { workspaceId: "w", path: "x", content: "once" }, { requestId: "restart-uncertain", signal: new AbortController().signal }),
    (error: unknown) => error instanceof Error
      && error.name === "RemoteNodeExecutionError"
      && /instance changed.*result was uncertain/i.test(error.message),
  );
  assert.equal(epochCalls, 3, "node-instance mismatch fails closed and surfaces the uncertainty instead of re-executing");

  let expiredResultCalls = 0;
  globalThis.fetch = (async (input) => {
    expiredResultCalls += 1;
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/hello")) return jsonResponse(resumableHello());
    return jsonResponse({
      ok: false,
      error: {
        code: "operation_result_expired",
        message: "Remote operation already ran but its replayable result has expired",
      },
    }, 410);
  }) as typeof fetch;
  await assert.rejects(
    new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t" })
      .execute("write_file", { workspaceId: "w", path: "x", content: "once" }, { requestId: "expired-result", signal: new AbortController().signal }),
    (error: unknown) => error instanceof Error
      && error.name === "RemoteNodeExecutionError"
      && /already ran.*result has expired/i.test(error.message),
  );
  assert.equal(expiredResultCalls, 2, "expired replay state is surfaced explicitly and is not retried");

  let identityCalls = 0;
  globalThis.fetch = (async (input) => {
    identityCalls += 1;
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/hello")) {
      return jsonResponse({ ...resumableHello(), machineId: identityCalls === 1 ? "m" : "wrong-machine" });
    }
    return jsonResponse(successEnvelope());
  }) as typeof fetch;
  const identityClient = new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t", maxBodyBytes: 1000 });
  await identityClient.execute("read_file", { workspaceId: "w", path: "x" }, { requestId: "first", signal: new AbortController().signal });
  await assert.rejects(
    identityClient.execute("read_file", { workspaceId: "w", path: "x" }, { requestId: "second", signal: new AbortController().signal }),
    /identity is incompatible/,
  );
  assert.equal(identityCalls, 3, "second operation stops after hello mismatch and makes no wrong-host call");

  let deadlineCancelCalls = 0;
  let deadlineCancelBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/hello")) return jsonResponse(resumableHello());
    if (path.endsWith("/cancel")) {
      deadlineCancelCalls += 1;
      deadlineCancelBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({ ok: true, state: "cancelling" });
    }
    await rejectWhenAborted(init?.signal);
    throw new Error("unreachable");
  }) as typeof fetch;
  const deadlineKeepAlive = setInterval(() => undefined, 50);
  try {
    await assert.rejects(
      new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t", timeoutMs: 15 })
        .execute("read_file", { workspaceId: "w", path: "x" }, { requestId: "deadline", signal: new AbortController().signal }),
      /execution deadline/,
    );
  } finally {
    clearInterval(deadlineKeepAlive);
  }
  assert.equal(deadlineCancelCalls, 1, "execution deadline sends one best-effort remote cancellation");
  assert.equal(deadlineCancelBody?.nodeInstanceId, nodeInstanceId);

  let callerCancelCalls = 0;
  let callStartedResolve!: () => void;
  const callStarted = new Promise<void>((resolve) => { callStartedResolve = resolve; });
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/hello")) return jsonResponse(resumableHello());
    if (path.endsWith("/cancel")) {
      callerCancelCalls += 1;
      return jsonResponse({ ok: true, state: "cancelling" });
    }
    callStartedResolve();
    await rejectWhenAborted(init?.signal);
    throw new Error("unreachable");
  }) as typeof fetch;
  const callerController = new AbortController();
  const callerPromise = new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t" })
    .execute("read_file", { workspaceId: "w", path: "x" }, { requestId: "caller-cancel", signal: callerController.signal });
  await callStarted;
  callerController.abort(new Error("caller went away"));
  await assert.rejects(callerPromise, /caller went away/);
  assert.equal(callerCancelCalls, 1, "upstream caller cancellation explicitly stops the resumable remote operation");

  globalThis.fetch = (async () => new Response("<html>Cloudflare Access denied</html>", {
    status: 403,
    headers: { "content-type": "text/html" },
  })) as typeof fetch;
  await assert.rejects(
    new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t" }).hello(new AbortController().signal),
    (error: unknown) => error instanceof Error && error.name === "TargetUnavailableError" && !error.message.includes("Cloudflare"),
  );

  let accessCalls = 0;
  globalThis.fetch = (async () => {
    accessCalls += 1;
    if (accessCalls === 1) return jsonResponse(resumableHello());
    return new Response("<html>Cloudflare Access denied</html>", { status: 403, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  await assert.rejects(
    new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t" })
      .execute("read_file", { workspaceId: "w", path: "x" }, { requestId: "access", signal: new AbortController().signal }),
    (error: unknown) => error instanceof Error && error.name === "TargetUnavailableError" && !error.message.includes("Cloudflare"),
  );
  assert.equal(accessCalls, 2, "Access failure is not classified as a transient tunnel failure");
} finally {
  globalThis.fetch = originalFetch;
}

function resumableHello() {
  return {
    protocolMajor: PROTOCOL_MAJOR,
    machineId: "m",
    packageVersion: "v",
    sourceCommit: "x",
    toolContractHash: TOOL_CONTRACT_HASH,
    resumableCalls: true,
    nodeInstanceId,
  };
}

function successEnvelope() {
  return { ok: true, machineId: "m", result: { content: [{ type: "text", text: "ok" }] } };
}

function textResult(result: { content: Array<{ type: string; text?: string }> }): string | undefined {
  const first = result.content[0];
  return first?.type === "text" ? first.text : undefined;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function rejectWhenAborted(signal: AbortSignal | null | undefined): Promise<never> {
  if (!signal) throw new Error("test expected an abort signal");
  if (signal.aborted) throw signal.reason;
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
