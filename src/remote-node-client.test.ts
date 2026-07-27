import assert from "node:assert/strict";
import { RemoteNodeClient } from "./remote-node-client.js";
import { PROTOCOL_MAJOR, getBuildMetadata } from "./build-metadata.js";
import { TOOL_CONTRACT_HASH } from "./tool-contract.js";

assert.throws(() => new RemoteNodeClient({ machineId: "m", url: "http://localhost", nodeToken: "t" }), /HTTPS/);
const originalFetch = globalThis.fetch; let count = 0; let lastInit: RequestInit | undefined;
const headerValue = (name: string) => lastInit?.headers instanceof Headers
  ? lastInit.headers.get(name)
  : (lastInit?.headers as Record<string, string> | undefined)?.[name] ?? null;
globalThis.fetch = (async (_input, init) => { count++; lastInit = init; return new Response(JSON.stringify({ protocolMajor: PROTOCOL_MAJOR, machineId: "m", packageVersion: getBuildMetadata("node").packageVersion, sourceCommit: "x", toolContractHash: TOOL_CONTRACT_HASH }), { status: 200, headers: { "content-length": "999999999" } }); }) as typeof fetch;
const client = new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t", maxBodyBytes: 100 });
await assert.rejects(client.hello(new AbortController().signal), (error: unknown) => error instanceof Error && error.name === "TargetUnavailableError"); assert.equal(count, 1); assert.equal(lastInit?.redirect, "manual");
globalThis.fetch = (async () => { count++; return new Response("", { status: 302, headers: { location: "https://elsewhere" } }); }) as typeof fetch;
await assert.rejects(client.hello(new AbortController().signal), /redirect rejected/); assert.equal(count, 2);
count = 0;
let normalCallBody = "";
globalThis.fetch = (async (input, init) => { count++; const path = new URL(String(input)).pathname; if (!path.endsWith("/hello")) normalCallBody = String(init?.body ?? ""); const payload = path.endsWith("/hello")
  ? { protocolMajor: PROTOCOL_MAJOR, machineId: "m", packageVersion: "v", sourceCommit: "x", toolContractHash: TOOL_CONTRACT_HASH }
  : { ok: true, machineId: "m", result: { content: [{ type: "text", text: "ok" }] } }; return new Response(JSON.stringify(payload), { status: 200 }); }) as typeof fetch;
const result = await new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t", maxBodyBytes: 1000 }).execute("read_file", { workspaceId: "w", path: "x" }, { requestId: "r", signal: new AbortController().signal });
const firstContent = result.content[0];
assert.equal(firstContent?.type === "text" ? firstContent.text : undefined, "ok"); assert.equal(count, 2, "one hello and one mutation call, no retry");
assert.equal(JSON.parse(normalCallBody).machineId, "m", "call atomically binds the expected machine ID");
assert.equal(headerValue("X-DevSpace-Node-Token"), "t");
assert.equal(headerValue("CF-Access-Client-Id"), null);
assert.equal(headerValue("CF-Access-Client-Secret"), null);

let identityCalls = 0;
globalThis.fetch = (async (input) => {
  identityCalls++;
  const path = new URL(String(input)).pathname;
  if (path.endsWith("/hello")) {
    return new Response(JSON.stringify({
      protocolMajor: PROTOCOL_MAJOR,
      machineId: identityCalls === 1 ? "m" : "wrong-machine",
      packageVersion: "v",
      sourceCommit: "x",
      toolContractHash: TOOL_CONTRACT_HASH,
    }), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: true, machineId: "m", result: { content: [{ type: "text", text: "ok" }] } }), { status: 200 });
}) as typeof fetch;
const identityClient = new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t", maxBodyBytes: 1000 });
await identityClient.execute("read_file", { workspaceId: "w", path: "x" }, { requestId: "first", signal: new AbortController().signal });
await assert.rejects(identityClient.execute("read_file", { workspaceId: "w", path: "x" }, { requestId: "second", signal: new AbortController().signal }), /identity is incompatible/);
assert.equal(identityCalls, 3, "second operation stops after hello mismatch and makes no wrong-host call");

globalThis.fetch = (async (_input, init) => {
  await new Promise<void>((_resolve, reject) => {
    const keepAlive = setInterval(() => undefined, 50);
    init?.signal?.addEventListener("abort", () => {
      clearInterval(keepAlive);
      reject(init.signal?.reason);
    }, { once: true });
  });
  throw new Error("unreachable");
}) as typeof fetch;
await assert.rejects(
  new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t", timeoutMs: 5 }).hello(new AbortController().signal),
  (error: unknown) => error instanceof Error && error.name === "TargetUnavailableError",
);

globalThis.fetch = (async () => new Response("<html>Cloudflare Access denied</html>", { status: 403, headers: { "content-type": "text/html" } })) as typeof fetch;
await assert.rejects(
  new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t" }).hello(new AbortController().signal),
  (error: unknown) => error instanceof Error && error.name === "TargetUnavailableError" && !error.message.includes("Cloudflare"),
);

let accessCalls = 0;
globalThis.fetch = (async () => {
  accessCalls++;
  if (accessCalls === 1) return new Response(JSON.stringify({ protocolMajor: PROTOCOL_MAJOR, machineId: "m", packageVersion: "v", sourceCommit: "x", toolContractHash: TOOL_CONTRACT_HASH }), { status: 200 });
  return new Response("<html>Cloudflare Access denied</html>", { status: 403, headers: { "content-type": "text/html" } });
}) as typeof fetch;
await assert.rejects(
  new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t" }).execute("read_file", { workspaceId: "w", path: "x" }, { requestId: "access", signal: new AbortController().signal }),
  (error: unknown) => error instanceof Error && error.name === "TargetUnavailableError" && !error.message.includes("Cloudflare"),
);
assert.equal(accessCalls, 2, "Access failure makes one call and is never retried");
globalThis.fetch = originalFetch;
