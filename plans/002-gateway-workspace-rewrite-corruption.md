# Plan 002: Fix gateway deep workspaceId rewrite that corrupts arbitrary content

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ee85288..HEAD -- src/gateway-router.ts src/server.ts src/gateway-router.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug (also security-adjacent: data integrity)
- **Planned at**: commit `ee85288`, 2026-08-28
- **Issue**: —

## Why this matters

`GatewayExecutionRouter` rewrites private executor `workspaceId` to public `gw_*` ID via a recursive `value.split(privateId).join(publicId)` over the entire `ExecutorResult`. That means any file content, grep output, diff/patch (up to 50 MB), or shell log that happens to contain the random private ID substring is silently mutated. `read_file` content is no longer byte-identical to disk, `grep` results corrupt, and `show_changes` patches break. The same naive split is used on error messages. Fixing it restores integrity and closes the substring-replacement attack surface while preserving the privacy requirement (private IDs must not leak to the caller).

## Current state

- Relevant files:
  - `src/gateway-router.ts` — `rewriteValue`/`rewriteExecutorWorkspaceId` (lines 401-418) and call sites (lines 158,161,331,350)
  - `src/server.ts` — embeds gateway result into card payload `publicExecutorResult` (lines 895-959) and activity logging
  - `src/gateway-router.test.ts` — existing leak tests for workspaceId mapping

- Excerpts (`src/gateway-router.ts:409-418`):
  ```ts
  function rewriteValue(value: unknown, privateId: string, publicId: string): unknown {
    if (typeof value === "string") return value.split(privateId).join(publicId);
    if (Array.isArray(value)) return value.map((item) => rewriteValue(item, privateId, publicId));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, rewriteValue(item, privateId, publicId)]),
      );
    }
    return value;
  }
  ```

- Excerpts (`src/gateway-router.ts:148-162` error path):
  ```ts
  const message = error instanceof Error ? error.message : String(error);
  if (/Unknown workspaceId:|Workspace is not active:/.test(message)) {
    this.bindings.delete(publicWorkspaceId);
    this.scheduleActivityCleanup(publicWorkspaceId);
    throw new GatewayRoutingError(
      "unknown_workspace",
      `Unknown workspaceId: ${publicWorkspaceId}. Call open_workspace first.`,
      { cause: error },
    );
  }
  throw new Error(message.split(binding.executorWorkspaceId).join(publicWorkspaceId));
  ```

- Excerpts (`src/gateway-router.ts:161,331,350` happy paths):
  ```ts
  const rewrittenResult = rewriteExecutorWorkspaceId(result, binding.executorWorkspaceId, publicWorkspaceId);
  // and in openWorkspace:
  ? rewriteExecutorWorkspaceId(result, executorWorkspaceId, "")
  : result,
  // ...
  const rewritten = rewriteExecutorWorkspaceId(result, executorWorkspaceId, publicWorkspaceId);
  ```

- Impact today: any `ToolResponse.content[*].text` or `structuredContent` field containing the private ID is rewritten. For `show_changes` the patch string is inside `result.details.patch` and inside `structuredContent`, and can be 50 MB (`src/review-checkpoints.ts:124-131`), causing 2x memory copy and corruption of diff content that coincidentally contains the UUID substring.

- Repo conventions:
  - `ToolResponse` shape: `src/pi-tools.ts` exports type; `publicExecutorResult` in `src/server.ts:895-959` projects `structuredContent` into card.
  - Tests use `node:assert/strict` with `tsx` runner; see `src/gateway-router.test.ts:1-100` for binding setup and `rewriteExecutorWorkspaceId` leak assertion.
  - Gateway bindings: `src/gateway-workspace-store.ts` persists `publicWorkspaceId`/`executorWorkspaceId`/`machineId`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `npm run typecheck` | exit 0 |
| Gateway tests | `npx tsx src/gateway-router.test.ts` | all pass |
| Server gateway results test | `npx tsx src/server-gateway-results.test.ts` | all pass |
| Full suite | `npm test` | all pass (modulo known terminal flake) |

## Suggested executor toolkit

- No new dependencies.
- For leak verification, reuse `gateway-workspace-store` in-memory store pattern from `src/gateway-router.test.ts`.

## Scope

**In scope** (the only files you should modify):
- `src/gateway-router.ts`
- `src/gateway-router.test.ts` (extend)

**Out of scope** (do NOT touch, even though they look related):
- `src/server.ts` — `publicExecutorResult` projection stays; do not alter card/payload shape
- `src/executor.ts` — workspace operation counter is separate plan
- `src/workspace-store.ts` / `src/gateway-workspace-store.ts` — binding persistence unchanged
- Any change to the public_workspaceId generation (`gw_${randomUUID()}`) — stability required

## Git workflow

- Branch: `advisor/002-gateway-rewrite`
- Commit per step; message style: `fix: ...`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add failing tests for content corruption and leak

In `src/gateway-router.test.ts`, add tests (model after existing binding setup that creates `GatewayExecutionRouter` with a fake `ExecutionTarget`):

- Test "does not corrupt file content containing private id substring": create a fake target whose `execute` returns `{ content:[{type:"text", text:`hello ${privateId} world`}], structuredContent:{}, isError:false }` via `read_file`; call `router.execute("read_file", {workspaceId:publicId, path:"x.txt"}, {requestId:"r1", signal:AbortSignal.timeout(1000)})`; assert returned `content[0].text` still contains the private substring? Actually assert it is **not** rewritten: the file content must remain `hello ${privateId} world` (byte-identical), not replaced with publicId. Currently this test will FAIL because `rewriteValue` does replace it.
- Test "does not rewrite patch/diff fields": return a result where `details.patch = "diff contains ${privateId} as code"` and assert patch unchanged except `workspaceId` fields.
- Test "rewrites only workspaceId fields and leaks no private id": return `structuredContent:{workspaceId: privateId, root:"/tmp", canonicalRoot:"/tmp"}`; assert rewritten `structuredContent.workspaceId === publicId` and no privateId appears in JSON serialization of the entire rewritten result when privateId is not in a workspaceId field (but content already covered).
- Test "error message rewrite preserves integrity": make target throw `Error("something with ${privateId} and Unknown workspaceId: ${privateId}")` and assert the gateway maps to `unknown_workspace` without leaking privateId in the new message's file-content portion.

Use existing assertion helpers; keep tests isolated per `node:test` subtest.

**Verify**: `npx tsx src/gateway-router.test.ts` → new tests fail before fix (content corruption case), existing tests still pass.

### Step 2: Replace deep split/join with field-targeted rewrite

Edit `src/gateway-router.ts:401-418` to:

- Remove generic `value.split(privateId).join(publicId)` recursion.
- Implement `rewriteExecutorWorkspaceId` that only rewrites **known workspaceId locations**:
  - Top-level `structuredContent.workspaceId` if it equals `privateId` (exact match, not substring)
  - `result.content` fields must NOT be rewritten at all (file content is authoritative and should not be mutated).
  - Error message rewrite at line 158 should only rewrite when the message contains the exact token `privateId` as an isolated token (or simply remap to known publicId message; see step 3).
  - Additionally handle `structuredContent.workspace?.workspaceId` inside `close_workspace` result if present, and `publicExecutorResult` already copies `publicWorkspaceId` separately.
  - Any other field that is literally `privateId` (exact string equality) may be rewritten, but not substrings.

Minimal change sketch:
```ts
function rewriteValue(value: unknown, privateId: string, publicId: string): unknown {
  if (value === privateId) return publicId;
  if (typeof value === "string") return value; // no substring replacement
  if (Array.isArray(value)) return value.map((item) => rewriteValue(item, privateId, publicId));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // WorkspaceId keys are the only ones that carry the private ID.
      if ((k === "workspaceId" || k === "executorWorkspaceId") && v === privateId) out[k] = publicId;
      else if (k === "workspace" && v && typeof v === "object") out[k] = rewriteValue(v, privateId, publicId);
      else if (k === "terminal" || k === "terminals") out[k] = v; // terminals carry no workspaceId to leak; avoid deep walk
      else out[k] = rewriteValue(v, privateId, publicId);
    }
    return out;
  }
  return value;
}
```
Tighten further based on actual `ToolResponse` shape: the only places privateId appears are `structuredContent.workspaceId`, `structuredContent.workspace.workspaceId` (close), and possibly `content` text only when the executor itself embeds workspaceId in human text (e.g., `Opened workspace ${id}`). For the human text case, allow exact equality check on the whole message? Better to leave content text untouched and let the human text show private? No — human text leaked privateId must be sanitized but without substring damage. Policy: if `content` text equals or contains `workspace <privateId>` as a token, rewrite that token using word-boundary regex limited to that pattern, not global split. Implement `rewriteContentText(text: string)` that does `text.replaceAll(privateId, publicId)` ONLY if the text matches the known opener pattern `Opened workspace ${privateId}` or `Workspace ${privateId}`. Otherwise leave text alone (caller's file content is not an opener). The safest Migration is: never rewrite `content` text at all; opener text is already rewritten via `structuredContent` and UI uses structured; the human text leak of privateId in opener is acceptable to fix by exact replacement of the opener string only.

Simplify for this plan: **do not rewrite `content` text strings at all**. Only rewrite exact-match strings in `structuredContent` and top-level `workspaceId` fields. This guarantees no content corruption and privateId leakage is limited to the opener human text which is low-risk and can be handled by the caller's `open_workspace` path at line 350 which already rewrites the whole result. Since we stop rewriting `content`, the file content leak of privateId disappears (privateId was never in file content unless the file itself contained it, which must not be mutated). For the opener case, the opener's `content` text contains `Opened workspace ${privateId}` — we can handle that by rewriting `content` only when it starts with `Opened workspace ` or `Workspace ` + privateId, using a constrained replace.

Document the rationale in a comment above `rewriteValue`.

Also fix error path `158`: change `message.split(privateId).join(publicId)` to only rewrite if message is exactly `Unknown workspaceId: ${privateId}...` or simply throw the generic `Unknown workspaceId: ${publicId}` without echoing the privateId-derived message. Replace with `throw new GatewayRoutingError("unknown_workspace", \`Unknown workspaceId: ${publicWorkspaceId}. Call open_workspace first.\`, {cause:error})` when the cause matches the workspaceId pattern; otherwise rethrow with `message` but without substring replacement (or with word-boundary replacement). Simplest: drop the substring join and just `throw error` or `throw new Error(message)` without rewrite — the privateId is not useful to the client.

**Verify**: `npx tsx src/gateway-router.test.ts` → all new tests pass (content not corrupted, workspaceId correctly mapped).

### Step 3: Tighten openWorkspace rewrite to not blank content

In `src/gateway-router.ts:328-335` the error case rewrites with `publicId=""`. Ensure that branch also uses field-targeted logic, so blank publicId does not erase substrings in error content. With new exact-match logic, passing `""` will only blank exact `workspaceId` fields, not substrings in messages.

**Verify**: `npx tsx src/gateway-router.test.ts` → still pass; `npx tsx src/server-gateway-results.test.ts` → pass (server projection unchanged).

### Step 4: Ensure performance and leak test for large payload

Add a test or manual check that a 1 MB patch string containing no privateId is returned without copying per-character overhead and without mutation. Not a perf benchmark, just correctness: construct a 1 MB `details.patch` with repeated `a` and assert `rewritten.details.patch === original` (object identity not required, but string equality).

**Verify**: `npm run typecheck` → exit 0.

## Test plan

- New tests in `src/gateway-router.test.ts`:
  - File content with private substring not rewritten
  - Patch/diff with private substring not rewritten
  - `structuredContent.workspaceId` exact rewrite
  - `close_workspace` structuredContent.workspace.workspaceId exact rewrite
  - Error path: unknown workspace translated without leaking private substring
  - Large patch unchanged
- Existing tests: all pass. Pattern file: existing `gateway-router.test.ts` already tests happy open/execute and unknown workspace routing.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npx tsx src/gateway-router.test.ts` exits 0 and includes the new content-corruption tests passing
- [ ] `npx tsx src/server-gateway-results.test.ts` exits 0
- [ ] `grep -rn "split(privateId\|split(binding.executorWorkspaceId" src/gateway-router.ts` returns no matches
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 002 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `src/gateway-router.ts:409-418` or `148-162` doesn't match the excerpts.
- `ExecutorResult` shape changed (e.g., `structuredContent.workspaceId` moved) — the field list in the rewrite must be updated to match the new shape.
- Fixing the rewrite causes an existing leak test to fail (privateId leaked via `structuredContent` or `content` opener) — keep mapping for `workspaceId` fields, adjust scope to include any newly discovered leak field.
- Any caller outside `gateway-router.ts` depends on substring replacement in `content` (search for `rewriteExecutorWorkspaceId` imports).

## Maintenance notes

For the human/agent who owns this code after the change lands:

- If a new tool adds a `workspaceId` field outside `structuredContent` (e.g., `structuredContent.sessionId`), add it to the allowlist in `rewriteValue`.
- When `multi_read` per-file activity is promoted, ensure its per-file `operationId` generation does not embed private IDs; public IDs are the external contract.
- Reviewer should scrutinize that no privateId leaks via `publicExecutorResult` card payload (`src/server.ts:926-952`); card already uses `publicWorkspaceId`, so leak test should cover card projection indirectly.
- Future optimization: replace deep recursion with explicit field rewrites for known keys to avoid O(payload size) walk on large patches; current fix already avoids copying large patch strings because their keys are skipped.
