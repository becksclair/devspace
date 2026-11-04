# Plan 011: Fix the versioned build and local rebuild so they work when launched by Bun

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 79ddffc..HEAD -- scripts/versioned-build.mjs scripts/rebuild-local.mjs scripts/release-utils.mjs scripts/release-utils.test.mjs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `79ddffc`, 2026-11-04

## Why this matters

Since the npm→Bun migration (commit `dc41e21`), `bun run build` (the versioned
release build) and `bun run rebuild:local` (rebuild, restart
`devspace.service`, verify `/healthz`) both fail. Their `spawnPm` helper
assumes `npm_execpath` points at a JavaScript file (`npm-cli.js`) and runs it
with `node`. Under `bun run`, `npm_execpath` is the **Bun native binary**
(`~/.bun/bin/bun`), so the scripts execute `node /path/to/bun run build:compile`,
and node fails trying to parse an ELF file. The failure was reproduced at
`79ddffc`: `node <bun> --version` exits 1. CI only runs `build:check`, so
nothing caught it. The package version has been stuck at 2.0.0 ever since.

## Current state

- `package.json` scripts: `"build": "node scripts/versioned-build.mjs"`, `"rebuild:local": "node scripts/rebuild-local.mjs"`, `"build:compile": "bun run clean && bun run build:app && tsc -p tsconfig.build.json"`. Both scripts run under real `node` (`process.execPath` is node), while `npm_execpath` is set by `bun run`.
- `scripts/versioned-build.mjs:118-132`:
  ```js
  function spawnPm(args, options) {
    if (process.env.npm_execpath) {
      return spawnSync(process.execPath, [process.env.npm_execpath, ...args], options);
    }

    const hasBunLock = existsSync(join(repoRoot, "bun.lock")) || existsSync(join(repoRoot, "bun.lockb"));
    if (hasBunLock) {
      return spawnSync("bun", args, options);
    }

    return spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      ...options,
      shell: process.platform === "win32",
    });
  }
  ```
  It is called at `:61`: `spawnPm(["run", "build:compile"], { cwd: repoRoot, env: process.env, stdio: "inherit" })`.
- `scripts/rebuild-local.mjs:156-163` has a near-copy (no win32 branch):
  ```js
  function spawnPm(args, options) {
    if (process.env.npm_execpath) {
      return spawnSync(process.execPath, [process.env.npm_execpath, ...args], options);
    }
    const hasBunLock = existsSync(join(repoRoot, "bun.lock")) || existsSync(join(repoRoot, "bun.lockb"));
    if (hasBunLock) return spawnSync("bun", args, options);
    return spawnSync("npm", args, options);
  }
  ```
  It is called at `:47`: `spawnPm(["run", "build", "--", ...process.argv.slice(2)], {...})`.
- `scripts/release-utils.mjs` holds the shared pure helpers. `versioned-build.mjs` imports from it (`import { … } from "./release-utils.mjs"` at lines 5-18). **`rebuild-local.mjs` does not import it at all today.** Its imports (lines 1-12) are only `node:child_process`, `node:fs`, `node:path` and `node:url`, and it keeps its own private `resolveLockfilePath` copy; leave that duplicate alone. Exemplar for a small pure exported helper: `resolveLockfilePath(repoRoot)` at `scripts/release-utils.mjs:143-150`.
- `updatePackageVersions` writes `package.json` with 2-space JSON while the file is tab-indented, so a real versioned build shows a whole-file whitespace reformat plus the version change. That is pre-existing behaviour and out of scope.
- Tests: `scripts/release-utils.test.mjs` uses `node:test` (`test("…", () => { … })`) with `node:assert/strict` and is run by `node --test scripts/release-utils.test.mjs` (the first command in the `package.json` `"test"` script).

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Release-utils tests | `node --test scripts/release-utils.test.mjs` | all pass, `fail 0` |
| Typecheck | `bun run typecheck` | exit 0 |
| All tests | `bun run test` | exit 0 (~65s; needs `tmux`) |
| Build check | `bun run build:check` | exit 0 |

Do **not** run `bun run build` or `bun run rebuild:local` in the main checkout. The first rewrites `package.json`/`CHANGELOG.md`; the second restarts a live service. Step 4 explains how to prove the fix in a disposable worktree.

## Scope

**In scope**: `scripts/release-utils.mjs` (add one exported function), `scripts/release-utils.test.mjs`, `scripts/versioned-build.mjs` and `scripts/rebuild-local.mjs` (replace `spawnPm` bodies only).

**Out of scope**:
- `scripts/dev-server.mjs` (it uses `npx tsx`; a separate cleanup item).
- `scripts/package-runtime-artifact.mjs:47-48`: the same class of `node $npm_execpath …` bug in a different shape. It is a separate item; do not touch it.
- Release semantics: version bumping, changelog generation, release markers.
- CI workflows.

## Git workflow

- Branch: `advisor/011-bun-package-manager-spawn`
- Commit style: `fix(scripts): spawn native package-manager binaries directly`.
- Do NOT push or open a PR unless instructed. Do NOT commit anything produced by the Step 4 worktree run.
- Commit the `plans/README.md` status-row update as a separate final commit (`docs(plans): mark 011 done`) after Step 5.

## Steps

### Step 1: Add a pure command resolver with failing tests

In `scripts/release-utils.test.mjs` add `packageManagerCommand` to the import list and add:

```js
test("package-manager command honours JS and native npm_execpath", () => {
  const base = { execPath: "/usr/bin/node", platform: "linux", hasBunLock: true };
  assert.deepEqual(
    packageManagerCommand(["run", "x"], { ...base, npmExecPath: "/usr/lib/node_modules/npm/bin/npm-cli.js" }),
    { command: "/usr/bin/node", args: ["/usr/lib/node_modules/npm/bin/npm-cli.js", "run", "x"], shell: false },
  );
  assert.deepEqual(
    packageManagerCommand(["run", "x"], { ...base, npmExecPath: "/home/u/.bun/bin/bun" }),
    { command: "/home/u/.bun/bin/bun", args: ["run", "x"], shell: false },
  );
  assert.deepEqual(
    packageManagerCommand(["run", "x"], { ...base, npmExecPath: undefined }),
    { command: "bun", args: ["run", "x"], shell: false },
  );
  assert.deepEqual(
    packageManagerCommand(["run", "x"], { ...base, npmExecPath: undefined, hasBunLock: false, platform: "win32" }),
    { command: "npm.cmd", args: ["run", "x"], shell: true },
  );
  assert.deepEqual(
    packageManagerCommand(["run", "x"], { ...base, npmExecPath: undefined, hasBunLock: false }),
    { command: "npm", args: ["run", "x"], shell: false },
  );
});
```

**Verify**: `node --test scripts/release-utils.test.mjs` → fails with an import/`SyntaxError` for `packageManagerCommand`.

### Step 2: Implement `packageManagerCommand`

In `scripts/release-utils.mjs` add:

```js
export function packageManagerCommand(args, { npmExecPath, execPath, platform, hasBunLock }) {
  if (npmExecPath) {
    if (/\.(c|m)?js$/i.test(npmExecPath)) return { command: execPath, args: [npmExecPath, ...args], shell: false };
    return { command: npmExecPath, args, shell: false };
  }
  if (hasBunLock) return { command: "bun", args, shell: false };
  if (platform === "win32") return { command: "npm.cmd", args, shell: true };
  return { command: "npm", args, shell: false };
}
```

**Verify**: `node --test scripts/release-utils.test.mjs` → all tests pass (`fail 0`).

### Step 3: Use it in both scripts

Replace the body of `spawnPm` in **both** `scripts/versioned-build.mjs` and `scripts/rebuild-local.mjs` with:

```js
function spawnPm(args, options) {
  const resolved = packageManagerCommand(args, {
    npmExecPath: process.env.npm_execpath,
    execPath: process.execPath,
    platform: process.platform,
    hasBunLock: existsSync(join(repoRoot, "bun.lock")) || existsSync(join(repoRoot, "bun.lockb")),
  });
  return spawnSync(resolved.command, resolved.args, { ...options, shell: resolved.shell });
}
```

In `scripts/versioned-build.mjs`, add `packageManagerCommand,` to the existing `import { … } from "./release-utils.mjs"` list (alphabetically, after `isBuildInputPath,`). In `scripts/rebuild-local.mjs`, add a new import line right after `import { fileURLToPath } from "node:url";`: `import { packageManagerCommand } from "./release-utils.mjs";`. Keep `existsSync` and `join` imported (both files already import them).

**Verify**:
- `node --check scripts/versioned-build.mjs && node --check scripts/rebuild-local.mjs` → exit 0
- `grep -n "spawnSync(process.execPath, \[process.env.npm_execpath" scripts/*.mjs` → no matches
- `node --test scripts/release-utils.test.mjs` → `fail 0`

### Step 4: Prove the real flow in a disposable worktree

Commit Steps 1-3 on your branch first, because the versioned build refuses uncommitted build inputs. Then:

```bash
WT=$(mktemp -d)
git worktree add --detach "$WT" HEAD
(cd "$WT" && bun install --frozen-lockfile && bun run build)
```

(A reviewer confirmed that at `79ddffc` a detached worktree passes every versioned-build precondition and, before this fix, fails exactly at `spawnPm` with the node `SyntaxError`.)

**Verify**:
- The output contains the line `$ bun run clean && bun run build:app && tsc -p tsconfig.build.json`, then `$ vite build`, then `Built DevSpace <next patch version>` (`2.0.1` when this plan was written). `tsc` prints nothing on success, so its appearance in that first echoed line is the evidence it ran.
- Exit code 0.
- `git -C "$WT" diff --name-only` → exactly `CHANGELOG.md` and `package.json`. `package.json` shows a large whitespace-only reformat (tabs → 2 spaces) plus the version line. That is pre-existing `updatePackageVersions` behaviour, not a defect, and out of scope.

Clean up whatever the outcome: `git worktree remove --force "$WT"`.

### Step 5: Full gates in the main checkout

**Verify**:
- `bun run typecheck` → exit 0
- `bun run test` → exit 0
- `bun run build:check` → exit 0
- `git status --porcelain` → no `scripts/` entries (they were committed before Step 4), no `package.json`, `CHANGELOG.md`, `dist/` or `releases/` entries. Entries under `plans/` are expected and fine.

## Test plan

- One new `node:test` case in `scripts/release-utils.test.mjs` covering five resolution branches: JS execpath, native execpath (the Bun case), the bun.lock fallback, the win32 npm fallback, and the POSIX npm fallback.
- The real end-to-end run in Step 4, done in a disposable worktree.

## Done criteria

- [ ] `node --test scripts/release-utils.test.mjs` passes, including the new test
- [ ] `bun run test` exits 0
- [ ] Both scripts call `packageManagerCommand`: `grep -c "packageManagerCommand" scripts/versioned-build.mjs scripts/rebuild-local.mjs` → each ≥ 2 (import + call)
- [ ] Step 4 printed `Built DevSpace <next patch version>` with exit 0; worktree removed (`git worktree list` has no entry for `$WT`)
- [ ] `plans/README.md` row for 011 updated

## STOP conditions

- Step 4 shows `spawnPm` is still failing, for example with the node `SyntaxError` on the bun binary.
- `bun run build` in the worktree exits non-zero **before** the `$ bun run clean && …` line appears. That is a precondition failure, and the fix was not exercised. Report the exact message.
- `bun install --frozen-lockfile` fails in the worktree. Do **not** rerun it as plain `bun install`: that may rewrite `bun.lock`, which is a build input, and the versioned build would then refuse to run.
- The scripts no longer define `spawnPm` as shown (already fixed; mark the plan REJECTED with a note).
- You would need to modify `package.json` scripts to make this work.
- Step 4 would require committing to or pushing anything other than your feature branch.

## Maintenance notes

- `packageManagerCommand` is the single place that decides how to re-enter the package manager. If the repository ever adds a `packageManager` field (`"bun@1.4.x"`), extend the resolver to prefer it rather than adding logic to the scripts.
- After this lands, the version will jump from 2.0.0 on the next real `bun run build`. The CHANGELOG has a hand-written `## Unreleased` section that `prependRelease` does not absorb (separate docs finding), so check the generated changelog on the first real release.
