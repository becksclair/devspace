# Plan 014: Turn AGENTS.md into an accurate operating guide and add CLAUDE.md

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 79ddffc..HEAD -- AGENTS.md CLAUDE.md package.json src/tool-contract.ts scripts/versioned-build.mjs scripts/rebuild-local.mjs .gitea/workflows/publish-runtime-artifact.yml`
> `package.json` is expected to differ if plans 006/008/010/013 landed (new test
> entries, dependency floors). That is fine. Any change to `AGENTS.md`, or a
> `CLAUDE.md` that already exists, is drift: STOP and compare.

## Status

- **Priority**: P2 (docs; it can run at any time; it is most useful before the other plans are executed by agents)
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `79ddffc`, 2026-11-04

## Why this matters

`AGENTS.md` is the only agent-facing instruction file, and the improvement plans
in `plans/` are meant to be executed by coding agents. Today it states product
intent but no build, test or typecheck commands. It does not warn about the two
scripts that mutate release metadata or restart a live service, or about the
tool-contract hash that gates gateway↔node compatibility. It also contains two
claims that contradict the code and `docs/security.md`:

1. "enforce [the allowlist] on every file and shell operation". In fact shell
   and terminal tools are **deliberately** unconfined (`docs/security.md`,
   "Shell and terminal authority"; `README.md`, "Mental Model"). An agent
   following AGENTS.md could "fix" the shell into a broken sandbox.
2. "`AGENTS.md` files are returned … by later tool calls when the requested
   path enters a directory …". In fact nested instruction files are only
   **listed** as `availableAgentsFiles` in the `open_workspace` result
   (`src/workspaces.ts:427-432`, `src/executor.ts:200-226`;
   `docs/chatgpt-coding-workflow.md:98` describes this correctly).

Current Claude Code reads a root `AGENTS.md` directly when no `CLAUDE.md`
exists. A `CLAUDE.md` that imports it (`@AGENTS.md`) is added so that older
Claude Code versions, and sessions without native `AGENTS.md` support, get the
same file. The import is documented not to load the file twice.

## Current state

- `AGENTS.md` (32 lines) has a title, three paragraphs of intent, a workspace-workflow paragraph containing claim 2, and a "Core constraints" bullet list whose second bullet is claim 1. There is no `CLAUDE.md` in the repo root.
- `AGENTS.md` line map, for Step 1: title = line 1. The three intent paragraphs = lines 3-5, 7-9, 11-14. The workspace-workflow paragraph = lines 16-24; its last sentence (claim 2) starts "`AGENTS.md` files are returned automatically…" (lines 21-24). The core-constraints bullet to replace (claim 1) = line 29.
- DevSpace itself loads the **first** matching root instruction file in the order `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` (`docs/chatgpt-coding-workflow.md:91-96`; `src/workspaces.ts:700,716-727`). Adding `CLAUDE.md` does not change what DevSpace loads for this repo. The new root `CLAUDE.md` will, however, be listed in `availableAgentsFiles` (`src/workspaces.ts:575-590`); that is a one-line file and harmless.
- Facts the new guide must state (all verified at `79ddffc`):
  - Package manager: Bun (`bun.lock`; CI `bun install --frozen-lockfile`). Runtime: Node `>=24 <27` (`package.json` `engines`). No `package.json` script loads `.env`. `bun run <script>` executes `node`/`tsx` children, and Bun injects `.env` only into code it runs itself (`bun file.ts`) or when `--env-file=.env` is passed. Export variables in the shell or the systemd unit; `.env.example` documents the names.
  - `bun run typecheck` → `tsc -p tsconfig.json --noEmit`.
  - `bun run test` → `node --test scripts/release-utils.test.mjs` followed by an `&&` chain of `tsx src/<name>.test.ts` scripts. Takes about 65 s and needs `tmux` on PATH. New test files must be appended to that script by hand, or they never run (orphaned tests already happened once; see commits `b027d45`, `7fee803`). Run one suite with `bunx tsx src/<name>.test.ts`. `bun run test:protocol` runs the gateway/node protocol subset. **`bun test` is not the test command**: it invokes Bun's own runner, which these scripts are not written for.
  - `bun run build:check` → clean, `vite build` (UI into `dist/ui`), then `tsc -p tsconfig.build.json`. This is the non-mutating build.
  - `bun run build` (`scripts/versioned-build.mjs`) bumps the version in `package.json`, prepends `CHANGELOG.md`, and requires committed build inputs. `bun run rebuild:local` additionally restarts `devspace.service` and probes `/healthz`. Agents must not run either unless explicitly asked.
  - `TOOL_CONTRACT_HASH` is the sha256 of `CONTRACT_DESCRIPTION`, a hand-maintained per-tool field list in `src/tool-contract.ts:63-89`. It is deliberately **not** derived from the Zod `TOOL_SCHEMAS`. Any wire-shape change must update `TOOL_SCHEMAS`, `CONTRACT_DESCRIPTION` (this is what changes the hash), and the mirrored `inputSchema` in `src/server.ts`, all together. Both the node server (`src/node-server.ts`) and the gateway client (`src/remote-node-client.ts`) reject a peer whose hash differs, so the gateway and every node must redeploy together.
  - The MCP SDK (`McpServer.validateToolOutput`) checks `structuredContent` against the `outputSchema` each tool declares in `src/server.ts`, but only on non-error results. Every tool with an output schema therefore needs at least one MCP-level success-path test (`src/server-mcp-routing.test.ts` is the harness pattern).
  - Widgets: when `DEVSPACE_WIDGETS` is not `off`, the server reads `dist/ui/.vite/manifest.json`; run `bun run build:check` (or `bun run build:app`) once on a fresh clone before `bun run dev`/`start`.
  - Child processes: shells and terminals get their environment from `createShellRuntime` (`src/shell-environment.ts`), which strips `config.secretNames`. New child processes must not copy `process.env` directly.
  - Gitea: a push to `main` runs `.gitea/workflows/publish-runtime-artifact.yml`, which builds and publishes the runtime artifact and then dispatches `.gitea/workflows/deploy-runtime-artifact.yml`.
  - Plans live in `plans/` with an index in `plans/README.md`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Line count | `wc -l AGENTS.md` | ≤ 110 |
| Claim 1 gone | `grep -n "every file and shell operation" AGENTS.md` | no output |
| Claim 2 gone | `grep -n "by later tool calls" AGENTS.md` | no output |
| Commands present | `grep -c "bun run typecheck\|bun run test\|bun run build:check" AGENTS.md` | ≥ 3 |
| CLAUDE.md | `cat CLAUDE.md` | exactly `@AGENTS.md` |
| Sanity | `bun run typecheck` | exit 0 (no code changed; confirms nothing else broke) |

## Scope

**In scope**: `AGENTS.md` (rewrite), `CLAUDE.md` (create).

**Out of scope**:
- README, `docs/*` (separate docs findings), and any source or `package.json` change.
- Personal homelab runbook content: do not move or edit `docs/asgard-gateway.md` or `docs/configuration.md`.

## Git workflow

- Branch: `advisor/014-agents-md-operating-guide`
- Commit style: `docs(agents): add operating commands and correct security/instruction claims`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Rewrite AGENTS.md

Keep the existing title and the first three paragraphs (purpose, "not delegating to a local agent", Pi as backend adapter) verbatim. Then write these sections, in this order, using the facts in "Current state". Keep the prose tight and imperative.

1. **Workspace workflow (for MCP clients)**: keep the existing `open_workspace`/`workspaceId` reuse paragraph, but replace its last sentence with: root `AGENTS.md`/`CLAUDE.md` content is returned by `open_workspace`; nested instruction files are **listed** in `availableAgentsFiles`, so read the relevant one before working under that directory.
2. **Core constraints**: keep the existing bullets, but replace the second bullet with two bullets:
   - "File tools enforce the configured canonical root policy on every operation, including every entry of batched tools such as `multi_read`."
   - "Shell and persistent terminal tools deliberately run with the DevSpace service account's authority and are not confined to roots (see `docs/security.md`). Do not present root policy as a shell sandbox, and do not 'fix' this without an explicit decision."
3. **Commands**: a table with `bun install --frozen-lockfile`, `bun run typecheck`, `bun run test` (≈65 s, needs tmux), `bunx tsx src/<name>.test.ts`, `bun run test:protocol`, `bun run build:check`. Add a note that `bun test` is not the test command.
4. **Never run unless explicitly asked**: `bun run build` (mutates `package.json` and `CHANGELOG.md`, needs committed inputs) and `bun run rebuild:local` (restarts `devspace.service`).
5. **Tests**: standalone `tsx` scripts using `node:assert/strict`; append every new `src/*.test.ts` to the `"test"` script in `package.json`; any tool with an `outputSchema` needs an MCP-level success-path test (pattern: `src/server-mcp-routing.test.ts`).
6. **Tool contract**: the `TOOL_CONTRACT_HASH` rule and the gateway/node co-deploy requirement; the public schemas in `src/server.ts` mirror `src/tool-contract.ts` by hand.
7. **Security invariants for contributors**: file-tool canonicalization lives in `src/roots.ts` (`canonicalTarget`); child-process environments must come from `src/shell-environment.ts`, never a raw copy of `process.env`; never log tokens or secret values.
8. **Environment notes**: no script loads `.env`; export variables in the shell or the systemd unit (names are in `.env.example`). Widgets need `dist/ui` built once (`bun run build:check`).

Formatting rules for Step 1: do not hard-wrap bullets or table rows, so the file stays within the line budget. Do not write the phrase "by later tool calls" anywhere, even negated, or the negative grep fails.
9. **Delivery**: pushing `main` to Gitea publishes an artifact **and** dispatches a deployment; improvement plans live in `plans/` (`plans/README.md` is the index).

**Verify**:
- `grep -n "every file and shell operation" AGENTS.md` → no output
- `grep -n "by later tool calls" AGENTS.md` → no output
- `grep -n "availableAgentsFiles" AGENTS.md` → at least one match
- `grep -c "bun run typecheck\|bun run test\|bun run build:check" AGENTS.md` → ≥ 3
- `grep -n "rebuild:local" AGENTS.md` → at least one match
- `grep -n "TOOL_CONTRACT_HASH" AGENTS.md` → at least one match
- `wc -l AGENTS.md` → ≤ 110

### Step 2: Create CLAUDE.md

Create `CLAUDE.md` containing exactly one line: `@AGENTS.md`

**Verify**: `cat CLAUDE.md` → `@AGENTS.md`

### Step 3: Fact-check every command you wrote

For each command in the new Commands table, confirm it exists: `grep -n '"typecheck"\|"test"\|"test:protocol"\|"build:check"' package.json` shows each script. Confirm the tmux requirement: `grep -n "command -v tmux" src/terminal-manager.test.ts`.

**Verify**: every `bun run <name>` target named in AGENTS.md appears in `package.json` `"scripts"`; `bun run typecheck` → exit 0.

## Test plan

Documentation only; the grep checks in Steps 1–3 are the tests.

## Done criteria

- [ ] All Step 1 grep checks pass
- [ ] `CLAUDE.md` contains exactly `@AGENTS.md`
- [ ] `git status --porcelain -- . ':!plans'` lists exactly ` M AGENTS.md` and `?? CLAUDE.md` (or the committed equivalent)
- [ ] `plans/README.md` row for 014 updated

## STOP conditions

- A `CLAUDE.md` already exists with different content. Merge by hand only if the operator asks.
- Any fact listed in "Current state" turns out false when you check it (for example, `bun run test` no longer starts with `node --test scripts/release-utils.test.mjs`, or the Gitea publish workflow no longer dispatches a deploy). Report it; don't write the stale fact.
- The rewrite would need more than 110 lines. Cut prose, not facts.

## Maintenance notes

- Update AGENTS.md in the same change whenever a script in `package.json` is added, removed or renamed, or when the test runner changes (for example, if the `&&` chain is replaced by a glob-based runner, the "append every new test" rule goes away).
- If plan 010 lands, the "child-process environment" rule can name `bridgeChildEnvironment` alongside `createShellRuntime`.
