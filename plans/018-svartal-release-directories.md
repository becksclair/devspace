# Plan 018: Serve the Svartal gateway from immutable release directories instead of the working checkout

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 63d6d81..HEAD -- AGENTS.md package.json scripts/ docs/svartal-gateway.md src/build-metadata.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> **Production safety (read before anything else)**: this plan is about a live
> service. You build tooling and documentation only. You never run
> `release:activate`, never call `launchctl`, and never write under
> `~/.local/bin`, `~/.local/opt`, or `~/Library/LaunchAgents`. Do all work in a
> separate git worktree or clone, never in `/Users/rclair/projects/devspace`.

## Status

- **Priority**: P1
- **Effort**: M (Step 1 alone is S and is worth landing first)
- **Risk**: MED — changes how production is deployed; the cutover itself is an operator step outside this plan's execution
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `63d6d81`, 2026-11-11

## Why this matters

The public DevSpace gateway on the macOS host Svartal runs directly out of the
development checkout: its launcher executes
`~/projects/devspace/dist/cli.js` and loads `node_modules` from the same
directory. `AGENTS.md` calls `bun run build:check` a "Non-mutating build" and
tells agents to run it, but that command deletes `dist` and rebuilds it. An
agent or person following the guide in that checkout breaks new MCP sessions
and widgets on the live gateway, and `bun install` there swaps dependencies
under the running process. In addition, `/healthz` reports the checkout's
current `git rev-parse HEAD`, not the commit the running `dist` was built
from, so production cannot be identified reliably. After this plan, the guide
is truthful immediately (Step 1), and the repository has a tested way to build
a self-contained release directory per commit and switch the gateway to it
with a health check and automatic rollback. The one-time cutover is a
documented operator step.

## Current state

Facts verified at planning time:

- The launcher on Svartal (outside the repository, `~/.local/bin/devspace-gateway`)
  ends with:
  `exec "$HOME/.local/share/mise/installs/node/24/bin/node" "$HOME/projects/devspace/dist/cli.js" gateway --config "$HOME/.config/devspace-svartal/gateway.json"`.
  It is started by the LaunchAgent `com.rclair.devspace-gateway`, whose
  `WorkingDirectory` is `/Users/rclair/projects/devspace`. The gateway listens
  on `127.0.0.1:7679`.
- `package.json` scripts:

  ```json
  "clean": "node -e \"require('node:fs').rmSync('dist', { recursive: true, force: true })\"",
  "build:compile": "bun run clean && bun run build:app && tsc -p tsconfig.build.json",
  "build:check": "bun run build:compile",
  ```

- `AGENTS.md:43`:
  `| Non-mutating build (clean, \`vite build\` into \`dist/ui\`, then \`tsc -p tsconfig.build.json\`) | \`bun run build:check\` |`
- `AGENTS.md:75`: "When `DEVSPACE_WIDGETS` is not `off`, the server reads
  `dist/ui/.vite/manifest.json`; run `bun run build:check` once on a fresh
  clone before `bun run dev` or `bun run start`."
- `src/build-metadata.ts:7-10` (why `/healthz` is not a build identity today):

  ```ts
  function sourceCommit(): string {
    if (process.env.DEVSPACE_SOURCE_COMMIT?.trim()) return process.env.DEVSPACE_SOURCE_COMMIT.trim();
    try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown"; } catch { return "unknown"; }
  }
  ```

- The gateway's `/healthz` returns `{ ok, role: "gateway", packageVersion,
  sourceCommit, protocolMajor }` (`src/server.ts:1951-1959`).
- `scripts/package-runtime-artifact.mjs` already builds a self-contained
  runtime for Linux CI. The part to imitate (lines 40-48, abridged):

  ```js
  cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
  cpSync(join(root, "package.json"), join(stage, "package.json"));
  cpSync(lockfilePath, join(stage, basename(lockfilePath)));
  writeFileSync(join(stage, "dist/build-metadata.js"), `export const PROTOCOL_MAJOR = 1;\nexport function toolContractHash() { return ${JSON.stringify(toolContractHash)}; }\nexport function getBuildMetadata(role) { return { protocolMajor: 1, packageVersion: ${JSON.stringify(packageJson.version)}, sourceCommit: ${JSON.stringify(commit)}, toolContractHash: ${JSON.stringify(toolContractHash)}, ...(role ? { role } : {}) }; }\n`);
  … spawnSync("bun", ["install", "--production", "--frozen-lockfile"], { cwd: stage, stdio: "inherit" })
  ```

  It then writes `artifact.json`, runs `scripts/smoke-runtime-artifact.mjs
  <stage>`, and creates a tarball with GNU tar flags that macOS `tar` does not
  accept. Its `readToolContractHash()` (lines 82-90) imports
  `TOOL_CONTRACT_HASH` from the built `dist/tool-contract.js`. A staged
  directory of `dist` + `package.json` + `bun.lock` + production
  `node_modules` is enough to run: runtime paths resolve from
  `import.meta.url`.
- `scripts/smoke-runtime-artifact.mjs <dir>` reads `<dir>/artifact.json`
  (requires `service_id: "devspace"`, `node_major: 24`, `protocol_major: 1`),
  starts the node role on port 17679 and the gateway role on port 17676 from
  `<dir>/dist/cli.js` with state inside `<dir>`, checks that the reported
  `sourceCommit` equals `artifact.json`'s `source_commit`, and removes its
  temporary files.
- `scripts/rebuild-local.mjs` is Linux and systemd only and is welded to the
  version-bumping build. Do not extend it.
- `.gitea/workflows/publish-runtime-artifact.yml` runs
  `scripts/package-runtime-artifact.mjs` on every push to `main` and then
  dispatches a deploy to another host. That lane must keep working unchanged.
- State, configuration, and secrets for Svartal already live outside the
  checkout (`~/.local/state/devspace-gateway`, `~/.config/devspace-svartal`,
  `~/.devspace`).
- The current deploy runbook is `docs/svartal-gateway.md:76-96` ("In
  `~/projects/devspace`, save the current `dist` for rollback, update to a
  revision that includes the bridge, and run `bun run build:check`.").

Decision this plan implements (made by the advisor after comparing a
documentation-only guard, a dedicated release checkout, immutable release
directories, and extending the CI artifact lane to macOS): **immutable release
directories under an app root, with a `current` symlink**, built by a new
script that never touches production (`prepare`) and switched by a separate
operator-only command (`activate`). The documentation guard ships first as its
own commit because it is true today and stays true until the cutover.

Layout the tooling creates (default app root `~/.local/opt/devspace`,
overridable with `--app-root` or `DEVSPACE_APP_ROOT`):

```text
<app-root>/releases/<full-commit>/   dist/, node_modules/, package.json, bun.lock, artifact.json
<app-root>/current   -> releases/<full-commit>     (what the launcher runs)
<app-root>/previous  -> releases/<full-commit>     (the release before the last switch)
```

Conventions:

- Scripts are plain ESM `.mjs` using only Node built-ins (see
  `scripts/release-utils.mjs`).
- Script tests run under `node --test` (see `scripts/release-utils.test.mjs`)
  and are listed first in the `"test"` script of `package.json`.
- Commit style: conventional commits, for example
  `fix(scripts): spawn native package-manager binaries directly`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install (in your worktree only) | `bun install --frozen-lockfile` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Script tests | `node --test scripts/release-utils.test.mjs scripts/local-release.test.mjs` | all pass |
| Full suite (about 65 s, needs `tmux`) | `bun run test` | exit 0 |

Never run: `bun run release:activate`, `launchctl`, `bun run build`,
`bun run rebuild:local`, `bun run test:t3-live`, `bun run test:t3-deployed`,
`bun test`.

## Scope

**In scope** (the only files you should modify):

- `AGENTS.md`
- `scripts/local-release.mjs` (create)
- `scripts/local-release.test.mjs` (create)
- `package.json` (two new scripts; add the new test file to the `node --test` part of `"test"`)
- `docs/svartal-gateway.md`
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):

- `scripts/package-runtime-artifact.mjs`, `scripts/smoke-runtime-artifact.mjs`,
  `scripts/rebuild-local.mjs`, `scripts/versioned-build.mjs`, and both
  workflow files under `.gitea/workflows/` — the Linux artifact lane
  auto-deploys; do not refactor it. Duplicating its ten staging lines is
  deliberate.
- `src/**` — no runtime code changes. In particular do not change
  `src/build-metadata.ts`; a staged release replaces the built
  `dist/build-metadata.js` instead.
- The launcher, the LaunchAgent, and anything under `~/.local` or `~/Library`.
- Bumping `package.json` `version` or editing `CHANGELOG.md`.

## Git workflow

- Branch: `advisor/018-svartal-release-directories`, created from the integration branch `advisor/audit-2026-11-11`.
- Step 1 is its own commit (`docs(agents): say that build:check rewrites dist and that the Svartal checkout serves production`), so it can be merged alone.
- Later steps: `feat(scripts): add local release directories with health-checked activation`, then a docs commit.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make `AGENTS.md` truthful (own commit)

1. Replace the table row at `AGENTS.md:43` with:
   `| Build without a version bump. Deletes and rewrites \`dist\` (clean, \`vite build\` into \`dist/ui\`, then \`tsc -p tsconfig.build.json\`) | \`bun run build:check\` |`
2. Under "## Never run unless explicitly asked", add a bullet:
   "On Svartal, `/Users/rclair/projects/devspace` is the checkout the
   production gateway runs from (`~/.local/bin/devspace-gateway` executes its
   `dist/cli.js`). In that checkout, `bun run build:check`, `bun run build`,
   `bun install`, and `bun update` replace files the live gateway loads, so
   they are deploy steps. Build and test in a separate git worktree or clone."
3. In the bullet at `AGENTS.md:75`, change "once on a fresh clone" to "once on
   a fresh clone or worktree (never in the serving checkout described above)".

**Verify**: `grep -n "Non-mutating" AGENTS.md` → no matches.
`grep -c "serving checkout\|production gateway runs from" AGENTS.md` → `2` or more.
Commit.

### Step 2: Add `prepare` — build a self-contained release directory

Create `scripts/local-release.mjs` (ESM, Node built-ins only). It exports
functions and runs a CLI only when executed directly:

```js
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
```

`main` dispatches `prepare [<rev>] [--app-root <dir>]` and
`activate <rev> --label <launchd-label> --health-url <url> [--app-root <dir>]`,
prints errors as `[devspace:release] <message>`, and sets
`process.exitCode = 1` on failure.

Export `defaultAppRoot(env = process.env)` →
`resolve(env.DEVSPACE_APP_ROOT || join(homedir(), ".local", "opt", "devspace"))`.

Export `prepareRelease({ rev = "HEAD", appRoot, repoRoot })`:

1. `commit` = output of `git rev-parse --verify <rev>^{commit}` in `repoRoot`
   (the directory above `scripts/`). It must match `/^[0-9a-f]{40}$/`.
2. `target = <appRoot>/releases/<commit>`. If it exists, print
   `release <commit> already prepared at <target>` and return.
3. Create `<appRoot>/releases`. Create a build directory with
   `mkdtempSync(join(tmpdir(), "devspace-release-build-"))` and run, with
   `stdio: "inherit"` and a thrown error on a non-zero exit:
   - `git worktree add --detach <build> <commit>` (cwd `repoRoot`)
   - `bun install --frozen-lockfile` (cwd `<build>`)
   - `bun run build:check` (cwd `<build>`)
4. Stage into `<appRoot>/releases/.stage-<pid>`: copy `<build>/dist`,
   `<build>/package.json`, `<build>/bun.lock`; overwrite
   `<stage>/dist/build-metadata.js` with exactly the text the packager writes
   (shown in "Current state"), using `commit`, the staged `package.json`
   version, and the tool contract hash; run
   `bun install --production --frozen-lockfile` in the stage.
   Read the tool contract hash the way the packager does: run
   `node --input-type=module -e 'import { TOOL_CONTRACT_HASH } from "./dist/tool-contract.js"; console.log(TOOL_CONTRACT_HASH)'`
   with cwd `<build>`, strip an optional `sha256:` prefix, require 64 hex
   characters, and store it as `sha256:<hex>`.
5. Write `<stage>/artifact.json` as one line of JSON plus a newline:
   `{ schema_version: "saga-service-artifact/v1", service_id: "devspace",
   source_commit: commit, package_version, package_lock_sha256:
   "sha256:<sha256 of bun.lock>", platform: \`${process.platform}-${process.arch}\`,
   node_major: 24, protocol_major: 1, tool_contract_hash, entrypoints: {
   gateway: ["node", "dist/cli.js", "gateway"], node: ["node", "dist/cli.js",
   "node"] }, health_path: "/healthz" }`.
6. Run `node <repoRoot>/scripts/smoke-runtime-artifact.mjs <stage>`; a non-zero
   exit is an error.
7. `renameSync(stage, target)` and print the target path.
8. In `finally`: remove the stage if it still exists, run
   `git worktree remove --force <build>` (ignore its result), and remove the
   build directory.

`prepare` must never create or change `current` or `previous`, and never call
`launchctl`.

Add to `package.json` `"scripts"`:
`"release:prepare": "node scripts/local-release.mjs prepare"` and
`"release:activate": "node scripts/local-release.mjs activate"`.

**Verify (this is the feasibility gate; commit your work first so `HEAD`
contains the new script)**:

```bash
scratch="$(mktemp -d)"
DEVSPACE_APP_ROOT="$scratch" node scripts/local-release.mjs prepare
commit="$(git rev-parse HEAD)"
test -f "$scratch/releases/$commit/dist/cli.js" && echo dist-ok
test -f "$scratch/releases/$commit/dist/ui/.vite/manifest.json" && echo ui-ok
test -d "$scratch/releases/$commit/node_modules/better-sqlite3" && echo deps-ok
grep -c "\"source_commit\":\"$commit\"" "$scratch/releases/$commit/artifact.json"
test ! -e "$scratch/current" && echo no-current
git worktree list | grep -c devspace-release-build- ; git status --short
```

Expected: exit 0 from `prepare`; `dist-ok`, `ui-ok`, `deps-ok`; `1`;
`no-current`; `0` leftover build worktrees; `git status --short` prints
nothing. Running `prepare` a second time prints `already prepared` and exits
0. Remove `$scratch` afterwards. If the smoke test cannot bind ports 17676 or
17679 because something else uses them, report that instead of changing the
smoke script.

### Step 3: Add `activate` — switch, restart, probe, roll back

In `scripts/local-release.mjs`, export:

- `currentRelease(appRoot, name = "current")` → the commit directory name the
  symlink points to, or `undefined` when the link does not exist.
- `pointLink(appRoot, name, commit)` → create a symlink to
  `releases/<commit>` (relative target) at `<appRoot>/<name>.tmp-<pid>`, then
  `renameSync` it over `<appRoot>/<name>` so the switch is atomic.
- `pruneReleases(appRoot, keep)` → remove every directory in
  `<appRoot>/releases` whose name is not in the `keep` set and does not start
  with `.`.
- `activateRelease({ appRoot, commit, restart, probe })` (async):

  ```js
  if (!existsSync(join(appRoot, "releases", commit, "dist", "cli.js"))) {
    throw new Error(`release ${commit} is not prepared under ${appRoot}`);
  }
  const previous = currentRelease(appRoot);
  pointLink(appRoot, "current", commit);
  await restart();
  if (!(await probe(commit))) {
    if (previous && previous !== commit) {
      pointLink(appRoot, "current", previous);
      await restart();
      const restored = await probe(previous);
      throw new Error(`release ${commit} did not become healthy; ${restored ? `restored ${previous}` : `restoring ${previous} also failed`}`);
    }
    throw new Error(`release ${commit} did not become healthy and there is no previous release to restore`);
  }
  if (previous && previous !== commit) pointLink(appRoot, "previous", previous);
  pruneReleases(appRoot, new Set([commit, currentRelease(appRoot, "previous")].filter(Boolean)));
  return { commit, previous };
  ```

The `activate` CLI wires real dependencies and has **no defaults** for the
label or the health URL, so nothing reaches production by accident:

- Require `process.platform === "darwin"`, `--label`, and `--health-url`;
  otherwise fail with a usage message.
- Resolve `<rev>` to a full commit with `git rev-parse` as in `prepare`.
- `restart` = `launchctl kickstart -k gui/<uid>/<label>` where `<uid>` is
  `process.getuid()`; a non-zero exit throws.
- `probe(commit)` = poll the health URL every 500 ms for up to 30 s; succeed
  when the JSON body has `ok === true` and `sourceCommit === commit`.

Create `scripts/local-release.test.mjs` (`node:test`, `node:assert/strict`,
temporary directories). Build fake releases as
`<appRoot>/releases/<name>/dist/cli.js` and inject `restart` and `probe`.
Cover:

1. First activation with no `current`: `current` points at the release, no
   `previous` link exists, `restart` ran once.
2. Second activation: `current` points at the new release and `previous` at
   the old one.
3. Failed probe (`probe` returns `false` for the new commit, `true`
   otherwise): the call rejects with a message containing `restored`,
   `current` points at the old release again, `restart` ran twice.
4. Prune: with releases `a`, `b`, `c`, `d` and a `.stage-1` directory,
   `current` → `b`, `previous` → `a`, activating `d` leaves exactly `b`, `d`,
   and `.stage-1`.
5. Activating a commit with no release directory rejects, leaves `current`
   unchanged, and never calls `restart`.

Change the start of the `"test"` script in `package.json` from
`node --test scripts/release-utils.test.mjs` to
`node --test scripts/release-utils.test.mjs scripts/local-release.test.mjs`.

**Verify**:
`node --test scripts/release-utils.test.mjs scripts/local-release.test.mjs` →
all tests pass, including five new ones.
`node scripts/local-release.mjs activate HEAD` (no label, no URL) → exits
non-zero with the usage message and does nothing else.

### Step 4: Document deploy, cutover, and rollback

In `docs/svartal-gateway.md`:

1. Add a section "## Release directories" after the component table. State
   that `bun run release:prepare [<rev>]` builds
   `~/.local/opt/devspace/releases/<commit>` from a clean temporary worktree
   and never touches the running gateway, and that
   `bun run release:activate <rev> --label com.rclair.devspace-gateway
   --health-url http://127.0.0.1:7679/healthz` switches `current`, restarts
   the LaunchAgent, waits for `/healthz` to report that commit, and switches
   back on failure. Say that `release:activate` must be run from a local
   terminal on Svartal, not through DevSpace's own shell or terminal tools
   (restarting the gateway kills its children).
2. Add "### One-time cutover (operator)" with these steps, marked as not yet
   done:
   1. On merged `main`: `bun run release:prepare`.
   2. `ln -sfn "releases/$(git rev-parse HEAD)" ~/.local/opt/devspace/current`
   3. Copy the launcher to `~/.local/bin/devspace-gateway.pre-release-root`,
      then replace its final `exec` line with:

      ```bash
      cd "$HOME/.local/opt/devspace/current"
      app="$(pwd -P)"
      exec "$HOME/.local/share/mise/installs/node/24/bin/node" "$app/dist/cli.js" gateway --config "$HOME/.config/devspace-svartal/gateway.json"
      ```

      (`pwd -P` pins the process to the real release directory; the `cd` also
      replaces the LaunchAgent's working directory, so the plist needs no
      change.)
   4. `launchctl kickstart -k gui/$(id -u)/com.rclair.devspace-gateway`
   5. Check `ps -o command= -p "$(pgrep -f 'dist/cli.js gateway')"` shows
      `releases/<commit>/dist/cli.js`, and that
      `curl -fsS http://127.0.0.1:7679/healthz` and the public `/healthz`
      report that commit.
   6. Update the Runtime row of the component table and remove the
      "production gateway runs from" bullet from `AGENTS.md`.
   Cutover rollback: restore the launcher backup and restart. This needs the
   checkout's `dist` to be intact, so the `AGENTS.md` rule applies until the
   cutover is verified.
3. Add "### Routine deploy and rollback": `release:prepare`, then
   `release:activate`; rollback is `release:activate <previous-commit> …` or
   automatic on a failed health check.
4. In the "T3 Code bridge" section, replace enable step 1 ("In
   `~/projects/devspace`, save the current `dist` for rollback … run
   `bun run build:check`.") with a pointer to the release sections, keeping
   the old in-checkout procedure as "before the cutover" text, and replace
   "restore the saved `dist` before restarting" likewise.

In `AGENTS.md`: add `bun run release:prepare` to the Commands table ("Build a
self-contained release directory for this host; does not touch the running
gateway"), and add `bun run release:activate` to "Never run unless explicitly
asked" ("switches the live Svartal gateway to a prepared release and restarts
it").

**Verify**: `grep -c "release:activate" docs/svartal-gateway.md AGENTS.md` →
each at least `1`. `bun run typecheck` → exit 0. `bun run test` → exit 0.

## Test plan

- `scripts/local-release.test.mjs`: the five activation cases in Step 3, with
  injected `restart` and `probe`, on temporary directories.
- `prepare` is verified by the scratch run in Step 2, whose built-in smoke
  test boots the staged gateway and node on test ports and checks the baked
  commit.
- Pattern: `scripts/release-utils.test.mjs`.
- Verification: `bun run test` → exit 0.

## Done criteria

- [ ] `grep -n "Non-mutating" AGENTS.md` returns no matches
- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0 and runs `scripts/local-release.test.mjs`
- [ ] The Step 2 scratch `prepare` run produced all expected outputs, and a second run reported `already prepared`
- [ ] `node scripts/local-release.mjs activate HEAD` exits non-zero with a usage message
- [ ] `git diff --stat 63d6d81..HEAD -- scripts/package-runtime-artifact.mjs scripts/smoke-runtime-artifact.mjs .gitea src` prints nothing
- [ ] `git status --short` lists only in-scope files; `git worktree list` shows no `devspace-release-build-` entry
- [ ] `plans/README.md` status row updated, noting that the operator cutover is still pending

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the repository.
- The Step 2 scratch `prepare` fails on this machine at
  `bun install --production --frozen-lockfile` or in the smoke test, and the
  cause is not a mistake in your script. Report the output; the fallback (a
  dedicated release checkout) is a different plan.
- Any step would require running `release:activate` with a real label,
  calling `launchctl`, or writing outside the repository and your scratch
  directory.
- The fix appears to require changing `scripts/package-runtime-artifact.mjs`,
  a workflow file, or anything under `src/`.
- Your working directory is `/Users/rclair/projects/devspace`. Move to a
  separate worktree or clone first.

## Maintenance notes

- Until the operator performs the one-time cutover, production still runs from
  the checkout and the Step 1 rule in `AGENTS.md` is the only protection.
- After the cutover the gateway's working directory is the release directory.
  Settings that fell back to the old working directory (unset allowed roots
  default to `process.cwd()` in `src/config.ts:121,130` and
  `src/server.ts:2221`) must be explicit in the gateway configuration; Svartal's
  configuration already sets roots.
- `artifact.json` in a local release reuses the CI schema with the local
  platform string. If the CI lane ever installs onto macOS, it can install
  into the same layout.
- `packageVersion` in `/healthz` stays whatever `package.json` says; release
  identity is `sourceCommit`.
- Reviewer focus: that `prepare` cannot reach `current`, that `activate` has no
  default label or URL, and the rollback path in `activateRelease`.
- Deferred: a detached mode for running `activate` remotely through DevSpace
  itself; publishing a macOS artifact from CI.
