# Plan 016: Keep managed workspaces whose commits or stashes exist nowhere else

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 63d6d81..HEAD -- src/workspaces.ts src/workspace-lifecycle.test.ts src/workspace-maintenance.test.ts src/server.ts docs/security.md package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `63d6d81`, 2026-11-11

## Why this matters

`open_workspace` with `mode: "isolated"` or `mode: "worktree"` creates a
managed checkout on a detached HEAD. When that workspace is closed, or has been
idle for seven days, DevSpace deletes the checkout if `git status` is clean. A
checkout whose work was **committed** is clean, so it is deleted too. In the
clone strategy the commits are deleted with the directory; in the worktree
strategy no branch points at them, so git garbage-collects them later.
Committing is how agent work normally ends, so this is silent loss of finished
work. After this plan, a managed checkout is removed only when everything in it
also exists somewhere that survives the removal.

## Current state

Files:

- `src/workspaces.ts` — `WorkspaceRegistry`. `closeWorkspace` (lines 165–211)
  and `cleanupStoredManagedWorkspace` (lines 594–626, called by `maintenance`)
  both decide removal with `managedWorkspaceDirty` (lines 673–680).
- `src/git-worktrees.ts` — creates managed checkouts. Read-only context; do not
  edit.
- `src/workspace-lifecycle.test.ts` — tool-level lifecycle test through
  `LocalExecutor`.
- `src/workspace-maintenance.test.ts` — maintenance test through
  `WorkspaceRegistry` and `SqliteWorkspaceStore`.
- `src/workspaces.test.ts:184-210` — exemplar for forcing the clone strategy.

The whole decision today (`src/workspaces.ts:673-680`):

```ts
  private async managedWorkspaceDirty(root: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: root, maxBuffer: 2 * 1024 * 1024 });
      return stdout.trim().length > 0;
    } catch {
      return true;
    }
  }
```

Its use on close (`src/workspaces.ts:182-190`):

```ts
      } else {
        dirty = await this.managedWorkspaceDirty(identity.canonicalRoot);
        if (dirty) {
          retainedPath = workspace.root;
          reason = "managed workspace contains uncommitted changes";
        } else if (workspace.worktree.strategy === "clone") {
          await rm(identity.canonicalRoot, { recursive: true, force: true });
          removed = true;
        } else if (workspace.sourceRoot) {
```

Its use in maintenance (`src/workspaces.ts:605-610`):

```ts
    const dirty = await this.managedWorkspaceDirty(identity.canonicalRoot);
    if (dirty) return { removed: false, dirty: true };
    if (session.strategy === "clone") {
      await rm(identity.canonicalRoot, { recursive: true, force: true });
      return { removed: true, dirty: false };
    }
```

How the checkouts are created (`src/git-worktrees.ts:48` and `:69-71`):

```ts
    await git(["worktree", "add", "--detach", worktreePath, source.baseSha], source.sourceRoot);
```

```ts
    await git(["clone", "--no-local", "--no-checkout", source.sourceRoot, clonePath], dirname(clonePath));
    await git(["checkout", "--detach", source.baseSha], clonePath);
    await preserveNetworkOrigin(source.sourceRoot, clonePath);
```

`preserveNetworkOrigin` removes the `origin` remote from the clone when the
source has no network origin, which also deletes the clone's remote-tracking
refs. The clone keeps a local default branch (for example `main`) at the
source's branch tip.

Facts you need:

- `Workspace.worktree` (`src/workspaces.ts:41-52`) has `strategy: "worktree" |
  "clone"`, `baseSha: string`, and `sourceCanonicalRoot: string`.
- A stored `WorkspaceSession` has optional `strategy`, `baseSha`, and
  `sourceCanonicalRoot` (`src/workspace-store.ts`); `baseSha` can be an empty
  string on old rows.
- Worktree strategy: branches, tags, remote-tracking refs, and stashes live in
  the **source** repository and survive `git worktree remove`. Only commits
  reachable solely from the worktree's detached HEAD are lost.
- Clone strategy: the directory is deleted with `rm`, so every local branch,
  the detached HEAD, and the stash are lost unless the same commits exist in
  the source repository or on a remote-tracking ref.
- The `close_workspace` output schema (`src/server.ts:1224-1235`) already has
  `dirty: z.boolean()` and `reason: z.string().optional()`. This plan changes
  no wire shape: `dirty` stays `true` whenever the checkout is retained for its
  contents, and `reason` says why.
- Maintenance reports retained checkouts in `retainedDirty` as
  `{ workspaceId, path }` (`src/workspaces.ts:245-247`). Keep that shape.

Conventions:

- Tests are standalone `tsx` scripts using `node:assert/strict`; every new
  `src/*.test.ts` must be appended by hand to the `"test"` script in
  `package.json` or it never runs.
- Commit messages are conventional commits, for example
  `fix(roots): resolve dangling symlinks before authorizing write targets`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install (in your worktree only) | `bun install --frozen-lockfile` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0, no output after the `tsc` line |
| One suite | `bunx tsx src/<name>.test.ts` | exit 0 |
| Full suite (about 65 s, needs `tmux`) | `bun run test` | exit 0 |

Do **not** run `bun test` (wrong runner), `bun run build`, `bun run
rebuild:local`, `bun run test:t3-live`, or `bun run test:t3-deployed`. Work in
a separate git worktree or clone: on the host Svartal the checkout
`/Users/rclair/projects/devspace` serves the production gateway from its
`dist/`, so never run `bun run build:check` or `bun install` there.

## Scope

**In scope** (the only files you should modify):

- `src/workspaces.ts`
- `src/workspace-lifecycle.test.ts`
- `src/workspace-maintenance.test.ts`
- `src/workspace-unpublished-work.test.ts` (create)
- `package.json` (append the new test to the `"test"` script only)
- `src/server.ts` (one description string, Step 4)
- `docs/security.md` (one sentence, Step 4)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):

- `src/git-worktrees.ts` — how checkouts are created stays as it is.
- The `close_workspace` input or output schema, `src/tool-contract.ts`, and
  `TOOL_CONTRACT_HASH` — no wire-shape change is needed.
- Automatic pruning or pushing of retained checkouts — retention is reported,
  the operator decides.
- The environment passed to git child processes — plan 017 owns that.

## Git workflow

- Branch: `advisor/016-retain-unpublished-managed-work`
- One commit per step or one for the whole plan; message style
  `fix(workspaces): keep managed checkouts that hold unpublished commits`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add failing tests

**1a. `src/workspace-lifecycle.test.ts`.** Next to the existing `let
dirtyPath` declarations add `let committedPath: string | undefined;`. After
the existing dirty case (the block ending with
`assert.equal((await stat(dirtyPath)).isDirectory(), true);`) and before
`} finally {`, add:

```ts
  // Committed work on the managed checkout's detached HEAD exists nowhere else.
  const committedOpen = await executor.execute("open_workspace", { path: source, mode: "isolated" }, { requestId: "open-committed" });
  const committedId = String(committedOpen.structuredContent?.workspaceId);
  committedPath = String(committedOpen.structuredContent?.root);
  await writeFile(join(committedPath, "committed.txt"), "keep me\n");
  await git(committedPath, ["add", "."]);
  await git(committedPath, ["-c", "user.name=DevSpace Test", "-c", "user.email=devspace@example.com", "commit", "-m", "work"]);
  const committedClose = await executor.execute("close_workspace", { workspaceId: committedId }, { requestId: "close-committed" });
  const committedResult = committedClose.structuredContent?.workspace as { removed?: boolean; dirty?: boolean; retainedPath?: string; reason?: string };
  assert.equal(committedResult.removed, false);
  assert.equal(committedResult.dirty, true);
  assert.equal(committedResult.retainedPath, committedPath);
  assert.match(committedResult.reason ?? "", /exist nowhere else/);
  await access(join(committedPath, "committed.txt"));

  // The same work on a branch survives in the source repository, so the checkout can go.
  const branchOpen = await executor.execute("open_workspace", { path: source, mode: "isolated" }, { requestId: "open-branch" });
  const branchId = String(branchOpen.structuredContent?.workspaceId);
  const branchPath = String(branchOpen.structuredContent?.root);
  await git(branchPath, ["switch", "-c", "devspace-lifecycle-kept"]);
  await writeFile(join(branchPath, "branch.txt"), "on a branch\n");
  await git(branchPath, ["add", "."]);
  await git(branchPath, ["-c", "user.name=DevSpace Test", "-c", "user.email=devspace@example.com", "commit", "-m", "branch work"]);
  const branchClose = await executor.execute("close_workspace", { workspaceId: branchId }, { requestId: "close-branch" });
  assert.equal((branchClose.structuredContent?.workspace as { removed?: boolean }).removed, true);
  await assert.rejects(() => access(branchPath));
  await git(source, ["rev-parse", "--verify", "devspace-lifecycle-kept"]);
```

In the `finally` block add
`if (committedPath) await rm(committedPath, { recursive: true, force: true });`
next to the existing `dirtyPath` cleanup.

**1b. `src/workspace-maintenance.test.ts`.** After the line that writes
`dirty.txt` (line 40), add:

```ts
const committed = await firstRegistry.openWorkspace({ path: source, mode: "isolated" });
await writeFile(join(committed.workspace.root, "committed.txt"), "retain\n");
await git(committed.workspace.root, ["add", "."]);
await git(committed.workspace.root, ["-c", "user.name=DevSpace Test", "-c", "user.email=devspace@example.com", "commit", "-m", "work"]);
```

Replace the `assert.deepEqual(result.retainedDirty, [...])` line with:

```ts
  assert.deepEqual(
    result.retainedDirty.map((entry) => entry.workspaceId).sort(),
    [dirty.workspace.id, committed.workspace.id].sort(),
  );
  await access(join(committed.workspace.root, "committed.txt"));
```

**1c. Create `src/workspace-unpublished-work.test.ts`** for the clone
strategy. Model the setup on `src/workspace-maintenance.test.ts:1-34` (temp
root, `git init`, `loadConfig`) and force the clone strategy the way
`src/workspaces.test.ts:199-205` does: `chmod(join(source, ".git"), 0o555)`
around the `openWorkspace({ path: source, mode: "isolated" })` call and
`chmod(..., 0o755)` in a `finally`. Assert `workspace.worktree?.strategy ===
"clone"` for every workspace the file opens. Use a `WorkspaceRegistry`
without a store and call `registry.closeWorkspace(id)` directly. The source
repository needs two commits (`first`, then `second`), with no remote. Cover
these four cases:

1. Fresh clone, nothing done in it → `closeWorkspace` returns `removed: true`,
   `dirty: false`.
2. Fresh clone opened with `baseRef: <sha of first>` while the source HEAD is
   `second` → `removed: true`. (The clone's local default branch is ahead of
   the base but its tip exists in the source.)
3. Clone with a new commit on its detached HEAD (use the `-c user.name=… -c
   user.email=…` form shown above) → `removed: false`, `dirty: true`, `reason`
   matches `/exist nowhere else/`, and the directory still exists.
4. Clone with a stash and a clean tree (write a file, then
   `git -c user.name=… -c user.email=… stash -u`) → `removed: false`,
   `reason` matches `/exist nowhere else/`.

Remove every retained directory and the temp root in a `finally` block, and
end with `console.log("workspace-unpublished-work checks passed");`.

Append `&& tsx src/workspace-unpublished-work.test.ts` to the end of the
`"test"` script in `package.json`.

**Verify (the tests must fail before the fix)**:

- `bunx tsx src/workspace-lifecycle.test.ts` → exits non-zero with an
  `AssertionError` on `committedResult.removed` (`true !== false`).
- `bunx tsx src/workspace-maintenance.test.ts` → exits non-zero on the
  `retainedDirty` assertion.
- `bunx tsx src/workspace-unpublished-work.test.ts` → cases 1 and 2 pass;
  it exits non-zero at case 3.

If case 1 or 2 already fails here, STOP: the clone setup is wrong.

### Step 2: Replace the dirty check with a retention reason

In `src/workspaces.ts`, delete `managedWorkspaceDirty` and add in its place:

```ts
  /** Why a managed checkout must be kept, or undefined when deleting it loses no work. */
  private async managedWorkspaceRetentionReason(
    root: string,
    managed: { strategy: "worktree" | "clone"; baseSha?: string; sourceCanonicalRoot?: string },
  ): Promise<string | undefined> {
    const run = async (args: string[], cwd = root): Promise<string> =>
      (await execFileAsync("git", args, { cwd, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
    try {
      if ((await run(["status", "--porcelain=v1"])).length > 0) return "managed workspace contains uncommitted changes";
      const known = managed.baseSha ? [managed.baseSha] : [];
      if (managed.strategy === "worktree") {
        // Branches, tags, and remote-tracking refs live in the source repository and survive
        // `git worktree remove`; commits reachable only from this detached HEAD do not.
        const lost = await run(["rev-list", "--max-count=1", "HEAD", "--not", "--branches", "--tags", "--remotes", ...known]);
        return lost ? UNPUBLISHED_WORK_REASON : undefined;
      }
      // Clone: the whole directory is deleted, so every local tip must also exist elsewhere.
      const tips = new Set([
        await run(["rev-parse", "HEAD"]),
        ...(await run(["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/stash"])).split("\n").filter(Boolean),
      ]);
      for (const tip of tips) {
        const ahead = await run(["rev-list", "--max-count=1", tip, "--not", "--remotes", ...known]);
        if (!ahead) continue;
        if (!managed.sourceCanonicalRoot) return UNPUBLISHED_WORK_REASON;
        const inSource = await run(["cat-file", "-e", `${tip}^{commit}`], managed.sourceCanonicalRoot).then(() => true, () => false);
        if (!inSource) return UNPUBLISHED_WORK_REASON;
      }
      return undefined;
    } catch {
      return "managed workspace could not be inspected with git";
    }
  }
```

Add the constant near the top of the file, after the imports:

```ts
const UNPUBLISHED_WORK_REASON = "managed workspace contains commits or stashes that exist nowhere else";
```

In `closeWorkspace`, replace the `dirty = await this.managedWorkspaceDirty(...)`
line and the `if (dirty) { ... }` block that follows it with:

```ts
        const retention = await this.managedWorkspaceRetentionReason(identity.canonicalRoot, {
          strategy: workspace.worktree.strategy,
          baseSha: workspace.worktree.baseSha,
          sourceCanonicalRoot: workspace.worktree.sourceCanonicalRoot,
        });
        dirty = retention !== undefined;
        if (retention) {
          retainedPath = workspace.root;
          reason = retention;
        } else if (workspace.worktree.strategy === "clone") {
```

(The `else if (workspace.worktree.strategy === "clone")` branch and everything
after it stay as they are.)

In `cleanupStoredManagedWorkspace`, replace the two lines starting with
`const dirty = await this.managedWorkspaceDirty(` with:

```ts
    const retention = await this.managedWorkspaceRetentionReason(identity.canonicalRoot, {
      strategy: session.strategy ?? "worktree",
      baseSha: session.baseSha,
      sourceCanonicalRoot: session.sourceCanonicalRoot,
    });
    if (retention) return { removed: false, dirty: true };
```

**Verify**: `bun run typecheck` → exit 0. `grep -n "managedWorkspaceDirty" src/` → no matches.

### Step 3: Run the suites

**Verify**:

- `bunx tsx src/workspace-lifecycle.test.ts` → exit 0
- `bunx tsx src/workspace-maintenance.test.ts` → exit 0
- `bunx tsx src/workspace-unpublished-work.test.ts` → exit 0, prints
  `workspace-unpublished-work checks passed`
- `bunx tsx src/workspaces.test.ts` → exit 0 (its existing clone and worktree
  cases must still pass)

### Step 4: Make the user-facing wording true

- `src/server.ts`, the `close_workspace` description (line 1222): replace
  `Dirty managed work is retained and reported.` with `A managed checkout with
  uncommitted changes, or with commits or stashes that exist nowhere else, is
  retained and reported.`
- `docs/security.md`, section "Persistent state": replace `Dirty managed work
  is retained and reported.` with `Managed work that is uncommitted, or
  committed or stashed but present nowhere else, is retained and reported.`

**Verify**: `grep -rn "Dirty managed work is retained" src docs` → no matches.
`bun run test` → exit 0.

## Test plan

- New cases: committed work on a detached HEAD is retained (worktree strategy,
  tool level and maintenance); work on a branch is removed and the branch
  survives in the source; clone strategy fresh close, fresh close with an
  older `baseRef`, new commit, and stash.
- Pattern: `src/workspace-lifecycle.test.ts` for tool-level cases,
  `src/workspace-maintenance.test.ts` for registry-level cases.
- Verification: `bun run test` → exit 0, including the new suite.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0
- [ ] `bunx tsx src/workspace-unpublished-work.test.ts` exits 0 and the file is in the `"test"` script of `package.json`
- [ ] `grep -n "managedWorkspaceDirty" src/` returns no matches
- [ ] `grep -rn "Dirty managed work is retained" src docs` returns no matches
- [ ] `git status --short` lists only in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- After Step 2, an **existing** assertion that a clean isolated workspace is
  removed fails (for example `cleanClose … removed, true` in
  `src/workspace-lifecycle.test.ts`). That means the new check retains
  checkouts with no work in them; do not loosen the check to make it pass.
- Forcing the clone strategy with `chmod` does not produce
  `strategy === "clone"` on this machine.
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file.

## Maintenance notes

- Retained checkouts are never pruned automatically; `maintenance` reports
  them in `retainedDirty` on every pass. Removing them is an operator action.
- Old stored sessions can have an empty `baseSha`. The check then omits the
  base commit, which can only cause extra retention, never deletion.
- Plan 017 gives every git child a filtered environment. If it lands after this
  plan, the `run` helper added here must pass that environment too; plan 017's
  done criteria check for it.
- Reviewer focus: the `--not` argument order in the two `rev-list` calls (all
  revisions after `--not` are excluded), and that a `cat-file` failure for any
  reason keeps the checkout.
