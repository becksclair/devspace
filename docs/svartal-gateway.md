# Svartal gateway with an Asgard node

## Verified deployment on 2026-11-08

The public endpoint remains `https://devspace-saga.heliasar.com/mcp`. Svartal now hosts the gateway on macOS and selects its local executor by default. Use `machine: "asgard"` (alias `home`) to access Asgard through its private node over Tailscale.

| Component | Location |
| --- | --- |
| Gateway | Svartal LaunchAgent `com.rclair.devspace-gateway`, loopback `127.0.0.1:7679` |
| Runtime | Node 24 at `~/.local/share/mise/installs/node/24/bin/node`, version 2.0.2 built from source `065844c6a4a7ad5c83de4d2ee4ad334dcc2ef2ed` in `~/projects/devspace` |
| Launcher | `~/.local/bin/devspace-gateway`, loads protected `~/.config/devspace-svartal/node.env` |
| Gateway configuration | `~/.config/devspace-svartal/gateway.json` |
| OAuth and workspace bindings | `~/.local/state/devspace-gateway/devspace.sqlite`, copied using SQLite backup from Asgard |
| Svartal executor state and worktrees | `~/.local/state/devspace-svartal` and `~/.local/share/devspace-svartal/worktrees` |
| Owner auth, configuration, rules | Copied `~/.devspace`, with `role-config-source/auth.json` and `config.json` linked to it |
| Shared public tunnel | LaunchAgent `com.rclair.cloudflared-svartal-public`, config `~/.cloudflared/svartal-public.yml` |
| Asgard private executor | Enabled `devspace-asgard-node.service`, `http://<asgard-tailnet-ip>:7679`, authenticated with `X-DevSpace-Node-Token` |
| Asgard old gateway | Disabled `devspace-asgard-gateway.service`, source configuration and state retained |

The shared tunnel retains its photos, Obsidian and LiveSync routes. Asgard's independent `devspace.service` remains separate from the private node. The node retains its original executor state and worktrees. Copied gateway bindings for Asgard still route to Asgard. Fresh Svartal workspaces use `/Users/rclair/...` paths and machine ID `svartal`.

## Filesystem policy and copied rules

The gateway's local file-tool allowlist maps the previous gateway roots from `/home/bex` to `/Users/rclair`. These roots exist on Svartal. Missing directories were created empty during setup. Existing Mac directory contents were retained.

```text
/Users/rclair/.agents
/Users/rclair/.config
/Users/rclair/.local/bin
/Users/rclair/.hermes
/Users/rclair/.hermes/hermes-agent
/Users/rclair/.openclaw
/Users/rclair/ai
/Users/rclair/OpenCloud
/Users/rclair/personal
/Users/rclair/Downloads
/Users/rclair/Documents
/Users/rclair/projects
/Users/rclair/Documents/Codex
/Users/rclair/HeliasMind
/Users/rclair/HeliasMind-Archive
```

The copied `.devspace/config.json` also has its standalone paths and skill paths translated to the Mac home. Its broader standalone allowlist applies only if a standalone server is launched. The gateway uses the narrower roots in `gateway.json`. Shell and terminal tools run with the service user's authority, as described in the security documentation.

`.devspace/AGENTS.md` was copied byte-for-byte. OAuth secrets and the node transport secret stay in mode-0600 files. The gateway state directory is mode 0700. Migration backup copies on both hosts were removed after acceptance. Active configurations, databases and Asgard’s original source state remain available.

## Operations and verification

The LaunchAgent has `RunAtLoad` and `KeepAlive`, and starts at user login. To inspect or restart it on Svartal, run:

```bash
launchctl print gui/$(id -u)/com.rclair.devspace-gateway
launchctl kickstart -k gui/$(id -u)/com.rclair.devspace-gateway
curl -fsS http://127.0.0.1:7679/healthz
curl -fsS https://devspace-saga.heliasar.com/healthz
cloudflared tunnel --config ~/.cloudflared/svartal-public.yml ingress validate
```

Logs are `~/.local/state/devspace-svartal/gateway.log` and `gateway.err.log`. After any machine move, verify the actual selected machine through an authenticated MCP call. Health reports the build and gateway role without identifying the executor host.

An independent Node MCP SDK client completed public OAuth discovery, dynamic client registration, authorization with PKCE and the copied owner credential, token exchange, and protocol initialization through Cloudflare. The complete file workflow passed for both machines before and after a launchd restart. This acceptance used the public HTTPS endpoint, separately from the pre-connected ChatGPT connector. The ChatGPT connector initially returned internal errors during cutover. After reconnecting the existing account in ChatGPT’s in-app browser, a real ChatGPT browser chat successfully opened both workspaces and read each package.json. The UI reported default machine `svartal` and explicit machine `asgard`, with package `@waishnav/devspace` version 2.0.2 on both. Gateway logs confirmed the browser chat’s `openai-mcp/1.0.0` requests.

The migration acceptance flow opens `/Users/rclair/projects/devspace` with `machine` omitted and requires `svartal`. It then opens `/home/bex/projects/devspace` with `machine: "asgard"` and requires `asgard`. Both targets must support reading `package.json`, writing and reading back a temporary file, and removing that file. OAuth discovery must retain the public issuer, and unauthenticated `/mcp` must return HTTP 401.

## Closeout

Both Svartal LaunchAgents are running. Asgard’s private node is enabled and active, and its old gateway is disabled and inactive. The independent standalone Asgard service is still active. The shared tunnel configuration validates, and public gateway health reports version 2.0.2 at the source commit above.

Disposable proof files are absent on both machines. The two OAuth registrations named `Svartal migration verification` and their four tokens were removed after acceptance. The real ChatGPT registration, migrated workspace bindings and original source state were retained. Migration rollback backup copies were subsequently removed on both hosts at the operator’s request. The verification script was removed and its browser tab closed. Screenshots remain under `~/.codex/visualizations/2026/11/08/devspace/`, and the verification conversation remains in ChatGPT history.

## Rollback to Asgard

1. On Asgard, stop the private node before starting its old local gateway, since both use port 7679 and the same executor state.

   ```bash
   systemctl --user disable --now devspace-asgard-node.service
   systemctl --user enable --now devspace-asgard-gateway.service
   curl -fsS http://127.0.0.1:7679/healthz
   ```

2. Restore the hostname to the existing `asgard-public` tunnel from an authorized management host. On Svartal the management certificate is `~/.cloudflared/svartal-public-management-cert.pem`.

   ```bash
   TUNNEL_ORIGIN_CERT="$HOME/.cloudflared/svartal-public-management-cert.pem" \
     cloudflared tunnel route dns --overwrite-dns asgard-public devspace-saga.heliasar.com
   ```

3. Verify public health and an authenticated default Asgard workspace. Reconnect ChatGPT if its credentials differ from those in Asgard’s original gateway database. Keep both hosts' active databases intact. Stop Svartal's gateway with `launchctl bootout gui/$(id -u)/com.rclair.devspace-gateway` after acceptance. Keep the shared Svartal tunnel running for its other routes.

## Later return to Saga

The older [Asgard gateway runbook](asgard-gateway.md) describes the Saga service, private node checks and DNS switch. Prepare Saga first, retain `asgard` as its remote target, and decide explicitly whether Svartal should remain a target before moving the gateway. The currently enabled Asgard node can serve Saga once its protocol and tool-contract hash match. Avoid starting Asgard's old gateway while the node is active. Verify the intended default machine after the move. Saga restoration has not been executed as part of this migration.
