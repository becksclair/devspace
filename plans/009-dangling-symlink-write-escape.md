# Plan 009: Resolve dangling symlinks during canonical-path authorization so writes cannot escape root policy

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 79ddffc..HEAD -- src/roots.ts src/roots.test.ts src/executor-root-policy.test.ts src/workspaces.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `79ddffc`, 2026-11-04

## Why this matters

DevSpace's file tools promise (in `docs/security.md`, "Canonical root policy")
that a symlink into an undeclared target is rejected, and that missing write
targets are authorized by canonicalizing the nearest existing parent.
`canonicalTarget()` uses `existsSync`, which **follows** symlinks, so a
*dangling* symlink (link exists, target does not) is treated as a missing
path. The function returns the link's own path, which lies inside the
workspace, so authorization passes. Pi's write tool then calls
`fs.writeFile` on that path, which follows the link and creates the target
wherever it points. A repository containing a committed dangling link (for
example to a not-yet-existing file in `~/.ssh/` or a systemd user unit
directory) turns an innocent-looking `write_file` into a write outside every
configured root. A dangling link to a *directory* is currently stopped by
Pi's parent `mkdir` failing with ENOENT, but authorization still wrongly
admits it. The fix covers both. The shell is deliberately unconfined, but the file tools'
policy is a documented guarantee and the UI's provenance relies on it.

## Current state

- `src/roots.ts:177-195` — the function to fix:
  ```ts
  export function canonicalTarget(path: string): string {
    const absolute = resolve(expandHomePath(path));
    if (existsSync(absolute)) return realpathSync.native(absolute);

    let existing = absolute;
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) throw new AccessDeniedError(`Path cannot be resolved: ${path}`);
      existing = parent;
    }

    const canonicalParent = realpathSync.native(existing);
    const suffix = relative(existing, absolute);
    if (!suffix || suffix === ".") return canonicalParent;
    if (suffix === ".." || suffix.startsWith(`..${sep}`)) {
      throw new AccessDeniedError(`Path cannot be resolved safely: ${path}`);
    }
    return resolve(canonicalParent, suffix);
  }
  ```
  Imports at `src/roots.ts:1-4`: `existsSync, realpathSync, statSync` from `node:fs`; `dirname, relative, resolve, sep` from `node:path`. `AccessDeniedError` is defined and exported in the same file.
- Callers (all benefit from the fix): `authorizeWorkspacePath` (`src/roots.ts:139`), `authorizeWorkspaceTarget` (`src/roots.ts:164`), `WorkspaceRegistry.resolveWorkspaceTarget` (`src/workspaces.ts:519`, used by `resolveWritePath` → `write_file`/`edit_file` in `src/executor.ts:310,316`), plus `src/skills.ts`, `restoreWorkspace` (`src/workspaces.ts:455-456`), and instruction discovery (`src/workspaces.ts:549-558, 707-720`). Their behaviour for existing paths is unchanged, because the `existsSync(absolute)` fast path is untouched.
- `src/workspaces.ts:288-290`: `resolveWritePath` returns the **canonical** path, which is what Pi's write tool receives.
- Existing tests:
  - `src/roots.test.ts` — standalone script; builds `projects`, `alias` (symlink), `externalReadOnly`, `undeclared` dirs under a `mkdtemp` root, creates `project/linked-config` and `project/escape` symlinks to **existing** directories, and asserts with `authorizeWorkspaceTarget(...)` and `assert.throws(..., AccessDeniedError)`. No dangling-link case.
  - `src/executor-root-policy.test.ts` — drives `LocalExecutor` with `DEVSPACE_ROOTS` (project read-write, external read-only) and asserts `write_file` rejections with `assert.rejects(..., /outside permitted write roots/)`.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Typecheck | `bun run typecheck` | exit 0 |
| Roots test | `bunx tsx src/roots.test.ts` | exit 0 |
| Executor policy test | `bunx tsx src/executor-root-policy.test.ts` | exit 0 |
| All tests | `bun run test` | exit 0 (~65s; needs `tmux`) |
| Build | `bun run build:check` | exit 0 |

## Scope

**In scope**: `src/roots.ts` (only `canonicalTarget`, one new module-level constant `MAX_SYMLINK_HOPS`, and the `node:fs` import line), `src/roots.test.ts`, `src/executor-root-policy.test.ts`.

**Out of scope**:
- The time-of-check/time-of-use window between authorization and Pi's `open()`. Closing it needs `O_NOFOLLOW`/fd-based writes inside Pi's tool, and the shell is unconfined by design anyway.
- Shell and terminal tools: they are intentionally not root-confined (`docs/security.md`, "Shell and terminal authority").
- `docs/security.md`: the documented guarantee already matches the fixed behaviour.

## Git workflow

- Branch: `advisor/009-dangling-symlink-write-escape`
- Commit style: `fix(roots): resolve dangling symlinks before authorizing write targets`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add failing tests

In `src/roots.test.ts`, immediately after the `assert.throws(() => authorizeWorkspaceTarget("escape/secret.txt", project, policies, "read"), AccessDeniedError)` block (ending ≈ line 63) and before the `future` assertions, add the following (`symlink` and `writeFile` are already imported):

1. Dangling file link to an undeclared target:
   `await symlink(join(undeclared, "planted.txt"), join(project, "planted"));`
   `assert.throws(() => authorizeWorkspaceTarget("planted", project, policies, "write"), AccessDeniedError);`
2. Dangling directory link to an undeclared target, written through:
   `await symlink(join(undeclared, "missing-dir"), join(project, "dangdir"));`
   `assert.throws(() => authorizeWorkspaceTarget("dangdir/x.txt", project, policies, "write"), AccessDeniedError);`
3. Dangling link to a missing file **inside** the project stays allowed and resolves to its target:
   `await symlink(join(project, "sub", "future.txt"), join(project, "inner"));`
   `assert.equal(authorizeWorkspaceTarget("inner", project, policies, "write").canonicalPath, join(project, "sub", "future.txt"));`
4. Symlink loop fails closed with `AccessDeniedError`, not a crash or stack overflow:
   `await symlink(join(project, "loop-b"), join(project, "loop-a"));`
   `await symlink(join(project, "loop-a"), join(project, "loop-b"));`
   `assert.throws(() => authorizeWorkspaceTarget("loop-a", project, policies, "write"), AccessDeniedError);`

In `src/executor-root-policy.test.ts`, add `import { existsSync } from "node:fs";` as a new line right after the `node:assert/strict` import. Then, immediately after the line `assert.equal(await readFile(join(project, "created.txt"), "utf8"), "created\n");` (≈ line 60), add:

```ts
await symlink(join(undeclared, "planted.txt"), join(project, "planted"));
await assert.rejects(
  () => executor.execute("write_file", { workspaceId, path: "planted", content: "x\n" }, { requestId: "write-dangling" }),
  /outside permitted write roots/,
);
assert.equal(existsSync(join(undeclared, "planted.txt")), false);
```

**Verify**: `bunx tsx src/roots.test.ts` → **fails** on case 1 (no exception thrown). `bunx tsx src/executor-root-policy.test.ts` → **fails** (the write succeeds and `undeclared/planted.txt` exists). If either passes, STOP.

### Step 2: Resolve a dangling symlink at the first missing component

Change `canonicalTarget` to accept an internal hop counter. After computing `canonicalParent` and `suffix` (and after the existing `..` check), inspect the **first** missing component with `lstatSync`. Only that component can exist as a dangling link, because every later component lies under a path that does not exist. If it is a symlink, resolve its target relative to the link's directory, re-append the rest of the suffix, and recurse:

```ts
const MAX_SYMLINK_HOPS = 40;

export function canonicalTarget(path: string, hops = 0, origin = path): string {
  if (hops > MAX_SYMLINK_HOPS) throw new AccessDeniedError(`Path cannot be resolved (too many symbolic links): ${origin}`);
  // ...existing body up to and including the `..` suffix check, but use `${origin}`
  // instead of `${path}` in its two existing AccessDeniedError messages...
  const [first, ...rest] = suffix.split(sep);
  const firstPath = resolve(canonicalParent, first);
  let firstStat: Stats | undefined;
  try {
    firstStat = lstatSync(firstPath);
  } catch {
    firstStat = undefined;
  }
  if (firstStat?.isSymbolicLink()) {
    let linkTarget: string;
    try {
      linkTarget = resolve(dirname(firstPath), readlinkSync(firstPath));
    } catch {
      throw new AccessDeniedError(`Path cannot be resolved: ${origin}`);
    }
    return canonicalTarget(rest.length > 0 ? resolve(linkTarget, ...rest) : linkTarget, hops + 1, origin);
  }
  return resolve(canonicalParent, suffix);
}
```

Add `lstatSync`, `readlinkSync` and `type Stats` to the `node:fs` import. Keep the public signature compatible: every existing caller passes one argument, and `hops`/`origin` are internal. `origin` keeps error messages naming the caller's input rather than an internal link target.

**Verify**: `bunx tsx src/roots.test.ts` → exit 0, and `bunx tsx src/executor-root-policy.test.ts` → exit 0.

### Step 3: Full gates

**Verify**:
- `bun run typecheck` → exit 0
- `bun run test` → exit 0
- `bun run build:check` → exit 0

## Test plan

- Four new cases in `src/roots.test.ts`: dangling file link out (rejected), dangling dir link out (rejected), dangling link in (allowed, resolves to the target), loop (rejected).
- One executor-level case in `src/executor-root-policy.test.ts`. It proves end to end that `write_file` is rejected and no file is created outside roots.
- All existing assertions stay unchanged, including the alias case `canonicalTarget(join(alias, "project", "new-file.txt")) === join(project, "new-file.txt")`.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0
- [ ] `grep -c "lstatSync" src/roots.ts` prints `2` (import + call site)
- [ ] `grep -c '"planted"' src/roots.test.ts src/executor-root-policy.test.ts` → `1` in each file
- [ ] `git status --porcelain -- src` lists exactly `src/executor-root-policy.test.ts`, `src/roots.test.ts`, `src/roots.ts`
- [ ] `plans/README.md` row for 009 updated

## STOP conditions

- The Step 1 tests pass before the fix.
- An existing assertion in `roots.test.ts`, `executor-root-policy.test.ts`, `workspaces.test.ts` or `skills.test.ts` fails after Step 2.
- The fix appears to require changing Pi's write tool or `src/pi-tools.ts`.
- `resolveWritePath` no longer returns `canonicalPath` (then the write target model has changed; re-assess).

## Maintenance notes

- `canonicalTarget` now follows a dangling link at the first missing component. It only stops at a component that truly does not exist. Reviewers should check that the loop limit cannot be bypassed and that relative link targets resolve against the link's directory, not the process cwd.
- A residual TOCTOU remains: a link swapped between authorization and write. Closing it means fd-relative, no-follow writes in the Pi tool layer. Revisit only if file-tool confinement becomes a hard boundary. Today it is not, because the shell is unconfined.
