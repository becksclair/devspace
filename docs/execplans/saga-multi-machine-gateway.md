# Build and deploy the Saga multi-machine DevSpace gateway

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

Maintain this document in accordance with `/home/bex/.agents/PLANS.md`. The plan must remain self-contained: a new agent should be able to continue from this file and the current machines without reading the conversation that produced it.

## Purpose / Big Picture

After this work, one ChatGPT developer app connects to the always-on Saga virtual machine at `https://devspace-saga.heliasar.net/mcp` and can operate on either Asgard or Saga. Existing, unqualified calls such as `open_workspace({ path: "/home/bex/projects/devspace" })` keep their simple meaning and always target Asgard, the one canonical machine. A caller reaches Saga only by naming it or its alias, for example `open_workspace({ path: "/opt/homelab", machine: "saga" })`. There is no load balancing, automatic machine choice, silent failover, or fallback.

The public `workspaceId` returned by `open_workspace` permanently records which machine owns that workspace. Every later `read`, `edit`, `write`, `bash`, search, directory, and `show_changes` call uses that binding; those tools do not accept a machine selector. A user can prove the behavior by opening one workspace on each machine, running `hostname` through each workspace, restarting the gateway, and observing that both workspace IDs still route to their original machines. If Asgard is stopped, an unqualified open fails with an Asgard-specific availability error while an explicit Saga open still works.

This plan also installs two dedicated, remotely managed Cloudflare Tunnels. The public Saga tunnel terminates at the gateway. The Asgard tunnel terminates at a private DevSpace node and is protected by both Cloudflare Access service authentication and an independent DevSpace bearer token. The existing single-machine Asgard service and Tailscale Funnel remain available throughout staging and are retired only after direct ChatGPT acceptance.

## Preflight Verdict

The codebase-grounded architecture preflight verdict is **Ready to plan**. Repository structure, machine ownership, target-selection behavior, trust boundaries, failure semantics, deployment topology, migration strategy, acceptance tests, and rollback are sufficiently decided to execute this plan. Implementation was deliberately not started during preflight.

The recommendation is a Saga-owned public gateway plus one private node per machine, not two independent public ChatGPT apps and not a transparent network filesystem. The gateway owns public OAuth, MCP transport sessions, app metadata and widget resources, the configured machine catalog, persistent public-to-node workspace bindings, and aggregate request logs. Each node owns local allowlist enforcement, workspace state, instruction and skill loading, file operations, shell execution, worktrees, and diff checkpoints.

The resulting topology is:

    ChatGPT developer app
              |
              | OAuth and Streamable HTTP MCP
              v
    devspace-saga.heliasar.net
              |
              | dedicated Cloudflare Tunnel
              v
    Saga gateway, 127.0.0.1:7676
          |                         |
          | local authenticated     | Cloudflare Access service token
          | node protocol           | plus DevSpace node bearer token
          v                         v
    Saga node,                 devspace-asgard.heliasar.net
    127.0.0.1:7679                   |
                                     | dedicated Cloudflare Tunnel
                                     v
                               Asgard node,
                               127.0.0.1:7679

The routing invariant is:

    open_workspace(path)                    -> Asgard only
    open_workspace(path, machine="asgard") -> Asgard
    open_workspace(path, machine="home")   -> Asgard
    open_workspace(path, machine="saga")   -> Saga
    open_workspace(path, machine="cloud")  -> Saga
    every later call(workspaceId)           -> machine recorded for that ID
    any target failure                      -> explicit error, never another machine

## Progress

- [x] (2026-07-17 04:46Z) Inspected the current DevSpace MCP server, configuration, OAuth store, workspace registry and SQLite persistence, transport/session handling, tool and widget metadata, tests, local deployment, Saga homelab conventions, Cloudflare/Tailscale topology, and relevant dirty worktrees.
- [x] (2026-07-17 04:46Z) Completed the `grill-me` architecture preflight and recorded the settled decisions, assumptions, risks, and invalidating evidence in this ExecPlan.
- [x] (2026-07-17 04:46Z) Authored this standalone multi-phase ExecPlan without implementing or deploying the feature.
- [ ] Revalidate both repositories, both machines, current npm/Git state, service definitions, routes, and secrets before changing anything.
- [ ] Refactor the current local tool implementation behind a reusable local executor while preserving `devspace serve` behavior.
- [ ] Add the private node protocol, gateway role, persistent gateway workspace bindings, machine configuration, capability checks, explicit failure behavior, and role-aware diagnostics.
- [ ] Add machine-aware widget output, complete automated coverage, operator documentation, and a releasable version.
- [ ] Prepare additive, host-systemd deployment packages for Saga and Asgard without disturbing unrelated dirty-tree changes.
- [ ] Create and secure the two dedicated Cloudflare Tunnels and the Asgard Cloudflare Access service-auth application.
- [ ] Deploy the Saga gateway, Saga node, and Asgard node in parallel with the existing Asgard service.
- [ ] Verify routing, persistence, authentication, failure isolation, observability, and widgets end to end from Asgard.
- [ ] Publish the accepted release only after the pinned Git commit has passed live validation.
- [ ] Create a parallel ChatGPT developer app, test both machines directly in ChatGPT, cut over, disable only the old Asgard Tailscale Funnel route, soak, and preserve the documented rollback path.

## Surprises & Discoveries

- Observation: The current server is a single process rather than a separable gateway and executor. `src/server.ts` creates OAuth, Streamable HTTP MCP sessions, the local `WorkspaceRegistry`, review checkpoints, every tool handler, widget resources, and `/healthz` in one module.
  Evidence: `createServer()` in `src/server.ts` creates `SingleUserOAuthProvider`, `createWorkspaceStore`, `WorkspaceRegistry`, and the MCP server together.

- Observation: Workspace restart recovery already exists locally, but its stored row has no machine ownership because the current process serves only one machine.
  Evidence: `src/workspace-store.ts` persists `workspace_sessions`, and `WorkspaceRegistry.getWorkspace()` in `src/workspaces.ts` reconstructs a missing in-memory workspace from that store.

- Observation: The existing widget already uses a content-hashed app resource URI, which must be preserved when machine badges are added; a stable resource URI can leave ChatGPT showing stale app HTML.
  Evidence: `workspaceAppResourceUri()` in `src/server.ts` hashes the built entry and CSS filenames.

- Observation: Saga must run the gateway and local node as host services, not containers, because the product intentionally reads files and launches shell commands on the host. `/opt/homelab` uses host systemd for services with this requirement even though most other services use Compose.
  Evidence: Preflight inspection of `/opt/homelab` found its host-service convention and the state/source split under `/etc/saga-homelab`, `/srv/services-state`, and `/srv/services`.

- Observation: Both the local DevSpace repository and Saga `/opt/homelab` may change between authoring and execution. The preflight snapshot had DevSpace clean at `0e30e8f`, while `/opt/homelab` and the Asgard dotfiles repository contained unrelated work.
  Evidence: Revalidation is the first milestone; no implementation step may assume the snapshot is still current or clean unrelated state.

## Decision Log

- Decision: Saga owns the public gateway because it is the always-on machine; Asgard remains the one canonical/default execution machine.
  Rationale: Gateway availability and execution-default semantics are separate concerns. Hosting routing on Saga improves reachability without changing where an unqualified coding request runs.
  Date/Author: 2026-07-17 / Bex and Codex preflight

- Decision: Add an optional `machine` argument only to `open_workspace`; do not add a mutable machine selector to later tools.
  Rationale: The optional argument keeps the existing call shape backward-compatible, makes non-default selection visible at the point where ownership is established, and prevents a later call from accidentally moving a workspace between machines.
  Date/Author: 2026-07-17 / Codex preflight

- Decision: Machine identifiers and aliases are exact, case-normalized configuration values. Use stable IDs `asgard` and `saga`, with aliases `home` and `cloud` respectively. Exactly one configured entry has `canonical: true`.
  Rationale: Stable IDs make persisted bindings robust across display-name changes. Exact matching and startup validation eliminate fuzzy or silent routing.
  Date/Author: 2026-07-17 / Bex and Codex preflight

- Decision: A gateway workspace ID is random and opaque, and maps persistently to a stable machine ID plus that node's workspace ID. Do not encode the machine in a user-controlled workspace ID and do not automatically reopen a workspace after node-state loss.
  Rationale: The mapping is the authority for routing. Automatic reopening could target changed filesystem state, recreate a worktree, or repeat side effects without the user's knowledge.
  Date/Author: 2026-07-17 / Codex preflight

- Decision: Nodes expose a small versioned JSON-over-HTTP protocol, not another public MCP server. The initial endpoints are authenticated `GET /internal/v1/hello` and `POST /internal/v1/call`.
  Rationale: MCP OAuth, app resources, client sessions, and model-facing metadata belong at one public boundary. A smaller internal protocol is easier to authenticate, version, bound, and test.
  Date/Author: 2026-07-17 / Codex preflight

- Decision: Never automatically retry an internal tool call. Propagate cancellation and return stable failure codes instead.
  Rationale: Reads are retryable in principle, but edits, writes, worktree creation, and shell commands may have completed before a connection failed. A blanket retry can duplicate irreversible effects.
  Date/Author: 2026-07-17 / Codex preflight

- Decision: The Asgard node is protected by two independent layers: Cloudflare Access service-auth headers at the tunnel edge and a DevSpace bearer token at the node. Both nodes bind only to loopback.
  Rationale: Cloudflare credentials authenticate the Saga gateway to the edge; the node token protects the origin if the edge policy or local route is bypassed. Loopback binding prevents direct LAN or public listening.
  Date/Author: 2026-07-17 / Codex preflight

- Decision: Do not place Cloudflare Access in front of the public Saga gateway.
  Rationale: ChatGPT must reach OAuth discovery, authorization, callback-related metadata, MCP, and app resources. DevSpace's existing single-user OAuth remains the public authorization boundary.
  Date/Author: 2026-07-17 / Codex preflight

- Decision: The gateway starts even when Asgard is unavailable. `/healthz` reports process health with HTTP 200; `/readyz` reports canonical-machine readiness and returns HTTP 503 while Asgard is unavailable. Explicit Saga work remains usable.
  Rationale: Failing gateway startup would unnecessarily remove the healthy Saga target. Readiness must still make degraded canonical behavior visible to operators.
  Date/Author: 2026-07-17 / Bex and Codex preflight

- Decision: Preserve `devspace serve` as the standalone, backward-compatible role. Add explicit `devspace gateway --config <path>` and `devspace node --config <path>` roles, and make `devspace doctor` role-aware.
  Rationale: Existing local users and the current Asgard rollback service should not require migration to the distributed topology.
  Date/Author: 2026-07-17 / Codex preflight

- Decision: Use two dedicated, remotely managed Cloudflare Tunnels named for DevSpace, one per hostname. Do not reuse the existing locally managed Asgard Watercooler tunnel.
  Rationale: Independent tunnel lifecycle, credentials, logs, and rollback reduce blast radius and avoid coupling unrelated services.
  Date/Author: 2026-07-17 / Bex and Codex preflight

- Decision: Saga's node allowlist is `/home/ubuntu`, `/opt/homelab`, and `/srv/services`. Asgard retains its current allowlist unless preflight revalidation finds an intentional configuration change.
  Rationale: Node-local enforcement is the security boundary. Saga needs broad but explicit access to its operator-owned source and service trees; the gateway must not weaken either machine's policy.
  Date/Author: 2026-07-17 / Bex

- Decision: Stage and deploy the exact same pinned Git commit on both machines, validate it live, then publish the npm release. Reconcile the package version against the registry immediately before release; the intended feature version is `1.1.0` if that version remains available.
  Rationale: Live testing a commit before publishing separates deployment acceptance from registry publication and guarantees gateway-node protocol parity during rollout.
  Date/Author: 2026-07-17 / Bex and Codex preflight

- Decision: Create a parallel replacement ChatGPT developer app for Saga. Do not mutate the current Asgard draft until the new app passes direct acceptance.
  Rationale: A parallel app makes connector, OAuth, widget, and routing rollback immediate and avoids breaking the only working app during rollout.
  Date/Author: 2026-07-17 / Bex and Codex preflight

- Decision: Disable only the old Asgard Tailscale Funnel route on HTTPS port 443 after acceptance. Preserve unrelated Funnel routes, including the OpenClaw route on port 10000 and any service on port 8877.
  Rationale: A global Funnel reset would break unrelated remote access.
  Date/Author: 2026-07-17 / Bex and Codex preflight

## Outcomes & Retrospective

No implementation outcome exists yet. The current outcome is a completed architecture preflight and this executable plan. At the end of every milestone, update this section with what is observably working, what remains, and whether any original assumption changed. At final completion, compare the live ChatGPT behavior, failure drills, security checks, and rollback proof against the Purpose section.

## Context and Orientation

The DevSpace source repository is `/home/bex/projects/devspace`. At plan authoring it is on `main` at commit `0e30e8f`, package name `@waishnav/devspace`, source version `1.0.1`, with npm scripts `npm test`, `npm run typecheck`, and `npm run build`. Recheck all of these before acting. Preserve every pre-existing tracked or untracked change. Do not stash, reset, clean, or overwrite unrelated work.

The existing program has one public role. `src/cli.ts` recognizes `serve`, loads `ServerConfig` from `src/config.ts`, and starts `createServer()` from `src/server.ts`. `src/server.ts` constructs the Express app, public OAuth routes, Streamable HTTP MCP sessions, tool registrations, widget resource, local workspace registry, and health endpoint. It also owns model-facing logging. The refactor must separate ownership without changing standalone behavior.

`src/workspaces.ts` defines `WorkspaceRegistry`. `openWorkspace()` validates a local path against `ServerConfig.allowedRoots`, optionally creates a managed Git worktree, loads project instructions and skills, and returns a local workspace. `getWorkspace()` first consults memory and then restores a row from `src/workspace-store.ts`. The SQLite schema in `src/db/schema.ts` currently stores the local workspace ID, root, mode, source root, Git base, and timestamps. OAuth clients and tokens are also persisted in the same state directory through separate tables.

`open_workspace` is registered directly in `src/server.ts`. Its current input is `path`, optional `mode`, and optional `baseRef`; its result includes `workspaceId`, root and worktree information, instruction files, skills, and an instruction telling the model to reuse the ID. Later tools accept only `workspaceId` plus operation-specific arguments. This model-facing contract is a core compatibility constraint.

The term **gateway** in this plan means the one public process that ChatGPT connects to. It does not touch local project files itself. The term **node** means a private process on one machine that performs filesystem, Git, skill, diff, and shell work on that machine. The term **canonical machine** means the only configured machine selected when `open_workspace` has no `machine` argument. Canonical does not mean gateway host and does not mean failover primary. A **gateway workspace ID** is the opaque ID returned to ChatGPT. A **node workspace ID** is private to one node. A **binding** is the durable database row connecting those two IDs and a stable machine ID.

The current Asgard deployment is a user systemd service at `/home/bex/.config/systemd/user/devspace.service`, serving the repository checkout on `127.0.0.1:7676` with public base URL `https://asgard.stegosaurus-aeolian.ts.net`. Tailscale Funnel exposes HTTPS port 443 to that port. The plan keeps this service and route untouched until final cutover. The last preflight snapshot found Asgard using a Node 24 runtime and a local allowlist covering `/home/bex/.agents`, `/home/bex/.codex`, `/home/bex/.config`, `/home/bex/projects`, `/home/bex/Documents/Codex`, `/home/bex/HeliasMind`, and `/home/bex/HeliasMind-Archive`; re-read the live unit and environment rather than copying this list blindly.

Saga is reachable with `ssh saga`; its homelab repository is `/opt/homelab`. The deployment convention is tracked service definitions under `/opt/homelab`, secrets and machine-local configuration under `/etc/saga-homelab`, mutable state under `/srv/services-state`, and source releases under `/srv/services`. Saga uses host systemd for software that must operate on the host. The last snapshot found Node 24 available through `mise`, passwordless non-interactive `sudo`, GitHub SSH access, and unrelated dirty work in `/opt/homelab`. Revalidate these facts. Add the DevSpace integration under a new `/opt/homelab/devspace/` subtree first; do not edit shared homelab files until overlap with existing work has been ruled out.

The deployment release layout is deliberately immutable by commit. On Saga use `/srv/services/devspace/releases/<full-git-commit>` and symlink `/srv/services/devspace/current` to the accepted release. Use `/srv/services-state/devspace-gateway` and `/srv/services-state/devspace-node-saga` for SQLite and runtime state. On Asgard use `/home/bex/.local/share/devspace/releases/<full-git-commit>` and `/home/bex/.local/share/devspace/current`, with separate state directories under `/home/bex/.local/share/devspace/state/`. Building on each target is required because `better-sqlite3` contains a native binary tied to the target Node runtime.

No existing OAuth or workspace database is migrated. The Saga gateway is a parallel app with fresh OAuth state and fresh gateway bindings. The old Asgard standalone service remains the rollback owner of its existing state. This avoids trying to reinterpret current local workspace rows as gateway binding rows.

## Constraints, Assumptions, and Invalidating Evidence

Exactly one machine must be canonical. Configuration loading must fail before listening if zero or multiple machines are canonical, stable IDs collide, an alias collides after lower-case normalization, a node URL is invalid, a required secret reference is absent, or the gateway itself is accidentally configured as a node target without an explicit loopback URL. A non-default machine must never be selected from path shape, availability, latency, model wording, prior workspace use, or failure of another target.

The plan assumes Bex controls the `heliasar.net` Cloudflare zone and can create two tunnels, DNS routes, one Access application, one Service Auth policy, and a service token. It also assumes the executor can obtain those tunnel tokens and Access credentials without committing or printing them. If the necessary Cloudflare permissions are unavailable, stop at the Cloudflare milestone with verdict **Needs investigation** and record the exact missing permission; do not substitute a quick tunnel, expose the node unauthenticated, or silently fall back to Tailscale.

The plan assumes `ssh saga` continues to reach the intended Ubuntu VM and that the Git commit can be fetched on both hosts. If either machine cannot install the same commit and compatible Node/native dependencies, stop before any public tunnel cutover. Do not deploy mismatched protocol implementations.

The plan assumes ChatGPT accepts an added optional string field on `open_workspace` and continues to call the tool normally when it is absent. Automated MCP schema tests and the parallel developer app must prove this. If ChatGPT omits explicit target selection even after the user names Saga, improve tool description and app instructions first. A separate explicit `open_workspace_on_machine` tool is the fallback design only if direct ChatGPT evidence shows the optional argument cannot be selected reliably; changing to it requires a Decision Log entry and new compatibility tests.

The plan assumes Cloudflare Access Service Auth forwards requests with `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers and that the dedicated tunnel can reach an Asgard loopback origin. If the edge consumes or transforms these headers differently, prove the actual request shape before changing node authentication. Do not remove the independent node bearer token.

The plan intentionally does not provide high availability for the gateway. If Saga is down, the one ChatGPT app is down. If Asgard is down, only the canonical target is unavailable. Solving gateway redundancy, distributed consensus, automatic failover, cross-machine worktree movement, or shared filesystems is outside this plan.

## Interfaces and Dependencies

Retain the existing dependencies where possible. Use Express and Zod already present in `package.json` for the node HTTP service and protocol validation. Use the existing SQLite and Drizzle helpers for durable bindings. Use the platform `fetch` implementation for gateway-to-node calls. Do not add a message broker, service-discovery system, reverse-proxy framework, or second MCP SDK layer.

Create a reusable local execution boundary, preferably `src/executor.ts`, with a narrow interface equivalent to:

    export type CanonicalToolName =
      | "open_workspace"
      | "read"
      | "write"
      | "edit"
      | "grep"
      | "glob"
      | "ls"
      | "bash"
      | "show_changes";

    export interface WorkspaceExecutor {
      call(input: {
        requestId: string;
        tool: CanonicalToolName;
        arguments: unknown;
        signal?: AbortSignal;
      }): Promise<unknown>;
      close(): void;
    }

    export function createLocalWorkspaceExecutor(
      config: NodeExecutionConfig,
    ): WorkspaceExecutor;

The exact internal method split may improve during implementation, but the important boundary is that standalone `serve` and private `node` use the same local executor. Do not maintain two copies of path validation or tool behavior.

Add role-specific configuration types, while keeping `loadConfig()` and current environment variables valid for standalone use. A recommended file split is `src/config.ts` for standalone compatibility, `src/gateway-config.ts` for the public role, and `src/node-config.ts` for the private role. Gateway configuration must name every machine and the one canonical entry. Machine credentials must come from environment variables or mode-0600 secret files, never JSON committed to Git.

The effective Saga gateway configuration should have this shape, with actual secret references supplied by systemd:

    {
      "role": "gateway",
      "host": "127.0.0.1",
      "port": 7676,
      "publicBaseUrl": "https://devspace-saga.heliasar.net",
      "stateDir": "/srv/services-state/devspace-gateway",
      "machines": [
        {
          "id": "asgard",
          "displayName": "Asgard",
          "aliases": ["home"],
          "canonical": true,
          "url": "https://devspace-asgard.heliasar.net"
        },
        {
          "id": "saga",
          "displayName": "Saga",
          "aliases": ["cloud"],
          "canonical": false,
          "url": "http://127.0.0.1:7679"
        }
      ]
    }

The Asgard node config must bind `127.0.0.1:7679`, declare machine ID `asgard`, preserve the live Asgard allowlist, use a node-specific state directory, and read its bearer token from a protected environment file. The Saga node config must bind `127.0.0.1:7679`, declare machine ID `saga`, allow `/home/ubuntu`, `/opt/homelab`, and `/srv/services`, and use `/srv/services-state/devspace-node-saga`. A node does not load OAuth owner credentials or expose OAuth routes, MCP, app resources, or public metadata.

Define protocol version `1` under `src/node-protocol.ts`. `GET /internal/v1/hello` requires node bearer authentication and returns a Zod-validated body such as:

    {
      "protocolVersion": 1,
      "machineId": "asgard",
      "nodeVersion": "1.1.0",
      "commit": "<full-git-commit>",
      "capabilities": [
        "workspace.checkout",
        "workspace.worktree",
        "file.read",
        "file.write",
        "file.edit",
        "search",
        "shell",
        "changes"
      ],
      "limits": {
        "maxRequestBytes": 67108864,
        "maxResponseBytes": 67108864
      }
    }

`POST /internal/v1/call` accepts one discriminated request envelope and returns one discriminated result envelope. Both sides validate with shared Zod schemas. The request contains `protocolVersion`, a gateway-generated `requestId`, canonical internal tool name, arguments, and a node workspace ID for every tool except `open_workspace`. The response is either `{ "ok": true, "result": ... }` or `{ "ok": false, "error": { "code": ..., "message": ..., "retryable": false } }`. Limit request and response bodies to 64 MiB initially, matching large but bounded file and image use. Reject unsupported protocol versions before execution.

Stable internal error codes must include at least `authentication_failed`, `protocol_mismatch`, `machine_mismatch`, `capability_unavailable`, `unknown_machine`, `target_unavailable`, `workspace_unknown`, `request_too_large`, `response_too_large`, `cancelled`, `timeout`, `invalid_arguments`, and `execution_failed`. Preserve useful existing local error messages inside a sanitized message, but let the gateway map internal failures to consistent MCP errors. Never turn `target_unavailable` into a request to another machine.

Add a gateway binding table through an additive SQLite migration, preferably named `gateway_workspace_bindings`, with `gateway_workspace_id` as primary key, `machine_id`, `node_workspace_id`, optional display-only `root` and `mode`, `created_at`, and `last_used_at`. Create `src/gateway-workspace-store.ts` rather than overloading the node's local `WorkspaceStore`. Every later call performs exactly one lookup by gateway ID, resolves the stable machine ID from current config, and invokes only that node workspace ID. If the stable machine ID has been removed from configuration, return an explicit configuration error; do not remap by alias.

Extend the public `open_workspace` input schema with:

    machine: z.string().optional().describe(
      "Optional explicit machine name or alias. Omit to use canonical Asgard. " +
      "Configured choices: asgard (alias home), saga (alias cloud)."
    )

Normalize only surrounding whitespace and ASCII case before exact ID-or-alias comparison. An absent value chooses the one canonical entry. An empty value is invalid. An unknown value returns `unknown_machine` and lists configured IDs and aliases. The structured output should add a non-secret object containing `machine: { id, displayName, canonical }`. Preserve all existing fields and the current workspace-reuse instruction. Later public tools remain unchanged.

Keep public OAuth and MCP transport sessions entirely in the gateway. An MCP transport session is the SDK-managed Streamable HTTP conversation identified by `mcp-session-id`; it is unrelated to a DevSpace workspace binding. Gateway restart may invalidate an MCP transport session as it does today, but must not invalidate OAuth state or gateway workspace bindings. A new MCP session can reuse a persisted `workspaceId`.

The gateway node client must send `Authorization: Bearer <node-token>` to both nodes. For Asgard only, it must also send the Cloudflare Access service-token headers. Secrets must be looked up by machine ID from protected environment values, not serialized into the machine catalog or logs. Use one bounded connect timeout and one bounded total-call timeout, propagate client cancellation through `AbortController`, and make timeout values configurable. Do not retry any call automatically.

Structured gateway logs must include a gateway request ID, operation, stable machine ID, gateway workspace ID prefix when present, node workspace ID prefix when present, duration, upstream HTTP status, and stable error code. Node logs must include the propagated request ID, operation, local workspace prefix, duration, and outcome. Preserve the existing default of not logging full shell commands. Never log owner tokens, OAuth bearer tokens, node tokens, Cloudflare Access secrets, full authorization headers, or file contents.

## Plan of Work

### Milestone 0: Protect current state and re-establish the baseline

Start by proving what is current, because this plan crosses a clean product repository, an unrelated dirty homelab repository, live services, and external routing. Do not modify anything during this milestone. Capture the full DevSpace commit, branch, status, package and registry versions, test baseline, Asgard service and Funnel state, Saga repository status, installed runtimes, free ports, and current Cloudflare tunnel ownership. Save non-secret output in the plan's Artifacts section or a timestamped operator transcript outside Git; never paste secret values.

On Asgard, inspect `/home/bex/projects/devspace`, `/home/bex/.config/systemd/user/devspace.service`, its environment sources, `systemctl --user status`, `tailscale funnel status --json`, and the existing cloudflared services. On Saga, use `ssh saga` and inspect `/opt/homelab`, `/etc/saga-homelab`, `/srv/services`, systemd units, ports 7676 and 7679, `mise`, Node, npm, cloudflared, GitHub SSH access, and disk space. Explicitly identify all dirty and untracked paths before adding files.

Run the current DevSpace tests, typecheck, and build before refactoring. Acceptance for this milestone is a written baseline with no state changes, all unrelated dirty work accounted for, and either a green baseline or an exact pre-existing failure recorded. If the repository is no longer clean at `0e30e8f`, treat the current tree as authoritative and update this plan before proceeding.

### Milestone 1: Extract one local workspace executor without changing standalone behavior

Refactor `src/server.ts` so model-facing MCP registration delegates workspace operations to a local executor rather than directly owning `WorkspaceRegistry` and Pi tools. Move only enough code to create a real ownership seam: workspace open/restore, path resolution, local tools, review checkpoints, skills/instructions, worktrees, and `show_changes` belong behind the executor. Keep public OAuth, MCP session routing, tool schemas and descriptions, widget resources, HTTP security headers, and public logging in the standalone/public server layer.

Make `devspace serve` construct `createLocalWorkspaceExecutor()` and pass it to the existing MCP registration. Preserve every current input and output byte that is model-relevant, including short and legacy tool names, minimal/full tool modes, widget modes, worktree behavior, persisted workspace recovery, and error messages unless a test explicitly documents an intentional improvement.

Add focused executor tests and adapt existing `src/workspaces.test.ts`, `src/review-checkpoints.test.ts`, and server tests to exercise the seam. Acceptance is that `npm test`, `npm run typecheck`, and `npm run build` pass and a locally started `devspace serve` can open the repository, read a file, run `hostname`, and show changes exactly as before. Do not begin network routing until this is true.

### Milestone 2: Implement the private node protocol and explicit gateway routing

Add shared protocol schemas, an authenticated node HTTP server, a node client, machine catalog validation, gateway workspace persistence, and the two new CLI roles. Keep node endpoints under `/internal/v1`; do not expose MCP or OAuth from a node. Add constant-time bearer-token comparison, bounded JSON parsing, body limits, timeout and cancellation propagation, stable error envelopes, request correlation, and graceful shutdown.

Refactor the public MCP construction so gateway mode uses `GatewayWorkspaceRouter` instead of a local executor. `open_workspace` resolves the optional `machine`, invokes that node once, stores the gateway binding transactionally only after a successful node open, replaces the private node workspace ID with a newly generated gateway ID, and returns machine metadata. All later tools resolve the binding and call exactly one configured node. Standalone mode continues to return and consume local IDs.

At gateway startup, validate configuration and probe each node's `hello` endpoint. A failed Asgard probe marks readiness degraded but does not prevent listening. A protocol or machine-ID mismatch marks only that target unavailable and logs the exact reason. A successful explicit Saga open remains possible. Refresh node status on a bounded interval or before a call, but do not let background health probes invoke workspace operations.

Add `/readyz` to gateway mode. `/healthz` should remain HTTP 200 when the process and local state database are functioning. `/readyz` should be HTTP 200 only when the canonical node has a compatible `hello`; otherwise HTTP 503 with a non-secret machine status summary. Nodes may expose a loopback `/healthz`, but `hello` is the authenticated compatibility proof.

Test with two in-process fake nodes and with two real loopback nodes on different ports. Cover omitted machine, explicit ID, alias, mixed case, whitespace, empty and unknown values, duplicate aliases, zero or multiple canonical entries, node machine mismatch, protocol mismatch, capability mismatch, target timeout, cancellation, oversized bodies, mutation disconnect, gateway restart, node restart, removed machine configuration, and node state loss. Assert that no test records a call on the wrong fake node.

Acceptance is observable: an unqualified open invokes only fake Asgard; `machine: "saga"` invokes only fake Saga; later calls route from the stored binding after a gateway restart; stopping fake Asgard produces `target_unavailable` and zero Saga calls; and explicit Saga operations still succeed.

### Milestone 3: Finish compatibility, widgets, documentation, and release preparation

Update the DevSpace widget structured payload and React UI under `src/ui/` to show a small Asgard or Saga badge on workspace and change cards. The machine badge is display metadata, not a selector. Preserve `workspaceAppResourceUri()` content hashing and both `_meta.ui.resourceUri` and `_meta["openai/outputTemplate"]` compatibility fields. Add widget metadata and rendering tests that prove a rebuilt template URI changes when assets change and machine data is rendered without exposing node URLs or credentials.

Update `README.md`, `docs/configuration.md`, `docs/security.md`, `docs/setup.md`, and `docs/gotchas.md`. Explain standalone, gateway, and node roles; exact target semantics; why only `open_workspace` accepts `machine`; local allowlists; gateway binding recovery; health versus readiness; Cloudflare Access plus node-token defense; no retries and no fallback; and how to rotate credentials. Include a two-machine example but keep standalone setup the first and simplest path.

Update `src/cli.ts` help and `doctor` output. `doctor --role gateway --config ...` must validate config, database access, public URL, each node's authenticated `hello`, protocol/capability compatibility, canonical uniqueness, and secret availability without printing secret values. `doctor --role node --config ...` must validate allowed roots, state directory, bind address, native SQLite, Git, Bash, and token availability. Preserve current plain `devspace doctor` output for standalone users.

Run the entire test suite, typecheck, production build, and a packed-package smoke test. Use `npm pack --dry-run` to verify new runtime files and docs are included. Reconcile `package.json` and `package-lock.json`; query the npm registry immediately before selecting the version. Use `1.1.0` only if it is still unpublished and semantically correct. Set MCP server/node version metadata from the package version rather than leaving `0.1.0` hard-coded in `src/server.ts`.

Create a local feature commit only after explicit authorization under the repository's `AGENTS.md`. Push only after separate explicit authorization. Record the full commit in this plan and use that exact commit for both machines. Do not publish npm yet.

### Milestone 4: Add additive host deployment packages on Saga and Asgard

In `/opt/homelab`, create a self-contained `/opt/homelab/devspace/` package before touching shared files. It should contain a README, non-secret gateway and Saga-node config templates, systemd units, and an idempotent install/update script. The script may create `/srv/services/devspace/releases/<commit>`, fetch or clone the approved commit, run `npm ci`, tests or a deployment smoke subset, and `npm run build`, then atomically update `/srv/services/devspace/current`. It must not create Cloudflare resources, write secret values, delete releases, publish npm, or restart unrelated services.

Create `devspace-saga-node.service`, `devspace-gateway.service`, and `cloudflared-devspace-saga.service` as host system units. Run DevSpace services as `ubuntu`, bind only to loopback, load secrets from root-owned mode-0600 files under `/etc/saga-homelab/devspace/`, use the state paths defined above, restart on failure with bounded backoff, and order the gateway after networking and the local node. Do not hard-require the Asgard node to start the gateway. The cloudflared unit must use `--token-file` so its tunnel token does not appear in the unit, process command line, journal, or repository.

On Asgard, add parallel user units `devspace-asgard-node.service` and `cloudflared-devspace-asgard.service`. Use a separate release symlink, state directory, config, and secrets from the existing `devspace.service`. Bind the node to `127.0.0.1:7679`; leave the old standalone server on 7676. Use a mode-0600 token file under `/home/bex/.config/devspace/secrets/` and ensure no secret-bearing file is tracked by the dirty dotfiles repository. If a tracked additive dotfiles package is desired, obtain authorization and stage only the exact new paths.

Validate units with `systemd-analyze verify` where available, shell-check installation scripts with the repository's accepted tool if present, and run install scripts in a no-restart or dry-run mode first. Acceptance is that all unit/config artifacts are additive, secrets are absent from Git and journals, release paths can be switched atomically, and neither current live service has changed.

### Milestone 5: Create the two Cloudflare Tunnels and secure the Asgard node

This milestone performs paid-account/external-system writes. Begin only when the task launching this ExecPlan explicitly authorizes Cloudflare DNS, Tunnel, and Access changes. Use Bex's existing Cloudflare account and zone; do not create a new account, subscription, or broad API token.

Create two dedicated remotely managed tunnels with unambiguous names such as `devspace-saga` and `devspace-asgard`. Route `devspace-saga.heliasar.net` to `http://127.0.0.1:7676` through the Saga tunnel. Route `devspace-asgard.heliasar.net` to `http://127.0.0.1:7679` through the Asgard tunnel. Store each tunnel token only in its protected token file. Do not add Watercooler, OpenClaw, or any other hostname to these tunnels.

Create a Cloudflare Access self-hosted application for `devspace-asgard.heliasar.net`. Add a Service Auth policy that permits only a dedicated service token named `devspace-saga-gateway`. Store that service token's client ID and secret only in the Saga gateway secret environment. Do not put an interactive Access policy in front of `devspace-saga.heliasar.net`; the public gateway uses DevSpace OAuth.

Generate an independent, high-entropy DevSpace node bearer token for Asgard and place the same value in Asgard's node secret file and Saga's gateway secret file. Generate a different bearer token for the Saga local node. Do not reuse the OAuth owner password, tunnel token, Cloudflare service token, or any token from an unrelated service.

Before starting DevSpace, prove the edge policy in layers. A request to the Asgard `hello` endpoint without Cloudflare credentials must be denied by Access. A request with valid Access headers but no DevSpace bearer token must reach the origin and receive the node's HTTP 401 JSON error. A request with both credential layers must reach `hello` and report machine ID `asgard`, protocol version 1, and the expected commit. Redact headers and tokens from all transcripts. Confirm the Saga public hostname reaches its loopback origin but does not yet disturb the old Asgard app.

Acceptance is two dedicated healthy tunnels, exact DNS hostnames, a service-auth-only Asgard Access policy, two-layer Asgard rejection/acceptance proof, no public listener on either machine, and no changes to existing tunnel or Funnel routes.

### Milestone 6: Deploy the pinned commit in parallel

External deployment and service restarts require explicit authorization. Install the exact accepted Git commit on Saga and Asgard using the release layout. Run `npm ci` under the machine's supported Node version so `better-sqlite3` is built correctly, then run tests, typecheck, and build on each host before changing the `current` symlink. Record Node version, npm version, commit, package version, and build result for each machine.

Start the Saga local node first and verify loopback `hello`. Start the Asgard node and its Cloudflare tunnel, then verify the two-layer public `hello` from Saga. Start the Saga Cloudflare tunnel and gateway last. Do not stop or restart the existing Asgard standalone service. Do not publish npm.

Verify systemd state, listening sockets, gateway `/healthz`, gateway `/readyz`, node commit parity, and non-secret journal correlation. Reboot-safety should be tested by restarting each new unit independently, not rebooting either host during the first deployment. Acceptance is that all three new DevSpace processes and two tunnel processes are healthy, the gateway reports Asgard ready, and the old Asgard MCP URL still works.

### Milestone 7: Verify the whole system from this development machine

Use the Asgard development machine as an external client of `https://devspace-saga.heliasar.net/mcp`, not only as a loopback node test. Use a pinned MCP Inspector version, initially `npx @modelcontextprotocol/inspector@0.22.0`, or the repository's own Streamable HTTP test client if Inspector's CLI changes. Complete the gateway OAuth flow with the new owner password without recording it.

Open `/home/bex/projects/devspace` without `machine` and assert the result reports Asgard. Open the same path with `machine: "asgard"` and alias `home`. Open `/opt/homelab` with `machine: "saga"` and alias `cloud`. Verify an unknown target fails and lists valid targets. Run `hostname` in one Asgard workspace and one Saga workspace; the outputs must identify the intended hosts. Read machine-specific files, make controlled temporary edits in dedicated test fixtures, inspect `show_changes`, revert those fixture edits through normal tools, and verify no operation appears on the other host.

Restart only `devspace-gateway.service`, reconnect the MCP client, and reuse both gateway workspace IDs. Restart one node at a time and reuse its ID. Then perform the destructive failure drill: stop the Asgard node, confirm `/healthz` remains 200, `/readyz` becomes 503, an unqualified open returns `target_unavailable` naming Asgard, a previously bound Asgard call fails without a Saga request, and an explicit Saga workspace still works. Restore Asgard and verify readiness returns 200. Do not test failover by changing the canonical setting.

Test authentication failures from Saga: invalid or absent Cloudflare Access headers must fail at the edge; valid Access plus invalid node bearer must fail at the node; valid credentials must succeed. Test a disconnected mutation with a safe fixture and prove from logs and filesystem state that the gateway made only one node request. Test protocol and capability mismatch using a local test node or configuration fixture, not by deploying mismatched production commits.

Inspect correlated gateway and node logs using one request ID. Confirm logs identify the target, timing, and error without printing secrets, file contents, or full shell commands. Inspect the widget resource and machine badges, including the content-hashed `ui://devspace/workspace-app-<hash>.html` URI and both required metadata keys.

Acceptance is a saved, redacted verification transcript covering target selection, aliases, workspace binding persistence, both hostnames, read/edit/bash/show-changes behavior, canonical outage with no fallback, explicit Saga availability, two-layer auth, one-attempt mutation behavior, correlated logs, and widget rendering. Any wrong-host call is a release blocker.

### Milestone 8: Publish the validated release

Publishing npm and pushing Git are external writes and require explicit authorization at execution time. Confirm the deployed commit is still the branch tip intended for release, all validation evidence points to that exact full commit, the selected semantic version remains available, package contents are correct, and both live machines run the same version and commit.

Push the authorized commit and tag according to the repository's established release practice. Publish `@waishnav/devspace` with public access only after `npm pack --dry-run` and registry identity checks. Immediately install or resolve the published version in a temporary directory, run `devspace --help`, and verify the package contains gateway, node, UI, docs, and native dependency metadata. Do not switch live machines from their pinned commit merely because publication succeeded.

If publication fails after the Git tag exists, leave the live commit in place, record the failure, and repair the release process without changing routing. Never reuse a published version number. Acceptance is a registry version that resolves to the already validated source, plus a recorded package integrity check.

### Milestone 9: Create and accept the parallel ChatGPT app, then cut over

Changing a ChatGPT developer app is an external write and requires explicit authorization. Create a new parallel developer-mode app/connector targeting `https://devspace-saga.heliasar.net/mcp`. Reuse the intended DevSpace name, description, icon assets from `docs/assets/`, OAuth flow, and app metadata, but give the draft a temporary distinguishing label until acceptance. Do not edit or remove the old Asgard draft yet.

Connect the new app and complete OAuth. In a fresh ChatGPT conversation, ask it to open `/home/bex/projects/devspace` without naming a machine, read a known file, and run `hostname`; it must report Asgard. Then explicitly ask it to open `/opt/homelab` on Saga, read a known file, and run `hostname`; it must report Saga. Ask for an unknown machine and verify a clear error. Continue each workspace with read, edit on a disposable fixture, bash, and `show_changes` without restating a machine, proving the workspace ID carries ownership. Verify both widgets show the correct badge and current asset version.

Run the Asgard-down drill once through ChatGPT: stop only the new Asgard node, ask for an unqualified workspace and confirm failure, then explicitly use the existing Saga workspace and confirm success. Restore the node immediately. Review both gateway and node logs for the ChatGPT request IDs and verify there was no Saga call for the failed Asgard request.

After Bex accepts the new app, disable the old Asgard developer app and verify the new one remains functional. Then inspect `tailscale funnel status --json`, save the current route map, and remove only the HTTPS 443 route that forwards to DevSpace 7676. Check `tailscale funnel --help` first and use the current syntax equivalent to `tailscale funnel --https=443 off`; never run a global reset. Compare the before/after JSON and prove ports 10000, 8877, and every unrelated route are unchanged.

Soak the new path through at least one gateway restart, one node restart, and normal usage on both machines. Keep the old standalone Asgard service installed and stopped or private during the initial soak; do not delete its state. Final acceptance is one working Saga-hosted ChatGPT app, Asgard canonical behavior, explicit Saga behavior, no silent fallback, healthy Cloudflare tunnels, preserved unrelated routes, and a tested rollback.

## Concrete Steps

Run baseline commands from `/home/bex/projects/devspace`:

    git status --short --branch
    git rev-parse HEAD
    git diff --stat
    git diff --cached --stat
    node --version
    npm --version
    npm view @waishnav/devspace version
    npm ci
    npm test
    npm run typecheck
    npm run build
    npm pack --dry-run

Expect the three validation commands to exit zero. Record, but do not repair or hide, any failure that existed before implementation. `npm ci` must not change tracked files; if it does, investigate lockfile/runtime drift before proceeding.

Inspect the current Asgard runtime without changing it:

    systemctl --user cat devspace.service
    systemctl --user show devspace.service -p ActiveState -p SubState -p ExecStart -p EnvironmentFiles
    systemctl --user status devspace.service --no-pager
    ss -ltnp | rg ':7676|:7679'
    tailscale funnel status --json
    systemctl --user list-units --type=service | rg 'devspace|cloudflared'

Inspect Saga without changing it:

    ssh saga 'cd /opt/homelab && git status --short --branch && git rev-parse HEAD'
    ssh saga 'node --version; npm --version; mise current; cloudflared --version || true'
    ssh saga 'sudo -n true && echo sudo-ok'
    ssh saga 'ss -ltnp | rg ":7676|:7679" || true'
    ssh saga 'systemctl list-unit-files | rg "devspace|cloudflared" || true'
    ssh saga 'df -h /opt /srv /etc'
    ssh saga 'git ls-remote ssh://git@github.com/becksclair/devspace.git HEAD'

During implementation, use the repository's normal loop after each milestone:

    npm test
    npm run typecheck
    npm run build
    git diff --check
    git status --short

Before any commit, push, Cloudflare write, service deployment/restart, npm publication, ChatGPT app update, or Tailscale route change, confirm the launching task explicitly authorizes that category of external state change. The plan itself documents scope but does not override `/home/bex/projects/devspace/AGENTS.md` approval requirements.

Install the pinned commit on Saga only after the implementation commit exists and deployment is authorized. The homelab install script should encapsulate these operations, but its observable equivalent is:

    COMMIT=<full-approved-commit>
    ssh saga "sudo mkdir -p /srv/services/devspace/releases/$COMMIT /srv/services-state/devspace-gateway /srv/services-state/devspace-node-saga /etc/saga-homelab/devspace"
    ssh saga "sudo chown -R ubuntu:ubuntu /srv/services/devspace /srv/services-state/devspace-gateway /srv/services-state/devspace-node-saga"
    ssh saga "test -d /srv/services/devspace/releases/$COMMIT/.git || git clone ssh://git@github.com/becksclair/devspace.git /srv/services/devspace/releases/$COMMIT"
    ssh saga "cd /srv/services/devspace/releases/$COMMIT && git fetch origin && git checkout --detach $COMMIT && test \"\$(git rev-parse HEAD)\" = $COMMIT && npm ci && npm test && npm run typecheck && npm run build"

Use an idempotent, atomic symlink update only after the build passes. Do not paste a shell one-liner that risks expanding `$COMMIT` on the wrong host; the implementation script should accept and validate a full 40-character commit argument.

On each host, verify release identity with:

    node /path/to/current/dist/cli.js --help
    git -C /path/to/current rev-parse HEAD
    node -p "require('/path/to/current/package.json').version"

Use systemd's own environment-file and credential protections. Secret files must be mode 0600 and owned by the service account or root as appropriate. Validate without outputting contents:

    stat -c '%a %U:%G %n' <secret-file>
    systemctl show <unit> -p FragmentPath -p User -p Group -p ActiveState -p SubState
    journalctl -u <unit> --since '10 minutes ago' --no-pager

For the Asgard user units, use `systemctl --user` and `journalctl --user`. For Saga system units, use `sudo systemctl` and `sudo journalctl` as required.

Public health proof after deployment should resemble:

    curl --fail --silent --show-error https://devspace-saga.heliasar.net/healthz
    {"ok":true,"name":"devspace","role":"gateway"}

    curl --silent --show-error --write-out '\nstatus=%{http_code}\n' https://devspace-saga.heliasar.net/readyz
    {"ok":true,"canonicalMachine":"asgard",...}
    status=200

When Asgard is deliberately stopped, `/readyz` must return 503 while `/healthz` remains 200. The exact JSON may evolve, but it must identify the degraded canonical target without exposing node URLs or credentials.

For direct Asgard node auth proof, load credentials from the protected Saga environment without echoing them, use `curl` headers from variables, and redact the command from captured transcripts. Expected status progression is Access denial without Cloudflare credentials, node 401 with only Cloudflare credentials, and HTTP 200 with machine ID `asgard` only when both layers are valid.

Before Tailscale cutover, preserve the route map:

    tailscale funnel status --json > /tmp/devspace-funnel-before.json
    tailscale funnel --help

Remove only the 443 DevSpace mapping using the syntax reported by the installed Tailscale version, then capture and compare:

    tailscale funnel status --json > /tmp/devspace-funnel-after.json
    diff -u /tmp/devspace-funnel-before.json /tmp/devspace-funnel-after.json

The diff must contain only the intended 443 route removal. If any other route changes, stop and restore the saved mapping before continuing.

## Validation and Acceptance

Automated acceptance requires every existing test plus new executor, protocol, node-auth, machine-config, gateway-binding, routing, restart-recovery, failure-isolation, logging, and widget test to pass. `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`, and the packed-package smoke test must all exit zero on the implementation commit. The test suite must include a counter or request ledger on each fake node so “no fallback” is proved by zero calls, not inferred from an error string.

Backward compatibility is accepted only if standalone `devspace serve` still supports current config files and environment variables, current OAuth, current short and legacy tool naming, minimal and full tool modes, all widget modes, checkout and worktree opens, tilde path expansion, nested instructions, skills, workspace restart recovery, and current tool outputs. Calling `open_workspace` without `machine` in standalone mode must remain valid; standalone may either omit machine metadata or consistently report its local identity, but existing required result fields cannot disappear.

Gateway routing is accepted only if exactly one canonical target exists; omission always chooses Asgard; explicit `asgard`, `home`, `saga`, and `cloud` choices are deterministic; unknown or empty choices fail; public IDs survive gateway restart; node IDs never escape as the public authority; and every later tool uses only its binding. A path that exists on both machines must not influence selection.

Failure behavior is accepted only if an Asgard outage leaves the gateway process and explicit Saga work healthy, marks readiness degraded, and fails both unqualified opens and bound Asgard operations without any Saga request. A Saga outage must fail only explicit or bound Saga work. Node state loss must return `workspace_unknown` and instruct the client to call `open_workspace` again; it must not recreate the workspace silently. No mutation is automatically retried after timeout, disconnect, or 5xx.

Security is accepted only if nodes listen on loopback, each node applies its own allowlist, Asgard requires both Cloudflare Access and a node bearer token, Saga's public gateway requires existing OAuth, secrets are mode 0600 and absent from Git/logs/process arguments, host header and public-base validation are correct, body and time limits are enforced, and machine/alias config fails closed.

Operational acceptance requires the same full Git commit and protocol version on gateway and both nodes, two dedicated healthy tunnels, fresh Saga OAuth and binding state, structured cross-host request correlation, independent service restart proof, and an atomic release rollback. ChatGPT acceptance requires direct successful work on Asgard by default and Saga by explicit name, continued routing without restating a machine, correct badges, an explicit unknown-machine error, and the canonical-outage drill with no fallback.

Cutover is complete only after Bex accepts the new ChatGPT app, the old app is disabled, only the old Tailscale 443 DevSpace route is removed, unrelated Funnel routes are byte-for-byte equivalent in the captured JSON, and the rollback procedure has been rehearsed or proved non-destructively.

## Idempotence and Recovery

All source and deployment changes should be additive until final cutover. Re-running config validation, builds, tests, `hello`, health checks, package packing, tunnel health checks, and install scripts must be safe. Release directories are immutable by full commit; if a directory exists with a different commit, fail rather than mutate it. `current` symlink changes are atomic and can point back to the previous release.

SQLite changes must be additive and automatically idempotent. Before first running the new gateway or node against a non-empty state directory, copy the database and its WAL/SHM companions while the owning service is stopped, or use SQLite's online backup API. The gateway uses a new state directory, so rollback does not require converting its bindings. Never point the new node at the old standalone state directory during parallel staging.

To roll back code before ChatGPT cutover, stop the new gateway/node units, point each `current` symlink to the previous commit if necessary, and restart only the new units. The old Asgard standalone app and Funnel remain untouched and available.

To roll back after ChatGPT cutover, re-enable the old Asgard ChatGPT developer app, restore only the saved Tailscale HTTPS 443 mapping to `127.0.0.1:7676`, verify the old `/healthz` and MCP OAuth discovery, and then disable the new Saga app if needed. Do not delete Saga OAuth state, gateway bindings, Cloudflare tunnels, Access policies, or release directories during immediate rollback; keeping them makes diagnosis and reattempt safe. Revoke new Cloudflare and node credentials only if compromise is suspected or the topology is intentionally abandoned.

If the Saga gateway is unhealthy but both nodes are healthy, do not expose either node as public MCP and do not point the ChatGPT app directly to Asgard as an improvised fallback. Restore the old app or roll the gateway release back. If Asgard alone is unhealthy, leave the canonical setting unchanged, report the outage, and continue only explicit Saga work.

If a Cloudflare tunnel or Access policy is misconfigured, stop at the edge proof and repair that resource. Never temporarily set the Asgard Access policy to allow everyone. If the Cloudflare token is printed or committed, revoke and rotate it before proceeding, remove it from the working tree without rewriting unrelated history, and record the incident in this plan.

## Artifacts and Notes

At implementation start, append the current baseline here: DevSpace branch and full commit, dirty paths, package and npm registry versions, test/typecheck/build results, Asgard unit and route summary, Saga homelab branch/commit/dirty paths, runtime versions, and Cloudflare tunnel inventory. Do not include secrets.

At the end of Milestone 3, record the implementation commit, package version, protocol version, test summary, package contents, and notable file layout. At the end of Milestone 5, record tunnel IDs by safe identifier, hostnames, Access application and policy names, and secret-file paths but never credential values. At the end of Milestone 7, attach or summarize the redacted request matrix and failure-drill transcript. At the end of Milestone 9, record the new app's non-secret identifier, cutover time, Tailscale route diff, soak result, and rollback proof.

The minimum verification matrix to preserve is:

    omitted machine + /home/bex/projects/devspace -> Asgard success
    asgard + /home/bex/projects/devspace         -> Asgard success
    home + /home/bex/projects/devspace           -> Asgard success
    saga + /opt/homelab                           -> Saga success
    cloud + /opt/homelab                          -> Saga success
    unknown machine                               -> explicit error, zero node calls
    bound Asgard ID after gateway restart         -> Asgard success
    bound Saga ID after gateway restart           -> Saga success
    Asgard stopped + omitted machine              -> Asgard unavailable, zero Saga calls
    Asgard stopped + existing Saga ID             -> Saga success
    Access only                                   -> node HTTP 401
    node token only through public Asgard URL     -> Access denial
    Access plus node token                        -> authenticated hello success
    disconnected mutation                         -> exactly one node invocation

## Plan Revision Note

2026-07-17: Created this ExecPlan from the completed codebase-grounded `grill-me` architecture preflight. It incorporates the decision that Saga hosts the public gateway while Asgard remains canonical, uses two dedicated Cloudflare Tunnels, preserves the standalone app during parallel rollout, makes target selection explicit only at workspace open, and defines phased implementation, deployment, verification, ChatGPT cutover, and rollback. No implementation or deployment files were changed as part of authoring this plan.
