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
| T3 bridge against the real T3 Code and `t3` CLI on this machine, through an in-process DevSpace | `bun run test:t3-live` |
| T3 bridge through the public DevSpace URL and the deployed Svartal gateway | `bun run test:t3-deployed` |
| Build without a version bump. Deletes and rewrites `dist` (clean, `vite build` into `dist/ui`, then `tsc -p tsconfig.build.json`) | `bun run build:check` |
| Build a self-contained release directory for this host; does not touch the running gateway (on Svartal pass `--node` with the launcher's Node 24, see `docs/svartal-gateway.md`) | `bun run release:prepare` |

`bun test` is not the test command: it invokes Bun's own runner, which these scripts are not written for.

## Never run unless explicitly asked

- `bun run build` (`scripts/versioned-build.mjs`): bumps the version in `package.json`, prepends `CHANGELOG.md`, and requires committed build inputs.
- `bun run rebuild:local`: does everything `build` does, then restarts `devspace.service` and probes `/healthz`.
- `bun run test:t3-live` and `bun run test:t3-deployed`: start real T3 Code threads that run agent turns and use provider credits, then settle and archive them; `test:t3-deployed` also authenticates against the production gateway (see `docs/t3-code.md`).
- `bun run release:activate`: switches the live Svartal gateway to a prepared release and restarts it.
- On Svartal, `/Users/rclair/projects/devspace` is the checkout the production gateway runs from (`~/.local/bin/devspace-gateway` executes its `dist/cli.js`). In that checkout, `bun run build:check`, `bun run build`, `bun install`, and `bun update` replace files the live gateway loads, so they are deploy steps. Build and test in a separate git worktree or clone.

## Tests

- Tests under `src/` are standalone `tsx` scripts using `node:assert/strict`; `scripts/release-utils.test.mjs` and `scripts/local-release.test.mjs` run under `node --test`.
- Append every new `src/*.test.ts` to the `"test"` script in `package.json` by hand, or it never runs.
- `src/testing/` holds the fake T3 Code server and CLI, the captured T3 contract fixtures, and the T3 orchestrator scenarios and behavior checks shared by the T3 suites; `tsconfig.build.json` excludes it from the build.
  `src/testing/widget-host/` is the developer MCP Apps host for the workspace card (`bun run widget:host`, see `docs/widget-host.md`).
- The widget (`src/ui/`) has no DOM test framework: test its logic as pure functions and its markup with `react-dom/server`. Its layout, and why it must not compile WebAssembly, are in `docs/widget-host.md`.
- Any tool with an `outputSchema` in `src/server.ts` needs at least one MCP-level success-path test, because the MCP SDK validates `structuredContent` only on non-error results (pattern: `src/server-mcp-routing.test.ts`).

## Tool contract

- `TOOL_CONTRACT_HASH` is the sha256 of `CONTRACT_DESCRIPTION` in `src/tool-contract.ts`, a hand-maintained per-tool field list. It is deliberately not derived from the Zod `TOOL_SCHEMAS`.
- Any wire-shape change must update `TOOL_SCHEMAS`, `CONTRACT_DESCRIPTION` (this is what changes the hash), and the mirrored `inputSchema` in `src/server.ts`, all together.
- `src/node-server.ts` and `src/remote-node-client.ts` reject a peer whose hash differs, so the gateway and every node must redeploy together.

## Security invariants for contributors

- File-tool path canonicalization lives in `src/roots.ts` (`canonicalTarget`).
- Child-process environments must come from `src/shell-environment.ts`: `createShellRuntime` for shell and terminal children (strips `config.secretNames`), `bridgeChildEnvironment` for MCP bridge children such as sky-cua and node_repl (additionally strips `GH_TOKEN`, `GITHUB_TOKEN`, and `*_NODE_TOKEN`), `gitChildEnvironment` for git children (strips the names that `WorkspaceRegistry` and `createGatewayServer` register from `config.secretNames`, and the names listed in `DEVSPACE_INFRA_SECRET_NAMES`). Never copy `process.env` directly.
- Never log tokens or secret values.
- DevSpace owns its OAuth authorization-server endpoint code in `src/oauth/` (`/authorize`, `/token`, `/register`, `/revoke`, client authentication, CORS, the `OAuthHttpError` type). No upstream package maintains or patches it, so treat changes there as security review, not dependency bumps. The discovery documents and `/mcp` bearer authentication come from the maintained `@modelcontextprotocol/express` (`mcpAuthMetadataRouter`, `requireBearerAuth`).
- Token verifiers must throw `OAuthHttpError` with `invalid_token`; anything else makes `/mcp` answer 500 instead of a 401 challenge.
- `src/server-oauth-http.test.ts` pins the OAuth wire output, including its `KNOWN DEFECT` cases; RFC 9207 `iss` is deliberately not sent (see the comment in `src/oauth/authorize.ts`).

## Environment notes

- No script loads `.env`. Export variables in the shell or the systemd unit; names are listed in `.env.example`.
- When `DEVSPACE_WIDGETS` is not `off`, the server reads `dist/ui/.vite/manifest.json`; run `bun run build:check` once on a fresh clone or worktree (never in the serving checkout described above) before `bun run dev` or `bun run start`.

## Delivery and plans

- Pushing `main` to Gitea runs `.gitea/workflows/publish-runtime-artifact.yml`, which publishes the runtime artifact **and** dispatches `.gitea/workflows/deploy-runtime-artifact.yml`.
- Improvement plans live in `plans/`; `plans/README.md` is the index.
