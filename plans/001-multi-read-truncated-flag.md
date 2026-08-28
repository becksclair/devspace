# Plan 001: Fix multi_read truncated flag loss on large-file fast path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ee85288..HEAD -- src/executor.ts src/executor-maintenance.test.ts src/executor.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ee85288`, 2026-08-28
- **Issue**: —

## Why this matters

`multi_read` has a fast path for files larger than `maxBytesPerFile` (256 kB default) that reads `maxBytesPerFile+1024` bytes via `open/read` and then truncates with `truncateUtf8Safe`. The large-file branch discards the `truncated`/`bytes` return values and later re-truncates already-cut content, so the result always reports `truncated:false` with an under-counted `bytes`. Callers therefore assume they saw the full file and may generate duplicate or overlapping edits on the unseen tail. The single-file `read_file` tool reports truncation correctly; `multi_read` diverges.

## Current state

- Relevant files:
  - `src/executor.ts` — `LocalExecutor.multiRead` and helper `truncateUtf8Safe` (lines 20-33, 390-508)
  - `src/tool-contract.ts` — defines `multi_read` schema with `maxBytesPerFile` / `maxTotalBytes`
  - No existing test covers `multi_read` truncation; `src/tool-contract.test.ts` only checks schema parse rejection.

- Excerpts as of `ee85288` (`src/executor.ts:20-33`):
  ```ts
  function truncateUtf8Safe(input: string, maxBytes: number): { content: string; truncated: boolean; bytes: number } {
    const total = Buffer.byteLength(input, "utf8");
    if (total <= maxBytes) return { content: input, truncated: false, bytes: total };
    let acc = 0;
    let end = 0;
    for (const ch of input) {
      const b = Buffer.byteLength(ch, "utf8");
      if (acc + b > maxBytes) break;
      acc += b;
      end += ch.length;
    }
    const content = input.slice(0, end);
    return { content, truncated: true, bytes: acc };
  }
  ```

- Excerpts (`src/executor.ts:427-441` fast path):
  ```ts
  if (sz !== null && sz > maxBytesPerFile && entry.offset === undefined && entry.limit === undefined) {
    let fh: any = null;
    try {
      fh = await open(readPath.absolutePath, "r");
      const buf = Buffer.alloc(maxBytesPerFile + 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      let text = buf.subarray(0, bytesRead).toString("utf8");
      const { content } = truncateUtf8Safe(text, maxBytesPerFile);
      rawByIdx.set(idx, { entry, readPath, status: "ok" as const, text: content, t0 });
      return;
    } catch {} finally { if (fh) try { await fh.close(); } catch {} }
  }
  ```

- Excerpts (`src/executor.ts:485-493` second truncation that erases flag):
  ```ts
  const { content, truncated, bytes } = truncateUtf8Safe(raw.text, maxBytesPerFile);
  if (totalBytes + bytes > maxTotalBytes) {
    results.push({ path: raw.entry.path, status: "error", error: { code: "total_limit_exceeded", message: `Total bytes limit ${maxTotalBytes} exceeded` } });
    this.logToolExecution("read_file", { workspaceId: input.workspaceId, path: raw.entry.path }, false, t0, "total_limit_exceeded");
    continue;
  }
  totalBytes += bytes;
  if (raw.readPath) this.workspaces.markReadPathLoaded(workspace, raw.readPath as any);
  results.push({ path: raw.entry.path, canonicalPath: (raw.readPath as { absolutePath: string }).absolutePath, status: "ok", content, truncated, bytes });
  ```

- Behavior today: when `sz > maxBytesPerFile` the first `truncateUtf8Safe` sets `truncated:true` but only `content` is stored. The second `truncateUtf8Safe(raw.text, ...)` sees `Buffer.byteLength(content) <= maxBytesPerFile` and returns `truncated:false`, so the pushed result lies.

- Repo conventions:
  - Error handling follows `ToolResponse` with `isError`/`content`/`structuredContent`; see `src/pi-tools.ts:55-71` and `src/executor.ts:80-106`.
  - Tests use `node:test` + `assert/strict` + `tsx` runner; see `src/executor-root-policy.test.ts:1-60` for workspace/executor test shape with `mkdtemp` + `createShellRuntime`.
  - `npm test` is a single chain of `tsx` invocations; keep it green.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `npm run typecheck` | exit 0, no errors |
| Single file test | `npx tsx src/executor.test.ts` (new file) | all pass |
| Existing contract test | `npx tsx src/tool-contract.test.ts` | all pass |
| Full suite | `npm test` | all pass (or terminal-manager flake noted separately) |

## Suggested executor toolkit

- Use existing `truncateUtf8Safe` helper; do not add a new truncation primitive.
- Model new test after `src/executor-root-policy.test.ts` for temp workspace setup.

## Scope

**In scope** (the only files you should modify):
- `src/executor.ts`
- `src/executor-multi-read.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):
- `src/tool-contract.ts` — schema unchanged
- `src/gateway-router.ts` — per-file activity fan-out for `multi_read` is separate concern
- `src/pi-tools.ts` — readFileTool single-file path already correct
- Any change to public response shape (fields `truncated`/`bytes` already exist; this only fixes their values)

## Git workflow

- Branch: `advisor/001-multi-read-truncated-flag`
- Commit per step; message style: conventional `fix: ...` as in `git log --oneline` (`fix(typecheck): ...`, `fix: ...`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add reproduction test for truncated flag

Create `src/executor-multi-read.test.ts` that:
- Creates a temp workspace (use helpers from `src/workspaces.test.ts:11` `mkdtemp` + `WorkspaceRegistry` or directly test `LocalExecutor.multiRead` with a stubbed `WorkspaceRegistry`).
- Simpler: reuse `LocalExecutor` with real filesystem like `src/executor-root-policy.test.ts:8` does: create temp Dir, create 3 files: `small.txt` (<10k), `large.txt` (>300k, e.g. `a`.repeat(300*1024)), `missing.txt` absent.
- Calls `executor.execute("multi_read", { workspaceId, reads: [{path:"small.txt"}, {path:"large.txt"}, {path:"missing.txt"}], maxBytesPerFile: 256_000, maxTotalBytes: 1_000_000 }, {requestId:"test01", signal: AbortSignal.timeout(5000)})`.
- Asserts: `results[1].truncated === true`, `results[1].bytes === 256000` or close (allow utf8 boundary), `results[0].truncated === false`, `results[2].status === "error"`, `totalBytes` equals sum of ok bytes, `isError === false` (partial success).
- Use `assert.equal` / `assert.ok` from `node:assert/strict`.

**Verify**: `npx tsx src/executor-multi-read.test.ts` → fails (shows `truncated:false` for large file) before fix; keep test.

### Step 2: Fix fast-path to propagate truncated flag

In `src/executor.ts:427-435` change:
```ts
const { content } = truncateUtf8Safe(text, maxBytesPerFile);
rawByIdx.set(idx, { entry, readPath, status: "ok" as const, text: content, t0 });
```
to:
```ts
const { content, truncated, bytes } = truncateUtf8Safe(text, maxBytesPerFile);
// Preserve truncation flag from the fast path; second truncation below must not re-derive it.
rawByIdx.set(idx, { entry, readPath, status: "ok" as const, text: content, truncated, bytes, t0 });
```

Then adjust the consumer loop (`src/executor.ts:484-493`) to honor stored values when present:
```ts
let content: string;
let truncated: boolean;
let bytes: number;
if (typeof (raw as any).truncated === "boolean" && typeof (raw as any).bytes === "number") {
  content = raw.text;
  truncated = (raw as any).truncated;
  bytes = (raw as any).bytes;
} else {
  const t = truncateUtf8Safe(raw.text, maxBytesPerFile);
  content = t.content; truncated = t.truncated; bytes = t.bytes;
}
```
And use those variables in the `totalBytes` check and `results.push`.

Prefer typing `rawByIdx` as `Map<number, {entry, readPath?, status:"ok", text:string, truncated?:boolean, bytes?:number, t0:number} | {entry, status:"error", error, t0}>` to avoid `any`.

Keep UTF-8 safety: `truncateUtf8Safe` already slices by `Buffer.byteLength` on codepoints, so char-boundary handling is preserved.

**Verify**: `npx tsx src/executor-multi-read.test.ts` → passes (large file `truncated:true`, `bytes` == maxBytesPerFile within 4 bytes).

### Step 3: Cover edge cases in same test file

Add cases:
- File exactly `maxBytesPerFile` bytes → `truncated:false`, `bytes == maxBytesPerFile`.
- File `maxBytesPerFile + 1` byte → `truncated:true`.
- Multi-byte UTF-8 at boundary (e.g., file of `é` 2-byte chars straddling cut) → `truncated:true` and `Buffer.byteLength(content) <= maxBytesPerFile` and content is valid UTF-8 (no half char).
- `offset/limit` on large file should NOT use fast path (current guard checks `entry.offset===undefined && entry.limit===undefined`); verify sliced read returns correct `truncated` (likely false if slice fits).

**Verify**: `npx tsx src/executor-multi-read.test.ts` → all cases pass.

### Step 4: Wire test into suite and typecheck

Add the new file to `package.json:34` `test` script chain: append `&& tsx src/executor-multi-read.test.ts` at end (keep ordering; insert before final entry).

**Verify**: `npm run typecheck` → exit 0. `npx tsx src/executor-multi-read.test.ts` → pass. Full `npm test` (skipping known terminal-manager flake) → this file passes.

## Test plan

- New file `src/executor-multi-read.test.ts` covering:
  - Happy path under cap (3 files mixed) — partial success `isError:false`
  - Per-file truncation flag propagation (large file) — the regression this plan fixes
  - Exact-limit boundary
  - UTF-8 boundary
  - `offset/limit` bypass of fast path
  - `total_limit` pre-flight vs mid-flight (two large files where second exceeds `maxTotalBytes` → `total_limit_exceeded`)
- Pattern: `src/executor-root-policy.test.ts` for workspace/executor scaffolding; `src/tool-contract.test.ts` for assertion style.
- Verification: `npx tsx src/executor-multi-read.test.ts` → all pass, including `truncated:false` no longer misreported.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npx tsx src/executor-multi-read.test.ts` exits 0 and asserts `truncated:true` for the `large.txt` fast-path case
- [ ] `grep -rn "const { content } = truncateUtf8Safe" src/executor.ts` returns no matches (old discard pattern removed)
- [ ] No files outside the in-scope list are modified (`git status` shows only `src/executor.ts`, `src/executor-multi-read.test.ts`, `package.json`, `plans/README.md`)
- [ ] `plans/README.md` status row for 001 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `src/executor.ts:427-435` or `485-493` doesn't match the excerpts (the codebase has drifted since this plan was written).
- `truncateUtf8Safe` signature changed (e.g., now returns additional fields) — re-derive fix.
- Adding the test requires importing a helper that doesn't exist (`createShellRuntime`, `WorkspaceRegistry`); inspect `src/workspaces.test.ts` for alternative helpers before inventing.
- `npm run typecheck` fails on `rawByIdx` typing — adjust generic, don't cast to `any` across the file.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- If `maxBytesPerFile` defaults change in `src/tool-contract.ts`, the fast-path `maxBytesPerFile+1024` read-ahead size at line 431 should scale proportionally.
- When `multi_read` per-file `truncateUtf8Safe` is extracted to a shared `ReadBatchLimiter` (future tech-debt plan), ensure the stored `truncated/bytes` propagation moves with it; the second truncation is the canonical place for `totalBytes` accounting.
- Reviewer should scrutinize that the fix doesn't widen `maptotalBytes` accounting to include truncated bytes beyond `maxBytesPerFile` (it must stay `bytes` after truncation, not raw read size).
- Follow-up explicitly deferred: removing the pre-flight `estTotal` estimate when `offset/limit` is present (separate correctness finding CORRECTNESS-07); keep this plan focused on truncated flag only.
