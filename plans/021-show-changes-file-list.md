# Plan 021: Make `show_changes` report renames and file types truthfully

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 63d6d81..HEAD -- src/review-checkpoints.ts src/review-checkpoints.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (Plan 017 may have changed
> `src/git.ts`; that does not affect this plan.)

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `63d6d81`, 2026-11-11

## Why this matters

`show_changes` returns a file list and a summary line that the model and the
review card rely on. Both are wrong in common cases. A renamed file corrupts
the list: its entry is dropped, the next file's statistics are swallowed, and
a bogus entry appears whose path contains tab characters. Independently, the
file type is guessed from line counts, so an edit that only adds lines is
labelled `new` and an edit that only removes lines is labelled `deleted`. After
this plan, each changed file appears once with the type git itself reports.

## Current state

Files:

- `src/review-checkpoints.ts` — review snapshots and `reviewChanges`; contains
  `parseNumstat` and `fileType` (lines 271–303).
- `src/review-checkpoints.test.ts` — standalone `tsx` test, already in the
  `"test"` script.

How the list is produced (`src/review-checkpoints.ts:124-133`):

```ts
        const patch = (await git(root, ["diff", "--binary", "--no-color", baseline, current], {
          env,
          maxBuffer: 50 * 1024 * 1024,
        })).stdout;
        const numstat = (await git(root, ["diff", "--numstat", "-z", baseline, current], {
          env,
          maxBuffer: 50 * 1024 * 1024,
        })).stdout;
        const files = parseNumstat(numstat);
        const summary = summarizeFiles(files);
```

The parser and the type guess (`src/review-checkpoints.ts:271-303`):

```ts
function parseNumstat(output: string): ReviewFile[] {
  const fields = output.split("\0").filter((field) => field.length > 0);
  const files: ReviewFile[] = [];
  for (let index = 0; index < fields.length;) {
    const header = fields[index++] ?? "";
    const parts = header.split("\t");
    const additions = parseStatNumber(parts[0]);
    const removals = parseStatNumber(parts[1]);
    if (parts.length >= 3) {
      const path = parts[2] ?? "";
      if (path) files.push({ path, type: fileType(path, undefined, additions, removals), additions, removals });
      continue;
    }
    const previousPath = fields[index++];
    const path = fields[index++];
    if (!path) continue;
    files.push({ path, previousPath, type: fileType(path, previousPath, additions, removals), additions, removals });
  }
  return files;
}
```

```ts
function fileType(_path: string, previousPath: string | undefined, additions: number, removals: number): ReviewFile["type"] {
  if (previousPath) return additions === 0 && removals === 0 ? "rename-pure" : "rename-changed";
  if (additions > 0 && removals === 0) return "new";
  if (additions === 0 && removals > 0) return "deleted";
  return "change";
}
```

The result type (`src/review-checkpoints.ts:14-20`), which must not change:

```ts
export interface ReviewFile {
  path: string;
  previousPath?: string;
  type: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
  additions: number;
  removals: number;
}
```

What git actually prints (captured with git 2.56; `|` stands for a NUL byte).
For one commit that adds `added.txt`, appends to `append.txt`, changes a
binary, renames `old-name.txt` to `new-name.txt` with one added line, deletes
`removed.txt`, and shrinks `shrink.txt`:

```text
git diff --numstat -z:
1<TAB>0<TAB>added.txt|1<TAB>0<TAB>append.txt|-<TAB>-<TAB>bin.dat|1<TAB>0<TAB>|old-name.txt|new-name.txt|0<TAB>1<TAB>removed.txt|0<TAB>2<TAB>shrink.txt|

git diff --name-status -z:
A|added.txt|M|append.txt|M|bin.dat|R085|old-name.txt|new-name.txt|D|removed.txt|M|shrink.txt|
```

So in `--numstat -z` a rename is a header with an **empty third field**
followed by two NUL-terminated paths (old, then new). The current parser sees
three parts, finds the empty path, skips the record, and then reads
`old-name.txt` as a header.

Neither of git's rename signals says whether a rename is pure. A binary file
has no line counts (`-<TAB>-`, parsed as 0 and 0), so a renamed binary whose
content changed looks unchanged by counts. The similarity score is an
estimate: reordered content can score `R100` although the bytes differ, for
text (where the counts are then non-zero) and for binaries (where there are no
counts at all). The exact signal is the content itself.
`git diff --raw -z --no-abbrev` prints the old and new blob ids with the
status:

```text
:100644 100644 70bd6b37…a815227e9d f34875b8…5b3a3a2201 R100|old.bin|new.bin|
:100644 000000 c8686e30…c464a1bc 00000000…00000000 D|dir|
```

A rename is pure exactly when the two blob ids are equal.

Conventions: tests are standalone `tsx` scripts with `node:assert/strict`;
commit style is conventional commits, for example
`fix(executor): read whole files up to maxBytesPerFile in multi_read`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install (in your worktree only) | `bun install --frozen-lockfile` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| This suite | `bunx tsx src/review-checkpoints.test.ts` | exit 0 |
| Full suite (about 65 s, needs `tmux`) | `bun run test` | exit 0 |

Do **not** run `bun test`, `bun run build`, `bun run rebuild:local`,
`bun run test:t3-live`, or `bun run test:t3-deployed`. Work in a separate git
worktree or clone: on the host Svartal the checkout
`/Users/rclair/projects/devspace` serves the production gateway from its
`dist/`, so never run `bun run build:check` or `bun install` there.

## Scope

**In scope** (the only files you should modify):

- `src/review-checkpoints.ts`
- `src/review-checkpoints.test.ts`
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):

- The `ReviewFile` and `ReviewChangesResult` shapes, the `show_changes` schema
  in `src/server.ts`, and `src/tool-contract.ts` — no wire-shape change.
- The patch text, the snapshot logic (`createWorkingTreeSnapshot`), and when
  the baseline advances — plan 022 owns the patch size and baseline behavior.
- `.gitignore` handling for workspaces that are repository subdirectories — a
  separate finding (G10).
- `src/ui/**` — the review card parses the patch itself and does not read
  `files[].type`.

## Git workflow

- Branch: `advisor/021-show-changes-file-list`, created from the integration
  branch `advisor/audit-2026-11-11`.
- Message style: `fix(review): parse renames and take file types from git status`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a failing test

In `src/review-checkpoints.test.ts`, add `rename as renameFile` and `unlink` to
the `node:fs/promises` import. Directly after the two lines

```ts
    const afterReviewed = await restartedManager.reviewChanges({ workspaceId: "ws_review", root });
    assert.equal(afterReviewed.summary.files, 0);
```

add:

```ts
    // File types come from git's own status, and a rename is one entry.
    await writeFile(join(root, "rename-me.txt"), "a\nb\nc\nd\ne\nf\n");
    await writeFile(join(root, "shrink.txt"), "1\n2\n3\n");
    await writeFile(join(root, "append.txt"), "x\n");
    await writeFile(join(root, "remove-me.txt"), "gone\n");
    const seeded = await restartedManager.reviewChanges({ workspaceId: "ws_review", root });
    assert.deepEqual(seeded.files.map((file) => file.type), ["new", "new", "new", "new"]);

    await renameFile(join(root, "rename-me.txt"), join(root, "renamed.txt"));
    await writeFile(join(root, "renamed.txt"), "a\nb\nc\nd\ne\nf\ng\n");
    await writeFile(join(root, "shrink.txt"), "1\n");
    await writeFile(join(root, "append.txt"), "x\ny\n");
    await unlink(join(root, "remove-me.txt"));
    await writeFile(join(root, "added.txt"), "n\n");
    const mixed = await restartedManager.reviewChanges({ workspaceId: "ws_review", root });
    const byPath = new Map(mixed.files.map((file) => [file.path, file]));
    assert.equal(mixed.files.length, 5);
    assert.deepEqual(byPath.get("renamed.txt"), { path: "renamed.txt", previousPath: "rename-me.txt", type: "rename-changed", additions: 1, removals: 0 });
    assert.deepEqual(byPath.get("shrink.txt"), { path: "shrink.txt", type: "change", additions: 0, removals: 2 });
    assert.deepEqual(byPath.get("append.txt"), { path: "append.txt", type: "change", additions: 1, removals: 0 });
    assert.deepEqual(byPath.get("remove-me.txt"), { path: "remove-me.txt", type: "deleted", additions: 0, removals: 1 });
    assert.deepEqual(byPath.get("added.txt"), { path: "added.txt", type: "new", additions: 1, removals: 0 });
    assert.equal(mixed.result, "Changed 5 files (+3 -3).");

    await renameFile(join(root, "added.txt"), join(root, "moved.txt"));
    const pureRename = await restartedManager.reviewChanges({ workspaceId: "ws_review", root });
    assert.deepEqual(pureRename.files, [{ path: "moved.txt", previousPath: "added.txt", type: "rename-pure", additions: 0, removals: 0 }]);

    // A pure rename needs both of git's signals: a changed binary has no line counts, and
    // reordered lines still score a similarity of 100.
    const binary = Buffer.from(Array.from({ length: 4096 }, (_value, index) => (index * 7 + (index >> 6)) % 256));
    await writeFile(join(root, "logo.bin"), binary);
    await writeFile(join(root, "order.txt"), "alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot\n");
    await restartedManager.reviewChanges({ workspaceId: "ws_review", root });
    binary[100] ^= 0xff;
    await renameFile(join(root, "logo.bin"), join(root, "brand.bin"));
    await writeFile(join(root, "brand.bin"), binary);
    await renameFile(join(root, "order.txt"), join(root, "reordered.txt"));
    await writeFile(join(root, "reordered.txt"), "bravo\nalpha\ncharlie\ndelta\necho\nfoxtrot\n");
    const changedRenames = await restartedManager.reviewChanges({ workspaceId: "ws_review", root });
    assert.deepEqual(changedRenames.files, [
      { path: "brand.bin", previousPath: "logo.bin", type: "rename-changed", additions: 0, removals: 0 },
      { path: "reordered.txt", previousPath: "order.txt", type: "rename-changed", additions: 1, removals: 1 },
    ]);

    // Reordered binary content scores 100 and has no line counts, yet the bytes differ.
    const blocks = Buffer.concat([Buffer.alloc(2048, "A"), Buffer.alloc(2048, "B")]);
    for (let offset = 0; offset < blocks.length; offset += 64) blocks[offset] = 0;
    await writeFile(join(root, "blocks.bin"), blocks);
    await restartedManager.reviewChanges({ workspaceId: "ws_review", root });
    await renameFile(join(root, "blocks.bin"), join(root, "swapped.bin"));
    await writeFile(join(root, "swapped.bin"), Buffer.concat([blocks.subarray(2048), blocks.subarray(0, 2048)]));
    const reorderedBinary = await restartedManager.reviewChanges({ workspaceId: "ws_review", root });
    assert.deepEqual(reorderedBinary.files, [
      { path: "swapped.bin", previousPath: "blocks.bin", type: "rename-changed", additions: 0, removals: 0 },
    ]);
```

`assert.deepEqual` is used on purpose: an entry without a rename must not
carry a `previousPath` key at all.

**Verify (must fail before the fix)**: `bunx tsx src/review-checkpoints.test.ts`
→ exits non-zero with an `AssertionError` in the new block (the first failing
assertion is `mixed.files.length` or the `renamed.txt` entry).

### Step 2: Parse both git outputs

In `src/review-checkpoints.ts`:

1. In `reviewChanges`, after the `numstat` call, add a third call with the
   same options:

   ```ts
        const rawDiff = (await git(root, ["diff", "--raw", "--no-abbrev", "-z", baseline, current], {
          env,
          maxBuffer: 50 * 1024 * 1024,
        })).stdout;
   ```

   and change `const files = parseNumstat(numstat);` to
   `const files = parseChangedFiles(numstat, rawDiff);`.

2. Replace `parseNumstat` and `fileType` with:

   ```ts
   interface FileChange {
     /** Git's status token, such as `M` or `R100`. */
     status: string;
     /** True when the old and the new blob are the same object, so the content is byte-identical. */
     sameBlob: boolean;
   }

   /**
    * Git's status per path from `git diff --raw -z --no-abbrev`. A record is
    * `:<old mode> <new mode> <old blob> <new blob> <status>` followed by one path, or by the old
    * and the new path for a rename or copy.
    */
   function parseRawDiff(output: string): Map<string, FileChange> {
     const fields = output.split("\0");
     const changes = new Map<string, FileChange>();
     for (let index = 0; index < fields.length;) {
       const header = fields[index++] ?? "";
       if (!header) continue;
       const [, , oldBlob, newBlob, status = ""] = header.split(" ");
       if (status.startsWith("R") || status.startsWith("C")) index += 1;
       const path = fields[index++];
       if (path) changes.set(path, { status, sameBlob: Boolean(oldBlob && oldBlob === newBlob) });
     }
     return changes;
   }

   /**
    * One entry per changed file. Counts come from `git diff --numstat -z`, where a rename is a
    * header with an empty path followed by the old and the new path; types come from git's status.
    */
   function parseChangedFiles(numstat: string, rawDiff: string): ReviewFile[] {
     const changes = parseRawDiff(rawDiff);
     const fields = numstat.split("\0");
     const files: ReviewFile[] = [];
     for (let index = 0; index < fields.length;) {
       const header = fields[index++] ?? "";
       if (!header) continue;
       const parts = header.split("\t");
       const additions = parseStatNumber(parts[0]);
       const removals = parseStatNumber(parts[1]);
       const inlinePath = parts.slice(2).join("\t");
       if (inlinePath) {
         files.push({ path: inlinePath, type: fileType(changes.get(inlinePath)), additions, removals });
         continue;
       }
       const previousPath = fields[index++];
       const path = fields[index++];
       if (!path) continue;
       const change = changes.get(path);
       const type = fileType(change);
       files.push(change?.status.startsWith("R") && previousPath ? { path, previousPath, type, additions, removals } : { path, type, additions, removals });
     }
     return files;
   }

   function fileType(change: FileChange | undefined): ReviewFile["type"] {
     const kind = change?.status[0];
     if (kind === "A" || kind === "C") return "new";
     if (kind === "D") return "deleted";
     // A rename is pure only when the content is byte-identical. Git's similarity score and the
     // line counts are not enough: reordered content can score 100, and a binary has no counts.
     if (kind === "R") return change?.sameBlob ? "rename-pure" : "rename-changed";
     return "change";
   }
   ```

   Keep `parseStatNumber` and `summarizeFiles` as they are.

**Verify**:

- `bun run typecheck` → exit 0
- `bunx tsx src/review-checkpoints.test.ts` → exit 0
- `grep -rn "parseNumstat" src/` → no matches

### Step 3: Full suite

**Verify**: `bun run test` → exit 0.

## Test plan

- New block in `src/review-checkpoints.test.ts`: a rename with a change, a
  shrink-only edit, an append-only edit, a deletion, an addition, a pure
  rename, a renamed binary with changed content, a rename with reordered
  lines, and a renamed binary with reordered content, asserted entry by entry with `deepEqual`, plus the summary line.
- Pattern: the existing assertions in the same file.
- Verification: `bun run test` → exit 0.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bunx tsx src/review-checkpoints.test.ts` exits 0 with the new block present
- [ ] `bun run test` exits 0
- [ ] `grep -rn "parseNumstat" src/` returns no matches
- [ ] `git status --short` lists only in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- The new test passes before Step 2.
- After Step 2, git on this machine reports the `rename-me.txt` change as a
  delete plus an add instead of a rename (rename detection disabled by a git
  configuration). Report it; do not add `-M` or change the diff options,
  because the patch text and the file list must come from the same detection.
- An existing assertion in the file fails after Step 2.

## Maintenance notes

- The three `git diff` calls (`--binary`, `--numstat -z`, `--raw -z --no-abbrev`)
  must keep identical revision arguments and rename-detection options, or the
  list and the patch will disagree.
- Rename purity is decided by comparing blob ids, not by the similarity score
  or the line counts. Keep `--no-abbrev`: abbreviated ids could collide.
- Plan 022 edits the same function (`reviewChanges`) to bound the patch size.
  Land this plan first; 022's excerpts assume it.
- A copy (`C`) only appears if copy detection is ever enabled; it is reported
  as `new` without a `previousPath`.
