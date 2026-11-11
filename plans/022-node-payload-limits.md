# Plan 022: Align gateway and node payload limits, and make `show_changes` deliver large diffs in pieces

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
- **Effort**: M (Steps 1–2 are S; Step 3 is the larger part)
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
result that fits. A large diff is delivered over several calls: each call
returns the per-file diffs that fit, and the review baseline advances **only
for the files whose diffs were returned**, so nothing is lost and the next
call returns the rest.

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

A JSON error body with its own `code` therefore reaches the model as that
message on the resumable path. The non-resumable path, used for a node whose
hello does not advertise `resumableCalls`, wraps **every** error
(`src/remote-node-client.ts:143-153`):

```ts
        if (!resumable) {
          try {
            return await this.withTimeout(
              options.signal,
              (boundedSignal) => this.callOnce(body, boundedSignal),
              remoteToolTimeoutMs(tool, args, this.config.timeoutMs),
            );
          } catch (error) {
            throw normalizeTargetError(error, options.signal, "Remote node call failed");
          }
        }
```

`normalizeTargetError` (`:336-340`) turns anything that is not already a
`TargetUnavailableError` into one, so on that path a node's JSON error would
still read as "unavailable". A non-JSON body makes `readBoundedJson` throw, which the caller
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

In `src/remote-node-client.ts`, in the non-resumable `catch` shown in "Current
state", keep a node's own error instead of wrapping it:

```ts
          } catch (error) {
            // A node's own JSON error (for example request_too_large) is not unavailability.
            if (error instanceof RemoteNodeExecutionError) throw error;
            throw normalizeTargetError(error, options.signal, "Remote node call failed");
          }
```

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
add **two** cases in which the call endpoint answers status `413` with the JSON
body
`{ ok: false, error: { code: "request_too_large", message: "Request exceeds the node's size limit; send less content per call" } }`:

1. with the resumable hello (`jsonResponse(resumableHello())`);
2. with a legacy hello that has no `resumableCalls` and no `nodeInstanceId`
   (copy the hello object from the existing "legacy node" case at lines
   122-140 of the file).

In both, assert that `execute("write_file", { workspaceId: "w", path: "x",
content: "y" }, …)` rejects with an error whose `message` matches
`/size limit/` and whose `name` is **not** `TargetUnavailableError`. Case 2
fails before the `catch` change above.

**Verify**:

- `bunx tsx src/node-server.test.ts` → exit 0
- `bunx tsx src/remote-node-client.test.ts` → exit 0

### Step 3: Deliver large diffs in pieces, and advance the baseline only for what was delivered

Design (decided; do not substitute another):

- Sizes are measured **as serialized JSON** (`JSON.stringify`), because that is
  what the node's response limit measures. Escaping can make a patch larger
  than its raw byte count.
- The patch is split into per-file sections. `git diff` emits them in the same
  order as the file list, so section `i` belongs to `files[i]`.
- Each file gets one of three outcomes, decided in order:
  - `included` — its diff fits in the remaining patch budget and is returned.
  - `deferred` — it does not fit now; a later call returns it.
  - `too-large` — its diff alone exceeds the whole patch budget, so no call
    could ever return it.
- The file list is bounded too. Files beyond the list budget are not listed in
  this response and are `deferred`.
- With `markReviewed` (the default) and `since: "last_shown"` (the default):
  - nothing deferred → the baseline moves to the current snapshot, as today;
  - something deferred → the baseline moves **only for the `included` and
    `too-large` files**. It becomes a commit equal to the old baseline with
    just those files at their current state. The deferred files stay pending
    and the next call returns them.
- With `since: "workspace_open"` and something deferred, the last-shown
  baseline is not moved at all. That view has no cursor to page with, and
  leaving the baseline alone loses nothing.
- A `too-large` file is the one case where the baseline moves past a diff that
  was not returned. It is unavoidable (holding the baseline would return the
  same oversized diff forever), so it is stated in the result text and marked
  on the file entry.
- The first file is always listed and is never `deferred`, so every call makes
  progress.

In `src/review-checkpoints.ts`:

1. Add near the other constants:

   ```ts
   /** Budgets for one `show_changes` result, measured as serialized JSON. */
   const DEFAULT_MAX_PATCH_BYTES = 1_000_000;
   const DEFAULT_MAX_FILE_LIST_BYTES = 1_000_000;
   ```

2. Extend the result types:

   ```ts
   export type PatchOmission = "deferred" | "too-large";
   ```

   Add `patchOmitted?: PatchOmission;` to `ReviewFile`, and add
   `patchTruncated?: boolean;`, `pendingFiles?: number;`, and
   `filesTruncated?: boolean;` to `ReviewChangesResult`. All four are present
   only when they apply, so a result that fits is byte-for-byte what it is
   today.

3. Add and export the pure planner:

   ```ts
   /** Size of a value as it travels: JSON-escaped, which is what the node's response limit measures. */
   function serializedBytes(value: unknown): number {
     return Buffer.byteLength(JSON.stringify(value));
   }

   /**
    * Decides, per changed file and in order, whether its diff is returned now ("included"),
    * returned by a later call ("deferred"), or can never be returned because it alone exceeds the
    * patch budget ("too-large"). `listed` is how many leading files fit in the file list; the
    * rest are deferred. The first file is always listed, so every call makes progress.
    */
   export function planDelivery(
     sections: string[],
     files: ReviewFile[],
     limits: { maxPatchBytes: number; maxFileListBytes: number },
   ): { states: Array<"included" | PatchOmission>; listed: number } {
     const states: Array<"included" | PatchOmission> = [];
     let patchBytes = 0;
     let listBytes = 0;
     let listed = 0;
     for (let index = 0; index < files.length; index += 1) {
       // 64 bytes of headroom per entry covers the `patchOmitted` field and separators.
       const entryBytes = serializedBytes(files[index]) + 64;
       if (listed !== index || (listed > 0 && listBytes + entryBytes > limits.maxFileListBytes)) {
         states.push("deferred");
         continue;
       }
       listed += 1;
       listBytes += entryBytes;
       const size = serializedBytes(sections[index] ?? "");
       if (size > limits.maxPatchBytes) states.push("too-large");
       else if (patchBytes + size <= limits.maxPatchBytes) {
         states.push("included");
         patchBytes += size;
       } else states.push("deferred");
     }
     return { states, listed };
   }
   ```

4. Add the partial-baseline helper next to `createWorkingTreeSnapshot`, which
   it is modeled on (temporary index, same environment):

   ```ts
   /** A commit equal to `baseline` except that the given files are at their `current` state. */
   async function createPartialBaseline(
     state: WorkspaceReviewState,
     baseline: string,
     current: string,
     advanced: ReviewFile[],
   ): Promise<string> {
     const tempDir = await mkdtemp(join(tmpdir(), "devspace-review-index-"));
     const pathspecFile = join(tempDir, "paths");
     const env = {
       ...reviewEnv(state),
       ...checkpointIdentity(),
       GIT_INDEX_FILE: join(tempDir, "index"),
       GIT_LITERAL_PATHSPECS: "1",
     };
     try {
       const paths = advanced.flatMap((file) => (file.previousPath ? [file.previousPath, file.path] : [file.path]));
       await writeFile(pathspecFile, paths.map((path) => `${path}\0`).join(""));
       await git(state.root, ["read-tree", baseline], { env });
       await git(state.root, ["reset", "-q", current, `--pathspec-from-file=${pathspecFile}`, "--pathspec-file-nul"], { env });
       const tree = (await git(state.root, ["write-tree"], { env })).stdout.trim();
       return (await git(state.root, ["commit-tree", tree, "-p", baseline, "-m", "DevSpace partial review baseline"], { env })).stdout.trim();
     } finally {
       await rm(tempDir, { recursive: true, force: true });
     }
   }
   ```

   `git reset <commit> --pathspec-from-file` with a temporary `GIT_INDEX_FILE`
   only rewrites index entries; it does not touch the working tree. A renamed
   file needs both its old and its new path. The option needs git 2.26 or
   newer.

5. Change the factory signature to
   `createReviewCheckpointManager(stateDir: string, options: { maxPatchBytes?: number; maxFileListBytes?: number } = {})`
   and read both values, with the defaults above, at the top of the function.

6. In `reviewChanges`, replace everything from the line
   `if (markReviewed) await git(root, ["update-ref", state.baselineRef, current], { env });`
   to the end of the `return { … };` statement with:

   ```ts
        const sections = patch.length === 0 ? [] : patch.split(/^(?=diff --git )/m);
        if (sections.length !== files.length) {
          throw new Error(`show_changes could not match ${sections.length} diff sections to ${files.length} changed files.`);
        }
        const { states, listed } = planDelivery(sections, files, { maxPatchBytes, maxFileListBytes });
        const deferred = states.filter((entry) => entry === "deferred").length;
        const tooLarge = states.filter((entry) => entry === "too-large").length;

        if (markReviewed) {
          if (deferred === 0) {
            await git(root, ["update-ref", state.baselineRef, current], { env });
          } else if (since !== "workspace_open") {
            // Advance only for the files this result accounts for; the rest stay pending.
            const advanced = files.filter((_file, index) => states[index] !== "deferred");
            const partial = await createPartialBaseline(state, baseline, current, advanced);
            await git(root, ["update-ref", state.baselineRef, partial], { env });
          }
        }

        const notes: string[] = [];
        if (deferred > 0) {
          notes.push(since === "workspace_open"
            ? `${deferred} more file ${deferred === 1 ? "diff does" : "diffs do"} not fit in this overview`
            : `${deferred} more file ${deferred === 1 ? "diff" : "diffs"} will be returned by the next show_changes call`);
        }
        if (tooLarge > 0) {
          notes.push(`${tooLarge} file ${tooLarge === 1 ? "diff is" : "diffs are"} too large to return and ${tooLarge === 1 ? "is" : "are"} marked in the file list`);
        }
        const changed = `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`;
        return {
          result: summary.files === 0
            ? `No changes since ${since === "workspace_open" ? "workspace open" : "last shown changes"}.`
            : `${changed}${notes.length > 0 ? ` Not every diff is included: ${notes.join("; ")}.` : ""}`,
          summary,
          files: files.slice(0, listed).map((file, index) => {
            const outcome = states[index];
            return outcome === undefined || outcome === "included" ? file : { ...file, patchOmitted: outcome };
          }),
          patch: sections.filter((_section, index) => states[index] === "included").join(""),
          ...(deferred > 0 || tooLarge > 0 ? { patchTruncated: true } : {}),
          ...(deferred > 0 ? { pendingFiles: deferred } : {}),
          ...(listed < files.length ? { filesTruncated: true } : {}),
        };
   ```

   `summary` stays computed over **all** changed files, so the result line
   always states the full pending change.

In `src/review-checkpoints.test.ts`, import `planDelivery` and add at the end
of the inner `try` block (before its `finally`):

```ts
    // planDelivery: serialized sizes, in order, and always some progress.
    const entry = (path: string) => ({ path, type: "change" as const, additions: 1, removals: 0 });
    const section = "diff --git a/x b/x\n+x\n"; // 26 bytes once serialized
    const roomy = { maxPatchBytes: 10_000, maxFileListBytes: 10_000 };
    assert.deepEqual(planDelivery([section, section], [entry("a"), entry("b")], roomy), { states: ["included", "included"], listed: 2 });
    assert.deepEqual(planDelivery([section, section], [entry("a"), entry("b")], { ...roomy, maxPatchBytes: 30 }).states, ["included", "deferred"]);
    assert.deepEqual(planDelivery([section, section], [entry("a"), entry("b")], { ...roomy, maxPatchBytes: 10 }).states, ["too-large", "too-large"]);
    assert.deepEqual(planDelivery([section, section], [entry("a"), entry("b")], { ...roomy, maxFileListBytes: 1 }), { states: ["included", "deferred"], listed: 1 });

    // A diff that does not fit is delivered over several calls; nothing is skipped or repeated.
    const pagedManager = createReviewCheckpointManager(stateDir, { maxPatchBytes: 1500 });
    await pagedManager.initializeWorkspace({ workspaceId: "ws_paged", root });
    const segments = ["seg-a", "seg-b", "seg-c"];
    for (const name of segments) {
      await writeFile(join(root, `${name}.txt`), `${Array.from({ length: 30 }, (_value, index) => `payload ${name} ${index}`).join("\n")}\n`);
    }
    await writeFile(join(root, "huge.txt"), `${Array.from({ length: 400 }, (_value, index) => `huge line ${index}`).join("\n")}\n`);
    const overview = await pagedManager.reviewChanges({ workspaceId: "ws_paged", root, since: "workspace_open" });
    assert.equal(overview.patchTruncated, true);
    assert.equal(overview.summary.files, 4, "the summary always covers every changed file");
    const timesInPatch = new Map<string, number>(segments.map((name) => [name, 0]));
    const tooLarge = new Set<string>();
    let pages = 0;
    for (;;) {
      const page = await pagedManager.reviewChanges({ workspaceId: "ws_paged", root });
      if (page.summary.files === 0) break;
      pages += 1;
      assert.ok(pages <= 6, "paging terminates");
      if (pages === 1) assert.equal(page.summary.files, 4, "a truncated overview does not consume the baseline");
      assert.ok(Buffer.byteLength(JSON.stringify(page.patch)) <= 1500, "the serialized patch stays within its budget");
      assert.equal(page.patch.includes("b/huge.txt"), false);
      for (const name of segments) if (page.patch.includes(`b/${name}.txt`)) timesInPatch.set(name, (timesInPatch.get(name) ?? 0) + 1);
      for (const file of page.files) if (file.patchOmitted === "too-large") tooLarge.add(file.path);
    }
    assert.ok(pages >= 2, "the diff needed more than one call");
    assert.deepEqual([...timesInPatch.values()], [1, 1, 1], "each deferred diff is returned exactly once");
    assert.deepEqual([...tooLarge], ["huge.txt"]);
    await pagedManager.removeWorkspace({ workspaceId: "ws_paged" });

    // The file list is bounded too, and files beyond it are deferred, not lost.
    const listedManager = createReviewCheckpointManager(stateDir, { maxFileListBytes: 200 });
    await listedManager.initializeWorkspace({ workspaceId: "ws_listed", root });
    const listedNames = ["list-a.txt", "list-b.txt", "list-c.txt"];
    for (const name of listedNames) await writeFile(join(root, name), `${name}\n`);
    const firstListed = await listedManager.reviewChanges({ workspaceId: "ws_listed", root });
    assert.equal(firstListed.filesTruncated, true);
    assert.equal(firstListed.summary.files, 3);
    assert.ok(firstListed.files.length < 3);
    const delivered = [...firstListed.files.map((file) => file.path)];
    for (let call = 0; call < 6; call += 1) {
      const next = await listedManager.reviewChanges({ workspaceId: "ws_listed", root });
      if (next.summary.files === 0) break;
      delivered.push(...next.files.map((file) => file.path));
    }
    assert.deepEqual(delivered.sort(), listedNames);
    await listedManager.removeWorkspace({ workspaceId: "ws_listed" });
```

Confirm the paging test can fail: with `createPartialBaseline` replaced by a
plain advance to `current`, `timesInPatch` contains a `0`.

**Verify**:

- `bun run typecheck` → exit 0
- `bunx tsx src/review-checkpoints.test.ts` → exit 0

### Step 4: Record the limits

Add an entry to `docs/gotchas.md` (match the file's existing heading style):
gateway and nodes share one internal payload limit, slightly above the 4 MiB
`/mcp` limit; an oversized request to a node returns `request_too_large`;
`show_changes` returns at most about 1 MB of patch and 1 MB of file list per
call, sets `patchTruncated` and `pendingFiles` when diffs remain, and returns
the rest on the next call; a single file whose diff alone exceeds the budget
is marked `patchOmitted: "too-large"` and is not returned.

**Verify**: `grep -n "patchTruncated" docs/gotchas.md` → one match.
`bun run test` → exit 0.

## Test plan

- `src/node-server.test.ts`: oversized request → `413` with JSON code
  `request_too_large`; oversized request with a wrong token → `401`; oversized
  response → `500` with `response_too_large`.
- `src/remote-node-client.test.ts`: a `413` JSON reply surfaces as a readable
  error, not as target-unavailable, on both the resumable and the legacy
  (non-resumable) path.
- `src/review-checkpoints.test.ts`: `planDelivery` unit cases; a diff larger
  than the patch budget is returned over several calls with every deferred
  diff delivered exactly once and the oversized one marked; a truncated
  `workspace_open` overview does not consume the baseline; a bounded file list
  defers, and later delivers, the files beyond it.
- Verification: `bun run test` → exit 0.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0
- [ ] `grep -rn "NODE_MAX_BODY_BYTES" src --include='*.ts' | grep -v test` shows the definition plus uses in `src/node-server.ts` and `src/remote-node-client.ts`
- [ ] `grep -n "1024 \* 1024" src/node-server.ts src/remote-node-client.ts` returns no matches
- [ ] `grep -c "createPartialBaseline" src/review-checkpoints.ts` prints `2` (definition and one call)
- [ ] `git diff --stat "$(git merge-base HEAD advisor/audit-2026-11-11)"..HEAD -- src/build-metadata.ts src/tool-contract.ts scripts` prints nothing (the merge base is the commit your plan branch started from, so work merged by other plans is not counted)
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
- An existing assertion in `src/remote-node-client.test.ts` expects a node's
  JSON error on the legacy path to be reported as unavailable. Report it; do
  not rewrite it.
- `reviewChanges` throws `could not match … diff sections` in any test. The
  design relies on one diff section per listed file; do not work around a
  mismatch by guessing.
- `git reset … --pathspec-from-file` is rejected by the installed git
  (`git --version` older than 2.26).
- You are tempted to add an export to `src/build-metadata.ts`.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Nodes pick up the larger limit only when they are upgraded; the gateway
  works with old and new nodes. Deploy the node after the gateway to get the
  full benefit.
- The worst-case `show_changes` result is about 2 MB serialized (patch budget
  plus file-list budget), well under the node limit. If either budget is
  raised, keep their sum below `NODE_MAX_BODY_BYTES`.
- `multi_read` with a caller-raised `maxTotalBytes` can still exceed the node
  limit; it then fails with `response_too_large`, which is truthful and loses
  no state.
- A `too-large` diff is never returned by `show_changes`; the model has to
  inspect that file another way. That is the one deliberate case where the
  baseline moves past an unreturned diff.
- A `workspace_open` overview that does not fit is truncated on every call; it
  has no cursor. Paging happens through the default `last_shown` view.
- A diff larger than the 50 MiB `maxBuffer` still fails before the baseline
  moves, so it fails the same way on every call. Not addressed here.
- The patch is paid for twice in the gateway's result (backlog F09). If that
  duplication is removed, the budgets can be reconsidered.
- Reviewer focus: the middleware order in `createNodeServer`; that
  `createPartialBaseline` receives both paths of a rename; and that the
  baseline never moves for a `deferred` file.
