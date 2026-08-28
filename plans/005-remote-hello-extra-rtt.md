# Plan 005: Cache gateway hello to remove extra RTT on every remote tool call

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ee85288..HEAD -- src/remote-node-client.ts src/gateway-router.ts src/remote-node-client.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `ee85288`, 2026-08-28
- **Issue**: —

## Why this matters

`RemoteNodeClient.execute()` revalidates the remote node's identity before every tool call by doing a full `GET /internal/v1/hello` (with 4 retries, 30s timeout) and only then `POST /internal/v1/call`. That doubles tunnel RTT (30-300 ms via Cloudflare/Tailnet) for every forwarded `read/grep/shell/multi_read`, erasing the 1-RTT win that `multi_read` was built to provide. A 30-60s cache keyed by `machineId+url+toolContractHash` with single-retry bust on `target_unavailable`/`protocol_mismatch` preserves safety while cutting p50 latency in half.

## Current state

- Relevant files:
  - `src/remote-node-client.ts` — `hello()` at lines 57-80 and `execute()` at 82-123 that unconditionally awaits `hello` before every call
  - `src/gateway-router.ts` — calls `target.execute` for each routed tool; `multi_read` proven to fan-out per-file activity
  - `src/remote-node-client.test.ts` — covers hello mismatch + resumable, but not caching
  - `src/build-metadata.ts` — `PROTOCOL_MAJOR`, `TOOL_CONTRACT_HASH` used in hello validation

- Excerpts (`src/remote-node-client.ts:57-90`):
  ```ts
  async hello(signal: AbortSignal): Promise<NodeHello> {
    let hello: NodeHello;
    try {
      hello = await this.withTimeout(signal, (boundedSignal) => this.retryTransient(
        async () => {
          const response = await this.request("/internal/v1/hello", { method: "GET" }, boundedSignal);
          if (!response.ok) throw new TargetUnavailableError(`Remote node hello failed (${response.status})`);
          return readBoundedJson<NodeHello>(response, this.maxBodyBytes());
        },
        boundedSignal,
        HELLO_RETRY_ATTEMPTS,
      ));
    } catch (error) {
      throw normalizeTargetError(error, signal, "Remote node hello failed");
    }
    if (
      hello.protocolMajor !== PROTOCOL_MAJOR ||
      hello.machineId !== this.config.machineId ||
      hello.toolContractHash !== TOOL_CONTRACT_HASH
    ) {
      throw new TargetUnavailableError("Remote node identity is incompatible");
    }
    return hello;
  }

  async execute(
    tool: ToolName,
    args: Record<string, unknown>,
    options: { requestId: string; signal: AbortSignal },
  ): Promise<ExecutorResult> {
    // Revalidate immediately before every operation. A process-lifetime cache
    // could route a later call to the wrong machine after DNS/tunnel changes.
    const hello = await this.hello(options.signal);
  ```

- Excerpts (`src/remote-node-client.ts:94-108` body after hello):
  ```ts
  const remoteRequestId = randomUUID();
  const nodeInstanceId = typeof hello.nodeInstanceId === "string" && hello.nodeInstanceId.length > 0
    ? hello.nodeInstanceId
    : undefined;
  const resumable = hello.resumableCalls === true && nodeInstanceId !== undefined;
  const body = JSON.stringify({
    protocolMajor: PROTOCOL_MAJOR,
    toolContractHash: TOOL_CONTRACT_HASH,
    machineId: this.config.machineId,
    requestId: remoteRequestId,
    tool,
    arguments: args,
    ...(resumable ? { resumable: true, nodeInstanceId } : {}),
  });
  ```

- Impact today: every `remote.execute` pays hello RTT + TLS, thundering herd on hello endpoint under fan-out (`multi_read` does N local reads but 1 gateway call; still 2 RTTs). Comment at 87-88 explicitly justifies revalidation but implementation is unconditional.

- Repo conventions:
  - `RemoteNodeClient` is constructed per `GatewayMachine` in `src/server.ts` gateway setup; `config.machineId` + `url` + `nodeToken` are stable per client.
  - Tests use `fetch` mock via overriding `globalThis.fetch` or injecting a fake `request` method; see `src/remote-node-client.test.ts:1-100` for hello mismatch cases and `remoteToolTimeoutMs`.
  - Logging at `src/logger.ts` is structured; `logEvent` on hello failures would duplicate.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `npm run typecheck` | exit 0 |
| Remote client tests | `npx tsx src/remote-node-client.test.ts` | all pass |
| Gateway tests | `npx tsx src/gateway-router.test.ts` | all pass |
| Full suite | `npm test` | all pass (modulo known terminal flake) |

## Scope

**In scope** (the only files you should modify):
- `src/remote-node-client.ts`
- `src/remote-node-client.test.ts` (extend)

**Out of scope** (do NOT touch, even though they look related):
- `src/gateway-router.ts` — activity fan-out is separate; do not alter routing
- `src/server.ts` — client construction and eviction timers unchanged
- `src/build-metadata.ts` — protocol hash unchanged
- `src/node-server.ts` — hello handler unchanged
- Any change to `TOOL_CONTRACT_HASH` or `PROTOCOL_MAJOR` — immutable contract

## Git workflow

- Branch: `advisor/005-hello-cache`
- Commit per step; message style: `perf: ...`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add test for hello caching behavior

In `src/remote-node-client.test.ts`, add (model after existing hello mismatch test):

- Mock `fetch` to count `GET /internal/v1/hello` and `POST /internal/v1/call` invocations. Sequence:
  1. `hello` returns `{protocolMajor, machineId, toolContractHash, nodeInstanceId:"abc", resumableCalls:true}`
  2. `call` returns `{ok:true, machineId, result:{content:[{type:"text", text:"ok"}], structuredContent:{}}}`
- Call `client.execute("read_file", {workspaceId:"ws1", path:"a.txt"}, {requestId:"r1", signal:AbortSignal.timeout(1000)})` twice.
- Assert: `helloCount === 1` (second call used cache), `callCount === 2`.
- Test bust on failure: mock hello success then call returns `code: "protocol_mismatch"` → transport error → next `execute` should re-hello (count 2).
- Test TTL: use fake timer or short TTL (1s) and assert after TTL expiry a new hello is issued.

Add `hello` cache test helper that injects a `Date.now` override or exposes `helloCacheTtlMs` for testing. Easiest: add optional `helloCacheTtlMs` param to `RemoteNodeClientConfig` (default 30_000) and use it in implementation so tests can set `1_000`.

**Verify**: `npx tsx src/remote-node-client.test.ts` → new caching tests fail before fix (helloCount 2 for two calls).

### Step 2: Implement 30-60s cache with single bust

In `src/remote-node-client.ts`:

Add fields to class:
```ts
private helloCache: { hello: NodeHello; expiresAt: number } | null = null;
private helloInflight: Promise<NodeHello> | null = null;
private readonly helloCacheTtlMs: number;
```

In constructor, set `this.helloCacheTtlMs = config.helloCacheTtlMs ?? 30_000` (or 60_000; pick 30s to match activity retention). Exported config type `RemoteNodeClientConfig` already is a public interface — add optional `helloCacheTtlMs?: number` with doc `// testing only: override cache TTL`.

Implement `cachedHello(signal)`:
```ts
private async cachedHello(signal: AbortSignal): Promise<NodeHello> {
  const now = Date.now();
  if (this.helloCache && now < this.helloCache.expiresAt) return this.helloCache.hello;
  if (this.helloInflight) return this.helloInflight;
  this.helloInflight = this.hello(signal).then((h) => {
    this.helloCache = { hello: h, expiresAt: Date.now() + this.helloCacheTtlMs };
    return h;
  }).finally(() => { this.helloInflight = null; });
  return this.helloInflight;
}
```

Change `execute()` first line from `const hello = await this.hello(...)` to `let hello = await this.cachedHello(...)`.

Add bust on specific errors after `callOnce`: if `TargetUnavailableError` with message containing `protocol_mismatch|identity_mismatch|hello` or `RemoteNodeExecutionError` code `protocol_mismatch|identity_mismatch`, clear `this.helloCache = null` and retry one hello + callOnce (for non-resumable; for resumable path, bust and re-enter `executeResumable` which will re-hello). Keep the retry bounded to one bust to avoid loop.

For simplicity, wrap the whole `execute` body in:
```ts
try {
  hello = await this.cachedHello(signal);
  // ... build body, callOnce / executeResumable
} catch (error) {
  if (isHelloStaleError(error)) {
    this.helloCache = null;
    hello = await this.cachedHello(signal);
    // retry once with fresh hello
  } else throw error;
}
```
Define `isHelloStaleError = (e) => e instanceof TargetUnavailableError && /identity|protocol_mismatch|hello/i.test(e.message) || e instanceof RemoteNodeExecutionError && (e.code==="protocol_mismatch"||e.code==="identity_mismatch")`.

Ensure `AbortSignal` cancellation still cancels hello + call; do not cache a rejected hello.

**Verify**: `npx tsx src/remote-node-client.test.ts` → caching tests pass: helloCount 1 for two calls, bust test triggers second hello.

### Step 3: Ensure resumable path respects cache

In `executeResumable`, `nodeInstanceId` comes from hello; if cache is busted mid-retry, `nodeInstanceId` may change. That's OK — new hello provides new `nodeInstanceId` for resumable. Ensure `executeResumable` re-reads hello after bust rather than reusing stale `nodeInstanceId`.

**Verify**: `npx tsx src/remote-node-client.test.ts` → resumable bust case passes.

### Step 4: Typecheck and gate

**Verify**: `npm run typecheck` → exit 0. `npx tsx src/gateway-router.test.ts` → pass (gateway not changed, but remote client is a target). Full `npm test` → pass for wired suites.

## Test plan

- New tests in `src/remote-node-client.test.ts`:
  - Two sequential executes → 1 hello
  - Concurrent executes → 1 hello (inflight dedup)
  - TTL expiry → 2 hellos
  - `protocol_mismatch` error busts cache and re-hellos once
  - Abort during hello does not cache
- Existing tests: `remote-node-client.test.ts` hello mismatch cases, `gateway-router.test.ts` routing, `server-gateway-results.test.ts` — all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npx tsx src/remote-node-client.test.ts` exits 0 and new caching tests show `helloCount` 1 for two cached calls
- [ ] `grep -n "helloCache\|cachedHello" src/remote-node-client.ts` returns matches
- [ ] `grep -n "await this.hello(" src/remote-node-client.ts` returns no unconditional execute-path hello (only inside `cachedHello` or `hello()` itself)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 005 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `src/remote-node-client.ts:57-90` doesn't match the excerpts (drift).
- `RemoteNodeClientConfig` is constructed via a factory that doesn't forward unknown fields — adding `helloCacheTtlMs` would be ignored; locate construction in `src/server.ts:1640-1700` and `src/role-config.ts` and ensure the field propagates.
- The hello response shape changed (e.g., `toolContractHash` renamed) — validation logic at lines 72-76 must match current contract.
- Caching breaks identity revalidation after DNS/tunnel failover and tests show stale `machineId` routed post-failover — reduce TTL or require bust on every `TargetUnavailableError`, not just protocol errors, and document.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- If `TOOL_CONTRACT_HASH` bumps, the cache must be busted; `hello()` validation already checks it, so a stale cache with old hash will fail on next `callOnce` with `protocol_mismatch` and self-heal via bust. No manual invalidation needed but monitor for one extra RTT on hash bump deploy.
- The comment at line 87-88 `Revalidate immediately before every operation. A process-lifetime cache could route...` should be updated to reflect the new 30s cache and single-retry bust rationale.
- Reviewer should scrutinize that `helloInflight` dedup doesn't hold a rejected promise (clear on finally) and that `signal` abort propagates through `cachedHello` to `hello`.
- Follow-up explicitly deferred: removing the pre-flight total-bytes estimate for sliced reads (CORRECTNESS-07) and parallelizing `probeWorkspaceCapabilities` git probes (PERF-02) — keep this plan focused on hello RTT only.
