# Plan 022: Align gateway and node payload limits, and keep `show_changes` deliverable

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 63d6d81..HEAD -- src/node-server.ts src/remote-node-client.ts src/review-checkpoints.ts src/node-server.test.ts src/remote-node-client.test.ts src/review-checkpoints.test.ts docs/gotchas.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Changes to `reviewChanges` and its
> test made by plan 021 (a third `git diff --name-status -z` call,
> `parseChangedFiles`, a new test block) are expected and are not a mismatch.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/021-show-changes-file-list.md (same function and test file; run 021 first)
- **Category**: bug
- **Planned at**: commit `63d6d81`, 2026-11-11

## Why this matters

A gateway forwards tool calls to executor nodes over HTTP. The public `/mcp`
endpoint and the gateway's node client both allow 4 MiB, but the node accepts
and returns only 1 MiB. Three things go wrong:

1. A `write_file` or `edit_file` between 1 and 4 MiB sent to a remote machine
   gets Express's HTML `413` page. The client cannot parse it, so the model is
   told "Target <machine> is unavailable." for a healthy node.
2. A `show_changes` diff over 1 MiB (one image or lockfile is enough, because
   the diff includes binary patches) is replaced by a `response_too_large`
   error **after** the review baseline was already advanced. The next
   `show_changes` says "No changes since last shown changes." The delta is
   lost.
3. `multi_read` can legitimately produce more than 1 MiB.

After this plan there is one limit shared by both sides, an oversized request
gets a JSON error the model can read, and `show_changes` always returns a
result that fits: the patch is cut at a file boundary and flagged, while the
file list and summary stay complete.

## Current state

Files:

- `src/node-server.ts` — the node's HTTP server (`createNodeServer`).
- `src/remote-node-client.ts` — the gateway's client for one node.
- `src/review-checkpoints.ts` — `reviewChanges` builds the `show_changes`
  result.
- `src/node-server.test.ts`, `src/remote-node-client.test.ts`,
  `src/review-checkpoints.test.ts` — existing suites, all in the `"test"`
  script.

The node's limit and middleware order (`src/node-server.ts:55-80`):

```ts
export function createNodeServer(config: NodeRoleConfig, executor: NodeExecutor, options: NodeServerOptions = {}) {
  const app = express();
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  …
  app.use(express.json({ limit: maxBodyBytes }));
  app.use((req, res, next) => {
    const provided = req.header("X-DevSpace-Node-Token") ?? "";
    …
    if (!expected || !constantTimeEqual(provided, expected)) {
      return res.status(401).json({ error: { code: "unauthorized", message: "Unauthorized" } });
    }
    next();
  });
```

The body is parsed **before** the bearer check, and there is no error handler,
so an oversized body gets Express's default HTML response.

The node's response cap (`src/node-server.ts:222-231`):

```ts
    const result = await executor.execute(tool, args, { requestId, signal });
    const envelope: NodeEnvelope = { ok: true, machineId, result };
    const body = JSON.stringify(envelope);
    if (Buffer.byteLength(body) > maxBodyBytes) {
      return jsonOutcome(500, {
        ok: false,
        error: { code: "response_too_large", message: "Executor response exceeds the configured limit" },
      });
    }
```

The client's limit (`src/remote-node-client.ts:8`, `:140`, `:324-326`):

```ts
const MAX_BODY_BYTES = 4 * 1024 * 1024;
…
      if (Buffer.byteLength(body) > this.maxBodyBytes()) throw new Error("Internal request is too large");
…
  private maxBodyBytes(): number {
    return this.config.maxBodyBytes ?? MAX_BODY_BYTES;
  }
```

How the client classifies a node reply (`src/remote-node-client.ts:234-242`):

```ts
    const envelope = await readBoundedJson<NodeCallEnvelope>(response, this.maxBodyBytes());
    if (!response.ok || !envelope.ok) {
      const code = !envelope.ok && envelope.error?.code ? envelope.error.code : "target_error";
      if (code === "protocol_mismatch" || code === "identity_mismatch" || code === "unauthorized" || code === "target_error") {
        throw new TargetUnavailableError(`Remote node call failed (${code})`);
      }
      const message = !envelope.ok && envelope.error?.message ? envelope.error.message.slice(0, 1024) : `Remote node call failed (${code})`;
      throw new RemoteNodeExecutionError(code, message);
    }
```

A JSON error body with its own `code` therefore already reaches the model as
that message. A non-JSON body makes `readBoundedJson` throw, which the caller
turns into `TargetUnavailableError`, and `src/gateway-router.ts:378-383`
turns that into "Target <machine> is unavailable."

The public limit (`src/server.ts:1832`):
`app.use("/mcp", express.json({ limit: DEFAULT_MAX_REQUEST_BODY_SIZE }));`
where the SDK constant is `4 * 1024 * 1024`. The node envelope wraps the tool
arguments in a few hundred bytes of metadata, so the node must accept slightly
more than 4 MiB.

`reviewChanges` at planning time (`src/review-checkpoints.ts:124-144`; plan 021
adds a `nameStatus` call and renames the parser, nothing else):

```ts
        const patch = (await git(root, ["diff", "--binary", "--no-color", baseline, current], {
          env,
          maxBuffer: 50 * 1024 * 1024,
        })).stdout;
        …
        const files = parseNumstat(numstat);
        const summary = summarizeFiles(files);

        if (markReviewed) await git(root, ["update-ref", state.baselineRef, current], { env });

        return {
          result: summary.files === 0
            ? `No changes since ${since === "workspace_open" ? "workspace open" : "last shown changes"}.`
            : `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`,
          summary,
          files,
          patch,
        };
```

`ReviewChangesResult` (`src/review-checkpoints.ts:22-27`) is `{ result,
summary, files, patch }`. The `show_changes` output schema is
`resultOutputSchema()` (`src/server.ts:1440`, defined at `:599-607`), which
requires only `result: string`, so an extra optional field in the structured
result is allowed. The gateway copies `patch` into the result twice
(`structuredContent.patch` and `_meta.card.payload.patch`,
`src/server.ts:945-947`), so a large patch is paid for twice on the way to the
MCP host. `createReviewCheckpointManager(stateDir: string)` has one production
caller, `src/executor.ts:63`, and two calls in its test.

**Trap — read this before choosing where the shared constant lives.**
`scripts/package-runtime-artifact.mjs:43` overwrites the built
`dist/build-metadata.js` with a hand-written module that exports only
`PROTOCOL_MAJOR`, `toolContractHash`, and `getBuildMetadata`. Anything else
exported from `src/build-metadata.ts` does not exist in the deployed artifact.
The new constant therefore goes in a **new** module, not in
`src/build-metadata.ts`.

Other constraints:

- `TOOL_CONTRACT_HASH` covers tool **input** fields only
  (`src/tool-contract.ts:65-89`). This plan changes no input field, so the
  hash does not change and gateway and nodes need not deploy together. An old
  node keeps its 1 MiB behavior until it is upgraded.
- Tests are standalone `tsx` scripts with `node:assert/strict`. Commit style
  is conventional commits, for example
  `fix(server): accept MCP request bodies up to the SDK limit`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install (in your worktree only) | `bun install --frozen-lockfile` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| One suite | `bunx tsx src/<name>.test.ts` | exit 0 |
| Protocol suites | `bun run test:protocol` | exit 0 |
| Full suite (about 65 s, needs `tmux`) | `bun run test` | exit 0 |

Do **not** run `bun test`, `bun run build`, `bun run rebuild:local`,
`bun run test:t3-live`, or `bun run test:t3-deployed`. Work in a separate git
worktree or clone: on the host Svartal the checkout
`/Users/rclair/projects/devspace` serves the production gateway from its
`dist/`, so never run `bun run build:check` or `bun install` there.

## Scope

**In scope** (the only files you should modify):

- `src/node-protocol.ts` (create)
- `src/node-server.ts`
- `src/remote-node-client.ts`
- `src/review-checkpoints.ts`
- `src/node-server.test.ts`
- `src/remote-node-client.test.ts`
- `src/review-checkpoints.test.ts`
- `docs/gotchas.md` (one short entry)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):

- `src/build-metadata.ts` and `scripts/package-runtime-artifact.mjs` — see the
  trap above.
- `src/tool-contract.ts`, `TOOL_CONTRACT_HASH`, and the `show_changes` input
  schema.
- The `/mcp` body limit in `src/server.ts` and the duplicate patch copy in the
  gateway result (backlog F09).
- Remote call deadlines and abort handling for `show_changes` (finding G11).
- The 50 MiB `maxBuffer` on the `git diff` calls.
- `src/executor.ts` — the manager's new option has a default, so its one
  production call site stays as it is.

## Git workflow

- Branch: `advisor/022-node-payload-limits`, created from the integration
  branch `advisor/audit-2026-11-11` after plan 021 has merged into it.
- One commit per step; message style
  `fix(node): share one payload limit and answer oversized requests in JSON`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: One shared limit

Create `src/node-protocol.ts`:

```ts
/**
 * Largest JSON body the gateway and a node exchange, in either direction. The public /mcp
 * endpoint accepts 4 MiB; the node envelope wraps the tool arguments in a little metadata,
 * so the internal limit leaves headroom above that.
 */
export const NODE_MAX_BODY_BYTES = 4 * 1024 * 1024 + 64 * 1024;
```

- `src/remote-node-client.ts`: delete `const MAX_BODY_BYTES = 4 * 1024 * 1024;`,
  import `NODE_MAX_BODY_BYTES` from `./node-protocol.js`, and return
  `this.config.maxBodyBytes ?? NODE_MAX_BODY_BYTES` from `maxBodyBytes()`.
- `src/node-server.ts`: import the constant and change the default to
  `options.maxBodyBytes ?? NODE_MAX_BODY_BYTES`.

**Verify**: `bun run typecheck` → exit 0.
`grep -n "1024 \* 1024" src/node-server.ts src/remote-node-client.ts` → no matches.
`bun run test:protocol` → exit 0.

### Step 2: Authenticate before parsing, and answer oversized requests in JSON

In `src/node-server.ts`:

1. Move the `app.use(express.json({ limit: maxBodyBytes }));` line so it comes
   **after** the bearer-check middleware. The check reads only a header.
2. Directly after the moved `express.json` line, add an error handler:

   ```ts
   app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
     const type = typeof error === "object" && error !== null ? (error as { type?: unknown }).type : undefined;
     if (type === "entity.too.large") {
       return sendOutcome(res, jsonOutcome(413, {
         ok: false,
         error: { code: "request_too_large", message: "Request exceeds the node's size limit; send less content per call" },
       }));
     }
     if (type === "entity.parse.failed") {
       return sendOutcome(res, jsonOutcome(400, { ok: false, error: { code: "invalid_request", message: "Invalid JSON body" } }));
     }
     next(error);
   });
   ```

   Import `NextFunction` as a type from `express` alongside the existing
   `Request` and `Response` imports.

In `src/node-server.test.ts`, before the final `server.close` line, add a
second server with a small limit and these checks (reuse `config`, `executor`,
`valid`, and the header pattern already in the file):

```ts
// Payload limits: JSON errors, and no body parsing before authentication.
const small = createNodeServer(config, {
  async execute() { return { content: [{ type: "text", text: "y".repeat(4096) }] }; },
}, { allowedTools: ["read_file"], maxBodyBytes: 1024 });
const smallServer = small.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => smallServer.once("listening", () => resolve()));
const smallAddress = smallServer.address();
assert.ok(smallAddress && typeof smallAddress !== "string");
const smallCall = (body: unknown, token = "secret-token") => fetch(`http://127.0.0.1:${smallAddress.port}/internal/v1/call`, {
  method: "POST",
  headers: { "content-type": "application/json", "X-DevSpace-Node-Token": token },
  body: JSON.stringify(body),
});
const oversized = { ...valid, requestId: "too-large", arguments: { workspaceId: "w", path: "p".repeat(4096) } };
const tooLarge = await smallCall(oversized);
assert.equal(tooLarge.status, 413);
assert.equal(((await tooLarge.json()) as { error?: { code?: string } }).error?.code, "request_too_large");
assert.equal((await smallCall(oversized, "wrong-token")).status, 401, "an oversized body from an unauthenticated caller is not parsed");
const bigAnswer = await smallCall({ ...valid, requestId: "big-answer" });
assert.equal(bigAnswer.status, 500);
assert.equal(((await bigAnswer.json()) as { error?: { code?: string } }).error?.code, "response_too_large");
await new Promise<void>((resolve) => smallServer.close(() => resolve()));
```

Confirm the two new failure assertions can fail: before making changes 1 and 2
of this step, the `413` body is HTML, so `tooLarge.json()` throws.

In `src/remote-node-client.test.ts`, following the file's existing pattern of
replacing `globalThis.fetch` (hello on `/hello`, a canned response otherwise),
add a case in which the call endpoint answers status `413` with the JSON body
`{ ok: false, error: { code: "request_too_large", message: "Request exceeds the node's size limit; send less content per call" } }`.
Assert that `execute("write_file", …)` rejects with an error whose `message`
matches `/size limit/` and whose `name` is **not** `TargetUnavailableError`.

**Verify**:

- `bunx tsx src/node-server.test.ts` → exit 0
- `bunx tsx src/remote-node-client.test.ts` → exit 0

### Step 3: Bound the `show_changes` patch at a file boundary

In `src/review-checkpoints.ts`:

1. Add near the other constants:

   ```ts
   /** Largest patch `show_changes` returns. The file list and summary are always complete. */
   const DEFAULT_MAX_PATCH_BYTES = 1_000_000;
   ```

2. Add and export a pure helper:

   ```ts
   /** Keeps whole per-file diffs, in order, until the next one would exceed `maxBytes`. */
   export function boundPatch(patch: string, maxBytes: number): { patch: string; omittedFiles: number } {
     if (Buffer.byteLength(patch) <= maxBytes) return { patch, omittedFiles: 0 };
     const sections = patch.split(/^(?=diff --git )/m);
     let kept = "";
     let size = 0;
     let index = 0;
     for (; index < sections.length; index += 1) {
       const bytes = Buffer.byteLength(sections[index] ?? "");
       if (size + bytes > maxBytes) break;
       kept += sections[index];
       size += bytes;
     }
     return { patch: kept, omittedFiles: sections.length - index };
   }
   ```

3. Change the factory signature to
   `createReviewCheckpointManager(stateDir: string, options: { maxPatchBytes?: number } = {})`
   and read `const maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;`
   at the top of the function.
4. Add `patchTruncated?: boolean;` to `ReviewChangesResult`.
5. In `reviewChanges`, after `summary` is computed, add
   `const bounded = boundPatch(patch, maxPatchBytes);` and build the return
   value from it:

   ```ts
        const changed = `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`;
        const truncation = bounded.omittedFiles > 0
          ? ` The patch is truncated: ${bounded.omittedFiles} file ${bounded.omittedFiles === 1 ? "diff is" : "diffs are"} omitted because of size; the file list is complete, so read those files directly.`
          : "";
        return {
          result: summary.files === 0
            ? `No changes since ${since === "workspace_open" ? "workspace open" : "last shown changes"}.`
            : `${changed}${truncation}`,
          summary,
          files,
          patch: bounded.patch,
          ...(bounded.omittedFiles > 0 ? { patchTruncated: true } : {}),
        };
   ```

   Leave the `update-ref` line where it is: the result is now always
   deliverable, so advancing the baseline is correct.

In `src/review-checkpoints.test.ts`, import `boundPatch` and add at the end of
the inner `try` block (before its `finally`):

```ts
    // boundPatch keeps whole file diffs and reports what it dropped.
    const twoFiles = "diff --git a/a.txt b/a.txt\n+a\ndiff --git a/b.txt b/b.txt\n+b\n";
    assert.deepEqual(boundPatch(twoFiles, 10_000), { patch: twoFiles, omittedFiles: 0 });
    assert.deepEqual(boundPatch(twoFiles, 40), { patch: "diff --git a/a.txt b/a.txt\n+a\n", omittedFiles: 1 });
    assert.deepEqual(boundPatch(twoFiles, 5), { patch: "", omittedFiles: 2 });

    // An oversized patch is truncated, flagged, and still advances the baseline.
    const boundedManager = createReviewCheckpointManager(stateDir, { maxPatchBytes: 300 });
    await boundedManager.initializeWorkspace({ workspaceId: "ws_bounded", root });
    await writeFile(join(root, "big-one.txt"), `${"one\n".repeat(60)}`);
    await writeFile(join(root, "big-two.txt"), `${"two\n".repeat(60)}`);
    const boundedReview = await boundedManager.reviewChanges({ workspaceId: "ws_bounded", root });
    assert.equal(boundedReview.patchTruncated, true);
    assert.equal(boundedReview.files.length, 2, "the file list stays complete");
    assert.ok(Buffer.byteLength(boundedReview.patch) <= 300);
    assert.match(boundedReview.result, /patch is truncated/);
    assert.equal((await boundedManager.reviewChanges({ workspaceId: "ws_bounded", root })).summary.files, 0);
    await boundedManager.removeWorkspace({ workspaceId: "ws_bounded" });
```

If plan 021's test block left other untracked files in `root`, the count of
`2` above will be higher: assert on the two `big-*.txt` paths being present
in `boundedReview.files` instead of on the length.

**Verify**:

- `bun run typecheck` → exit 0
- `bunx tsx src/review-checkpoints.test.ts` → exit 0

### Step 4: Record the limits

Add an entry to `docs/gotchas.md` (match the file's existing heading style):
gateway and nodes share one internal payload limit, slightly above the 4 MiB
`/mcp` limit; an oversized request to a node returns `request_too_large`;
`show_changes` returns at most about 1 MB of patch, flags `patchTruncated`,
and always returns the complete file list.

**Verify**: `grep -n "patchTruncated" docs/gotchas.md` → one match.
`bun run test` → exit 0.

## Test plan

- `src/node-server.test.ts`: oversized request → `413` with JSON code
  `request_too_large`; oversized request with a wrong token → `401`; oversized
  response → `500` with `response_too_large`.
- `src/remote-node-client.test.ts`: a `413` JSON reply surfaces as a readable
  error, not as target-unavailable.
- `src/review-checkpoints.test.ts`: `boundPatch` unit cases; a truncated review
  keeps the full file list, is flagged, and advances the baseline.
- Verification: `bun run test` → exit 0.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0
- [ ] `grep -rn "NODE_MAX_BODY_BYTES" src --include='*.ts' | grep -v test` shows the definition plus uses in `src/node-server.ts` and `src/remote-node-client.ts`
- [ ] `grep -n "1024 \* 1024" src/node-server.ts src/remote-node-client.ts` returns no matches
- [ ] `git diff --stat 63d6d81..HEAD -- src/build-metadata.ts src/tool-contract.ts scripts` prints nothing
- [ ] `git status --short` lists only in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts
  (other than plan 021's expected changes).
- Plan 021 has not landed on the branch you started from (`grep -n
  "parseChangedFiles" src/review-checkpoints.ts` returns nothing).
- Moving `express.json` after the bearer check makes an existing assertion in
  `src/node-server.test.ts` fail.
- You are tempted to add an export to `src/build-metadata.ts`.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Nodes pick up the larger limit only when they are upgraded; the gateway
  works with old and new nodes. Deploy the node after the gateway to get the
  full benefit.
- `multi_read` with a caller-raised `maxTotalBytes` can still exceed the
  limit; it then fails with `response_too_large`, which is truthful and loses
  no state.
- A diff larger than the 50 MiB `maxBuffer` still fails before the baseline
  moves, so it fails the same way on every call. Not addressed here.
- The 1 MB patch budget is paid twice in the gateway's result (backlog F09).
  If that duplication is removed, the budget can be reconsidered.
- Reviewer focus: the middleware order in `createNodeServer`, and that the
  truncation message reaches the model through `result`.
