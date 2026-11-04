# Plan 012: Recover from node restarts immediately, and stop one caller's cancellation from failing shared hellos

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 79ddffc..HEAD -- src/remote-node-client.ts src/remote-node-client.test.ts src/node-server.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `79ddffc`, 2026-11-04

## Why this matters

In gateway mode, `RemoteNodeClient` caches each node's `/internal/v1/hello`
response for 30s (added by an earlier performance plan). The hello carries
`nodeInstanceId`, a random ID per node process. When a node restarts (every
deploy), it rejects calls that carry the old ID with
`409 operation_epoch_mismatch`, **before executing anything**. The client does
not treat that code as a stale hello. So for up to 30s after every node
restart, every gateway call to that machine fails with "Remote node instance
changed while the operation result was uncertain". That message is misleading,
because nothing ran. Separately, the shared in-flight hello runs on the
**first** caller's `AbortSignal`. If that caller's request is cancelled (the
user stops a ChatGPT turn) while the cache is cold, every concurrent caller
waiting on the same hello fails with that caller's cancellation.

## Current state

- `src/remote-node-client.ts:89-98`, the cache:
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
  `hello(signal)` (`:64-87`) already bounds itself with `this.withTimeout(signal, …)`, which combines the passed signal with `AbortSignal.timeout(config.timeoutMs ?? 30_000)` (`:291-298`). If the signal aborts, `normalizeTargetError` (`:312-316`) rethrows `signal.reason`.
- `src/remote-node-client.ts:100-152`, `execute()`. It loops at most twice (`bustAttempt`). On a stale-hello error it clears the cache and retries once:
  ```ts
  } catch (error) {
    if (bustAttempt === 0 && isHelloStaleError(error)) {
      this.helloCache = null;
      bustAttempt++;
      continue;
    }
    throw error;
  }
  ```
- `src/remote-node-client.ts:154-202`, `executeResumable()`. It loops calling `callOnce`, retrying transport errors. The `retry` counter is 0 on the first attempt. A `RemoteNodeExecutionError` is rethrown unchanged at `:182`:
  ```ts
  if (error instanceof RemoteNodeExecutionError) throw error;
  ```
- `src/remote-node-client.ts:204-223`, `callOnce()`. Envelope error codes other than `protocol_mismatch|identity_mismatch|unauthorized|target_error` become `new RemoteNodeExecutionError(code, message)`. That includes `operation_epoch_mismatch`.
- `src/remote-node-client.ts:318-326`:
  ```ts
  function isHelloStaleError(error: unknown): boolean {
    if (error instanceof TargetUnavailableError) {
      return /identity|protocol_mismatch|hello/i.test(error.message);
    }
    if (error instanceof RemoteNodeExecutionError) {
      return error.code === "protocol_mismatch" || error.code === "identity_mismatch";
    }
    return false;
  }
  ```
- `src/node-server.ts`, resumable branch, after the non-resumable early return:
  `if (body.nodeInstanceId !== nodeInstanceId) return fail(409, "operation_epoch_mismatch", …)`. This runs **before** any operation is created or executed. So on the *first* attempt of a call, an epoch mismatch proves the operation never ran on the current instance. After a transport-error reattach (`retry > 0`), the old instance may have run it, so the outcome is genuinely uncertain and must still fail closed.
- Existing test that must keep passing (`src/remote-node-client.test.ts:142-163`, the "restart-uncertain" case). The hello is OK, call #1 throws a transport error, the reattach gets `operation_epoch_mismatch`, and the test expects a rejection whose `name === "RemoteNodeExecutionError"` with `/instance changed.*result was uncertain/i`, and exactly 3 fetches.
- Existing "resumable bust" test (`:266-290`) simulates a restart with `protocol_mismatch` and expects a second hello whose fresh `nodeInstanceId` is used.
- Test conventions: one standalone script. It swaps `globalThis.fetch` with fakes, and its helpers `jsonResponse`, `resumableHello`, `successEnvelope`, `textResult` and `rejectWhenAborted` are defined at the bottom of `src/remote-node-client.test.ts`. New cases go in `{ … }` blocks inside the existing `try`, using the same pattern as the TTL and bust blocks.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Typecheck | `bun run typecheck` | exit 0 |
| Client test | `bunx tsx src/remote-node-client.test.ts` | exit 0 |
| Protocol tests | `bun run test:protocol` | exit 0 |
| All tests | `bun run test` | exit 0 (~65s; needs `tmux`) |
| Build | `bun run build:check` | exit 0 |

## Scope

**In scope**: `src/remote-node-client.ts`, `src/remote-node-client.test.ts`.

**Out of scope**:
- `src/node-server.ts`: the node's fail-closed behaviour is correct; do not change it.
- The non-resumable path's error wrapping (separate low-priority finding).
- The hello cache TTL value.

## Git workflow

- Branch: `advisor/012-gateway-hello-cache-staleness`
- Commit style: `fix(remote): refresh hello on first-attempt epoch mismatch and decouple shared hello from caller abort`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add failing tests

Add two blocks to `src/remote-node-client.test.ts`, next to the existing "Resumable path bust" block.

**A. Restart between calls recovers on the first attempt.**

```ts
{
  let helloCount = 0;
  const instanceA = "33333333-3333-4333-8333-333333333333";
  const instanceB = "44444444-4444-4444-8444-444444444444";
  let currentInstance = instanceA;
  const sentInstances: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/hello")) {
      helloCount += 1;
      return jsonResponse({ ...resumableHello(), nodeInstanceId: currentInstance });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sentInstances.push(String(body.nodeInstanceId));
    if (body.nodeInstanceId !== currentInstance) {
      return jsonResponse({ ok: false, error: { code: "operation_epoch_mismatch", message: "Remote node instance changed while the operation result was uncertain" } }, 409);
    }
    return jsonResponse(successEnvelope());
  }) as typeof fetch;
  const client = new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t" });
  await client.execute("read_file", { workspaceId: "w", path: "x" }, { requestId: "before-restart", signal: AbortSignal.timeout(1000) });
  currentInstance = instanceB; // node restarted; client's cached hello still says A
  const after = await client.execute("read_file", { workspaceId: "w", path: "x" }, { requestId: "after-restart", signal: AbortSignal.timeout(1000) });
  assert.equal(textResult(after), "ok");
  assert.equal(helloCount, 2, "epoch mismatch on first attempt refreshes hello once");
  assert.deepEqual(sentInstances, [instanceA, instanceA, instanceB]);
}
```

**B. One caller's abort does not fail a concurrent caller sharing the cold hello.**

```ts
{
  let releaseHello: (() => void) | undefined;
  const helloGate = new Promise<void>((resolve) => { releaseHello = resolve; });
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/hello")) {
      // Honour the request's abort signal like real fetch does (helper defined at the bottom of this file).
      await Promise.race([helloGate, rejectWhenAborted(init?.signal)]);
      return jsonResponse(resumableHello());
    }
    return jsonResponse(successEnvelope());
  }) as typeof fetch;
  const client = new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t" });
  const cancelled = new AbortController();
  const first = client.execute("read_file", { workspaceId: "w", path: "x" }, { requestId: "first", signal: cancelled.signal });
  const second = client.execute("read_file", { workspaceId: "w", path: "x" }, { requestId: "second", signal: AbortSignal.timeout(2000) });
  cancelled.abort(new Error("user cancelled"));
  await assert.rejects(first, /user cancelled/);
  releaseHello?.();
  assert.equal(textResult(await second), "ok");
}
```

**C. A caller that is already aborted on a cold cache must not leave an orphaned hello behind.** If it did, a failing hello would become an unhandled rejection and Node would exit the gateway process.

```ts
{
  globalThis.fetch = (async () => { throw new TypeError("node down"); }) as typeof fetch;
  const client = new RemoteNodeClient({ machineId: "m", url: "https://remote.test", nodeToken: "t", timeoutMs: 50 });
  const aborted = new AbortController();
  aborted.abort(new Error("already cancelled"));
  await assert.rejects(
    client.execute("read_file", { workspaceId: "w", path: "x" }, { requestId: "pre-aborted", signal: aborted.signal }),
    /already cancelled/,
  );
  // An unhandled rejection from an orphaned shared hello would terminate the script in this window.
  await new Promise((resolve) => setTimeout(resolve, 300));
}
```

**Verify**: `bunx tsx src/remote-node-client.test.ts` → exit 1. The first failure is in block A: `RemoteNodeExecutionError: Remote node instance changed while the operation result was uncertain` (`code: 'operation_epoch_mismatch'`). Blocks B and C are not reached in this run, because the script stops at its first failure. If the run exits 0, STOP.

### Step 2: Treat a first-attempt epoch mismatch as a stale hello

In `executeResumable`, immediately before `if (error instanceof RemoteNodeExecutionError) throw error;`, add:

```ts
if (retry === 0 && error instanceof RemoteNodeExecutionError && error.code === "operation_epoch_mismatch") {
  throw new RemoteNodeStaleHelloError("Remote node instance changed before the operation started");
}
```

Define the class next to the other error classes:

```ts
class RemoteNodeStaleHelloError extends TargetUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "RemoteNodeStaleHelloError";
  }
}
```

and make `isHelloStaleError` return `true` for `error instanceof RemoteNodeStaleHelloError`. Put that check first. The existing `execute()` catch then clears `helloCache` and retries once with a fresh hello and a **new** `remoteRequestId`. The second attempt is a brand-new operation, which is safe because the node proved the first one never started.

Note the router-visible effect: if a call hits a *second* first-attempt mismatch after the one bust retry (the node restarted twice in quick succession), the error now escapes as `RemoteNodeStaleHelloError`, a `TargetUnavailableError`. `src/gateway-router.ts` maps it to `target_unavailable` instead of rethrowing a `RemoteNodeExecutionError`. That is still fail-closed and more accurate; it is not a regression.

**Verify**: `bunx tsx src/remote-node-client.test.ts` → exit 1, now failing at block B with `Error: user cancelled` thrown by `await second`. Block A and the existing "restart-uncertain" case have passed by then (in "restart-uncertain" the mismatch arrives at `retry === 1`, so it still fails closed). If the failure is still in block A, or is in "restart-uncertain", STOP.

### Step 3: Decouple the shared hello from any single caller's signal

Change `cachedHello` so the shared request never uses a caller's signal, and each caller races the shared promise against its own:

```ts
private async cachedHello(signal: AbortSignal): Promise<NodeHello> {
  const now = Date.now();
  if (this.helloCache && now < this.helloCache.expiresAt) return this.helloCache.hello;
  if (signal.aborted) throw signal.reason ?? new Error("Remote node call cancelled");
  if (!this.helloInflight) {
    const inflight = this.hello(new AbortController().signal).then((h) => {
      this.helloCache = { hello: h, expiresAt: Date.now() + this.helloCacheTtlMs };
      return h;
    }).finally(() => { this.helloInflight = null; });
    inflight.catch(() => undefined); // the shared promise must never become an unhandled rejection; callers observe errors via raceAbort
    this.helloInflight = inflight;
  }
  return raceAbort(this.helloInflight, signal);
}
```

Two guards matter here. First, a caller whose signal is already aborted throws **before** a shared hello is created. Otherwise it would start a request that nothing awaits. Second, the `inflight.catch(() => undefined)` line means that even if every waiter aborts, a later hello failure is never an unhandled rejection. Under Node ≥24 an unhandled rejection terminates the gateway process. `hello()` still applies its own timeout through `withTimeout`, so the shared request stays bounded. Add a module-level helper:

```ts
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Remote node call cancelled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Remote node call cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
```

**Verify**: `bunx tsx src/remote-node-client.test.ts` → exit 0 (blocks A, B and C plus all existing cases). Run it 3 times; all three must exit 0.

### Step 4: Full gates

**Verify**:
- `bun run typecheck` → exit 0
- `bun run test:protocol` → exit 0
- `bun run test` → exit 0
- `bun run build:check` → exit 0

## Test plan

- Block A: a node restart between calls recovers transparently with exactly one extra hello.
- Block B: a cancelled caller does not poison a concurrent caller's shared hello.
- Block C: a pre-aborted caller on a cold cache does not orphan a failing hello (that would crash the process).
- Existing cases keep passing unchanged, especially "restart-uncertain" (a mismatch after a reattach still fails closed with 3 fetches) and the TTL and bust cases.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0
- [ ] `grep -n "RemoteNodeStaleHelloError" src/remote-node-client.ts` shows the class, the throw, and the `isHelloStaleError` check
- [ ] `grep -n "this.hello(signal)" src/remote-node-client.ts` returns no matches
- [ ] `grep -n "inflight.catch(() => undefined)" src/remote-node-client.ts` returns one match
- [ ] `git status --porcelain -- src` lists exactly `src/remote-node-client.test.ts` and `src/remote-node-client.ts` (or the committed equivalent)
- [ ] `plans/README.md` row for 012 updated

## STOP conditions

- The node server no longer checks `nodeInstanceId` **before** creating the operation (in `src/node-server.ts`, find `operation_epoch_mismatch` and confirm nothing executes before it). If the check moved after execution, the safety argument for Step 2 is void.
- The existing "restart-uncertain" test needs changing to pass. That would mean the fix weakened fail-closed behaviour.
- `withTimeout`/`hello()` no longer bound the hello with a timeout (then Step 3 could create an unbounded request).

## Maintenance notes

- Invariant: an `operation_epoch_mismatch` is retryable **only** when the gateway has not yet had a transport failure for that operation (`retry === 0`). Any future change to `executeResumable` retry accounting must keep that distinction. Reviewers should check that `retry` cannot be 0 after a reattach.
- The `retry === 0` invariant assumes that no intermediary (cloudflared or the Cloudflare edge) re-sends a `/internal/v1/call` body to a second node instance after the first instance accepted it. That is the existing exposure of the non-resumable path, not a new one.
- The shared hello is now owned by the client, not by a caller. It must always carry a no-op rejection handler. If hellos ever become expensive or long, consider an explicit `AbortController` owned by the client that `close()` aborts.
