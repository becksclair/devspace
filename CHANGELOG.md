# Changelog

## 2.0.1 - 2026-11-04

- ci: install tmux for trusted-host tests
- ci: run trusted-host checks unprivileged
- feat: consolidate gateway workspace activity UI
- test: make workspace mode fixture self-contained
- chore: retire obsolete DevSpace deploy path
- ci: deploy verified runtime artifacts automatically
- fix: run artifact publish steps with bash
- feat: add trusted-owner tool annotations
- fix: resume remote calls across tunnel loss
- feat: add global DevSpace instructions
- fix: normalize executor PATH
- feat: add headless OAuth token minting
- fix: guard Hermes OAuth client conflicts
- fix(oauth): cap dynamic clients at 500
- fix(gateway): evict idle MCP sessions to bound memory growth
- ci: build devspace runtime artifacts on the saga-build runner
- ci: surface smoke test child output and widen boot budget
- Merge pull request 'Add static API key auth alongside OAuth' (#1) from codex/static-api-key-auth into main
- Merge branch 'codex/static-api-key-auth' into main
- workspaces: prune heavy dirs and cap homedir walk (fix asgard unreachability)
- tailnet: allow http for Tailnet targets, direct http over WireGuard
- sky-cua: live bridge with per-client DISABLED_CAPABILITIES, phone aliases
- sky-cua: fix system service XDG_RUNTIME_DIR fallback (24s timeout)
- sky-cua: mark phone handshake tools non-destructive for platform safety
- sky-cua: force all bridge tools non-destructive for platform safety
- devspace: inject ephemeral phone lifecycle AGENTS.md on open_workspace
- devspace: note Thunderbird package is net.thunderbird.android in phone AGENTS
- devspace: normalize phone selector alias+session_id for sky-cua
- devspace: add wait-for-ready guidance to phone AGENTS
- devspace: fix observe(phone) schema mismatch — strip detail/mixed-surface fields and normalize selectors
- devspace: auto-inject phone-use skill alongside phone-AGENTS.md
- devspace: fix phone_pointer provenance and document AppShotRequired retry
- devspace: harden gateway for all strict phone branches
- devspace: add Telegram list/visual-grounding guidance to phone AGENTS
- devspace: clarify workspace/machine for phone - Asgard vs Saga
- devspace: document 30s AppShot TTL and fresh-observe retry for pointer
- devspace: clarify Telegram ready is RecyclerView, not window title
- devspace: add sane polling interval to phone AGENTS
- docs: clarify delegation and add round-trip efficiency contract
- feat: multi_read batch + per-session node_repl
- Revert "feat: multi_read batch + per-session node_repl"
- feat: multi_read + per-session node_repl bridge
- fix: RV-003 gateway multi_read fan-out per-file duration split + sanitized opId
- fix: RV-002 resilience (node_repl passthrough) + RV-003 gateway timing split; final advisory closeout
- fix(typecheck): cover multi_read + exhaustive switch in workspace-activity; add compilation-guard test
- fix: wire orphaned tests and harden terminal-manager flake
- test: add reproduction for multi_read truncated flag loss
- fix: propagate truncated flag from multi_read fast path
- fix(gateway): field-targeted workspaceId rewrite (002)
- perf(remote): cache hello 30s with single bust on stale identity
- security(oauth): add CSRF double-submit + rate limiting for owner approval
- docs(plans): add deep audit execution plans 001-005 (DONE)
- chore: migrate package manager from npm to bun
- chore(deps): update dependencies to latest compatible versions
- fix(lint): resolve TypeScript/ESLint warnings
- perf(executor): optimize multiRead hot path
- perf(gateway): optimize activity fan-out and retention
- docs: document Asgard gateway and Saga restoration
- docs(plans): add deep audit execution plans 006-014
- Merge branch 'advisor/006-multi-read-mcp-output-schema' into advisor/audit-2026-11-04
- Merge branch 'advisor/007-multi-read-truthful-truncation' into advisor/audit-2026-11-04
- Merge branch 'advisor/008-dependency-security-floor' into advisor/audit-2026-11-04
- Merge branch 'advisor/013-rate-limit-client-keying' into advisor/audit-2026-11-04
- Merge branch 'advisor/009-dangling-symlink-write-escape' into advisor/audit-2026-11-04
- Merge branch 'advisor/010-bridge-secret-scrubbing' into advisor/audit-2026-11-04
- Merge branch 'advisor/012-gateway-hello-cache-staleness' into advisor/audit-2026-11-04
- Merge branch 'advisor/011-bun-package-manager-spawn' into advisor/audit-2026-11-04
- Merge branch 'advisor/014-agents-md-operating-guide' into advisor/audit-2026-11-04
- docs(plans): record execution status for 006-014
- fix: address final review findings
- fix(server): accept MCP request bodies up to the SDK limit
- Merge branch 'bex/sad-lamport-b02e37'

<!-- devspace-release: version=2.0.1 commit=33d0ee8325ffe45e2e86c0b40b12ae6c33f85995 -->
## Unreleased

- fix: evict idle MCP sessions so the gateway no longer accumulates memory
- feat: add DEVSPACE_SESSION_IDLE_TTL_SECONDS and DEVSPACE_SESSION_SWEEP_INTERVAL_SECONDS knobs

## 2.0.0 - 2026-08-05

- Bump version to 1.0.2
- feat: add multi-machine gateway
- fix: use DevSpace package workflow variables
- fix: verify runtime artifact checksum from archive directory
- fix: use POSIX digest comparison in artifact workflow
- docs: use existing Cloudflare zone
- refactor: use node token for remote machines
- fix: package runtime without link members
- fix: allow OAuth approval form submission from any origin
- feat!: add trusted-host engineering cockpit

<!-- devspace-release: version=2.0.0 commit=546b0e143cef0de100f67f51550fef865e2f9c01 -->
## 1.0.2 - 2026-07-17

- docs: add founder philosophy to readme
- Document CLI installation and local startup
- Clarify ChatGPT capabilities in README
- Persist OAuth clients and tokens to SQLite
- Harden HTTP security headers and CSP
- Add ChatGPT app icon asset
- Improve workspace tool guidance
- Fix ChatGPT app template caching
- Log MCP request details and routing errors
- Handle batched MCP initialize requests and clean up orphan transports
- Enforce JavaScript bundle budgets in Vite build
- feat: automate changelog versioned builds

<!-- devspace-release: version=1.0.2 commit=b9787b912e9ca148071b538666c6d707fb9f4b34 -->
## 1.0.1 - 2026-06-17

- Baseline for automated release tracking.

<!-- devspace-release: version=1.0.1 commit=342af0fbeaa160e72d85a94fd87cde9001223233 -->
