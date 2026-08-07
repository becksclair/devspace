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

## Child environment filtering

DevSpace control-plane credentials must not enter development subprocesses.

Before launching a shell or terminal, DevSpace removes exact configured names including:

- `DEVSPACE_OAUTH_OWNER_TOKEN`
- the current node role's bearer-variable name
- every remote machine bearer-variable name configured by the gateway
- additional names listed through `DEVSPACE_INFRA_SECRET_NAMES`

DevSpace does not delete every variable containing `TOKEN`, `KEY`, or `SECRET`. User development tools may intentionally require such credentials. Filtering is based on ownership by DevSpace's control plane, not broad name heuristics.

Diagnostics report filtered variable names, never values.

## Shell modes and executor PATH

Service mode does not source the user's shell profile. DevSpace instead builds a deterministic executor `PATH` from conventional user tool locations, configured runtime-manager homes, and the service environment it inherited. This keeps bounded commands predictable while still exposing tools installed under locations such as `~/.local/bin`, `~/bin`, Bun, Cargo, and mise shims.

Login mode remains an explicit semantic choice for commands that genuinely require the user's login-shell profile. It may modify the executor environment further through `.bash_profile` or equivalent startup files after DevSpace control-plane secrets are removed.

## OAuth and network exposure

The public MCP endpoint requires OAuth approval with the owner password. Keep the owner password private and use a stable HTTPS tunnel or reverse proxy.

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
