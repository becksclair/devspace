# Implementation Plans

Plans 001-005 came from the improve skill's deep audit on 2026-08-28 (at `2effcdd`). Plans 006-014 come from a second deep audit on 2026-11-04 (at `97e507c`). The user selected F01-F08 plus F15 from that audit's findings table. Plans 016-023 come from a standard audit on 2026-11-11 (at `63d6d81`): 016-020 are the advisor's default top five from that audit's findings table (the run did not wait for a selection), and the user then approved 021-023 (findings G06, G07 + G08 with backlog F12, and G12). All work from this audit lands on the integration branch `advisor/audit-2026-11-11`. Execute in the recommended order given under the dependency notes; the table is numeric, not an execution order. Each executor: read the plan fully before starting, honor its STOP conditions, and update your row when done.

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
| 015  | Bridge T3 Code thread orchestration into DevSpace for a voice orchestrator (two phases) | P1 | M + S | — | IN PROGRESS (Phase 2 deployed; voice pass pending) |
| 016  | Keep managed workspaces whose commits or stashes exist nowhere else | P1 | S–M | — | TODO |
| 017  | Give git child processes the filtered environment that shells already get | P1 | S–M | 016 (merge order) | TODO |
| 018  | Serve the Svartal gateway from immutable release directories instead of the working checkout | P1 | M (Step 1 is S) | — | TODO |
| 019  | Stop `multi_read` from breaking the workspace activity card | P1 | S | — | DONE (approved at `ccc775b`; PR #7 into `advisor/audit-2026-11-11`, not merged) |
| 020  | Close three small liveness gaps in the T3 bridge | P2 | S | — | TODO |
| 021  | Make `show_changes` report renames and file types truthfully | P1 | S | — | DONE (approved at `467cf7f`; PR #8 into `advisor/audit-2026-11-11`, not merged) |
| 022  | Align gateway and node payload limits, and make `show_changes` deliver large diffs in pieces | P1 | M | 021 | TODO |
| 023  | Clear the high-severity dependency advisories with an in-range refresh | P2 | S | — | TODO |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (with one-line reason) | REJECTED (with one-line rationale — finding fixed independently or approach abandoned)

## Execution notes

- **019 (2026-11-11).** Executor followed the plan (`ccc775b`); the typecheck found a second exhaustive switch (`getToolDisplay`), handled as the plan directed. Advisor review passed every done criterion including `build:check`, with a clean scope. `/code-review xhigh --fix` applied nothing. Advisory findings left open: after a gateway restart the activity poller resets its cursor and then overwrites it with the stale page's `latestSeq`, so the first new events are never fetched (pre-existing, `src/ui/workspace-app.tsx:385-401`); a `multi_read` now shows its parent row plus one `read_file` row per file while the header counts one operation (`src/gateway-router.ts:180`); the `multi_read` activity detail counts lines of the summary text (`src/workspace-activity.ts:121`); the drift test checks `isToolName` but not the `ToolName` union; the tolerant page validator has no automated test.
- **Plan review on PR #6 (2026-11-11).** CodeRabbit raised seven findings on plans 021-023; all were checked against the code and fixed in the plans. 021: classify a rename as pure only for `R100` with zero counts (the same defect `/code-review` found in the executed branch), and search `src/` recursively in the verification greps (also fixed in 016). 022: keep a node's JSON error on the non-resumable client path; measure `show_changes` output as serialized JSON and bound the file list as well as the patch; and replace "truncate and advance the baseline" with delivery in pieces, where the baseline advances only for files whose diffs were returned (prototyped against a shadow repository before the plan was rewritten). 023: compare against the plan branch's starting commit in the done criteria (also fixed in 018 and 022), and keep the `undici` override until the version Pi pins is checked against `bun audit`.
- **021 (2026-11-11).** Executor followed the plan verbatim (`83152fe`); advisor review passed every done criterion with a clean scope. `/code-review xhigh --fix` then found a defect in the plan's own design: purity of a rename was decided from line counts alone, so a renamed binary with changed content was reported as `rename-pure`. The fix keeps git's full status token and requires `R100` with zero counts; a new test covers a changed binary rename and a reordered-lines rename and fails on the pre-fix parser. Advisory findings left open: `diff.renames=copies` in the service account's git config reports a copy as `new` with counts relative to its source; the new test inherits the developer's global git rename settings; the two-command join could be one `git diff --raw --numstat -z` call.

## Dependency notes (016-023)

- **Integration branch.** All work from the 2026-11-11 audit lands on `advisor/audit-2026-11-11`. Each plan's branch (`advisor/NNN-<slug>`) is created from it and merged back into it; nothing goes to `main` until the user decides.
- **022 after 021.** Both edit `reviewChanges` in `src/review-checkpoints.ts` and its test; 022's excerpts assume 021's parser is in place.
- **023 must run outside the serving checkout.** It installs dependencies; see the next note. Its only source changes are `package.json` and `bun.lock`, which 016, 017 and 018 also touch (the `"test"` script line), so merge it carefully.
- 021, 022 and 023 are independent of 016-020 apart from those shared lines.
- Recommended order for the second batch: 021 → 022, with 023 in parallel.
- **Every executor works in a separate git worktree or clone.** On Svartal, `/Users/rclair/projects/devspace` serves the production gateway from its `dist/` (finding G03, plan 018). `bun run build:check` and `bun install` in that directory are deploy steps.
- **017 after 016.** Both edit git call sites in `src/workspaces.ts`. 016 adds new git calls; 017's done criteria require every git call in that file to pass the filtered environment, so running 017 second covers them.
- **018 Step 1 can merge alone.** It is a documentation commit that makes `AGENTS.md` truthful today. The rest of 018 adds tooling; the production cutover is an operator step that no executor performs.
- 019 and 020 are independent of the others. 020 touches `src/server.ts` in `createServer` only.
- Recommended order if run sequentially: 018 Step 1 → 019 → 016 → 017 → 020 → rest of 018. 016, 018, 019 and 020 can run in parallel worktrees.
- 016, 017 and 019 each append or extend a test in the `package.json` `"test"` script; 018 extends the `node --test` part of it. Merge those lines carefully.
- 020 changes T3 bridge behavior. `docs/t3-code.md` asks for `bun run test:t3-live` before merging bridge changes; that suite spends provider credits and is an operator decision.

## 2026-11-11 audit (at `63d6d81`): scope and baseline

- **Baseline**: `bun run typecheck` clean; `bun run test` green (39 suites); working tree clean. `bun audit`: 37 advisories (10 high, 23 moderate, 4 low).
- **Audited**: standard depth, all nine categories, five read-only auditors: T3 bridge correctness and everything changed since `97e507c`; core runtime correctness; security across the repository; performance, tests and tech debt; dependencies, DX, docs and direction. Every finding below was re-opened and confirmed by the advisor against the cited lines. Auditors reproduced several with throwaway probes outside the repository (workspace removal after a commit, `show_changes` rename parsing, the parent `.gitignore` case, a busy-port start, the nested root policy, a dropped SSE stream against a stand-in server, a stuck CLI descendant, inbox call counts against the fake T3). The deployment layout in plan 018 was decided by a separate read-only decision review.
- **Not audited**: real T3 Code behavior (no live or deployed suite was run); runtime profiling; UI component internals beyond the activity poller and HTML sinks; Pi SDK and MCP SDK internals; Gitea run history, secrets and the out-of-repo deploy controller; whether the GitHub remote is public; `src/t3-live.test.ts` beyond its contract section.
- **Backlog status from the 2026-11-04 table**: F28 is fixed (`src/server.ts:1832`, `src/server-mcp-body-limit.test.ts`). F12 is worse: the 1 MiB node limit now also rejects requests that `/mcp` accepts (G08) and can consume `show_changes` state (G07). F23's high advisories can be cleared without the 1.x upgrade (G12). F16, F20, F21 and F25 grew slightly with the T3 work. F10, F11, F13, F14, F19, F22, F24, F26 and F27 are unchanged.

## 2026-11-11 findings (vetted, leverage order)

| # | Finding | Cat | Eff | Risk | Evidence | Plan |
|---|---|---|---|---|---|---|
| G01 | A managed checkout with committed (not uncommitted) work is deleted on close and by idle maintenance; the commits are lost | bug | S–M | LOW | `src/workspaces.ts:673-680,183-198,605-618`; `src/git-worktrees.ts:48,70` | 016 |
| G02 | Git children inherit the unfiltered service environment, so repository hooks and fsmonitor can read the owner token and node bearers; contradicts `AGENTS.md` and `docs/security.md` | security | S–M | LOW | `src/git.ts:26`; `src/git-worktrees.ts:187`; `src/workspaces.ts:197,617,670,675`; `src/workspace-capabilities.ts:133` | 017 |
| G03 | The production gateway runs from the working checkout's `dist`; `AGENTS.md` calls the command that deletes `dist` "non-mutating"; `/healthz` reports the checkout's HEAD, not the build's commit | dx | S + M | MED | `AGENTS.md:43,75`; `package.json` `clean`/`build:check`; `src/build-metadata.ts:7-10`; launcher outside the repo | 018 |
| G04 | The widget's tool-name list lacks `multi_read`; one such activity event makes the workspace card fail and re-poll every 2 s | bug | S | LOW | `src/ui/card-types.ts:3-27,92-119`; `src/ui/workspace-app.tsx:378-381,423-431`; `src/gateway-router.ts:119-122` | 019 |
| G05 | T3 bridge liveness: no catalog load until the first session (schema-less tools after every restart); CLI timeout waits for pipes to close and can wedge minting; blank optional arguments are rejected | bug | S | LOW | `src/t3-bridge.ts:717-728,395-423,1686-1688,1280-1284`; `src/server.ts:1798-1801` | 020 |
| G06 | `show_changes` misreports files: a rename corrupts the list and drops the next file's stats; an append-only edit is typed `new`, a shrink-only edit `deleted` | bug | S | LOW | `src/review-checkpoints.ts:271-303` | 021 |
| G07 | `show_changes` advances its baseline before the result is deliverable; through a node, a diff over 1 MiB returns an error and the next call says "No changes" | bug | S–M | LOW | `src/review-checkpoints.ts:124-135`; `src/node-server.ts:222-229` | 022 |
| G08 | Node request limit is 1 MiB while `/mcp` and the client allow 4 MiB; an oversized write gets an HTML 413 that the gateway reports as "target unavailable" | bug | S | LOW | `src/node-server.ts:57,67`; `src/remote-node-client.ts:8`; `src/server.ts:1832` | 022 |
| G09 | A failed `listen` (for example a busy port) prints "listening" and exits 0; standalone `serve` has no forced-exit timer on SIGTERM | bug | S | LOW | `src/cli.ts:105,314-328`; `src/server.ts:2335-2346`; `node_modules/express/lib/application.js:598-606` | — |
| G10 | `show_changes` and `workspace_status` ignore `.gitignore` files above a workspace that is a repository subdirectory; ignored trees are snapshotted and reported | bug | S–M | MED | `src/review-checkpoints.ts:245-259` | — |
| G11 | Every non-shell tool gets a 30 s remote deadline; a slow `open_workspace` is reported as "target unavailable" while the node finishes and leaves an unbound managed checkout | bug | S–M | LOW | `src/remote-node-client.ts:7,178,194-196,329-334` | — |
| G12 | All 10 high advisories clear with an in-range lockfile refresh plus an `undici` override; the `proxy-addr` override is redundant and the exact `ws`/`protobufjs` pins block patches | deps | S | LOW | `package.json` `overrides`; `bun outdated` (vite 8.2.2 → 8.3.8); `bun pm why undici` | 023 |
| G13 | The phone guidance injected into every `open_workspace` still routes phone work to `machine:saga`, which the Svartal gateway does not have | docs | S | LOW | `src/server.ts:398-400,1113-1134`; `docs/svartal-gateway.md:5` | — |
| G14 | File tools use the workspace's access for any target inside it and ignore a more specific nested root policy; the correct helper exists but is unused | bug | S | LOW–MED | `src/workspaces.ts:519-525`; `src/roots.ts:153-171` | — |
| G15 | `t3_inbox` re-lists every unsettled thread and reads each active thread on every check (26-36 T3 calls in a probe against the fake); T3's list already accepts status and snooze filters | perf | S–M | LOW–MED | `src/t3-bridge.ts:1379-1407,1418` | — |
| G16 | A T3 response stream that ends without a result holds the call for up to 120 s, and one dropped stream fails every in-flight call; real T3's transport behavior is unverified | bug | M | MED | `src/t3-bridge.ts:887-893,909-915,58`; `src/testing/fake-t3.ts:1192` | — (investigate first) |
| G17 | T3 drift is detectable only by the credit-spending live suite: no version logged, new T3 properties pass through deny-list trimming, description rewrites miss silently | tests | S–M | LOW | `src/t3-bridge.ts:787-806,1786-1844`; `src/t3-live.test.ts:504-528` | — (see direction 1) |
| G18 | Bridged execution tools (node_repl `js`, sky-cua) advertise non-destructive hints under every annotation profile, and `docs/security.md` lists only two execution surfaces | security | S | LOW–MED | `src/server.ts:1717,1746-1750`; `docs/configuration.md:128`; `docs/security.md:7` | — (needs an owner decision on sky-cua) |
| G19 | CI runs on Ubuntu only; the production gateway and the T3 bridge run on macOS | tests | S | LOW | `.github/workflows/ci.yml`; `docs/svartal-gateway.md:5` | — |
| G20 | Stale review and session state: a failure diagnostic is cached for the process lifetime; one stale stored session blocks `open_workspace`; sessions for deleted managed directories are probed hourly forever | bug | S | LOW | `src/review-checkpoints.ts:111-118`; `src/workspaces.ts:442-447,494-500` | — |
| G21 | Small T3 items: early renewal revokes the working token before its replacement exists; the inbox can announce an outcome twice; inbox workers keep calling T3 after a failure; non-loopback `http:` T3 origins are accepted | bug | S each | LOW–MED | `src/t3-bridge.ts:521-523,1279,1331-1348,1950-1961,444-448` | — |
| G22 | Hardening and hygiene: OAuth redirect URIs are checked by host, not scheme; `auth mint --owner-token` takes the password on the command line; the publish workflow can deploy a non-main ref; config errors name the wrong field; three reference docs contradict the code (`docs/configuration.md:173` "twelve T3 tools") | mixed | S each | LOW | `src/oauth-provider.ts:227-237`; `src/cli.ts:615,628`; `.gitea/workflows/publish-runtime-artifact.yml:2-5,93-108`; `src/role-config.ts:237` | — |
| G23 | Per-session and per-spawn blocking work: synchronous skill-tree walk on every MCP initialize; synchronous `busctl` on Linux spawns; wall-clock upper bounds in the T3 catalog tests | perf/tests | S each | LOW | `src/server.ts:968-970`; `src/skills.ts:47-50`; `src/shell-environment.ts:131-139`; `src/t3-bridge.test.ts:455,490,505` | — |

Planned after the user approved them: G06 (021), G07 + G08 with backlog F12 (022), G12 (023; a dry run on copies of `package.json` and `bun.lock` took `bun audit` from 37 advisories to 1 moderate). Still unplanned and self-contained: G09.

## 2026-11-11 considered and rejected

| Finding | Reason |
|---|---|
| Splitting `src/t3-bridge.ts` (1,961 lines) | New, sectioned, with injected credential and CLI seams; revisit after the voice pass. |
| Folding T3 retry classes into `TOOL_SPECS`; merging the two JSON-Schema-to-Zod converters | Real duplication, but the test-side copies are deliberate independent oracles and switching sky-cua to the stricter converter risks rejecting live phone calls. Not worth a plan now. |
| Removing `clientRequestId` from the exposed T3 schemas | Plan 015 specifies "added if absent"; the dedupe risk depends on unverified T3 retention. |
| Reusing one T3 OAuth client across mints | No evidence that T3 caps or retains registrations; investigate only if minting ever fails. |
| Stale graphical-session variables after a session change; `tmux new-session -e` on tmux older than 3.2 | Linux nodes only, low confidence, no observed failure. |
| MCP SDK v2 / ext-apps 2 migration | v1 is still patched (1.32.2); large blast radius across the auth boundary. Worth a one-day spike only before a chassis extraction (direction 3). |
| Lint and formatter | Formatter drift is visible, but a reformat conflicts with every open worktree; land Biome's formatter only when no long-lived worktrees are open. |
| Config-driven generic MCP bridges | The three bridges have different lifecycles and T3 needed behavior a config file cannot express; a small shared bridge interface is the proportionate version (direction 2). |
| macOS CI as a default plan | Cheap to add, but hosted macOS runners cost paid minutes on a private repository; an owner decision (G19). |

## 2026-11-11 direction options (not ranked against bugs)

1. **Credit-free T3 drift detection.** Split the three contract checks that start no threads (`src/t3-live.test.ts:504-528`) into a `test:t3-contract` command, log T3's server version on catalog load, and warn on unknown properties or missed description rewrites. Evidence: T3 ships nightly, the bridge is verified against one build (`docs/t3-code.md:79`), and the only detector spends credits. Trade-off: one more command to keep in step with the fake; it could run from launchd after each T3 update.
2. **Move the phone runbook out of code and give bridges one small interface.** The hard-coded runbook (`src/server.ts:398-425`, about 8 KB in every `open_workspace`) is already wrong for Svartal (G13) and has a natural home in sky-cua's `phone-use` skill. A shared interface (capability name, register, close, health) would give backlog F24 a health hook. Trade-off: the runbook's facts are the owner's, not the repository's, so its content needs the owner.
3. **Chassis extraction, after an SDK-version decision.** The owner treats DevSpace as a reusable connector base, but the HTTP/OAuth layer depends on v1-only SDK auth exports and the T3 work added more DevSpace-specific plumbing through it (`src/server.ts:963,1798-1811,2217,2312`). Extracting now hands every consumer a later v1-to-v2 migration. Trade-off: a spike first costs a day and may conclude "stay on v1".
4. **`list_workspaces`.** Unchanged from 2026-11-04 and still small: `WorkspaceStore.listSessions()` exists (`src/workspace-store.ts:122`) and plan 016 makes retained checkouts more common, so a way to find them from a new chat gains value.

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
| F28 | **Fixed in `d652aee`** (`src/server.ts:1832`, `src/server-mcp-body-limit.test.ts`). Was: `/mcp` request bodies cap at 100 KiB (`createMcpExpressApp` mounts bare `express.json()`), so `write_file`/`edit_file` with larger content returns 413. Found by the plan 008 reviewer, who verified it before and after the SDK bump | bug | S | LOW | `src/server.ts:1810`; `node_modules/@modelcontextprotocol/sdk/dist/esm/server/express.js:29` |

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
