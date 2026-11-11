# Plan 023: Clear the high-severity dependency advisories with an in-range refresh

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 63d6d81..HEAD -- package.json bun.lock`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live files before proceeding; on a mismatch,
> treat it as a STOP condition. A change that only appends test files to the
> `"test"` script (plans 016, 017, 018) is expected and is not a mismatch.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: migration
- **Planned at**: commit `63d6d81`, 2026-11-11

## Why this matters

`bun audit` reports 37 advisories, 10 of them high. An earlier audit assumed
the fix needed a major upgrade of `@earendil-works/pi-coding-agent`. It does
not: six packages can move within their existing semver ranges, and one
override lifts `undici` to a patched release of the same major version. A dry
run of exactly these changes on a copy of `package.json` and `bun.lock`
reduced the report from 37 advisories to 1 moderate. Five of the cleared
moderates are in `ip-address`, which sits under the rate limiter on the public
OAuth endpoints.

## Current state

Files:

- `package.json` — dependency ranges and the `overrides` block.
- `bun.lock` — the lockfile CI installs from with `--frozen-lockfile`.

`bun audit` at planning time, by package:

| Package (locked) | Advisories | Why it is locked there | Fixed in |
|---|---|---|---|
| `undici@8.9.0` | 6 high, 9 moderate, 3 low | `@earendil-works/pi-coding-agent@0.84.3` requires exactly `8.9.0` | `8.12.2` per the advisory ranges at planning time (`<8.10.2` and `<8.12.2`); the dry run resolved `8.12.4`, the newest `8.x` |
| `vite@8.2.2` | 1 high, 4 moderate, 1 low | direct devDependency `^8.2.2`; lock is stale | `8.3.8` |
| `source-map-js@1.2.1` | 1 high | `vite > postcss` requires `^1.2.1` | `1.2.2` |
| `brace-expansion@5.0.9` | 2 high, 1 moderate | `pi-coding-agent > minimatch` requires `^5.0.5` | `5.0.12` |
| `ip-address@10.5.0` | 5 moderate | `express-rate-limit` requires `^10.2.0` | `10.7.6` |
| `hono@4.13.5` | 2 moderate | `@modelcontextprotocol/sdk` requires `^4.11.4` | `4.13.17` |
| `@hono/node-server@2.1.1` | 1 moderate | `@modelcontextprotocol/sdk` | `2.1.6` |
| `minimatch@10.2.5` | 1 moderate | `pi-coding-agent` requires exactly `10.2.5` | `11.0.1` (not in reach; stays) |

`package.json` today:

```json
	"devDependencies": {
		…
		"vite": "^8.2.2"
	},
	"overrides": {
		"body-parser": ">=2.4.0 <3",
		"fast-uri": ">=3.1.9 <4",
		"protobufjs": "7.6.6",
		"proxy-addr": ">=2.0.8 <3",
		"ws": "8.21.3"
	}
```

The file is indented with tabs. `bun pm why undici` prints:

```text
undici@8.9.0
  └─ @earendil-works/pi-coding-agent@0.84.3 (requires 8.9.0)
```

The dry run (Bun 1.4.4, on copies of the two files in a scratch directory):

```text
$ bun update vite source-map-js brace-expansion ip-address hono @hono/node-server --lockfile-only
^ @hono/node-server 2.1.1 -> 2.1.6
^ brace-expansion 5.0.9 -> 5.0.12
^ hono 4.13.5 -> 4.13.17
^ ip-address 10.5.0 -> 10.7.6
^ source-map-js 1.2.1 -> 1.2.2
^ vite 8.2.2 -> 8.3.8
Saved bun.lock (386 packages)

$ bun audit
minimatch@10.2.5 … moderate …
1 vulnerability (1 moderate)
```

`bun update` rewrote the `vite` range in `package.json` to `^8.3.8`; with the
`undici` override that was the only other change to `package.json`.

Why the `undici` override is safe to try: DevSpace never installs that
`undici` as Node's global dispatcher. Only the Pi CLI and RPC entry points do
(`node_modules/@earendil-works/pi-coding-agent/dist/cli.js`,
`dist/rpc-entry.js`, `dist/main.js`), and DevSpace imports the library API
(`src/pi-tools.ts`, `src/skills.ts`, `src/shell-environment.ts`, `src/cli.ts`),
not those entry points. DevSpace's own `fetch` calls use Node's built-in
implementation. The test suite exercises the Pi-backed file and shell tools.

Conventions and environment:

- CI (`.github/workflows/ci.yml`) installs with Bun `1.4.0` and
  `bun install --frozen-lockfile`.
- Pushing `main` to Gitea builds a runtime artifact from the lockfile and
  dispatches a deployment (`.gitea/workflows/publish-runtime-artifact.yml`).
- Commit style: conventional commits, for example
  `chore(deps): raise MCP SDK, zod and express floors to clear audit highs`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install (in your worktree only) | `bun install --frozen-lockfile` | exit 0 |
| Advisory report | `bun audit` | see Step 2 |
| Typecheck | `bun run typecheck` | exit 0 |
| Full suite (about 65 s, needs `tmux`) | `bun run test` | exit 0 |
| Build, including the Vite UI (separate worktree or clone only) | `bun run build:check` | exit 0 |

Do **not** run `bun test`, `bun run build`, `bun run rebuild:local`,
`bun run test:t3-live`, `bun run test:t3-deployed`, `bun audit fix`, or a bare
`bun update` (it would move every dependency). **This plan must run in a
separate git worktree or clone.** On the host Svartal the checkout
`/Users/rclair/projects/devspace` serves the production gateway and loads
`node_modules` from that directory; installing there swaps dependencies under
the live process.

## Scope

**In scope** (the only files you should modify):

- `package.json` (the `vite` range and one new `overrides` entry)
- `bun.lock`
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):

- Upgrading `@earendil-works/pi-coding-agent` to 1.x, or overriding
  `minimatch` across a major version.
- Any other direct dependency (`react`, `@pierre/diffs`, `drizzle-orm`,
  `@clack/prompts`, `express-rate-limit`, …), even though newer versions exist.
- The existing overrides (`body-parser`, `fast-uri`, `protobufjs`,
  `proxy-addr`, `ws`). `proxy-addr` is now redundant and the two exact pins
  block later patches, but changing them is not needed to clear an advisory.
- Source files, tests, and CI workflows.

## Git workflow

- Branch: `advisor/023-dependency-advisory-refresh`, created from the
  integration branch `advisor/audit-2026-11-11`.
- One commit: `chore(deps): refresh in-range packages and override undici to clear audit highs`
- Do NOT push or open a PR unless the operator instructed it. A push to `main`
  triggers an artifact build and a deployment dispatch.

## Steps

### Step 1: Record the baseline

**Verify**: `pwd` is not `/Users/rclair/projects/devspace`.
`bun install --frozen-lockfile` → exit 0.
`bun audit 2>&1 | tail -4` → reports `37 vulnerabilities (10 high, 23
moderate, 4 low)`. A different total is acceptable (advisories change daily),
but if there are **no** high advisories, STOP: the work is already done.

### Step 2: Apply the override and refresh the six packages

1. In `package.json`, add `"undici": ">=8.12.4 <9",` to `overrides`, between
   the `proxy-addr` and `ws` lines. Keep the tab indentation.
2. Run:

   ```bash
   bun update vite source-map-js brace-expansion ip-address hono @hono/node-server
   ```

**Verify**:

- `git status --short` → exactly ` M bun.lock` and ` M package.json`
- `git diff package.json` → exactly two changes: `"vite": "^8.2.2"` became a
  higher `^8.x` range, and the `undici` override line was added. No other
  dependency line changed.
- `bun pm why undici 2>&1 | head -2` → shows `undici@8.12.4` or a later `8.x`
- `bun audit 2>&1 | grep -c -E "^\s+(high|critical):"` → `0`
- `bun audit 2>&1 | tail -4` → at planning time `1 vulnerability (1 moderate)`
  (`minimatch`). More moderates or lows are acceptable if they are new
  advisories unrelated to the packages in the table above.
- `rm -rf node_modules && bun install --frozen-lockfile` → exit 0 (the
  lockfile is self-consistent)

### Step 3: Prove nothing broke

**Verify**:

- `bun run typecheck` → exit 0
- `bun run test` → exit 0
- `bun run build:check` → exit 0 (this is the only check that exercises the
  new Vite)
- `git status --short` → still only `bun.lock` and `package.json`

Commit.

## Test plan

No new tests. The change is covered by the existing suite (the Pi-backed file
and shell tools run under the overridden `undici` tree, the rate-limit suites
run on the new `ip-address`, and the MCP suites run on the new `hono`) and by
`bun run build:check` for Vite.

## Done criteria

- [ ] `bun audit` reports no high or critical advisory
- [ ] `bun install --frozen-lockfile` exits 0 from a clean `node_modules`
- [ ] `bun run typecheck`, `bun run test`, and `bun run build:check` exit 0
- [ ] `git diff --stat "$(git merge-base HEAD advisor/audit-2026-11-11)"..HEAD -- src scripts .github .gitea` prints nothing (the merge base is the commit your plan branch started from, so source changes merged by other plans are not counted)
- [ ] `git diff package.json` shows only the `vite` range and the `undici` override (plus test-script edits from other plans, if present before you started)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Your working directory is `/Users/rclair/projects/devspace`.
- `bun update` changes any direct dependency range other than `vite`, or the
  lockfile's `lockfileVersion` line changes (`git diff bun.lock | grep
  lockfileVersion` prints something): CI pins Bun 1.4.0 and may not read a
  newer lockfile format.
- A test fails after the refresh. Report which suite and whether reverting
  only the `undici` override fixes it; do not start pinning other versions.
- `bun audit` still reports a high advisory for one of the packages in the
  table.

## Maintenance notes

- The remaining `minimatch` moderate goes away only with
  `@earendil-works/pi-coding-agent` 1.x, which pins `minimatch` 11 and
  `undici` 8.12.3. That upgrade touches four import sites and about eleven
  symbols (`src/pi-tools.ts:1-18`, `src/skills.ts:5-8`,
  `src/shell-environment.ts:5`, `src/cli.ts:8`); it is a separate decision.
- Do not remove the `undici` override as a side effect of that upgrade. Pi
  1.5.2 pins `undici` 8.12.3, which the advisories known at planning time do
  not flag (their ranges end at `<8.12.2`), but advisories keep arriving.
  After the upgrade, run `bun pm why undici` and `bun audit`; drop the
  override only if the version Pi pins has no advisory, and keep it otherwise.
- Left as they are: the redundant `proxy-addr` override (Express 5.3 already
  requires `^2.0.8`) and the exact `ws` and `protobufjs` pins.
- Reviewer focus: the `package.json` diff is two lines, and the lockfile diff
  touches only the seven packages named here and their own dependencies.
