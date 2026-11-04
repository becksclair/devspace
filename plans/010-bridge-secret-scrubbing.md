# Plan 010: Make stdio MCP bridges scrub the same configured secret names as shells and terminals

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 79ddffc..HEAD -- src/shell-environment.ts src/sky-cua/bridge.ts src/node-repl-bridge.ts src/server.ts package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (Plan 013 edits a different region of
> `src/server.ts` — the HTTP limiter/trust-proxy block near line 1841 — which is
> not drift for this plan.)

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `79ddffc`, 2026-11-04

## Why this matters

`docs/security.md` ("Child environment filtering") promises that DevSpace's
control-plane credentials never enter development subprocesses, and that
operators can extend the filtered list with `DEVSPACE_INFRA_SECRET_NAMES`.
Shells and terminals honour `config.secretNames`. The two stdio MCP bridges do
not. `node_repl` (enabled by default; it runs arbitrary JavaScript chosen by
the MCP client) and the sky-cua bridge each copy `process.env` through a
hard-coded deny-list instead. As a result, any name in
`DEVSPACE_INFRA_SECRET_NAMES` reaches them. On a gateway, so does any remote
node bearer whose env name does not end in `_NODE_TOKEN` (`nodeTokenEnv` is free-form in role
configs). The two copies of that deny-list have already drifted from the shell
path.

## Current state

- `src/node-repl-bridge.ts:51-56` and `src/sky-cua/bridge.ts:41-46` contain the same hand-written filter:
  ```ts
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (k === "DEVSPACE_OAUTH_OWNER_TOKEN" || k === "GH_TOKEN" || k === "GITHUB_TOKEN" || k.endsWith("_NODE_TOKEN")) continue;
    env[k] = v;
  }
  ```
  The sky-cua bridge then adds `XDG_RUNTIME_DIR` / `SKY_CUA_SERVICE_SOCKET_PATH` fallbacks (`src/sky-cua/bridge.ts:47-59`). Keep those.
- Factory signatures:
  - `src/sky-cua/bridge.ts:26` — `export async function createSkyBridge(config: SkyCuaConfig): Promise<SkyBridge>`
  - `src/node-repl-bridge.ts:41` — `export async function createNodeReplBridge(config?: { nodeRepl?: { binPath: string; cwd: string } }): Promise<NodeReplBridge>`
- Call sites in `src/server.ts`:
  - `:65` inside `getSkyBridge(config: ServerConfig)` — `const bridge = await mod.createSkyBridge(skyCua);` The cache key is `skyCua.binPath` (`:59`); leave the cache as it is.
  - `:1685` inside `createMcpServer` — `const b = await mod.createNodeReplBridge(config);`
- Where `secretNames` come from:
  - Standalone: `src/config.ts:401` — `secretNames: Array.from(new Set(["DEVSPACE_OAUTH_OWNER_TOKEN", ...(env.DEVSPACE_INFRA_SECRET_NAMES ?? "")...]))`.
  - Gateway: `src/server.ts:2183-2240` `createGatewayServer` builds `publicConfig` via `loadConfig(...)`. It adds the remote machines' `nodeTokenEnv` names **only** to each local executor's `executorConfig.secretNames` (`:2230-2233`). `createServer(publicConfig, …)` (≈`:2273`) passes `publicConfig` to `createMcpServer`, so the bridges (which use that config) never see the node-token names.
  - Node role: `src/cli.ts:147-150`, which includes `config.nodeTokenEnv`. The node role (`src/cli.ts:89-94` → `createNodeServer` + `LocalExecutor`) never spawns either bridge; no change is needed there. `grep -rn "createSkyBridge\|createNodeReplBridge" src` must return exactly four lines: two definitions and two call sites.
- The existing shell helper is `src/shell-environment.ts:17-47` `createShellRuntime(config, secretNames, baseEnvironment = process.env)`. It validates names with `/^[A-Za-z_][A-Za-z0-9_]*$/` and deletes each from a copy of the environment.
- Test conventions: standalone `tsx` scripts with `node:assert/strict`, registered by hand in the `package.json` `"test"` `&&` chain. `src/shell-environment.test.ts` is the closest exemplar.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Typecheck | `bun run typecheck` | exit 0 |
| New test  | `bunx tsx src/bridge-environment.test.ts` | exit 0 |
| Shell env test | `bunx tsx src/shell-environment.test.ts` | exit 0 |
| All tests | `bun run test` | exit 0 (~65s; needs `tmux`) |
| Build     | `bun run build:check` | exit 0 |

## Scope

**In scope**:
- `src/shell-environment.ts`: add one exported helper
- `src/sky-cua/bridge.ts`, `src/node-repl-bridge.ts`: use the helper; add a `secretNames` parameter
- `src/server.ts`: the two bridge call sites (`:65`, `:1685`) and the `publicConfig.secretNames` assignment in `createGatewayServer`
- `src/bridge-environment.test.ts` (create)
- `package.json`: append the new test to the `"test"` script only

**Out of scope**:
- Merging the two bridge files into one factory. That is a separate tech-debt item; this plan only fixes the security drift.
- Changing which bridges are enabled, the node_repl cap, bridge caching or health handling.
- `createShellRuntime` behaviour: shells keep their current filtering (they do not strip `GH_TOKEN`/`GITHUB_TOKEN`, by design, so developers can use `gh`).

## Git workflow

- Branch: `advisor/010-bridge-secret-scrubbing`
- Commit style: `fix(bridges): scrub configured secret names from bridge child environments`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add the shared helper with a failing test

Create `src/bridge-environment.test.ts`:

```ts
import assert from "node:assert/strict";
import { bridgeChildEnvironment } from "./shell-environment.js";

const base = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  DEVSPACE_OAUTH_OWNER_TOKEN: "owner",
  GH_TOKEN: "gh",
  GITHUB_TOKEN: "ghub",
  SAGA_NODE_TOKEN: "node",
  CLOUDFLARE_TUNNEL_TOKEN: "infra",
  ASGARD_BEARER: "custom-node-bearer",
  UNDEFINED_VALUE: undefined,
};
const env = bridgeChildEnvironment(base, ["DEVSPACE_OAUTH_OWNER_TOKEN", "CLOUDFLARE_TUNNEL_TOKEN", "ASGARD_BEARER"]);
assert.equal(env.PATH, "/usr/bin");
assert.equal(env.HOME, "/home/u");
for (const name of ["DEVSPACE_OAUTH_OWNER_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "SAGA_NODE_TOKEN", "CLOUDFLARE_TUNNEL_TOKEN", "ASGARD_BEARER", "UNDEFINED_VALUE"]) {
  assert.equal(Object.hasOwn(env, name), false, `${name} must not reach bridge children`);
}
assert.throws(() => bridgeChildEnvironment(base, ["BAD-NAME"]), /Invalid DevSpace infrastructure secret name/);
console.log("bridge-environment checks passed");
```

**Verify**: `bunx tsx src/bridge-environment.test.ts` → **fails** (the export does not exist yet).

### Step 2: Implement `bridgeChildEnvironment`

In `src/shell-environment.ts`, add:

```ts
const BRIDGE_ALWAYS_STRIPPED = new Set(["DEVSPACE_OAUTH_OWNER_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]);

export function bridgeChildEnvironment(baseEnvironment: NodeJS.ProcessEnv, secretNames: string[]): Record<string, string> {
  const configured = new Set<string>();
  for (const raw of secretNames) {
    const name = raw.trim();
    if (!name) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid DevSpace infrastructure secret name: ${name}`);
    configured.add(name);
  }
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(baseEnvironment)) {
    if (typeof value !== "string") continue;
    if (BRIDGE_ALWAYS_STRIPPED.has(name) || name.endsWith("_NODE_TOKEN") || configured.has(name)) continue;
    env[name] = value;
  }
  return env;
}
```

This keeps every name the bridges stripped before, so nothing regresses, and adds the configured names.

**Verify**: `bunx tsx src/bridge-environment.test.ts` → prints `bridge-environment checks passed`, exit 0.

### Step 3: Use the helper in both bridges

- `src/sky-cua/bridge.ts`: change the signature to `createSkyBridge(config: SkyCuaConfig, secretNames: string[])` (no default value, so the compiler catches any caller that does not pass names). Replace the hand-written loop with `const env = bridgeChildEnvironment(process.env, secretNames);`. Keep the `XDG_RUNTIME_DIR` and `SKY_CUA_SERVICE_SOCKET_PATH` fallback block right after it. Import from `"../shell-environment.js"`.
- `src/node-repl-bridge.ts`: change the signature to `createNodeReplBridge(config: { nodeRepl?: { binPath: string; cwd: string } } | undefined, secretNames: string[])` (no default). Replace the loop with `const env = bridgeChildEnvironment(process.env, secretNames);`. Import from `"./shell-environment.js"`.

`bun run typecheck` is expected to **fail** after this step, until Step 4 updates the two call sites.

**Verify**: `grep -n 'k === "DEVSPACE_OAUTH_OWNER_TOKEN"' src/sky-cua/bridge.ts src/node-repl-bridge.ts` → no output and exit code 1 (expected: the string is gone).

### Step 4: Pass `config.secretNames` at both call sites, including the gateway's node tokens

In `src/server.ts`:
- `:65` → `const bridge = await mod.createSkyBridge(skyCua, config.secretNames);`
- `:1685` → `const b = await mod.createNodeReplBridge(config, config.secretNames);`
- In `createGatewayServer`, insert this block immediately before the line `const bindings = createGatewayWorkspaceStore(roleConfig.stateDir);` (≈`:2210`, right after the `if (!publicConfig.disabledCapabilities) …` line). It folds the remote node-token env names into `publicConfig.secretNames`:
  ```ts
  publicConfig.secretNames = Array.from(new Set([
    ...publicConfig.secretNames,
    ...roleConfig.machines
      .filter((entry) => entry.kind === "remote" && typeof entry.nodeTokenEnv === "string" && entry.nodeTokenEnv.length > 0)
      .map((entry) => entry.nodeTokenEnv as string),
  ]));
  ```
  Leave the existing `executorConfig.secretNames` expression at `:2230-2233` unchanged. It now repeats names already in `publicConfig.secretNames`, which is harmless.

**Verify**: `grep -n "createSkyBridge(skyCua, config.secretNames)\|createNodeReplBridge(config, config.secretNames)" src/server.ts` → two matches; `bun run typecheck` → exit 0.

### Step 5: Register the test and run all gates

Append ` && tsx src/bridge-environment.test.ts` to the end of the `"test"` script in `package.json`.

**Verify**:
- `bun run typecheck` → exit 0
- `bun run test` → exit 0
- `bun run build:check` → exit 0

## Test plan

- New `src/bridge-environment.test.ts`: always-stripped names, the `_NODE_TOKEN` suffix rule, configured infra names, a configured custom node-bearer name, dropping undefined values, and rejection of an invalid name.
- `src/shell-environment.test.ts` must keep passing unchanged. This plan does not touch `createShellRuntime`.
- Not covered: the actual stdio child launch. Neither bridge binary is available in CI, and the helper is the entire behaviour change.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0, including `src/bridge-environment.test.ts`
- [ ] `grep -c "bridgeChildEnvironment(" src/sky-cua/bridge.ts src/node-repl-bridge.ts` → `src/sky-cua/bridge.ts:1` and `src/node-repl-bridge.ts:1`
- [ ] `grep -n "publicConfig.secretNames = " src/server.ts` returns one match
- [ ] `git status --porcelain -- src package.json` lists exactly ` M package.json`, ` M src/node-repl-bridge.ts`, ` M src/server.ts`, ` M src/shell-environment.ts`, ` M src/sky-cua/bridge.ts`, `?? src/bridge-environment.test.ts` (or the committed equivalent)
- [ ] `plans/README.md` row for 010 updated

## STOP conditions

- The bridge files no longer contain the hand-written filter shown above (someone already consolidated them; re-assess).
- `createGatewayServer` no longer builds `publicConfig` with `loadConfig`, or no longer passes it to `createServer`.
- Typecheck fails because another caller of `createSkyBridge` or `createNodeReplBridge` exists outside `src/server.ts` (find it with `grep -rn "createSkyBridge\|createNodeReplBridge" src`) and changing it would go out of scope.
- Any existing test fails after Step 4.

## Maintenance notes

- Any future child process that DevSpace spawns (a third bridge, a helper daemon) must take its environment from `createShellRuntime` or `bridgeChildEnvironment`. Never copy `process.env` directly. A reviewer should grep new spawn code (`spawn(`, `execFile(`, `StdioClientTransport`) for `process.env` passed through or copied without going through one of those two helpers. Note: `src/git.ts:26` already passes `process.env` to `git` unfiltered. It is out of scope here; it was flagged in the audit as a possible follow-up.
- The bridges deliberately strip `GH_TOKEN`/`GITHUB_TOKEN` while shells do not. That asymmetry is pre-existing and is now written down in one place (`BRIDGE_ALWAYS_STRIPPED`).
- Deferred: unify the two bridge implementations into one factory (audit tech-debt item). After this plan they share the security-relevant part.
