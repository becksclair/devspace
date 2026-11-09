# Plan 007: Make multi_read return whole files up to its byte limit and report truncation truthfully

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 97e507c..HEAD -- src/executor.ts src/executor-multi-read.test.ts`
> Plan 006 is expected to have changed the end of `multiRead()` in `src/executor.ts`
> (it adds `result: text` to `structuredContent`). Any *other* change in the
> excerpted regions below is drift: treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: plans/006-multi-read-mcp-output-schema.md (same function; land 006 first)
- **Category**: bug
- **Planned at**: commit `97e507c`, 2026-11-04

## Why this matters

`multi_read` advertises a per-file byte limit (`maxBytesPerFile`, default
256,000) and a `truncated` flag per file. In reality, any file **at or below**
that limit is read through the Pi `read` tool, which silently cuts output at
2000 lines or 50 KB (it appends a "[Showing lines … Use offset=… to continue.]"
note), and multi_read then reports `truncated: false`. So an 80 KB, 3000-line
source file comes back as 2000 lines and the model believes it saw the whole
file, then edits it. Separately, the pre-flight byte budget reserves the full
per-file limit for entries that use `offset`/`limit` and for paths that do not
exist, so valid later files get skipped with `total_limit_exceeded` even when
the real output is tiny.

## Current state

- `src/executor.ts` `multiRead()` (starts near line 392).
  - Pre-flight budget, `src/executor.ts:410-421`:
    ```ts
    const preSkipped = new Map<number, { code: string; message: string }>();
    {
      let estTotal = 0;
      for (let idx = 0; idx < input.reads.length; idx++) {
        const sz = statSizes[idx];
        const est = sz !== null ? Math.min(sz, maxBytesPerFile) : maxBytesPerFile;
        if (estTotal + est > maxTotalBytes) {
          preSkipped.set(idx, { code: "total_limit_exceeded", message: `Total bytes limit ${maxTotalBytes} exceeded (pre-flight)` });
          continue;
        }
        estTotal += est;
      }
    }
    ```
  - Raw "fast path", used **only** when the file is larger than the limit, `src/executor.ts:442-455`:
    ```ts
    const sz = statSizes[idx];
    if (sz !== null && sz > maxBytesPerFile && entry.offset === undefined && entry.limit === undefined) {
      let fh: FileHandle | null = null;
      try {
        fh = await open(readPath.absolutePath, "r");
        const buf = Buffer.allocUnsafe(maxBytesPerFile + 1024);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const text = buf.subarray(0, bytesRead).toString("utf8");
        const { content, truncated, bytes } = truncateUtf8Safe(text, maxBytesPerFile);
        // Preserve truncation flag from the fast path; second truncation below must not re-derive it.
        rawByIdx.set(idx, { entry, readPath, status: "ok" as const, text: content, truncated, bytes, t0 });
        return;
      } catch {} finally { if (fh) try { await fh.close(); } catch {} }
    }
    ```
  - Slow path via Pi, `src/executor.ts:456-468`; the Pi result's `details` (which carries `truncation`) is discarded:
    ```ts
    const result = await readFileTool(
      { path: readPath.absolutePath, offset: entry.offset, limit: entry.limit },
      { cwd: workspace.root, root: workspace.canonicalRoot, readRoots: readPath.readRoots },
      options.signal,
      `${options.requestId}:${entry.path}:${idx}`,
    );
    if (result.isError) { ... status: "error" ... return; }
    const text = result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
    rawByIdx.set(idx, { entry, readPath, status: "ok" as const, text, t0 });
    ```
  - Result assembly, `src/executor.ts:505-516`: if the raw entry carries `truncated`/`bytes` it is used as-is; otherwise `truncateUtf8Safe(raw.text, maxBytesPerFile)` re-derives `truncated` **against 256 KB**, which is why Pi's 50 KB cut is reported as `truncated: false`.
- `src/pi-tools.ts` `readFileTool` returns `{ content, details }`; for text reads Pi sets `details = { truncation }` when it truncates, where `truncation.truncated === true` (`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js` around lines 217-247; limits `DEFAULT_MAX_LINES = 2000`, `DEFAULT_MAX_BYTES = 50 * 1024` in `.../tools/truncate.js:10-11`). For small un-truncated text files Pi's output equals the raw file text, so the raw path is a faithful replacement.
- Pi's read tool also handles images (returns an image block plus "Read image file [...]" text). multi_read already discards image blocks (it keeps only text), so images have never been useful through multi_read.
- `truncateUtf8Safe(input, maxBytes)` is at `src/executor.ts:20-36`; reuse it.
- Tests: `src/executor-multi-read.test.ts` drives `LocalExecutor` directly (pattern: `loadConfig({...})`, `new LocalExecutor({ config })`, `executor.execute("multi_read", {...}, { requestId, signal: AbortSignal.timeout(5000) })`). New cases go **before** the final `console.log("all executor-multi-read checks passed");` line, inside the inner `try`.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Typecheck | `bun run typecheck` | exit 0 |
| Unit test | `bunx tsx src/executor-multi-read.test.ts` | prints `all executor-multi-read checks passed`, exit 0 |
| MCP test  | `bunx tsx src/server-multi-read.test.ts` | exit 0 (created by plan 006) |
| All tests | `bun run test` | exit 0 (~65s; needs `tmux`) |
| Build     | `bun run build:check` | exit 0 |

## Scope

**In scope**:
- `src/executor.ts` — `multiRead()` only
- `src/executor-multi-read.test.ts`

**Out of scope**:
- `src/tool-contract.ts` and the multi_read input/output schemas in `src/server.ts` — no new fields; the contract hash must not change.
- `read_file` (single-file tool) behaviour — it intentionally keeps Pi's 50 KB/2000-line paging.
- Remote node / gateway response-size limits (separate finding, not this plan).

## Git workflow

- Branch: `advisor/007-multi-read-truthful-truncation`
- Commit style: `fix(executor): read whole files up to maxBytesPerFile in multi_read`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add failing tests

Append these cases to `src/executor-multi-read.test.ts` (before the final `console.log`). Use a fresh `requestId` per call.

1. **Mid-size file is returned whole.** Write `mid.txt` = `Array.from({ length: 3000 }, (_, i) => \`line ${i} ${"y".repeat(20)}\`).join("\n") + "\n"` (91,890 bytes, 3000 lines). `multi_read` it with defaults. Assert `status === "ok"`, `truncated === false`, `bytes === Buffer.byteLength(<that string>)`, and `content` equals the written string.
2. **Pi truncation on a sliced read is reported.** `multi_read` `{ path: "mid.txt", offset: 1 }` (offset only, no limit). Assert `status === "ok"` and `truncated === true` (Pi caps at 2000 lines).
3. **Binary files are rejected explicitly.** Write `img.png` = `Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])`. Assert `status === "error"` and `error.code === "binary_file"`.
4. **Sliced reads do not reserve the full limit.** Write five files `big0.txt`…`big4.txt`, each `"z\n".repeat(150 * 1024)` (300 KB). `multi_read` all five with `{ offset: 1, limit: 10 }` and `maxTotalBytes: 1_000_000`. Assert all five are `status === "ok"`.
5. **Missing paths do not reserve the full limit.** `multi_read` `reads` = ten missing paths followed by `{ path: "mid.txt" }`, with `maxTotalBytes: 300_000`. Assert the last result is `status === "ok"`.

**Verify**: `bunx tsx src/executor-multi-read.test.ts` → **fails** (case 1 should fail first with a content/bytes mismatch). If all five pass before your change, STOP.

### Step 2: Use the bounded raw read for every un-sliced entry, with binary detection

In the per-file loop, change the fast-path condition so it applies to every entry without `offset`/`limit` whose size is known, regardless of size:

```ts
if (sz !== null && entry.offset === undefined && entry.limit === undefined) {
```

Inside that block, after `fh.read(...)`, detect binary content before decoding:

```ts
const head = buf.subarray(0, Math.min(bytesRead, 8192));
if (head.includes(0)) {
  rawByIdx.set(idx, { entry, readPath, status: "error" as const, error: { code: "binary_file", message: "Binary file; multi_read returns text only. Use read_file for images." }, t0 });
  return;
}
```

Keep the existing `truncateUtf8Safe` call, the `truncated`/`bytes` fields, the `catch {}` fallback to the Pi path, and the `finally` close. Replace the inline comment on the `rawByIdx.set` line (`// Preserve truncation flag from the fast path; …`) with `// Default path for whole-file reads: bounded raw read; truncated/bytes here are authoritative and must not be re-derived in the assembly loop.` Keep the buffer at `maxBytesPerFile + 1024`. Do not shrink it to the stat size: a file that grows between stat and read would then come back partial with `truncated: false`.

**Verify**: `bunx tsx src/executor-multi-read.test.ts` → exits non-zero at **case 2** (the `truncated === true` assertion). The script stops at its first failure, so this is expected. All pre-existing cases and case 1 pass before it. A failure anywhere earlier than case 2 is a STOP condition.

### Step 3: Propagate Pi's truncation on the sliced path

On the Pi path, read the truncation flag from `result.details` and carry it into the raw entry:

```ts
const piTruncated = (result.details as { truncation?: { truncated?: boolean } } | undefined)?.truncation?.truncated === true;
const text = result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
const t = truncateUtf8Safe(text, maxBytesPerFile);
rawByIdx.set(idx, { entry, readPath, status: "ok" as const, text: t.content, truncated: t.truncated || piTruncated, bytes: t.bytes, t0 });
```

(The `rawByIdx` value type already allows optional `truncated` and `bytes` on `ok` entries.)

**Verify**: `bunx tsx src/executor-multi-read.test.ts` → exits non-zero at **case 4**: the fourth and fifth `big*.txt` return `total_limit_exceeded`, because the pre-flight is not fixed yet. Cases 1–3 and all pre-existing cases pass before it, including the sliced `large2.txt` case, which asserts `truncated === false`. A failure earlier than case 4 is a STOP condition.

### Step 4: Make the pre-flight estimate reflect what will be read

Replace the estimate line with:

```ts
const entry = input.reads[idx];
const sliced = entry?.offset !== undefined || entry?.limit !== undefined;
const est = sz !== null && !sliced ? Math.min(sz, maxBytesPerFile) : 0;
```

Sliced and unstat-able entries are still bounded by the existing post-read check (`totalBytes + bytes > maxTotalBytes` in the assembly loop), so the overall budget remains enforced.

**Verify**: `bunx tsx src/executor-multi-read.test.ts` → all cases pass, prints `all executor-multi-read checks passed`.

### Step 5: Full gates

**Verify**:
- `bun run typecheck` → exit 0
- `bunx tsx src/server-multi-read.test.ts` → exit 0
- `bun run test` → exit 0
- `bun run build:check` → exit 0

## Test plan

Five new cases in `src/executor-multi-read.test.ts` (Step 1): whole mid-size file, Pi truncation reported on sliced reads, binary rejection, sliced pre-flight, missing-path pre-flight. Existing cases (small, large fast-path, exact-size, plus-one, UTF-8 boundary, sliced large file) must keep passing unchanged.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0
- [ ] `grep -n "sz > maxBytesPerFile" src/executor.ts` returns no matches
- [ ] `grep -n "binary_file" src/executor.ts` returns one match
- [ ] `git status --porcelain -- src package.json` prints exactly ` M src/executor-multi-read.test.ts` and ` M src/executor.ts` (or the committed equivalent)
- [ ] `plans/README.md` row for 007 updated

## STOP conditions

- Plan 006 has not landed (`grep -n "result: text" src/executor.ts` finds nothing) — land 006 first.
- Step 1 tests all pass before any change.
- An existing multi_read test case fails after Step 2 and the expected value would have to change (that would mean the raw path is not equivalent to Pi output for that case — report it).
- Pi's `readFileTool` result no longer exposes `details.truncation` (check `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js`).

## Maintenance notes

- multi_read now deliberately differs from `read_file`: whole files up to `maxBytesPerFile` versus Pi's 50 KB/2000-line pages. Document this if a tool reference is written.
- The binary check is a NUL-byte heuristic over the first 8 KB; UTF-16 text files will be reported as binary. Acceptable for a code workspace; revisit if users hit it.
- Remote nodes cap responses at 1 MiB (`src/node-server.ts:57`) while multi_read's default total is 1,000,000 raw bytes; JSON escaping can push a near-limit batch over the node cap. That mismatch is a separate audit finding, not fixed here.
