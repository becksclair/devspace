# Security Model

DevSpace exposes local engineering capabilities over MCP. Treat it as authenticated remote access to a development machine, not as a low-risk document viewer.

## Two different trust boundaries

DevSpace deliberately has two execution surfaces:

1. **File tools** enforce configured canonical root policy. This provides scope, provenance, useful UI, and protection against accidental or misleading path traversal.
2. **Shell and persistent terminal tools** run with the authority of the DevSpace service account. They are not confined by workspace roots and may be root-capable when the host grants passwordless sudo or equivalent authority.

A trusted-host deployment must display that distinction clearly. File-root enforcement is not advertised as a sandbox around an unrestricted shell.

## Canonical root policy

Each configured root has:

- a canonical `path`
- optional logical `aliases`
- `access: "read-only" | "read-write"`

Existing string roots are shorthand for read-write policies.

Example:

```json
{
  "path": "/srv/pool/projects",
  "aliases": ["/home/ubuntu/projects"],
  "access": "read-write"
}
```

The alias must resolve to the same canonical directory as the configured path. DevSpace preserves the alias for display and logical shell `PWD`, while file tools authorize the canonical target immediately before each operation.

For an existing target, DevSpace resolves its complete canonical path. For a missing write target, it canonicalizes the nearest existing parent and validates the unresolved suffix before creation.

A nested symlink is allowed only when its target is:

- inside the workspace's canonical root, or
- inside another explicitly configured root that grants the requested access.

Therefore an intentional project link into a configured read-only `/etc` root may be read but not written. A link into an undeclared target is rejected.

Skill files and project instruction discovery receive the same canonical checks. Persisted workspaces are re-authorized after process restart rather than trusting stale path metadata.

## Root aliases are not escapes

Useful storage topology such as:

```text
/home/ubuntu/projects -> /srv/pool/projects
```

is supported directly through root aliases. DevSpace does not ban symlinks merely to simplify containment logic.

The unsafe case is not “a path contains a symlink.” The unsafe case is “the canonical target is outside every policy that grants the requested access.”

## Shell and terminal authority

Shell and terminal tools may:

- read or modify files outside configured roots
- install packages and dependencies
- access the network
- interact with processes and services
- use Git credentials and user development credentials
- obtain root when host sudo policy permits it

This is intentional on a trusted engineering host. OAuth approval and the host's service policy decide who receives that authority.

Persistent terminals use opaque IDs bound to one workspace and executor machine. The initial backend is tmux with an explicit private socket. Returned history is bounded and terminal escape sequences are displayed as text rather than interpreted as trusted HTML.

## T3 Code bridge

The [T3 Code bridge](t3-code.md) is opt-in: it is exposed only when `t3.enabled` is `true` and the `t3` capability is not disabled. When exposed, any authenticated DevSpace client can start, steer, interrupt, and answer coding-agent threads in the T3 Code instance on the DevSpace host. Every thread the bridge launches runs in T3's `full-access` runtime mode, and callers cannot select another mode. The bridge's T3 credential is a full-access credential with the `orchestration:read`, `orchestration:operate`, `settings:write`, and `source-control:write` scopes.

When T3 Code runs as the DevSpace service user, this is equivalent to the shell and terminal authority DevSpace already grants: the bridge adds another path to that authority without widening it. Enable it only where shell authority is already acceptable. Only the 21 allowlisted tools are exposed; T3's other tools are not reachable through DevSpace. As with annotation profiles, the bridged tools' hints are not a security boundary.

Beyond threads:

- **Scheduled tasks** start unattended runs later. Each run of a task created through DevSpace is a new `full-access` thread with the default model the project had when the task was created, and a recurring task keeps starting runs until it is disabled or deleted. A task created in the T3 app keeps its own thread binding, runtime mode, and model when DevSpace updates it.
- **Webhook triggers are excluded.** A webhook URL accepts requests from anyone who holds it and starts full-access agents with each request's content; DevSpace callers can already start threads directly, so a webhook would add only a persistent outside trigger. DevSpace rejects webhook schedules and removes `webhookUrl` (which embeds its access token) and `webhookSignature` from scheduled-task results, including those of webhook tasks created in the T3 app. An existing webhook task created in the T3 app can still be edited through `schedule_task` without a `schedule`, including re-enabled, which reactivates its trigger.
- **Project creation and cloning** write folders as the OS user that runs T3 Code (normally the DevSpace service user), anywhere that user can write; DevSpace roots do not confine them. Paths must be absolute (a leading `~/` is expanded), because T3 resolves relative paths against its own working directory.
- **Project deletion is not exposed.** `t3_project_create` forwards only a title and a folder, and `t3_project_update` only a title and a default model; T3's other project settings, including project scripts (commands T3 runs on every new worktree), are not reachable.

Credential handling:

- The credential is minted through the local T3 CLI's pairing-code flow. There is no browser step and no stored secret; nothing is added to DevSpace configuration.
- The token lives in process memory only. DevSpace never writes tokens, pairing codes, or authorization codes to disk, logs them, or returns them in tool results or errors.
- Each DevSpace instance uses its own T3 session label, derived from its state directory, and revokes every session carrying that label before minting, so restarts do not accumulate live credentials.
- The CLI child environment is built like the sky-cua and node_repl bridge children: the control-plane names listed under [Child environment filtering](#child-environment-filtering) are removed, along with `GH_TOKEN`, `GITHUB_TOKEN`, and every `*_NODE_TOKEN`. It adds `ELECTRON_RUN_AS_NODE=1`, runs with a 30-second timeout, and gets no stdin.

Write tools advertise destructive, open-world hints under the `standard` annotation profile, so MCP hosts can ask for confirmation; `trusted-owner` relaxes them like DevSpace's exec tools. Launches always run in T3's `full-access` mode.

The bridge persists nothing; its inbox cursor is also memory-only, and thread, project, and scheduled-task state stays in T3.

## Child environment filtering

DevSpace control-plane credentials must not enter development subprocesses.

Before launching a shell or terminal, DevSpace removes exact configured names including:

- `DEVSPACE_OAUTH_OWNER_TOKEN`
- the current node role's bearer-variable name
- every remote machine bearer-variable name configured by the gateway
- additional names listed through `DEVSPACE_INFRA_SECRET_NAMES`

DevSpace does not delete every variable containing `TOKEN`, `KEY`, or `SECRET`. User development tools may intentionally require such credentials. Filtering is based on ownership by DevSpace's control plane, not broad name heuristics.

Diagnostics report filtered variable names, never values.

The git processes DevSpace starts itself (worktree and clone creation, status probes, and review snapshots) receive the same exact-name filtering, because git runs repository-configured hooks and helpers. Development credentials such as `GH_TOKEN` are left in place for them.

## Shell modes and executor PATH

Service mode does not source the user's shell profile. DevSpace instead builds a deterministic executor `PATH` from conventional user tool locations, configured runtime-manager homes, and the service environment it inherited. This keeps bounded commands predictable while still exposing tools installed under locations such as `~/.local/bin`, `~/bin`, Bun, Cargo, and mise shims.

On Linux, a fixed allowlist of graphical-session variables (display, Wayland socket, X authority, and desktop/session identifiers) is refreshed from the systemd user manager at each shell or terminal spawn. Only those names are imported; `PATH` and every other manager variable are ignored, and configured shell environment values and filtered secret names are never overridden.

Login mode remains an explicit semantic choice for commands that genuinely require the user's login-shell profile. It may modify the executor environment further through `.bash_profile` or equivalent startup files after DevSpace control-plane secrets are removed.

## OAuth and network exposure

The public MCP endpoint requires OAuth approval with the owner password. Keep the owner password private and use a stable HTTPS tunnel or reverse proxy.

DevSpace is its own OAuth 2.1 authorization server, and it owns that code. The owner-approval page, codes, tokens, and registration policy live in `src/oauth-provider.ts`; the protocol endpoints (`/authorize`, `/token`, `/register`, `/revoke`), client authentication, PKCE verification, and CORS handling live in `src/oauth/`. That endpoint layer was ported from the MCP TypeScript SDK's frozen, unmaintained authorization-server helpers, so no upstream release will deliver fixes for it: review changes to `src/oauth/` as changes to the authentication boundary, and keep `src/server-oauth-http.test.ts` passing. Only the discovery documents and `/mcp` bearer-token checking come from the maintained `@modelcontextprotocol/express` package.

Registration and approval rules that clients observe:

- A client that registers `token_endpoint_auth_method: "none"`, or omits the method, is a public client and is issued no secret; it authenticates at `/token` and `/revoke` by `client_id` alone, and PKCE S256 is mandatory for every client. A registration with any other method receives a secret, which expires after 30 days; `client_secret_post` is the only secret-based method the endpoints accept.
- A redirect URI with a fragment or userinfo is rejected at registration with `invalid_redirect_uri`, because `/authorize` never redirects to one.
- A requested `redirect_uri` must match a registered one exactly; for a loopback host (`localhost`, `127.0.0.1`, `[::1]`) only the port may differ (RFC 8252). A requested URI with a fragment or userinfo never matches, and neither does such a URI registered before registration refused it. A mismatch is answered `400` and never redirects.
- `/revoke` acts only on the authenticated client's own tokens. A token issued to another client is answered `200 {}` and left alone, exactly like an unknown token, so the answer does not reveal whether it exists (RFC 7009). Revoking an access token deletes that token only. Revoking a refresh token deletes it and every access token of the same client: tokens record no link to the grant they came from, so a client with several grants loses the access tokens of the others too, and those recover by refreshing with their own refresh tokens, which survive. `token_type_hint` is ignored; the token is looked up by its hash.
- Each OAuth endpoint has one rate limiter, per client address (see `DEVSPACE_TRUST_PROXY` in [Configuration](configuration.md#logging)): `/authorize` 10 requests per minute, `/token` 30 per minute, `/register` 20 per hour, `/revoke` 50 per 15 minutes. Requests with a wrong method count; CORS preflights do not. Every counted response carries `RateLimit-*` headers describing that limit, and a request over it receives `429` with a `too_many_requests` OAuth error body and `Retry-After`. Until 2026-11-13 each endpoint also had a second, 15-minute limiter (`/authorize` 100, `/token` 50); it was removed with the duplicate, so the sustained ceilings are now 150 and 450 requests per 15 minutes per address.
- The approval page's CSRF double-submit cookie is `__Host-devspace-csrf` with `Secure` when the public base URL is https, and `devspace-csrf` without `Secure` on a plain-http base URL, where browsers would refuse the `__Host-` form. The server reads only the name for its scheme.
- A bearer token with the static-key prefix (`obsk_`) that matches no usable static key is still tried as an OAuth access token; if both reject it, the `401` reports the static-key reason (unknown or revoked, expired, or minted for another resource).

Owner-password guessing is bounded by two independent limits. `/authorize` is rate-limited to 10 requests per minute per client IP, which depends on correct proxy attribution (`DEVSPACE_TRUST_PROXY`). In addition, the server counts wrong owner-password approvals process-wide: after 20 failures within 15 minutes, every approval attempt from any client receives `429` with `Retry-After` until the oldest failure leaves the window. Successful approvals and CSRF rejections are not counted. The cap holds even if a misconfigured proxy lets clients choose their `X-Forwarded-For` address; the tradeoff is that a sustained wrong-password flood also delays the owner's own approval for up to 15 minutes. The cap is fixed, not configurable, and resets on restart.

The Saga multi-machine gateway uses a separate node bearer for each remote executor. Node endpoints require that bearer on every request and bind loopback behind their dedicated tunnel. OAuth, tunnel credentials, and node bearers are independent authorities.

Host headers remain allowlisted from the configured public URL. Use `DEVSPACE_ALLOWED_HOSTS=*` only for intentional local debugging.

## Persistent state

DevSpace stores:

- OAuth state
- public gateway workspace bindings
- executor workspace metadata
- terminal metadata
- shadow review Git repositories

Managed isolated checkouts and terminal sockets live under configured DevSpace state/runtime roots. Review commits and refs no longer mutate user repositories.

Closing a workspace removes safe managed state. Dirty managed work is retained and reported. Periodic maintenance prunes stale metadata and clean abandoned work, reconciles dead terminals, and checkpoints SQLite WAL state.

## Worktrees and isolated clones

A Git worktree requires writable source Git metadata. `mode: "worktree"` fails when that requirement is not met.

`mode: "isolated"` chooses a worktree when possible, otherwise creates an independent `--no-local` clone. This clone does not share writable object files with a read-only source. Source dirty changes are reported and are not copied automatically.

Managed workspaces are a workflow boundary, not a privilege boundary.

## Logs

Request and tool-call logs are enabled by default. Shell command previews are disabled unless explicitly enabled.

Do not log complete environments or credentials. Terminal commands are stored only as bounded summaries; terminal environments are not stored in SQLite.

## Trusted-host profile

A trusted-host systemd profile may deliberately remove conventional daemon restrictions and permit the service account to sudo. In that profile, the meaningful controls are:

- strong OAuth and node authentication
- loopback binding behind dedicated tunnels
- exact control-plane secret filtering
- canonical file-tool policy
- explicit tool history and logging
- truthful capability reporting
- bounded terminal and workspace lifecycle

Do not describe a root-capable trusted-host endpoint as sandboxed merely because some file tools remain scoped.
