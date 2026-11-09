# Plan 013: Key OAuth rate limits on the real client when DevSpace sits behind a local tunnel

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 97e507c..HEAD -- src/config.ts src/config.test.ts src/logger.ts src/server.ts docs/configuration.md .env.example package.json`
> Plan 008 changes `package.json`/`bun.lock` and plan 010 edits `src/server.ts`
> around the bridge call sites (lines ~65, ~1685) and `createGatewayServer`.
> Those are expected. Any change to the excerpts below is drift: treat it as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (changes the default client-IP derivation on loopback binds)
- **Depends on**: plans/008-dependency-security-floor.md (needs `proxy-addr ≥ 2.0.8`; the "loopback" trust setting is exactly what the critical advisory GHSA-jqcg-44mw-7w3h affects)
- **Category**: security
- **Planned at**: commit `97e507c`, 2026-11-04

## Why this matters

The normal deployment binds DevSpace to `127.0.0.1` and puts a tunnel
(cloudflared, Tailscale serve, Caddy) in front of it. Express `trust proxy`
is **off** unless `DEVSPACE_TRUST_PROXY` is set, so every request's `req.ip`
is the tunnel's loopback address. The `/authorize` limiter (10/min), the
`/token` limiter (30/min), and the SDK's own `/register` limiter all key on
`req.ip`, so the whole internet shares one bucket. Anyone can exhaust it and
lock the owner out of approval and token refresh. When an operator *does* set
`DEVSPACE_TRUST_PROXY=1`, the request logger ignores Express's resolution and
logs the **leftmost** `X-Forwarded-For` or `CF-Connecting-IP` value, which the
client controls.

Behind a loopback bind, every remote request must already come through a
local proxy. Trusting **loopback** proxies (`trust proxy = "loopback"`) is
therefore safe by default: Express then takes the right-most non-loopback
`X-Forwarded-For` hop, which is the address the proxy saw.

## Current state

- `src/config.ts:247-256`:
  ```ts
  function parseLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
    return {
      level: parseLogLevel(env.DEVSPACE_LOG_LEVEL),
      ...
      shellCommands: parseBoolean(env.DEVSPACE_LOG_SHELL_COMMANDS),
      trustProxy: parseBoolean(env.DEVSPACE_TRUST_PROXY),
    };
  }
  ```
  It is called at `src/config.ts:395` (`logging: parseLoggingConfig(env),`) inside `loadConfig`, where `host` is computed at `:353` (`const host = env.HOST ?? files.config.host ?? "127.0.0.1";`). `parseBoolean` (`:165-167`) treats only `1/true/yes/on` as true; anything else is false.
- `src/logger.ts:6-14`: `LoggingConfig` has `trustProxy: boolean`.
- `src/logger.ts:55-65`:
  ```ts
  export function requestIp(req: Request, trustProxy: boolean): string | undefined {
    if (trustProxy) {
      const cfConnectingIp = firstHeaderValue(req.header("cf-connecting-ip"));
      if (cfConnectingIp) return cfConnectingIp;

      const forwardedFor = firstHeaderValue(req.header("x-forwarded-for"));
      if (forwardedFor) return forwardedFor;
    }

    return req.ip ?? req.socket.remoteAddress;
  }
  ```
  `firstHeaderValue` (`:80-82`) is used only here.
- `src/server.ts:1841-1843`:
  ```ts
  if (config.logging.trustProxy) {
    app.set("trust proxy", 1);
  }
  ```
  `src/server.ts:1873-1887` defines `authorizeLimiter` and `tokenLimiter` (`express-rate-limit`, default key = `req.ip`) mounted on `/authorize` and `/token`. `mcpAuthRouter` adds the SDK's own limiters, which also key on `req.ip`.
  `src/server.ts:2307` logs `trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}` at startup.
- `src/server.ts:686` passes `config.logging.trustProxy` to `requestIp`; the type widening covers it.
- Other `trustProxy` uses, all `false` literals that stay valid: `src/cli.ts:182` (node role), and the `ServerConfig` literals in `src/server-mcp-routing.test.ts:68`, `src/server-session-eviction.test.ts:66`, `src/server-workspace-mode.test.ts:77`.
- `src/config.test.ts:94-102` asserts the default logging block with `trustProxy: false`, and `:117` asserts `DEVSPACE_TRUST_PROXY: "1"` → `true`. `baseEnv` (`:8`) does not set `HOST`, so the default host is `127.0.0.1`.
- Docs: `docs/configuration.md:175` table row `| \`DEVSPACE_TRUST_PROXY\` | \`0\` |`; `.env.example:34` `# DEVSPACE_TRUST_PROXY=1`.
- Gateway role: `createGatewayServer` calls `loadConfig({... HOST: roleConfig.host ...})`, so the new default follows the gateway's bind host automatically.
- HTTP test harness to copy: `src/server-mcp-routing.test.ts` (full `ServerConfig` literal, `createServer(config)`, `app.listen(0, config.host)`, `try/finally` close).

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Typecheck | `bun run typecheck` | exit 0 |
| Config test | `bunx tsx src/config.test.ts` | exit 0 |
| New test | `bunx tsx src/server-rate-limit.test.ts` | exit 0 |
| All tests | `bun run test` | exit 0 (~65s; needs `tmux`) |
| Build | `bun run build:check` | exit 0 |
| proxy-addr version | `bun pm ls --all \| grep proxy-addr@` | `proxy-addr@2.0.8` or later 2.x |

## Scope

**In scope**: `src/config.ts` (trust-proxy parsing only), `src/logger.ts` (`LoggingConfig.trustProxy` type, `requestIp`, removal of `firstHeaderValue`), `src/server.ts` (trust-proxy setup block and the startup log line only), `src/config.test.ts`, `src/server-rate-limit.test.ts` (create), `package.json` (append the test to `"test"` only), `docs/configuration.md` (the `DEVSPACE_TRUST_PROXY` row plus one short paragraph), `.env.example` (the trust-proxy comment).

**Out of scope**:
- Limiter thresholds and windows, and exempting refresh grants. That is a separate decision.
- The node role (`src/cli.ts`, `src/node-server.ts`): nodes have no OAuth surface.
- `CF-Connecting-IP`-specific keying: Express's `X-Forwarded-For` resolution is the single source of truth.

## Git workflow

- Branch: `advisor/013-rate-limit-client-keying`
- Commit style: `fix(server): trust loopback proxies by default so rate limits key on real clients`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 0: Confirm the dependency

**Verify**: `bun pm ls --all | grep proxy-addr@` → `proxy-addr@2.0.8` or later. If it shows `2.0.7`, STOP: plan 008 has not landed.

### Step 1: Write the failing HTTP test

Create `src/server-rate-limit.test.ts` from the `src/server-mcp-routing.test.ts` setup: the same `ServerConfig` literal with `widgets: "off"` and `logging.requests: false`, but `logging.trustProxy: "loopback"`. No OAuth token seeding is needed. Start the server on `127.0.0.1` with `listen(0)`. Then:

```ts
const authorize = (xff: string) => fetch(`${baseUrl}/authorize`, { headers: { "x-forwarded-for": xff }, redirect: "manual" });
for (let i = 0; i < 10; i++) assert.notEqual((await authorize("203.0.113.1")).status, 429, `request ${i + 1} from client A must not be limited`);
assert.equal((await authorize("203.0.113.1")).status, 429, "11th request from client A is limited");
assert.notEqual((await authorize("203.0.113.2")).status, 429, "client B has its own bucket");
assert.equal((await authorize("198.51.100.9, 203.0.113.1")).status, 429, "a spoofed leftmost hop does not escape client A's bucket");
assert.equal((await authorize("203.0.113.1, 127.0.0.1")).status, 429, "a trailing loopback hop is skipped: still client A's bucket (fails under trust proxy = 1)");
```

The last assertion is the one that tells `"loopback"` apart from the old one-hop setting: under `trust proxy = 1` that request is keyed on `127.0.0.1` and gets a 400.

(`/authorize` without valid parameters returns a 4xx from the SDK. The limiter runs before it, so any non-429 status is fine for the first ten.)

Append ` && tsx src/server-rate-limit.test.ts` to the `"test"` script in `package.json`.

**Verify**:
- `bun run typecheck` → **fails** with `Type '"loopback"' is not assignable to type 'boolean'` in `src/server-rate-limit.test.ts` (tsconfig includes test files).
- `bunx tsx src/server-rate-limit.test.ts` → **fails** on the last assertion (the trailing-loopback-hop case). `tsx` does not typecheck, and `"loopback"` is truthy, so the old code applies one-hop trust and the earlier assertions pass. If the script passes, STOP.

### Step 2: Widen the config type and parse the new default

- `src/logger.ts`: change `trustProxy: boolean;` to `trustProxy: boolean | "loopback";`.
- `src/config.ts`: change `parseLoggingConfig(env)` to `parseLoggingConfig(env, host)`, update the call at `:395` to pass `host`, and set `trustProxy: parseTrustProxy(env.DEVSPACE_TRUST_PROXY, host)` using:
  ```ts
  function parseTrustProxy(value: string | undefined, host: string): boolean | "loopback" {
    const normalized = value?.trim().toLowerCase() ?? "";
    if (normalized === "") return isLoopbackHost(host) ? "loopback" : false;
    if (normalized === "loopback") return "loopback";
    return parseBoolean(normalized);
  }

  function isLoopbackHost(host: string): boolean {
    return host === "localhost" || host === "::1" || host.startsWith("127.");
  }
  ```
  An explicit `DEVSPACE_TRUST_PROXY=0` (or any non-true value) still disables trust, and `=1` keeps the existing one-hop behaviour.
- `src/config.test.ts`: change the default expectation at `:101` to `trustProxy: "loopback"`, and add:
  ```ts
  assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "0" }).logging.trustProxy, false);
  assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "loopback" }).logging.trustProxy, "loopback");
  assert.equal(loadConfig({ ...baseEnv, HOST: "0.0.0.0" }).logging.trustProxy, false);
  ```

**Verify**: `bunx tsx src/config.test.ts` → exit 0.

### Step 3: Apply the setting in Express and use Express's resolution in logs

- `src/server.ts:1841-1843` →
  ```ts
  if (config.logging.trustProxy === true) {
    app.set("trust proxy", 1);
  } else if (config.logging.trustProxy === "loopback") {
    app.set("trust proxy", "loopback");
  }
  ```
- `src/server.ts:2307` → `console.log(\`trust proxy: ${config.logging.trustProxy === false ? "disabled" : config.logging.trustProxy === true ? "1 hop" : "loopback"}\`);`
- `src/logger.ts` `requestIp`: rename the parameter to `_trustProxy: boolean | "loopback"`. Keep it, because the call at `src/server.ts:686` passes it. Return `req.ip ?? req.socket.remoteAddress` unconditionally (Express has already applied the trust setting). Delete `firstHeaderValue` if nothing else uses it (`grep -n firstHeaderValue src/*.ts`).

**Verify**:
- `bun run typecheck` → exit 0
- `bunx tsx src/server-rate-limit.test.ts` → exit 0
- `grep -n "cf-connecting-ip\|firstHeaderValue" src/logger.ts` → no matches
- `bunx tsx src/server-rate-limit.test.ts 2>&1 | grep -c ERR_ERL` → `0`

### Step 4: Document

- `docs/configuration.md:175`: change the default cell to `` `loopback` when `HOST` is loopback, otherwise `0` ``. Below the logging table, add one short paragraph explaining that `loopback` trusts only local proxies (cloudflared, Tailscale serve, a local Caddy), that `1` trusts exactly one proxy hop of any address (use it when the proxy runs on another host), and that `0` disables trust. Rate limits and logged client IPs follow this setting.
- `.env.example:34`: change to `# DEVSPACE_TRUST_PROXY=loopback   # default when HOST is loopback; 1 = one proxy hop; 0 = off`.

**Verify**: `grep -n "DEVSPACE_TRUST_PROXY" docs/configuration.md .env.example` shows the updated text.

### Step 5: Full gates

**Verify**:
- `bun run typecheck` → exit 0
- `bun run test` → exit 0
- `bun run build:check` → exit 0

## Test plan

- New `src/server-rate-limit.test.ts`: per-client buckets behind a loopback proxy, an 11th-request limit, resistance to a spoofed leftmost `X-Forwarded-For` hop, and a trailing-loopback-hop case that only passes under `"loopback"` trust.
- `src/config.test.ts`: default `"loopback"` on a loopback host, explicit `0`, explicit `loopback`, and a non-loopback host defaulting to `false`. The existing `"1"` → `true` assertion stays.
- Existing server tests pass unchanged; their literals use `trustProxy: false`.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0, including `src/server-rate-limit.test.ts`
- [ ] `grep -n '"trust proxy", "loopback"' src/server.ts` returns one match
- [ ] `grep -n "firstHeaderValue" src/logger.ts` returns nothing
- [ ] `git diff --name-only main...HEAD` prints exactly `.env.example`, `docs/configuration.md`, `package.json`, `src/config.test.ts`, `src/config.ts`, `src/logger.ts`, `src/server-rate-limit.test.ts`, `src/server.ts` (plus `plans/README.md` if you committed the status row)
- [ ] `plans/README.md` row for 013 updated

## STOP conditions

- `proxy-addr` is still below 2.0.8 (Step 0).
- Any `ValidationError` / `ERR_ERL_*` line appears on stderr during `bunx tsx src/server-rate-limit.test.ts` or `bun run test`. express-rate-limit logs validation problems; it never throws. Report the code, and do not set `validate: false`. None is expected: `ERR_ERL_PERMISSIVE_TRUST_PROXY` fires only for `trust proxy = true`, and `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` only when trust is `false` and an XFF header is present.
- The test's first ten requests return 429, or any assertion contradicts the Express documentation for `trust proxy = "loopback"`.
- Another consumer of `logging.trustProxy` exists that expects a plain boolean and is outside scope (`grep -rn "trustProxy" src`).

## Maintenance notes

- Security assumption: when `HOST` is loopback, every non-local client reaches DevSpace through a local proxy that **appends** to `X-Forwarded-For` (cloudflared, Caddy and Tailscale serve all do). If someone runs a proxy that passes client-supplied `X-Forwarded-For` through unchanged, a client could pick its own bucket. That is no worse than today's single global bucket for lockout purposes, but reviewers should know it. A pass-through proxy would also let a client choose arbitrary strings as its key and as the logged `ip`. It could even target the owner's bucket by sending the owner's address.
- If the operator's proxy runs on a different host, they must set `DEVSPACE_TRUST_PROXY=1` (one hop). The default only covers loopback proxies.
- Follow-up candidates, deliberately deferred: separate or exempt refresh-token grants from `/token`; throttle only failed owner-password approvals.
