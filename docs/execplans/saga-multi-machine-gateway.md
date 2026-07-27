# Build the lean Saga multi-machine DevSpace gateway

## Outcome

One ChatGPT developer app connects to `https://devspace-saga.heliasar.com/mcp` and can operate on both machines:

- `open_workspace({ path })` always opens on Asgard, the one canonical machine.
- `open_workspace({ path, machine: "saga" })` explicitly opens on Saga. Exact configured aliases such as `home` and `cloud` may also be accepted.
- No path inspection, availability check, retry, or failure can silently select another machine.
- The returned public `workspaceId` is durably bound to its machine. Later `read`, `edit`, `write`, search, `bash`, and `show_changes` calls keep their current schemas and route from that binding.
- Restarting the Saga gateway preserves both Asgard and Saga workspace bindings.
- If Asgard is unavailable, an unqualified open and existing Asgard workspaces fail explicitly while explicit Saga work remains usable.
- Every DevSpace widget card clearly shows the bound machine display name, such as `Asgard` or `Saga`, for both `open_workspace` and all later workspace operations.
- The current standalone Asgard service and Tailscale Funnel remain untouched until the new ChatGPT app passes acceptance.
- Pushes to DevSpace's Gitea `main` build one immutable Linux artifact, publish it under the full source commit, and automatically deploy that exact artifact to the Asgard node and Saga gateway after the initial infrastructure bootstrap.

The implementation should use the smallest topology that satisfies those rules:

    ChatGPT
       |
       | OAuth + Streamable HTTP MCP
       v
    devspace-saga.heliasar.com
       |
       | dedicated Cloudflare Tunnel
       v
    Saga gateway on 127.0.0.1:7676
       |                         |
       | local executor          | HTTPS + node bearer token
       v                         v
    Saga files/shell      devspace-asgard.heliasar.com
                                  |
                                  | dedicated Cloudflare Tunnel
                                  v
                           Asgard node on 127.0.0.1:7679

Saga does not need a second node process. The gateway executes Saga work locally through the same executor used by standalone mode and proxies only Asgard work across the network. The Asgard node is loopback-only and requires an independent DevSpace bearer token at the origin. Do not add mTLS, Tailscale routing, a message broker, service discovery, failover, shared storage, or distributed coordination.

The public gateway owns OAuth, MCP sessions, app metadata and widgets, target selection, durable public workspace bindings, and request logging. The local executor owns allowlist enforcement, workspaces, instructions and skills, filesystem tools, shell execution, worktrees, and change checkpoints. The Asgard node exposes that executor through one private versioned HTTP call endpoint; it does not expose OAuth, MCP, or app resources.

Deployment ownership is split along existing repository boundaries. DevSpace owns application code, artifact creation, and Gitea workflows. `/home/bex/personal/saga-homelab` owns the stable Saga systemd units and non-secret configuration templates. `/home/bex/personal/homelab` owns the allowlisted Saga artifact-install contract and Ansible control path. `/home/bex/personal/dotfiles` owns the tracked Asgard user units and installer entrypoint. That Saga Ops control path performs the two-host orchestration and Saga-side installation; application CI must not hand-edit `/opt/homelab`, overwrite live dotfile links, or copy a source checkout to either host.

This plan is **Ready to implement**, with two fail-closed bootstrap gates before automatic deployment is enabled: the overlapping uncommitted `artifact_service` work must first land in a reviewed clean commit/worktree, and a canary must prove the controller-host deployment job survives runner disconnect while serializing two submitted commits. Product implementation and artifact publication may proceed before those gates; production auto-deploy may not.

## Work

### 1. Revalidate the two hosts and protect the working trees

Before editing, record the current DevSpace branch, commit, dirty paths, Node/npm versions, installed package version, and baseline validation. Inspect rather than modify the existing Asgard service, Tailscale routes, Saga `/opt/homelab` tree, relevant systemd units, listeners on ports 7676 and 7679, and installed `cloudflared` versions. Also record the branches, commits, and dirty paths in `/home/bex/personal/saga-homelab`, `/home/bex/personal/homelab`, and `/home/bex/personal/dotfiles`.

Use:

    cd /home/bex/projects/devspace
    git status --short --branch
    git rev-parse HEAD
    node --version
    npm --version
    npm ci
    npm test
    npm run typecheck
    npm run build:check
    npm pack --dry-run

    systemctl --user cat devspace.service
    systemctl --user status devspace.service --no-pager
    tailscale funnel status --json
    ss -ltnp | rg ':7676|:7679'
    cloudflared --version

    ssh saga 'cd /opt/homelab && git status --short --branch && git rev-parse HEAD'
    ssh saga 'node --version; npm --version; cloudflared --version || true'
    ssh saga 'ss -ltnp | rg ":7676|:7679" || true'
    ssh saga 'systemctl list-unit-files | rg "devspace|cloudflared" || true'

    git -C /home/bex/personal/saga-homelab status --short --branch
    git -C /home/bex/personal/homelab status --short --branch
    git -C /home/bex/personal/dotfiles status --short --branch

Do not stash, reset, clean, or absorb unrelated changes. Routine checks use `npm run build:check`; `npm run build` mutates release metadata and is reserved for release preparation.

At this review, `/home/bex/personal/homelab` has uncommitted changes in the exact `artifact_service` defaults/tasks that DevSpace must extend, `/home/bex/personal/dotfiles` has unrelated dirty work, and live Saga `/opt/homelab` has unrelated dirty work. Treat this as a hard ownership gate, not inventory trivia: do not edit those working trees or deploy from `/opt/homelab`. Wait for the overlapping artifact work to reach a reviewed commit, then create clean isolated worktrees for all three infrastructure repositories and pin the controller, `saga-homelab`, and dotfiles revisions used by deployment. If the overlapping work changes the artifact contract, re-read and update this plan before continuing.

Source-of-truth product files are currently `src/server.ts`, `src/cli.ts`, `src/config.ts`, `src/workspaces.ts`, `src/workspace-store.ts`, `src/db/schema.ts`, the nearby tests, and the widget code already referenced from `src/server.ts`. Read their current form before choosing exact new filenames.

### 2. Extract one reusable local executor

Move local tool execution out of the public MCP registration code into one internal executor used by both existing standalone mode and the new gateway/node roles. It accepts the canonical tool name, Zod-validated arguments, bounded request ID, and `AbortSignal`, then returns the same result the current handler returns. Pass that signal through to Pi tool execution so a cancelled or disconnected Bash/file operation can terminate; do not merely abandon the HTTP response while work continues.

Keep path validation, allowlists, workspace recovery, instruction and skill loading, worktree behavior, shell limits, and `show_changes` behavior in this executor. Do not create separate implementations for standalone, Saga, and Asgard. Keep `devspace serve` and its current configuration working.

Keep public MCP tool definitions, short/legacy naming, app/widget metadata, and result formatting separate from the executor. First prove the refactor without network behavior: existing tests pass; tool schemas and metadata are unchanged; and a local standalone server can open this repository, read a file, run `hostname`, cancel a blocking Bash command, and call `show_changes` as before.

### 3. Add only the network and routing needed for Asgard

Add two explicit roles while preserving `serve`:

- `devspace gateway --config <path>` runs the public server on Saga, executes the configured local Saga target directly, and calls remote targets through the private node client.
- `devspace node --config <path>` runs the executor-only HTTP service used on Asgard.

The private protocol should be deliberately small:

- `GET /internal/v1/hello` returns protocol major, machine ID, package version, source commit, and one deterministic hash of the canonical internal tool schemas.
- `POST /internal/v1/call` accepts `{ protocolMajor, toolContractHash, machineId, requestId, tool, arguments }` and returns either the executor result or a structured error. The node compares `machineId` with its configured identity before invoking the executor.
- The node validates the envelope and the selected tool's arguments with the shared Zod schemas before execution. Public short or legacy names are translated to a fixed internal canonical name; they are never accepted as arbitrary strings by the node.
- Exact protocol-major, machine-ID, or tool-contract-hash mismatch makes that target unavailable before a workspace operation runs.
- MCP cancellation aborts the gateway `fetch`; node request abort/close aborts the executor signal. The gateway never automatically retries any tool call because a disconnected edit or shell command may already have completed.
- Reuse the existing configured body limit for internal requests, add the same bound to buffered responses, cap request IDs and error text, and reject oversize data before logging or execution.

Use Express, Zod, platform `fetch`, and the existing SQLite/Drizzle stack already in the repository. Do not build a capability framework, generic RPC library, request queue, or broad new error taxonomy. The public behavior only needs stable errors for unknown machine, target unavailable, and unknown workspace; other executor errors can preserve the existing sanitized messages.

The Asgard node binds only to `127.0.0.1:7679` and authenticates every internal endpoint with a constant-time comparison of an environment-supplied DevSpace bearer token. Its public hostname is reachable through the dedicated Cloudflare Tunnel. The gateway sends only a dedicated `X-DevSpace-Node-Token` header to the configured Asgard origin, requires an `https:` URL, rejects redirects, bounds connect/total time, and redacts credentials and response bodies from transport errors. Saga-to-Saga execution is an in-process executor call and needs no HTTP credentials.

Extend only `open_workspace` with an optional `machine` string. Normalize surrounding whitespace and case, then match an exact configured ID or alias. Omission selects the single configured canonical target. Empty or unknown values fail and list the valid configured names. Later tools must not gain a machine argument.

Add one gateway binding table with:

    public_workspace_id primary key
    machine_id
    executor_workspace_id
    created_at
    last_used_at

For Saga, `executor_workspace_id` is the local executor's workspace ID. For Asgard, it is the private node's workspace ID. On every later call, look up the public ID and invoke exactly that recorded target. Persist the binding only after `open_workspace` succeeds. Do not encode routing authority in a caller-editable ID, infer a target from the path, reopen automatically after node state loss, or remap a removed machine by alias.

Executor workspace IDs are private. On `open_workspace`, replace the executor ID with the new public ID in the structured result and widget `_meta.card`. On every later request translate public ID to executor ID before execution, then rewrite any workspace ID in structured content, text instructions, logs returned to the client, and widget metadata back to the public ID. Add a recursive leak assertion to tests so no executor ID crosses the public MCP boundary.

The gateway also injects `machine: { id, displayName }` into every public widget card from the selected catalog entry or persisted binding; it never trusts a node-supplied display label. Extend `ToolResultCard` with that optional object and render a compact, persistent machine badge in every card header, including workspace, read/write/edit, search/list, Bash, and `show_changes`. The visible and accessible label is the configured display name (`Asgard`, `Saga`), not the public URL, raw OS hostname, alias, or internal node ID. Keep the field optional so standalone/legacy cards remain compatible, and preserve the content-hashed widget resource URI so ChatGPT loads the updated UI.

Gateway configuration needs only:

- bind address, port, public base URL, and a gateway state directory for OAuth plus public bindings;
- one canonical machine;
- stable machine IDs and aliases;
- `kind: "local"` plus Saga's explicit allowlist (`/home/ubuntu`, `/opt/homelab`, and `/srv/services`) and separate local-executor state/worktree roots, or `kind: "remote"` plus an HTTPS URL and an environment-variable name for the node token.

Fail configuration loading if there is not exactly one canonical machine, IDs or aliases collide after normalization, gateway and executor state/worktree roots overlap, a remote URL is not HTTPS, or its node-token variable is absent. Keep credentials out of JSON, Git, logs, and process arguments. The Asgard node independently owns its state and worktree roots; never point the new node at the old standalone database or worktree directory.

Add the same non-secret machine metadata to the `open_workspace` structured result so ChatGPT can report where it opened the workspace. Keep existing required fields and the workspace-reuse instruction. Do not add a machine-list tool or make the badge interactive; target selection remains exclusively on `open_workspace.machine`.

Gateway `/healthz` reports only that the gateway process and its database are working, plus non-secret role, package version, source commit, and protocol major from build-injected metadata. The gateway still listens while Asgard is down so explicit Saga work remains available. A lightweight authenticated `hello` check at startup is enough; remote calls report their own failures and a later explicit call may try again. Do not add readiness state, a background scheduler, or periodic probes in the first slice.

Workspace bindings and OAuth clients/tokens persist across gateway restart; MCP transports, in-flight authorization codes, and review-checkpoint manager memory do not. Acceptance after restart therefore creates a new MCP initialize/session and reuses the prior OAuth access token and public workspace IDs. `show_changes` keeps today's lazy checkpoint reset on the executor that restarted; do not claim that its `workspace_open` baseline survives process restart in this feature.

Add focused tests for:

- standalone compatibility after executor extraction;
- exactly one canonical target and exact ID/alias matching;
- omitted target routes only to Asgard;
- explicit Saga routes only to the local executor;
- later calls use the persisted binding after gateway restart;
- a new MCP session after gateway restart can reuse the previous OAuth token and both public workspace IDs, while the old MCP session fails normally;
- public results and widget metadata never contain an executor workspace ID;
- every gateway-mode card carries the correct bound machine and renders an accessible `Asgard` or `Saga` badge, while a missing machine field preserves standalone rendering;
- unknown target invokes neither executor;
- Asgard failure never invokes Saga;
- Saga work still succeeds while Asgard is unavailable;
- cancellation reaches a blocked remote executor, and a disconnected mutation produces one node invocation with no retry;
- protocol/tool-contract/machine mismatch and invalid per-tool arguments execute nothing;
- the Asgard node enforces its own allowlist.

Use fake executors or loopback servers with call counters so wrong-target behavior is proven by zero calls rather than inferred from an error string. Do not add tests for hypothetical negotiation, failover, distributed recovery, or concurrency behavior outside the promised contract.

### 4. Publish immutable Gitea builds and give Saga Ops deployment ownership

DevSpace does not yet have a `bex/devspace` repository on `git.heliasar.com`. The existing GitHub repository is public, so create the Gitea repository with the same public-read/private-write posture, push the reviewed history, and retain GitHub as a mirror or secondary remote. Generic Package downloads are anonymous read; only publication and deploy dispatch use scoped secrets. If policy requires a private Gitea repository instead, stop and add a root-owned read-only package credential to both installers before enabling deployment. External repository creation and pushes require explicit authorization.

For the initial public feature release, run the repository's versioned-build workflow and commit the reviewed version/changelog changes before pushing the commit that Gitea will package and deploy. Subsequent non-release `main` commits may keep the same npm version because deployment identity is the full Git commit; never mutate release metadata after live acceptance and then claim the new commit was validated.

Add a deterministic runtime-artifact script and Gitea workflow using the established Obsidian MCP/Fastmail MCP pattern:

- trigger publication on pushes to Gitea `main` and allow manual dispatch;
- build on the live `asgard-build-1` runner inside a digest-pinned Linux/amd64 Node 24 build image; do not use Saga's privileged `saga-build` runner merely to match architecture;
- run `npm ci`, tests, typecheck, and `npm run build:check` before packaging;
- package `dist`, prebuilt production dependencies, `package.json`, `package-lock.json`, and an `artifact.json` declaring service ID `devspace`, full source commit, package version, lockfile digest, `linux-amd64`, Node major 24, protocol major, tool-contract hash, and exact `gateway` and `node` entrypoints;
- inject the same immutable source commit/protocol/tool-contract data into runtime build metadata used by `/healthz` and node `hello`;
- run an isolated artifact smoke test in the pinned runtime image, including loading `better-sqlite3` and starting both entrypoints against temporary config/state;
- produce deterministic `devspace-linux-amd64-<full-commit>.tar.gz` bytes and a SHA-256 sidecar;
- publish both as an immutable Gitea Generic Package whose version is the full commit;
- read the package back and verify its digest before dispatching deployment.

Protect Gitea `main` and expose package/deploy credentials only to trusted push and manual-dispatch jobs, never pull requests. A SHA-256 proves artifact identity but does not make an unreviewed branch trustworthy; the protected branch and workflow are the code-execution authority for both machines.

Keep publication and deployment as separate workflows. The deployment workflow accepts only the full commit and verified archive SHA-256. It runs on `asgard-build-1`, submits one narrow controller-host job, and polls its recorded result; workflow YAML never contains install or service-mutation logic. The host job owns a lock across both machines and survives runner disconnect, so Gitea's known cancellation behavior cannot interrupt activation. Submitted commits may queue, but two deployments must never mutate either install root or service concurrently. Before enabling automatic dispatch, prove with a harmless canary that killing the submitter does not kill the host job and that two submitted identities run serially.

The first implementation also adds DevSpace to the existing Saga artifact-service lane:

- In `/home/bex/personal/saga-homelab`, add `services/devspace/devspace.service`, `cloudflared-devspace-saga.service`, non-secret gateway/tunnel environment examples, and concise operator documentation. Install at the established fixed root `/opt/saga-services/devspace`; keep gateway OAuth/bindings, Saga executor state/worktrees, and secrets in distinct paths under `/srv/services-state/devspace`, with secret files mode 0600. Pin the unit to Saga's Node 24 runtime. Its sandbox must deliberately grant the configured read/write roots `/home/ubuntu`, `/opt/homelab`, `/srv/services`, and its state/worktree paths; prove each root through DevSpace rather than assuming `ProtectHome`/`ProtectSystem` exceptions work. Do not add application source, generations, or a `current` selector.
- In `/home/bex/personal/homelab`, add `devspace` to the existing `artifact_service_catalog` and `configs/services.json`, then regenerate from the manifest with `mise run services:sync`. Extend the artifact manifest validator in a backward-compatible, per-service way so existing services retain their exact `serve` contract while DevSpace permits the declared gateway/node map and selects only `gateway` for `devspace.service`. Reuse `ansible/playbooks/saga-service-install.yml`; do not build a second installer.
- Before DevSpace uses that role, add an opt-in safe-replacement contract enabled only for the DevSpace catalog entry; do not change existing services' deployment semantics in this work. In that mode, fully extract and validate in a sibling staging directory; verify Node major 24, package/build identity, entrypoint syntax, and native module loading there; stop only `devspace.service`; move the current fixed root to one `.previous` rollback directory; atomically rename staging to the fixed root; start and health-check the new unit; and automatically restore/restart `.previous` if activation fails. Keep only one rollback copy and never touch state or secret paths. Cover first install, successful update, extraction failure, start failure, and health failure with focused role/fixture tests.
- Expose one Saga Ops-owned, fixed-grammar deploy entrypoint on the Asgard controller host. It accepts only a full DevSpace commit and SHA-256, derives the allowlisted `bex/devspace` Generic Package URL, submits a host-owned locked job, stages/activates the local Asgard node through its fixed installer, invokes `ansible/playbooks/saga-service-install.yml` with fixed service ID `devspace` for Saga, performs the cross-host proof, and records a bounded non-secret result for polling. Bind the workflow credential to submit/status for that entrypoint only. Do not accept arbitrary repository URLs, service IDs, units, paths, commands, or Ansible variables, and do not give CI a general shell or unrestricted sudo. This is an admission/orchestration shim over the two installers, not a second installer.

In a clean `/home/bex/personal/dotfiles` worktree, add a matching Asgard user-scoped installer and units outside the current standalone service:

- `devspace-asgard-node.service` on `127.0.0.1:7679` with the current Asgard allowlist;
- `cloudflared-devspace-asgard.service` using a protected tunnel token file;
- a fixed installation root and state directory separate from the old service;
- a unit pinned to Node 24 and a mode-0600 origin-token file;
- an installer with the same stage/validate/one-previous/atomic-swap/automatic-restore behavior, accepting only the commit-pinned Gitea artifact URL and SHA-256, validating `artifact.json`, loading the native module, restarting only the new node, and proving authenticated loopback `hello`.

The controller-host job first stages and validates the artifact on both hosts without activation. It then updates Asgard, proves authenticated `hello`, activates the Saga gateway through the artifact-service role, and proves both report the requested source commit, protocol major, and tool-contract hash. It restores every host it switched if a later activation/health proof fails. A failure leaves the existing standalone Asgard app untouched. Automatic dispatch remains disabled until both target installers, units, secrets, and tunnels are bootstrapped; the previous/current compatibility matrix passes; one manual deployment passes; and the disconnect/serialization canary passes. After those proofs, successful pushes to protected Gitea `main` publish and deploy automatically.

Rollback after a healthy deployment is a manual dispatch of the last known-good immutable commit and digest through the same workflow. Immediate activation failure uses the installer's one `.previous` copy automatically. Keep service state, OAuth data, workspace bindings, worktrees, and secret files outside the replaced application root. Do not add release selectors or a second rollback framework.

Within protocol major 1, node/gateway changes must remain rolling-compatible because the two hosts activate sequentially. CI must run the new gateway against the previous published node contract and the new node against the previous published gateway contract before automatic deployment. A protocol-major or tool-contract break disables automatic deployment and requires an explicitly coordinated rollout; do not build general multi-version negotiation into the first implementation.

### 5. Create the two Cloudflare paths and activate in dependency order

External Cloudflare writes require explicit authorization. Create:

1. A dedicated `devspace-asgard` Tunnel mapping `devspace-asgard.heliasar.com` to Asgard `http://127.0.0.1:7679`.
2. A dedicated `devspace-saga` Tunnel mapping `devspace-saga.heliasar.com` to Saga `http://127.0.0.1:7676`.

Store tunnel tokens only in protected token files. Store the Asgard node bearer only in Saga's protected gateway environment and the matching bearer only in Asgard's protected node environment. Use different values for tunnel, node, and OAuth credentials. The public Saga hostname uses DevSpace OAuth; the internal Asgard hostname requires the 256-bit node token on every route.

Tunnel units are stable infrastructure installed and enabled during bootstrap, not artifact-deploy companions. Recurring application deploys restart only `devspace.service` on Saga and `devspace-asgard-node.service` on Asgard; they must not restart either tunnel or modify Cloudflare, DNS, OAuth, or secret state. On first bootstrap, start and prove each loopback application before starting its tunnel. Leave Saga's existing general `cloudflared.service`, Watercooler tunnel, Fastmail tunnel, and every unrelated hostname untouched.

Bootstrap in this order:

1. From clean pinned controller/package worktrees, converge the reviewed `saga-homelab` units/configuration and central artifact-service contract without deploying an unverified artifact.
2. Install the Asgard node/tunnel units and both hosts' protected environment/token files; validate their exact permissions without printing values.
3. Publish one DevSpace artifact, manually dispatch its deployment workflow, and let that workflow install Asgard first and Saga through Saga Ops second.
4. After authenticated loopback `hello` works, start the Asgard tunnel. From Saga, prove missing and incorrect node tokens receive origin 401 responses and the correct node token returns `hello` for `asgard` and the deployed commit.
5. Start the Saga tunnel and verify public `/healthz`, OAuth discovery, and MCP connection.
6. Enable automatic deployment from future successful Gitea `main` builds.

Inspect service, tunnel, and DNS state before retrying any mutation whose outcome is uncertain. Do not weaken node authentication to diagnose it. Leave the old Asgard service and Funnel route running.

### 6. Prove the complete behavior from this development machine

Use the repository's Streamable HTTP test client or a pinned MCP Inspector against `https://devspace-saga.heliasar.com/mcp` and complete the normal OAuth flow.

Run this minimum matrix:

    omitted machine + /home/bex/projects/devspace -> Asgard
    asgard or home + same path                    -> Asgard
    saga or cloud + /opt/homelab                  -> Saga
    unknown machine                               -> explicit error, zero calls
    later calls with each workspaceId             -> original machine
    both workspaceIds after gateway restart       -> original machine
    Asgard node stopped + omitted machine         -> explicit Asgard failure, zero Saga calls
    Asgard node stopped + existing Saga ID        -> Saga success
    Asgard URL without node token                  -> origin 401
    Asgard URL with incorrect node token           -> origin 401
    Asgard hello with correct node token            -> success

For one workspace on each machine, run `hostname`, read a machine-specific file, edit a disposable fixture, inspect `show_changes`, and revert the fixture through normal tools. Inspect each resulting widget and confirm every Asgard-bound card says `Asgard` and every Saga-bound card says `Saga`, including later calls that did not restate a machine. Correlate one gateway request ID with the Asgard node log. Confirm logs name the target and outcome without secrets or file contents.

Restart the gateway, establish a new MCP session with the existing OAuth token, and reuse both public IDs. Confirm the old MCP session is rejected rather than mistaken for durable state. Restart the Asgard node and confirm its existing workspace recovers through the node workspace store. After each executor restart, verify and document that `show_changes` starts a new lazy checkpoint baseline; durable review-checkpoint history is not part of this feature.

Any wrong-host call, silent fallback, lost gateway binding after restart, node-authentication bypass, or regression in standalone mode blocks ChatGPT testing.

### 7. Test in a parallel ChatGPT app, then cut over

Creating or changing the ChatGPT app and Tailscale routes requires explicit authorization. Create a new developer-mode app targeting `https://devspace-saga.heliasar.com/mcp`; do not mutate the current Asgard app.

In a fresh ChatGPT conversation:

- open this repository without naming a machine and verify `hostname` is Asgard;
- explicitly open `/opt/homelab` on Saga and verify `hostname` is Saga;
- continue both workspaces without restating a machine;
- verify the workspace and subsequent file/shell/change cards visibly show `Asgard` or `Saga` to match their binding;
- verify an unknown machine fails clearly;
- stop the new Asgard node once, verify unqualified work fails without fallback, and verify the existing Saga workspace still works; then restore Asgard.

After Bex accepts the new app, disable the old app and remove only the Tailscale Funnel HTTPS 443 mapping for the old DevSpace service. Capture `tailscale funnel status --json` before and after and prove unrelated routes are unchanged. Keep the old standalone unit, state, and configuration for the initial soak.

Publish to npm only after the exact Gitea-deployed commit passes direct ChatGPT acceptance. Npm remains a public distribution channel, not the Saga deployment source. Release publication, Git pushes, remote service changes, Cloudflare mutations, and app/Tailscale mutations each require their normal explicit authorization under `AGENTS.md`; this plan grants none of them. From a clean detached checkout of that accepted commit, run the non-mutating validation and `npm pack`, publish once, and verify the registry package/version resolves to that source. Do not run the version-bumping build again and do not invent a Git tag if the repository still has no tag convention.

Rollback before or after cutover is intentionally simple: re-enable the old ChatGPT app if needed, restore only its saved Tailscale 443 mapping, and restart the unchanged old Asgard standalone service. Do not delete the new tunnels, state, or package while diagnosing a failed cutover.

## Validation

Product validation from `/home/bex/projects/devspace`:

    npm test
    npm run typecheck
    npm run build:check
    npm pack --dry-run
    git diff --check

Gitea and Saga Ops validation:

    OUTPUT_DIR=.artifacts/first scripts/package-runtime-artifact.sh "$(git rev-parse HEAD)"
    OUTPUT_DIR=.artifacts/second scripts/package-runtime-artifact.sh "$(git rev-parse HEAD)"
    (cd .artifacts/first && sha256sum --check devspace-linux-amd64-"$(git -C ../.. rev-parse HEAD)".tar.gz.sha256)
    cmp .artifacts/first/devspace-linux-amd64-*.tar.gz .artifacts/second/devspace-linux-amd64-*.tar.gz
    cd /home/bex/personal/homelab && mise run services:sync
    ansible-playbook --syntax-check ansible/playbooks/saga-service-install.yml
    tests/test-ansible-artifact-service.sh

The publish job must show validation, byte-identical repeated packaging, immutable Generic Package upload, read-back digest verification, and deployment dispatch for the same full commit. The deploy job must show the Asgard node and Saga gateway installed from that same URL/digest, both reporting the same commit, protocol major, and tool-contract hash; automatic restoration on an injected health failure; serialization under the Gitea cancellation canary; and no unrelated service or tunnel restart.

Host validation:

    systemd-analyze verify /home/bex/personal/saga-homelab/services/devspace/*.service
    systemd-analyze --user verify /home/bex/personal/dotfiles/configs/dot_config/systemd/user/devspace-asgard-*.service
    ssh saga 'systemctl status devspace cloudflared-devspace-saga --no-pager'
    systemctl --user status devspace-asgard-node cloudflared-devspace-asgard --no-pager
    ssh saga 'ss -ltnp | rg ":7676"'
    ss -ltnp | rg ':7679'

Public validation:

    curl --fail --silent --show-error https://devspace-saga.heliasar.com/healthz

Acceptance requires all product checks to pass; an immutable Gitea artifact and successful automatic deployment of the exact same commit to Saga and Asgard through the established control seams; healthy dedicated tunnels; the routing matrix above; persistent workspace affinity across gateway restart; correct visible machine badges on every gateway-mode card; explicit Asgard failure with zero Saga fallback; standalone Asgard still available until cutover; successful direct ChatGPT use of both machines; and an unchanged set of unrelated Tailscale Funnel routes.

Update this plan only when execution discovers evidence that changes the remaining work or acceptance criteria. Do not append routine progress, worker handoffs, resource ledgers, or command transcripts.
