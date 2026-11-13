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

The first `DEVSPACE_OAUTH_SCOPES` entry is the scope `/mcp` requires, and it is what an authorization request that omits `scope` (or sends it empty) is granted. A redirect host outside `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` is rejected at registration with `invalid_redirect_uri`; loopback hosts are always allowed. A redirect URI with a fragment or userinfo is rejected the same way, whatever its host.

On a plain-http `DEVSPACE_PUBLIC_BASE_URL` (local testing), the approval page's CSRF cookie is named `devspace-csrf` instead of `__Host-devspace-csrf`, because browsers accept the `__Host-` prefix only on a `Secure` cookie. See [Security](security.md#oauth-and-network-exposure).

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

The authorization server does not implement RFC 9207: its metadata has no `authorization_response_iss_parameter_supported` field, and authorization redirects carry no `iss` parameter.

The authorization-server endpoints are DevSpace's own code in `src/oauth/`; the discovery documents and `/mcp` bearer authentication use the maintained `@modelcontextprotocol/express` package. See [Security](security.md#oauth-and-network-exposure).

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

Under both profiles every tool, including the bridged `node_repl`, sky-cua, and T3 tools, states `readOnlyHint`, `destructiveHint`, and `openWorldHint` explicitly. Read-only workspace tools are read-only, non-destructive, and closed-world. Independently of the profile, `node_repl` tools advertise non-destructive and closed-world, and sky-cua tools keep sky-cua's `readOnlyHint` (false when sky-cua omits it) but always advertise `destructiveHint: false` and `openWorldHint: false`.

## Tool and resource metadata

What `tools/list` and the card resource carry for ChatGPT, Claude, and other MCP Apps hosts:

| Where | Key | Value |
| --- | --- | --- |
| Every tool | `_meta.securitySchemes` | `[{ "type": "oauth2", "scopes": ["<first DEVSPACE_OAUTH_SCOPES entry>"] }]`, the scope the `/mcp` bearer check requires. A declaration only; the `/mcp` bearer check is the enforcement. The MCP SDK lists no top-level `securitySchemes`, so only OpenAI's documented `_meta` mirror is emitted. |
| Tools with a card (see Widgets) | `_meta.ui.resourceUri` | The content-hashed `ui://devspace/workspace-app-<hash>.html` card. MCP Apps standard key. |
| | `_meta.ui.visibility` | `["model"]`; the app-only `workspace_activity` tool has `["app"]` and no card. |
| | `_meta["openai/outputTemplate"]` | Same URI. ChatGPT compatibility alias. |
| | `_meta["ui/resourceUri"]` | Same URI. Deprecated flat key that ext-apps' `registerAppTool` adds for older hosts. |
| Card resource and its `resources/read` contents | `_meta.ui.csp` | `resourceDomains` and `connectDomains` set to `DEVSPACE_PUBLIC_BASE_URL`. |
| | `_meta["openai/widgetCSP"]` | The same domains as `resource_domains` and `connect_domains`. Legacy ChatGPT compatibility key. |

The two `openai/*` keys are documented by OpenAI as optional compatibility aliases. They stay until a ChatGPT session has been checked to render the card without them.

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
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated skill directories. Can also be set as `skillPaths` (string array) in `~/.devspace/config.json`. The environment variable overrides that array. |
| `DEVSPACE_AUTOLOAD_SKILLS` | Optional comma-separated skill names to preload at **connection**; can also be configured as `autoLoadSkills` (string array) in `~/.devspace/config.json`. Defaults to none. Each skill found in the agent directory or skill paths has its entire `SKILL.md` appended to the MCP server instructions once per session, so it is available without opening a workspace. Skills larger than 64 KiB are skipped. `open_workspace` does not repeat the content; it names the autoloaded skills and makes their reference files readable without a separate skill activation. Skills unavailable in a workspace generate warnings there. Autoloaded sky-cua skills are omitted when sky-cua is disabled for the session. `DEVSPACE_SKILLS=0` disables preloading too. Clients may truncate long server instructions (Claude Code cuts at 4,096 characters by default), so keep autoloaded skills compact. |
| `DISABLED_CAPABILITIES` | Comma-separated list of capabilities to hide for this instance or per-MCP-session. Hermes on Saga sets `DISABLED_CAPABILITIES=sky-cua` so ChatGPT sees phone/desktop/browser tools but Hermes does not. `t3` hides the T3 Code tools (see [T3 Code bridge](#t3-code-bridge)). Future values use same list: `DISABLED_CAPABILITIES=sky-cua,other-cap`. Per-session: client may send `X-Disabled-Capabilities: sky-cua` header or `?disabled_capabilities=sky-cua` query or `params._meta.disabledCapabilities` at `initialize`; evaluated at session creation — ChatGPT “refresh tools” re-initializes (new MCP session) without reauth and picks up the new set; plain `tools/list` on the same session does not change until next session. |
| `DEVSPACE_SKY_CUA_PROJECT_ROOT` | Local checkout of sky-cua, default `~/projects/sky-cua`. Used to resolve `bin/sky-cua-client` and `skills/` for the live bridge. |
| `DEVSPACE_SKY_CUA_BIN` | Override sky-cua MCP binary path, default `<projectRoot>/bin/sky-cua-client`. |
| `SKY_CUA_SERVICE_SOCKET_PATH` | Passthrough to sky-cua service (default `XDG_RUNTIME_DIR/sky-cua/service.sock`). Also `SKY_CUA_PHONE_*`, `SKY_CUA_BROWSER` etc. are forwarded unchanged. |
| `SKY_CUA_PHONE_ALIASES` | Alias map for phone devices (`phone` default + `tablet`). Preferred: `~/.config/sky-cua/sky-cua.toml` `[phone.aliases]` as committed. |

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.agents/skills" \
DEVSPACE_AUTOLOAD_SKILLS="agent-monitor" \
npx @waishnav/devspace serve
```

## T3 Code bridge

The `t3` block in `config.json` controls the [T3 Code orchestration bridge](t3-code.md). It has no environment-variable equivalent. In gateway mode, DevSpace reads it from `<stateDir>/role-config-source/config.json`.

| Key | Default | Purpose and validation |
| --- | --- | --- |
| `enabled` | `false` | Expose the twelve T3 tools. Must be a boolean. |
| `cliPath` | `~/.t3/bin/t3` | T3 CLI used to mint the bridge's credential. Must be a non-empty string; `~` is expanded and the path made absolute. |
| `runtimeFile` | `~/.t3/userdata/server-runtime.json` | T3 runtime file whose `origin` locates the server, re-read on every reconnect. Same rules as `cliPath`. |
| `url` | none | Fixed T3 origin, such as `http://127.0.0.1:3773`. Must be an `http` or `https` URL; only its origin is kept, and `null` counts as unset. When set, `runtimeFile` is ignored. |

A `t3` value that is not an object, an unknown key, or a wrong type fails configuration loading with an `Invalid t3…` error, so DevSpace does not start. Settings are read at startup; restart DevSpace after changing them.

The capability name is `t3`. Hide the tools for an instance with `DISABLED_CAPABILITIES=t3`, for one MCP session with `X-Disabled-Capabilities: t3` (or the query and `_meta` forms above), or on a gateway with `t3` in the local machine's `disabledCapabilities`. The bridge runs in the gateway process, so remote machine entries do not affect it.

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_TRUST_PROXY` | `loopback` when `HOST` is loopback, otherwise `0` |

`DEVSPACE_TRUST_PROXY=loopback` trusts only proxies on the local machine
(cloudflared, Tailscale serve, a local Caddy), so the client address is the
right-most non-loopback `X-Forwarded-For` hop. `1` trusts exactly one proxy hop
of any address; use it when the proxy runs on another host. `0` disables proxy
trust. Per-IP OAuth rate limits (`/authorize` 10 per minute, `/token` 30 per
minute, `/register` 20 per hour, `/revoke` 50 per 15 minutes) and logged client
IPs follow this setting. The
separate process-wide cap on failed owner-password approvals (20 per 15
minutes) does not depend on client IPs and is not configurable; see
[Security](security.md#oauth-and-network-exposure).

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

Remote machines hide `sky-cua` by default (`disabled_capabilities: ["sky-cua"]` or `disabledCapabilities: ["sky-cua"]`) so the phone/desktop/browser bridge stays local. To expose it for Asgard testing, set `disabled_capabilities: []` (or `disabledCapabilities: []`) on that node's config. Local machines default to enabled. `DISABLED_CAPABILITIES` on the server still applies per-session via header/query without reauth.

Phone aliases are `[phone.aliases]` in `~/.config/sky-cua/sky-cua.toml` (already `phone` default + `tablet` secondary on this host). DevSpace's bridge reads tools live from `bin/sky-cua-client mcp` at startup, so definitions/descriptions stay in sync without edits.


## Checkout session reuse

`open_workspace` reuses an active checkout session when its logical path, canonical target, and mode match. Pass `fresh: true` to force a separate checkout session and independent review baseline. Managed `worktree` and `isolated` opens are never merged. In gateway mode, checkout reuse also preserves the existing public workspace ID.
