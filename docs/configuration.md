# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
environment variables.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config npx @waishnav/devspace serve
```

## Commands

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
npx @waishnav/devspace doctor
npx @waishnav/devspace config get
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `DEVSPACE_ALLOWED_ROOTS` | Legacy comma-separated roots. Every entry is read-write. Do not combine with `DEVSPACE_ROOTS`. |
| `DEVSPACE_ROOTS` | JSON root-policy array supporting `path`, `aliases`, and `access` (`read-only` or `read-write`). |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `DEVSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |
| `DEVSPACE_ANNOTATION_PROFILE` | MCP tool-annotation profile: `standard` (default) or `trusted-owner`. |

## Root policies and aliases

Use `DEVSPACE_ROOTS` or role JSON `roots` when a machine has path aliases or read-only inspection roots:

```json
[
  {
    "path": "/srv/pool/projects",
    "aliases": ["/home/ubuntu/projects"],
    "access": "read-write"
  },
  {
    "path": "/etc",
    "access": "read-only"
  }
]
```

The configured path and every alias must exist. An alias must resolve to the same canonical directory as `path`. DevSpace preserves the logical alias for display and shell `PWD`, while file operations authorize the canonical target immediately before execution.

A nested symlink may enter another configured root when that root grants the requested access. Undeclared canonical targets are rejected. Shell and terminal commands are not confined by root policies.

## Shell, terminals, and maintenance

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_SHELL_PATH` | auto | Explicit Bash-compatible shell path. |
| `DEVSPACE_SHELL_MODE` | `service` | `service` uses the inherited non-login executor environment with an augmented user-tool `PATH`; `login` additionally loads the user's login shell profile. |
| `DEVSPACE_INFRA_SECRET_NAMES` | empty | Additional exact DevSpace-owned environment names removed from child processes. |
| `DEVSPACE_TERMINAL_BACKEND` | `tmux` | Persistent terminal backend. |
| `DEVSPACE_TERMINAL_RUNTIME_DIR` | `<stateDir>/terminal-runtime` | Private tmux socket and environment directory. |
| `DEVSPACE_TERMINAL_MAX_PER_WORKSPACE` | `4` | Active terminal limit per workspace. |
| `DEVSPACE_TERMINAL_MAX_TOTAL` | `12` | Active terminal limit per executor. |
| `DEVSPACE_TERMINAL_IDLE_TTL_SECONDS` | `28800` | Idle lifetime for unretained terminals. |
| `DEVSPACE_TERMINAL_USER_SYSTEMD` | `1` | Use the user systemd manager when available so the tmux server survives DevSpace restart. |
| `DEVSPACE_MAINTENANCE_INTERVAL_SECONDS` | `3600` | Maintenance cadence. |
| `DEVSPACE_CLOSED_SESSION_TTL_SECONDS` | `604800` | Closed workspace metadata retention. |
| `DEVSPACE_CHECKOUT_IDLE_TTL_SECONDS` | `2592000` | Inactive checkout metadata retention. |
| `DEVSPACE_ISOLATED_IDLE_TTL_SECONDS` | `604800` | Inactive clean managed workspace retention. Dirty work is retained. |
| `DEVSPACE_SESSION_IDLE_TTL_SECONDS` | `1800` | Idle lifetime for MCP sessions before they are evicted. Active sessions self-warm via request activity; clients re-initialize freely after eviction. Bounds gateway memory growth from clients that never send DELETE. |
| `DEVSPACE_SESSION_SWEEP_INTERVAL_SECONDS` | `60` | How often the server sweeps for idle MCP sessions. |

DevSpace always removes `DEVSPACE_OAUTH_OWNER_TOKEN`, the current node bearer variable, and configured remote-node bearer names from child shell and terminal environments. It does not remove user development credentials merely because their names contain `TOKEN`, `KEY`, or `SECRET`.

## OAuth

DevSpace uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Tool Modes

`DEVSPACE_TOOL_NAMING` controls tool names.

| Value | Behavior |
| --- | --- |
| `short` | Default. Uses `read`, `edit`, `bash`, and related names. |
| `legacy` | Uses `read_file`, `edit_file`, `run_shell`, and related names. |

`DEVSPACE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Disables dedicated search and list tools. Clients use the shell tool with `rg`, `grep`, `find`, `ls`, or `tree` for inspection. |
| `full` | Enables dedicated `grep`, `glob`, and `ls` tools. |

## Tool annotation profiles

`DEVSPACE_ANNOTATION_PROFILE` controls only the MCP risk hints advertised to the host. It does not change filesystem policy, authentication, shell authority, tool behavior, or DevSpace's own execution checks.

| Value | Behavior |
| --- | --- |
| `standard` | Default. Advertises mutation and open-world risk according to the tool's actual capabilities. |
| `trusted-owner` | Intended for a private owner-operated engineering endpoint. Keeps `readOnlyHint` truthful, advertises mutating tools as non-destructive and closed-world, and marks deterministic file write/edit operations idempotent. |

The trusted-owner profile is an operator UX choice for MCP hosts that apply extra confirmation or classification to risky annotations. Do not use it as a security boundary.

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default for standalone servers. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `workspace` | Gateway default when `DEVSPACE_WIDGETS` is unset. Renders one live `open_workspace` card and folds later workspace activity into that card without per-tool widgets. Gateway operators may explicitly select another mode for debugging; standalone servers reject this mode. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to workspace lifecycle tools and `show_changes`. |
| `off` | Disables widget UI. |

## Instructions and skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_GLOBAL_INSTRUCTIONS_FILE` | Optional global DevSpace instruction file. Defaults to `~/.devspace/AGENTS.md`; absence is allowed. Loaded before project instructions on every workspace open and returned to the connected MCP client, so it must not contain secrets. |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_AGENT_DIR` | Skill/resource agent directory, defaulting to `~/.codex`. It is not used as DevSpace global instruction context. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated skill directories. |

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.codex/skills,$HOME/.claude/skills" \
npx @waishnav/devspace serve
```

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_TRUST_PROXY` | `0` |

Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging.

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="$HOME/.devspace/worktrees" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_TOOL_NAMING="short" \
DEVSPACE_ANNOTATION_PROFILE="standard" \
DEVSPACE_WIDGETS="full" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.
# Gateway and node roles

Standalone `devspace serve` keeps the existing user/environment configuration.
The multi-machine roles use explicit JSON passed with `--config`; the optional
`role` property may be `gateway` or `node` but is inferred from `machines` or
`machineId` when omitted.

The Saga gateway configuration is:

```json
{
  "host": "127.0.0.1",
  "port": 7676,
  "publicBaseUrl": "https://devspace-saga.heliasar.com",
  "stateDir": "/srv/services-state/devspace/gateway",
  "machines": [
    {
      "id": "asgard", "displayName": "Asgard", "aliases": ["home"],
      "canonical": true, "kind": "remote",
      "url": "https://devspace-asgard.heliasar.com",
      "nodeTokenEnv": "DEVSPACE_ASGARD_NODE_TOKEN"
    },
    {
      "id": "saga", "displayName": "Saga", "aliases": ["cloud"],
      "canonical": false, "kind": "local",
      "roots": [
        {
          "path": "/srv/pool/projects",
          "aliases": ["/home/ubuntu/projects"],
          "access": "read-write"
        },
        { "path": "/home/ubuntu", "access": "read-write" },
        { "path": "/etc", "access": "read-only" },
        { "path": "/var/log", "access": "read-only" }
      ],
      "stateDir": "/srv/services-state/devspace/executor",
      "worktreeRoot": "/srv/services-state/devspace/worktrees",
      "shell": { "path": "/bin/bash", "mode": "login" },
      "terminals": {
        "runtimeDir": "/run/user/1000/devspace",
        "useUserSystemd": true
      }
    }
  ]
}
```

The protected gateway environment supplies `DEVSPACE_OAUTH_OWNER_TOKEN` and
`DEVSPACE_ASGARD_NODE_TOKEN`. The gateway sends only
`X-DevSpace-Node-Token`; it never accepts credentials in JSON.

The Asgard node configuration is:

```json
{
  "host": "127.0.0.1", "port": 7679, "machineId": "asgard",
  "allowedRoots": ["/home/bex/projects"],
  "stateDir": "/home/bex/.local/state/devspace-asgard-node",
  "worktreeRoot": "/home/bex/.local/share/devspace-asgard-worktrees",
  "nodeTokenEnv": "DEVSPACE_NODE_TOKEN"
}
```

The node environment must define `DEVSPACE_NODE_TOKEN`. Configuration loading
fails on a missing node-token variable, non-HTTPS remote URLs, alias/ID collisions,
multiple or missing canonical machines, non-loopback node binding, and
overlapping gateway/executor state or worktree roots.


## Checkout session reuse

`open_workspace` reuses an active checkout session when its logical path, canonical target, and mode match. Pass `fresh: true` to force a separate checkout session and independent review baseline. Managed `worktree` and `isolated` opens are never merged. In gateway mode, checkout reuse also preserves the existing public workspace ID.
