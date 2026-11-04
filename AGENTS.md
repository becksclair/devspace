# DevSpace

This project exposes a local development workspace over MCP so ChatGPT, Claude,
or another MCP-capable host can operate directly on this machine's approved
development directories.

The goal is not to delegate work to a separate local coding agent. The MCP host
should call tools that read files, edit files, search code, and run shell
commands directly against approved local project roots.

Pi's SDK is currently used as the backend adapter for mature local coding
primitives such as read, edit, write, grep, find, ls, and bash. DevSpace wraps
those primitives behind a remote Streamable HTTP MCP interface, suitable for use
through a Cloudflare Tunnel.

## Workspace workflow (for MCP clients)

The model-facing workflow is workspace based. MCP clients should call `open_workspace` once per local project directory or worktree, then reuse the returned `workspaceId` for subsequent tool calls in that same folder. Do not call `open_workspace` again for the same folder unless the `workspaceId` is rejected as unknown, the client switches folders/worktrees or checkout/worktree mode, or the user explicitly asks to reopen. `open_workspace` returns the content of the first root instruction file found (`AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`, in that order); nested instruction files are **listed** in `availableAgentsFiles`, so read the relevant one before working under that directory.

## Core constraints

- Treat this as remote access to the local machine; security is part of the core design, not a later add-on.
- Start with a narrow filesystem allowlist.
- File tools enforce the configured canonical root policy on every operation, including every entry of batched tools such as `multi_read`.
- Shell and persistent terminal tools deliberately run with the DevSpace service account's authority and are not confined to roots (see `docs/security.md`). Do not present root policy as a shell sandbox, and do not "fix" this without an explicit decision.
- Do not delegate work to Pi or any other local agent unless the user explicitly asks; the MCP host remains the orchestrator.
- Optimize for round-trip efficiency over Streamable HTTP + Cloudflare Tunnel: prefer composite/batch and co-located execution (e.g., batched reads, grep+read, multi-edit) over N× sequential read/grep/edit calls.
- Keep every file and action inspectable and auditable even when executed as a batch, and keep the surface small enough to validate with real ChatGPT/Claude MCP clients before adding UI or workflow features.

## Commands

Package manager is Bun; runtime is Node `>=24 <27`.

| Purpose | Command |
|---|---|
| Install | `bun install --frozen-lockfile` |
| Typecheck | `bun run typecheck` |
| Full test suite (about 65 s, needs `tmux` on PATH) | `bun run test` |
| One test suite | `bunx tsx src/<name>.test.ts` |
| Gateway/node protocol tests | `bun run test:protocol` |
| Non-mutating build (clean, `vite build` into `dist/ui`, then `tsc -p tsconfig.build.json`) | `bun run build:check` |

`bun test` is not the test command: it invokes Bun's own runner, which these scripts are not written for.

## Never run unless explicitly asked

- `bun run build` (`scripts/versioned-build.mjs`): bumps the version in `package.json`, prepends `CHANGELOG.md`, and requires committed build inputs.
- `bun run rebuild:local`: does everything `build` does, then restarts `devspace.service` and probes `/healthz`.

## Tests

- Tests under `src/` are standalone `tsx` scripts using `node:assert/strict`; `scripts/release-utils.test.mjs` runs under `node --test`.
- Append every new `src/*.test.ts` to the `"test"` script in `package.json` by hand, or it never runs.
- Any tool with an `outputSchema` in `src/server.ts` needs at least one MCP-level success-path test, because the MCP SDK validates `structuredContent` only on non-error results (pattern: `src/server-mcp-routing.test.ts`).

## Tool contract

- `TOOL_CONTRACT_HASH` is the sha256 of `CONTRACT_DESCRIPTION` in `src/tool-contract.ts`, a hand-maintained per-tool field list. It is deliberately not derived from the Zod `TOOL_SCHEMAS`.
- Any wire-shape change must update `TOOL_SCHEMAS`, `CONTRACT_DESCRIPTION` (this is what changes the hash), and the mirrored `inputSchema` in `src/server.ts`, all together.
- `src/node-server.ts` and `src/remote-node-client.ts` reject a peer whose hash differs, so the gateway and every node must redeploy together.

## Security invariants for contributors

- File-tool path canonicalization lives in `src/roots.ts` (`canonicalTarget`).
- Child-process environments must come from `src/shell-environment.ts`: `createShellRuntime` for shell and terminal children (strips `config.secretNames`), `bridgeChildEnvironment` for MCP bridge children such as sky-cua and node_repl (additionally strips `GH_TOKEN`, `GITHUB_TOKEN`, and `*_NODE_TOKEN`). Never copy `process.env` directly.
- Never log tokens or secret values.

## Environment notes

- No script loads `.env`. Export variables in the shell or the systemd unit; names are listed in `.env.example`.
- When `DEVSPACE_WIDGETS` is not `off`, the server reads `dist/ui/.vite/manifest.json`; run `bun run build:check` once on a fresh clone before `bun run dev` or `bun run start`.

## Delivery and plans

- Pushing `main` to Gitea runs `.gitea/workflows/publish-runtime-artifact.yml`, which publishes the runtime artifact **and** dispatches `.gitea/workflows/deploy-runtime-artifact.yml`.
- Improvement plans live in `plans/`; `plans/README.md` is the index.
