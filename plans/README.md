# Implementation Plans

Plans 001-005 came from the improve skill's deep audit on 2026-08-28 (at `2effcdd`). Plans 006-014 come from a second deep audit on 2026-11-04 (at `97e507c`). The user selected F01-F08 plus F15 from that audit's findings table. Execute in the recommended order given under "Dependency notes (006-014)"; the table is numeric, not an execution order. Each executor: read the plan fully before starting, honor its STOP conditions, and update your row when done.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001  | Fix multi_read truncated flag loss on large-file fast path | P1 | S | — | DONE |
| 002  | Fix gateway deep workspaceId rewrite that corrupts arbitrary content | P1 | S | — | DONE |
| 003  | Harden OAuth owner approval with CSRF + rate limit | P1 | M | — | DONE |
| 004  | Wire orphaned tests and fix terminal-manager flake so CI is trustworthy | P1 | S | — | DONE |
| 005  | Cache gateway hello to remove extra RTT on every remote tool call | P2 | S | — | DONE |
| 006  | Make multi_read succeed over MCP by satisfying its output schema | P1 | S | — | DONE |
| 007  | Make multi_read return whole files up to its byte limit and report truncation truthfully | P1 | S–M | 006 | DONE |
| 008  | Clear the high/critical advisories on the public HTTP/OAuth path by raising dependency floors | P1 | S | — | DONE |
| 009  | Resolve dangling symlinks during canonical-path authorization so writes cannot escape root policy | P1 | S | — | DONE |
| 010  | Make stdio MCP bridges scrub the same configured secret names as shells and terminals | P1 | S | — | DONE |
| 011  | Fix the versioned build and local rebuild so they work when launched by Bun | P1 | S | — | DONE |
| 012  | Recover from node restarts immediately, and stop one caller's cancellation from failing shared hellos | P1 | S | — | DONE |
| 013  | Key OAuth rate limits on the real client when DevSpace sits behind a local tunnel | P1 | S | 008 | DONE |
| 014  | Turn AGENTS.md into an accurate operating guide and add CLAUDE.md | P2 | S | — | DONE |
| 015  | Bridge T3 Code thread orchestration into DevSpace for a voice orchestrator (two phases) | P1 | M + S | — | IN PROGRESS (Phase 1) |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (with one-line reason) | REJECTED (with one-line rationale — finding fixed independently or approach abandoned)

## Dependency notes (006-014)

- **007 requires 006.** Both edit `multiRead()` in `src/executor.ts`, and 007's drift check expects 006's `result: text` change to be present.
- **013 requires 008.** 013 turns on `trust proxy = "loopback"` by default, and that is only safe with `proxy-addr ≥ 2.0.8` (critical GHSA-jqcg-44mw-7w3h). 008 provides it.
- **File overlaps** (not dependencies; just merge carefully):
  - 010 and 013 both edit `src/server.ts`, in different regions: bridge call sites and `createGatewayServer` for 010, the trust-proxy block and startup log line for 013.
  - 006, 010 and 013 each append one test to the `package.json` `"test"` script.
  - 008 rewrites `package.json` dependency ranges and `bun.lock`.
- 014 is documentation only and can land at any time. Landing it first helps agents that execute the other plans.
- Recommended order if run sequentially: 006 → 008 → 009 → 010 → 012 → 011 → 007 → 013 → 014. 006, 008, 009, 010, 011 and 012 are mutually independent and can run in parallel worktrees.

## Plan review

After writing, plans 006-014 were cold-read by seven parallel Fable reviewers: 006+007, 008+013, 009, 010, 011, 012, and 014 with this index. Most reviewers dry-ran their plan in a disposable worktree. Two blockers were fixed: 012's orphaned shared hello could crash the gateway on an unhandled rejection, and 013's Step 1 test passed before the fix. Several major issues were fixed too: verification steps that could not be observed in 006/007/013, a wrong fact about imports in 011, and false facts about the hash derivation and `.env` in 014. Plans 009, 010 and 011 were dry-run end to end with every gate green.

## 2026-11-04 audit (at `97e507c`): scope and baseline

- **Baseline**: `bun run typecheck` clean (0.7s); `bun run test` green (≈64s); working tree clean. Plans 001-005 verified as still holding.
- **Audited**: whole repo, all nine categories, one read-only auditor per category (DX and docs combined). Every cited finding was re-opened and vetted by the advisor. F01 (multi_read over MCP) and F05 (`spawnPm` under Bun) were reproduced live. `bun audit` was run; the local `devspace.sqlite` was inspected read-only for OAuth row counts.
- **Not audited**: runtime profiling or benchmarks; live tunnel/ChatGPT/Claude client calls; UI component internals (`src/ui/*.tsx`); Gitea run history and secrets; Saga's out-of-repo installer; reachability of moderate/low advisories.

## 2026-11-04 findings not yet planned (vetted backlog, leverage order)

| # | Finding | Cat | Eff | Risk | Evidence |
|---|---|---|---|---|---|
| F09 | Every tool payload is sent 2-4× (`_meta.card.payload.content`, `terminalOutput`, and `structuredContent.result` copies) | perf | S | LOW | `src/server.ts:911-915,936,946-952` |
| F10 | Gateway leaks private executor `ws_` ids in terminal objects, in warning-prefixed text, and in thrown errors | bug | S | MED | `src/gateway-router.ts:445-459`; `src/executor.ts:203` |
| F11 | `auth mint-key` ignores `publicBaseUrl` from `config.json`; the server requires an exact resource match | bug | S | LOW | `src/cli.ts:530`; `src/config.ts:355`; `src/static-key-provider.ts:153` |
| F12 | Node response cap 1 MiB vs client 4 MiB; multi_read's default 1 MB budget can exceed it | perf | S | LOW | `src/node-server.ts:57`; `src/remote-node-client.ts:8` |
| F13 | State dir and sqlite/WAL files are world-readable; `writeFileSync` mode never tightens existing files | security | S | LOW | `src/db/client.ts:21-22`; `src/user-config.ts:124` |
| F14 | Any tmux exit code 1 is treated as a missing session; maintenance errors are swallowed | bug | S | LOW | `src/terminal-manager.ts:379`; `src/executor.ts:68-70,170` |
| F16 | Hand-maintained `&&` test chain with no filter; README's `bun test` is wrong | tests | S | LOW | `package.json` `"test"`; `README.md:217` |
| F17 | No HTTP-level tests for the `/mcp` auth boundary or the rate limiters; two OAuth assertions can never fail | tests | M | LOW | `src/server.ts:1825-1838`; `src/oauth-provider.test.ts:219,230` |
| F18 | Capability probes run serially; reusing a workspace re-runs full hydration | perf | S-M | LOW | `src/workspace-capabilities.ts:45-49,107-116`; `src/workspaces.ts:325` |
| F19 | `__Host-` CSRF cookie is sent without `Secure` on http deployments, so browser approval fails | bug | S | LOW | `src/oauth-provider.ts:36,91,273` |
| F20 | `doctor` always exits 0 and cannot check role configs or UI assets | dx | M | LOW | `src/cli.ts:383-391` |
| F21 | Ops docs drift: the publish workflow auto-deploys; `security.md` says loopback-only nodes while nodes use Tailnet http; static API keys are undocumented | docs | S | LOW | `docs/runtime-artifact.md:9-16`; `docs/security.md:97-99` |
| F22 | Publish workflow runs `curl bun.sh \| bash` as root, unpinned, in a job holding tokens | security | S | LOW | `.gitea/workflows/publish-runtime-artifact.yml:27-31` |
| F23 | pi-coding-agent 0.84 pins vulnerable undici/minimatch/brace-expansion; fix needs 1.x | deps | M | MED | `bun.lock:104` |
| F24 | Dead or unhealthy bridges are never detected; sky-cua respawns on every MCP initialize | bug | M | MED | `src/server.ts:55-79,1686`; `src/sky-cua/bridge.ts:117` |
| F25 | Tech-debt cluster: `server.ts` god module, duplicate bridges, 5 hand DDLs drifted from drizzle schema, schemas declared 3×, cast clusters, dead code | tech-debt | M-L | MED | `src/server.ts`; `src/db/schema.ts`; `src/sky-cua/bridge.ts` vs `src/node-repl-bridge.ts` |
| F26 | OAuth hygiene: 500-client cap with no pruning, no refresh-reuse detection, expired tokens kept (local DB has 1 client, 166 expired tokens) | security | M | LOW | `src/oauth-store.ts:111-125`; `src/oauth-provider.ts:385` |
| F27 | Small items: node bearer has no minimum length; react/`@pierre/diffs` in runtime deps (~37 MB artifact); `@types/node ^26` vs Node 24 floor; no lint/formatter; shutdown ordering; `inFlight` Set | mixed | S each | LOW | per audit transcript |
| F28 | `/mcp` request bodies cap at 100 KiB (`createMcpExpressApp` mounts bare `express.json()`), so `write_file`/`edit_file` with larger content returns 413. Found by the plan 008 reviewer, who verified it before and after the SDK bump | bug | S | LOW | `src/server.ts:1810`; `node_modules/@modelcontextprotocol/sdk/dist/esm/server/express.js:29` |

Prior-audit items resolved by this audit:
- CORRECTNESS-04 (node_repl cap race): the cap race is fixed. A narrower leak remains when a session closes mid-create (part of F24/F25).
- CORRECTNESS-05 (unchecked store touch) and CORRECTNESS-06 (tmux exit 1): still present; tmux is now F14.
- PERF-02 and PERF-04: still present (F18 and part of F27).
- SECURITY-02 (wildcard CORS): accepted; see the rejected list.

## 2026-11-04 considered and rejected

| Finding | Reason |
|---|---|
| Wildcard CORS on `/mcp-app-assets` | Immutable, credential-free build files that host sandboxes must load cross-origin; restricting it risks breaking widgets for no gain. |
| Unused dependencies | None found; every direct dependency is imported. |
| drizzle-kit migration generation | Too heavy for 7 tables; centralizing DDL (F25) is the proportionate fix. |
| Splitting `cli.ts`, `workspaces.ts`, `ui/workspace-app.tsx` | Low churn and cohesive; only `server.ts` mixes unrelated concerns. |
| Per-call drizzle statement preparation, `touchSession` writes | Microseconds next to process spawns and tunnel round trips. |
| sky-cua argument stripping on shapeless schemas | Mechanism is real (`src/server.ts:1750-1764`), but working phone traffic suggests no live tool hits it; investigate-only. |
| "Bun auto-loads `.env` into `bun run` scripts" (audit DEP-07) | Refuted by probe: `bun run <script>` does not pass `.env` to `node`/shell children; only Bun-executed code or `--env-file` sees it. |
| `trustedDependencies` for better-sqlite3 | Not needed: v13 ships N-API prebuilds with no install script. |

## 2026-11-04 direction options (not ranked against bugs)

1. **Cut round trips in the hot loop.** Pass grep `context`/`limit` through to Pi (already supported), add `captureAfterMs` to `terminal_write`, and add a multi-file `apply_edits` that validates every edit before writing. Contract-hash change, so gateway and nodes co-deploy.
2. **`list_workspaces`.** Retained terminals and isolated work are unreachable from a new chat; `WorkspaceStore.listSessions()` exists but no tool exposes it.
3. **Config-driven MCP bridges routed per machine.** This also moves the ~28 KB hard-coded phone runbook out of `src/server.ts:401-425`; today it is injected into every `open_workspace`.
4. **Extract the connector chassis.** `createServer`'s HTTP/OAuth/session layer has only two DevSpace-specific call sites; one factory seam makes it a reusable base.

---

# 2026-08-28 audit (historical, at `2effcdd`)

## Dependency notes

- 001, 002, 003, 004, 005 are independent and can run in parallel. Execution order above is recommended priority (leverage) order.
- 004 is the verification prerequisite for all later risky code changes — consider doing it first if CI is currently red.
- 002 and 005 both touch gateway performance/correctness; either can go first.

## What was audited

- Languages/frameworks: TypeScript ES2022 NodeNext, Node >=24 <27, Vite 8 UI, Express 5, better-sqlite3/drizzle-orm, tmux terminals, Pi coding agent adapter.
- Commands verified: `npm run typecheck` (tsc --noEmit), `npm test` (node --test + 28x tsx chain), `npm run build:check` (vite build + tsc -p tsconfig.build.json), `npm run build` (versioned), `npm ci`/`npm install` (lockfile).
- Whole repo deep pass (~16.2k lines, 67 src entries): `src/server.ts:2287`, `src/workspaces.ts:801`, `src/cli.ts:814`, `src/executor.ts:589`, `src/gateway-router.ts:422`, `src/terminal-manager.ts:418`, plus all stores, bridges, workspaces, roots, config, oauth, gateway, UI.
- All nine audit categories: correctness, security, performance, test coverage, tech debt/architecture, dependencies/migrations, DX/tooling, docs, direction.
- Git HEAD: `2effcdd`, main, clean working tree.

## What was not audited

- Live profiling: no `vite build` bundle measurement, no `walkWorkspace` wall-time, no `probeGit` latency, no `rewriteValue` GC, no DB `EXPLAIN QUERY PLAN` beyond schema read of `src/db/schema.ts`.
- Dynamic `npm audit` / `cargo audit` run: lockfile reviewed, `overrides` for `ws`/`protobufjs` noted, but CVE list not executed (cheap next lookup: `npm audit --json`).
- Full registry release-date checks for abandoned verdicts (`prebuild-install`, `node-domexception`) and duplicate `diff`/`@pierre/diffs` usage split (needs `grep` + `npm ls`).
- `madge --circular` for layering cycles, full `git log --stat` churn mapping, and Windows-specific terminal behavior beyond `ci.yml` matrix read.

## Findings considered and vetted

### Vetted and kept (table; leverage-ordered)

| Finding | Category | Impact | Effort | Risk | Confidence | Evidence |
|---------|----------|--------|--------|------|------------|----------|
| CORRECTNESS-01 truncated flag loss | bug | multi_read lies about truncation; model edits on unseen tail | S | LOW | HIGH | `src/executor.ts:427-435` discards `truncated`, `src/executor.ts:485` re-truncates |
| CORRECTNESS-02 substring rewrite | bug | file/grep/patch content corrupted; 50 MB copy overhead | S-M | MED | HIGH | `src/gateway-router.ts:409-410` split/join over entire ExecutorResult |
| SECURITY-01 CSRF+rate limit | security | Owner approval POST lacks CSRF, no throttle on 16-char token | M | LOW | HIGH | `src/oauth-provider.ts:105` no csrf, `src/oauth-provider.ts:203-229` no limit, `src/server.ts:1872-1881` no limiter |
| CORRECTNESS-04 node-repl cap/link race | bug | burst per-host cap overflow, orphan stdio fd until 1800s sweep | M | MED | HIGH | `src/server.ts:1680-1694` pending counter + WeakMap link after `onsessioninitialized` |
| CORRECTNESS-05 unchecked store touch | bug | touch/close on evicted workspace silently no-ops, retention leak | S | LOW | HIGH | `src/workspace-store.ts:114-120` no `changes` check |
| CORRECTNESS-06 tmux exit 1 swallowing | bug | real tmux errors masked as missing session → orphan sessions | S | LOW | MED | `src/terminal-manager.ts:379-381` `code===1` catch-all |
| PERF-01 extra hello RTT | perf | every remote call pays 1 extra RTT, doubles multi_read latency | S | MED | HIGH | `src/remote-node-client.ts:89` `await hello` before every `execute` |
| PERF-02 capability probe serialization | perf | open_workspace latency sum of 5 git forks + mount+probe serial | S | LOW | HIGH | `src/workspace-capabilities.ts:44-49`, `src/workspace-capabilities.ts:107-127` |
| PERF-03 gateway deep rewrite on 50 MB patch | perf | O(patch bytes) split + 2x alloc blocking event loop | S | LOW | MED | `src/gateway-router.ts:401-418` + `src/review-checkpoints.ts:124-131` maxBuffer 50MB |
| PERF-04 terminal reconcile N sequential has-session | perf | 20 terminals → 400-1000 ms sequential tmux spawns | S | LOW | HIGH | `src/terminal-manager.ts:239-247` for-await loop |
| TEST-02 unwired suites | tests | 3 suites on disk never run: static-key, activity, workspaces-optimized | S | LOW | HIGH | `package.json:34` omits them, files exist |
| TEST-07 terminal flake red CI | tests | `terminal-manager` Missing expected rejection; chain hides later suites | S | MED | HIGH | `src/terminal-manager.test.ts:81` + `npm test` chain `&&` |
| DEP-01 lockfile drift | deps | engines bump >=24 not reflected in lock, vite patch drift | S | LOW | HIGH | `package.json:7-9` >=24 vs `package-lock.json:41-43` >=20.12 |
| TECHDEBT-02 stdio bridge duplication | tech-debt | sky-cua vs node_repl 85% duplicate; drift on env secret stripping | S | LOW | HIGH | `src/sky-cua/bridge.ts:26-137` vs `src/node-repl-bridge.ts:27-89` |
| TECHDEBT-03 5x SQLite store duplication | tech-debt | 5 stores replicate openDatabase/migrate/raw DDL vs drizzle schema | M | MED | HIGH | `src/workspace-store.ts:56-209` vs `src/gateway-workspace-store.ts:24-105` vs `src/terminal-store.ts` |
| SECURITY-02 wildcard CORS | security | `Access-Control-Allow-Origin:*` on mcp-app-assets | S | LOW | HIGH | `src/server.ts:836` `setAssetHeaders` |
| DX-04 Node range/doc drift | dx | README says >=20.12, engines >=24, CI node 22 contradict | S | LOW | HIGH | `README.md:25` vs `package.json:7-9` vs `.github/workflows/ci.yml:35` |

Additional vetted low-priority/leverage-deferred findings retained in index for future planning (not in top 5):

| Finding | Category | Note |
|---------|----------|------|
| SECURITY-03 CSP wasm-unsafe-eval | security | MED confidence necessity not documented; keep unless wasm proven required |
| SECURITY-04 healthz fingerprinting | security | Low severity authenticated-fingerprint leak |
| PERF-05 AGENTS discovery walk | perf | M, cache or lazy discovery; unbounded walk on large monorepos |
| PERF-06 no pagination on grep/find/list | perf | M, add limit/truncated caps mirroring multi_read |
| TEST-03 pi-tools wrapper untested | tests | M, mutation path zero direct tests |
| TEST-05 multi_read byte-limit untested | tests | S, fixed by plan 001's new test file |
| TECHDEBT-01 server.ts god 2287 lines | tech-debt | L, split via visible seams (phone normalization 134 lines, http/mcp/widgets) |
| DX-01/02 lint+formatter | dx | S, Biome 2.x fits |
| DOC-01 missing tool reference | docs | M, generate from TOOL_SCHEMAS |
| DIR-01 batch read-only | direction | M spike, adjacent possible one interface away |

### Considered and rejected (not worth doing now)

| Finding | Reason not a finding / not worth doing |
|---------|----------------------------------------|
| Host-policy shell broader than file allowlist | By-design: documented as trusted partner (`AGENTS.md`, `docs/security.md:60`) — not a finding unless implementation adds risk beyond convention |
| honoring `https_proxy`/`NO_PROXY` | By-design platform convention per playbook handling rule |
| `better-sqlite3` deprecated `prebuild-install` alone | Not a standalone finding without `npm audit` critical/high; tracked as DEP-02 but not prioritized — override pin handles it |
| Vite chunk budget 500kB | Currently passing per `vite.config.ts:5` + shiki lazy exclusion `isIndivisibleLazyShikiChunk`; not a finding unless budget exceeded |
| Adding dark mode / generic AI features | Ungrounded direction; no repo evidence per grounding rule — rejected |

## Direction options (not ranked against bugs)

1. **Finish read-only batch (grep+read composite)** — Evidence `src/tool-contract.ts:10` multi_read + `AGENTS.md:30` batch mandate + deferred Phase 2 in plan `1787829623232`. Design spike: 4-tool discriminatedUnion, 1-12 ops, per-op audit pattern, bench tunnel `grep→4×read` vs batch. Effort M, MED risk (polymorphic schema), HIGH grounded confidence.
2. **Plugin/MCP bridge generalization** — Evidence two bridges already (`src/sky-cua/bridge.ts` + `src/node-repl-bridge.ts` + shared `src/mcp-bridge-utils.ts:12-112` `jsonSchemaToZod`). Spike defines `mcpBridges: [{id,command,allowedTools}]` config and lifecycle/ caps. Effort L, MED confidence.
3. **Add list_workspaces / list_terminals (CRUD asymmetry)** — Evidence `src/tool-contract.ts:5-24` has open/status/close minus List; client must guess via `ls ~/.local/share/devspace`. Spike: workspace-scoped enumerable store query, redact secrets. Effort S, HIGH confidence.
4. **Refresh deploy/artifact strategy after Saga artifact_service retirement** — Evidence `docs/runtime-artifact.md:9-16` retired `devspace-deployctl` + deterministic `scripts/package-runtime-artifact.mjs` artifact still produced. Spike only: `artifact.json v1` verifier + `healthz` poller as standalone script, not re-adding to app CI. Effort L, HIGH risk if re-added.

## How to use this index

- Execute plans 001-005 in recommended order; 004 first if CI is red and blocking confidence.
- Each plan is self-contained for a zero-context executor; it vendors its excerpts and verification gates.
- After each DONE, re-run `git diff --stat 2effcdd..HEAD` drift checks for remaining TODOs.
