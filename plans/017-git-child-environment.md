# Plan 017: Give git child processes the filtered environment that shells already get

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 63d6d81..HEAD -- src/shell-environment.ts src/git.ts src/git-worktrees.ts src/workspaces.ts src/workspace-capabilities.ts docs/security.md AGENTS.md package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Changes to `src/workspaces.ts` made
> by plan 016 (a new `managedWorkspaceRetentionReason` method with its own git
> calls) are expected and are not a mismatch.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: plans/016-retain-unpublished-managed-work.md (merge order only: both edit git call sites in `src/workspaces.ts`; run 016 first)
- **Category**: security
- **Planned at**: commit `63d6d81`, 2026-11-11

## Why this matters

DevSpace's security model says its control-plane credentials (the OAuth owner
token and the per-node bearers) must not enter development subprocesses, and
`AGENTS.md` says child environments must never copy `process.env`. Shells,
terminals, and MCP bridge children follow that rule. The git processes DevSpace
starts itself do not: they inherit the full service environment. Git runs
programs chosen by the repository (hooks such as `post-checkout` during
`git worktree add`, `core.fsmonitor` during `git status`, credential helpers),
so any repository opened as a workspace can read those credentials. After this
plan, every git child gets the service environment minus the configured secret
names.

## Current state

Files and their git call sites:

- `src/shell-environment.ts` — the only module allowed to build child
  environments. Has `createShellRuntime` (shells and terminals) and
  `bridgeChildEnvironment` (MCP bridges). Add the git function here.
- `src/git.ts` — `git()` helper used by `src/review-checkpoints.ts` and
  `getGitEligibility`.
- `src/git-worktrees.ts` — private `git()` helper for worktree and clone
  creation.
- `src/workspaces.ts` — direct `execFileAsync("git", …)` calls in
  `closeWorkspace`, `cleanupStoredManagedWorkspace`,
  `removeFreshManagedWorkspace`, and (after plan 016)
  `managedWorkspaceRetentionReason`.
- `src/workspace-capabilities.ts` — private `git()` helper used by `probeGit`
  on every `open_workspace` and `workspace_status`.

`src/git.ts:19-31`:

```ts
export async function git(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
): Promise<GitCommandResult> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  });
```

`src/git-worktrees.ts:185-188`:

```ts
async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
```

`src/workspace-capabilities.ts:132-140`:

```ts
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout;
}
```

`src/workspaces.ts` at planning time has four calls of the form
`execFileAsync("git", [...], { cwd: …, maxBuffer: 2 * 1024 * 1024 })` (lines
197, 617, 670, 675), none with `env`.

How the existing filters work (`src/shell-environment.ts:171-188`):

```ts
function normalizeSecretNames(secretNames: string[]): string[] {
  const names = Array.from(new Set(secretNames.map((name) => name.trim()).filter(Boolean))).sort();
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid DevSpace infrastructure secret name: ${name}`);
  }
  return names;
}

export function bridgeChildEnvironment(baseEnvironment: NodeJS.ProcessEnv, secretNames: string[]): Record<string, string> {
```

Where the secret names come from:

- `config.secretNames` (`src/config.ts:444`) always contains
  `DEVSPACE_OAUTH_OWNER_TOKEN` plus the names in `DEVSPACE_INFRA_SECRET_NAMES`.
- A gateway adds each remote machine's bearer variable name
  (`src/server.ts:2244-2249`) and passes that config to its local executors
  (`src/server.ts:2259-2260`, `...publicConfig`).
- A node's config adds its own bearer variable name (`src/cli.ts:147-150`).
- Every git call in the list above runs under a `WorkspaceRegistry`, whose
  constructor receives that config (`src/workspaces.ts:113-118`):

```ts
  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {
    this.shellRuntime = createShellRuntime(config.shell, config.secretNames);
  }
```

Design constraints quoted from the docs (honor them):

- `docs/security.md`, "Child environment filtering": "DevSpace does not delete
  every variable containing `TOKEN`, `KEY`, or `SECRET`. User development tools
  may intentionally require such credentials. Filtering is based on ownership
  by DevSpace's control plane, not broad name heuristics."
  So git children keep `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, `HOME`,
  `PATH`, and every other variable; only the configured names are removed.
  Do **not** reuse `bridgeChildEnvironment` for git: it also strips `GH_TOKEN`
  and `GITHUB_TOKEN`, which git credential helpers need.
- `AGENTS.md`, "Security invariants": "Never copy `process.env` directly."

Conventions:

- Tests are standalone `tsx` scripts using `node:assert/strict`
  (exemplar: `src/bridge-environment.test.ts`); every new `src/*.test.ts` must
  be appended by hand to the `"test"` script in `package.json`.
- Commit style: conventional commits, for example
  `fix(bridges): scrub configured secret names from bridge child environments`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install (in your worktree only) | `bun install --frozen-lockfile` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| One suite | `bunx tsx src/<name>.test.ts` | exit 0 |
| Full suite (about 65 s, needs `tmux`) | `bun run test` | exit 0 |

Do **not** run `bun test`, `bun run build`, `bun run rebuild:local`,
`bun run test:t3-live`, or `bun run test:t3-deployed`. Work in a separate git
worktree or clone: on the host Svartal the checkout
`/Users/rclair/projects/devspace` serves the production gateway from its
`dist/`, so never run `bun run build:check` or `bun install` there.

## Scope

**In scope** (the only files you should modify):

- `src/shell-environment.ts`
- `src/git.ts`
- `src/git-worktrees.ts`
- `src/workspaces.ts`
- `src/workspace-capabilities.ts`
- `src/git-child-environment.test.ts` (create)
- `package.json` (append the new test to the `"test"` script only)
- `docs/security.md` (one paragraph)
- `AGENTS.md` (one bullet under "Security invariants for contributors")
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):

- `createShellRuntime`, `bridgeChildEnvironment`, and their callers — their
  behavior must not change.
- `src/review-checkpoints.ts` — it calls `git()` from `src/git.ts` and is fixed
  by the change there; do not thread parameters through it.
- git commands that the model runs through `run_shell` or terminals — those
  already use the shell runtime's filtered environment.
- `src/build-metadata.ts` (`git rev-parse HEAD` for `/healthz`) and
  `scripts/*.mjs` — build and release tooling, not workspace children.
- Any name heuristic such as stripping every `*_TOKEN`.

## Git workflow

- Branch: `advisor/017-git-child-environment`, created from the integration branch `advisor/audit-2026-11-11`.
- Message style: `fix(git): filter control-plane secrets from git child environments`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the environment function and its unit test

In `src/shell-environment.ts`, after `bridgeChildEnvironment`, add:

```ts
const GIT_ALWAYS_STRIPPED = new Set(["DEVSPACE_OAUTH_OWNER_TOKEN"]);
const registeredGitSecretNames = new Set<string>();

/**
 * Adds control-plane secret names that git children must never receive. The process
 * environment is process-wide, so the names accumulate for the life of the process.
 */
export function registerGitChildSecretNames(secretNames: string[]): void {
  for (const name of normalizeSecretNames(secretNames)) registeredGitSecretNames.add(name);
}

/**
 * Environment for git processes DevSpace starts itself (worktrees, clones, status probes,
 * review snapshots). Git runs repository-configured programs (hooks, fsmonitor, credential
 * helpers), so these children get the service environment minus DevSpace's control-plane
 * secrets. Development credentials such as GH_TOKEN are kept.
 */
export function gitChildEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(baseEnvironment)) {
    if (value === undefined) continue;
    if (GIT_ALWAYS_STRIPPED.has(name) || registeredGitSecretNames.has(name)) continue;
    environment[name] = value;
  }
  return { ...environment, ...overrides };
}
```

Create `src/git-child-environment.test.ts` with a unit section:

```ts
import assert from "node:assert/strict";
import { gitChildEnvironment, registerGitChildSecretNames } from "./shell-environment.js";

registerGitChildSecretNames(["DEVSPACE_TEST_NODE_BEARER"]);
const base = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  GH_TOKEN: "development-credential",
  DEVSPACE_OAUTH_OWNER_TOKEN: "owner",
  DEVSPACE_TEST_NODE_BEARER: "bearer",
  UNDEFINED_VALUE: undefined,
};
const env = gitChildEnvironment({ GIT_DIR: "/tmp/shadow" }, base);
assert.equal(env.PATH, "/usr/bin");
assert.equal(env.GH_TOKEN, "development-credential", "development credentials are kept");
assert.equal(env.GIT_DIR, "/tmp/shadow", "overrides are applied");
for (const name of ["DEVSPACE_OAUTH_OWNER_TOKEN", "DEVSPACE_TEST_NODE_BEARER", "UNDEFINED_VALUE"]) {
  assert.equal(Object.hasOwn(env, name), false, `${name} must not reach git children`);
}
assert.throws(() => registerGitChildSecretNames(["BAD-NAME"]), /Invalid DevSpace infrastructure secret name/);
```

Append `&& tsx src/git-child-environment.test.ts` to the end of the `"test"`
script in `package.json`.

**Verify**: `bunx tsx src/git-child-environment.test.ts` → exit 0.
`bun run typecheck` → exit 0.

### Step 2: Add an end-to-end test that fails today

Append to `src/git-child-environment.test.ts` a second section that proves a
repository hook cannot see the secrets. Model the repository setup on
`src/workspace-maintenance.test.ts:13-34`. Shape:

```ts
// A repository hook run by `git worktree add` records the variable names it can see.
const root = await mkdtemp(join(tmpdir(), "devspace-git-env-test-"));
const source = join(root, "source");
const hookOutput = join(root, "hook-env.txt");
// … git init, user.email, user.name, one commit, as in workspace-maintenance.test.ts …
await git(source, ["config", "core.hooksPath", join(source, ".git", "hooks")]);
const hook = join(source, ".git", "hooks", "post-checkout");
await writeFile(hook, `#!/bin/sh\nenv | cut -d= -f1 > ${JSON.stringify(hookOutput)}\n`);
await chmod(hook, 0o755);

process.env.DEVSPACE_OAUTH_OWNER_TOKEN = "test-owner-token-that-is-long-enough";
process.env.DEVSPACE_TEST_GATEWAY_BEARER = "must-not-reach-hooks";
process.env.GH_TOKEN ??= "development-credential";
const config = loadConfig({
  // same keys as workspace-maintenance.test.ts, plus:
  DEVSPACE_INFRA_SECRET_NAMES: "DEVSPACE_TEST_GATEWAY_BEARER",
});
const registry = new WorkspaceRegistry(config);
const opened = await registry.openWorkspace({ path: source, mode: "isolated" });
try {
  assert.equal(opened.workspace.worktree?.strategy, "worktree");
  const names = (await readFile(hookOutput, "utf8")).split("\n");
  assert.ok(names.includes("PATH"), "the hook ran and saw the ordinary environment");
  assert.ok(names.includes("GH_TOKEN"), "development credentials still reach git children");
  assert.equal(names.includes("DEVSPACE_OAUTH_OWNER_TOKEN"), false, "owner token must not reach git hooks");
  assert.equal(names.includes("DEVSPACE_TEST_GATEWAY_BEARER"), false, "configured secret names must not reach git hooks");
} finally {
  await registry.closeWorkspace(opened.workspace.id).catch(() => undefined);
  await git(source, ["worktree", "prune"]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
  delete process.env.DEVSPACE_TEST_GATEWAY_BEARER;
}
console.log("git-child-environment checks passed");
```

The `core.hooksPath` line makes the test independent of a developer's global
git hooks configuration.

**Verify (must fail before the fix)**: `bunx tsx src/git-child-environment.test.ts`
→ exits non-zero with `owner token must not reach git hooks`. If it fails with
`ENOENT` on `hook-env.txt` instead, the hook did not run: STOP.

### Step 3: Use the filtered environment at every git call site

1. `src/workspaces.ts`: import `gitChildEnvironment` and
   `registerGitChildSecretNames` from `./shell-environment.js`. In the
   `WorkspaceRegistry` constructor, after the `createShellRuntime` line, add
   `registerGitChildSecretNames(config.secretNames);`. Add
   `env: gitChildEnvironment()` to the options object of **every**
   `execFileAsync("git", …)` call in the file (including the `run` helper
   inside `managedWorkspaceRetentionReason` if plan 016 has landed).
2. `src/git.ts`: import `gitChildEnvironment` and replace the `env:` line with
   `env: gitChildEnvironment(options.env),`.
3. `src/git-worktrees.ts`: import `gitChildEnvironment` and add
   `env: gitChildEnvironment()` to the `execFileAsync("git", …)` options in the
   private `git` helper.
4. `src/workspace-capabilities.ts`: import `gitChildEnvironment` and add
   `env: gitChildEnvironment(),` to the options in the private `git` helper.

**Verify**:

- `bunx tsx src/git-child-environment.test.ts` → exit 0, prints
  `git-child-environment checks passed`
- `grep -n "process.env" src/git.ts` → no matches
- `test "$(grep -c 'execFileAsync("git"' src/workspaces.ts)" = "$(grep -c 'env: gitChildEnvironment()' src/workspaces.ts)" && echo equal` → prints `equal`
- `grep -c "gitChildEnvironment" src/git-worktrees.ts src/workspace-capabilities.ts` → each file reports at least `2` (import and use)
- `bun run typecheck` → exit 0

### Step 4: Document the rule

- `docs/security.md`, section "Child environment filtering": after the
  sentence "Diagnostics report filtered variable names, never values." add a
  paragraph: "The git processes DevSpace starts itself (worktree and clone
  creation, status probes, and review snapshots) receive the same exact-name
  filtering, because git runs repository-configured hooks and helpers.
  Development credentials such as `GH_TOKEN` are left in place for them."
- `AGENTS.md`, the bullet that begins "Child-process environments must come
  from `src/shell-environment.ts`": add `gitChildEnvironment` for git children
  (strips the names `WorkspaceRegistry` registers from `config.secretNames`)
  to the list of functions.

**Verify**: `grep -n "gitChildEnvironment" AGENTS.md` → one match.
`bun run test` → exit 0.

## Test plan

- New file `src/git-child-environment.test.ts`: unit checks (strips registered
  names and the owner token, keeps `GH_TOKEN`, applies overrides, rejects
  invalid names) and one end-to-end check with a real `post-checkout` hook.
- Pattern: `src/bridge-environment.test.ts` for the unit part,
  `src/workspace-maintenance.test.ts` for repository setup.
- Verification: `bun run test` → exit 0 including the new suite.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0
- [ ] `bunx tsx src/git-child-environment.test.ts` exits 0 and the file is in the `"test"` script
- [ ] `grep -n "process.env" src/git.ts` returns no matches
- [ ] Every `execFileAsync("git"` call in `src/workspaces.ts`, `src/git-worktrees.ts`, and `src/workspace-capabilities.ts` passes `env: gitChildEnvironment()` (the Step 3 commands succeed)
- [ ] `git status --short` lists only in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts
  (other than plan 016's expected additions).
- The Step 2 test passes before Step 3, or fails because the hook never ran.
- An existing suite fails after Step 3 because a git command now lacks a
  variable it needs. Report which variable; do not widen the environment or
  special-case it.
- You find a git child started from a module not listed in "Current state"
  (check with `grep -rn '"git"' src --include='*.ts' | grep -v test`). Report it
  rather than extending scope, unless it is in `src/workspaces.ts`.

## Maintenance notes

- New code that starts git must pass `env: gitChildEnvironment()`. The registry
  of names is filled by the `WorkspaceRegistry` constructor; code that runs git
  without a registry still strips the owner token but not node bearers.
- The registry is process-wide and only grows. That is intended: the secrets
  are process-wide environment variables.
- Deferred: `src/build-metadata.ts` runs `git rev-parse HEAD` with the raw
  environment in DevSpace's own checkout, not in a user repository. It is not a
  workspace child, so it was left out.
- Reviewer focus: confirm no call site still spreads `process.env`, and that
  `GH_TOKEN` is not stripped.
