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
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `DEVSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |

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

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_AGENT_DIR` | Defaults to `~/.codex`. |
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
      "accessClientIdEnv": "DEVSPACE_ASGARD_ACCESS_CLIENT_ID",
      "accessClientSecretEnv": "DEVSPACE_ASGARD_ACCESS_CLIENT_SECRET",
      "nodeTokenEnv": "DEVSPACE_ASGARD_NODE_TOKEN"
    },
    {
      "id": "saga", "displayName": "Saga", "aliases": ["cloud"],
      "canonical": false, "kind": "local",
      "allowedRoots": ["/home/ubuntu", "/opt/homelab", "/srv/services"],
      "stateDir": "/srv/services-state/devspace/executor",
      "worktreeRoot": "/srv/services-state/devspace/worktrees"
    }
  ]
}
```

The protected gateway environment supplies `DEVSPACE_OAUTH_OWNER_TOKEN` and the
three Asgard variables named above. The gateway sends exactly
`CF-Access-Client-Id`, `CF-Access-Client-Secret`, and
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
fails on missing credentials, non-HTTPS remote URLs, alias/ID collisions,
multiple or missing canonical machines, non-loopback node binding, and
overlapping gateway/executor state or worktree roots.
