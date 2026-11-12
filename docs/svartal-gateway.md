# Svartal gateway with an Asgard node

## Verified deployment on 2026-11-08

The public endpoint remains `https://devspace-saga.heliasar.com/mcp`. Svartal now hosts the gateway on macOS and selects its local executor by default. Use `machine: "asgard"` (alias `home`) to access Asgard through its private node over Tailscale.

| Component | Location |
| --- | --- |
| Gateway | Svartal LaunchAgent `com.rclair.devspace-gateway`, loopback `127.0.0.1:7679` |
| Runtime | Node 24 at `~/.local/share/mise/installs/node/24/bin/node`, version 2.0.2 built from source `c75139e6cbe46933c394c42b6c25390970793a39` in `~/projects/devspace` (`065844c6a4a7ad5c83de4d2ee4ad334dcc2ef2ed` before the 2026-11-09 history rewrite; builds made before then still report that ID) |
| Launcher | `~/.local/bin/devspace-gateway`, loads protected `~/.config/devspace-svartal/node.env` |
| Gateway configuration | `~/.config/devspace-svartal/gateway.json` |
| OAuth and workspace bindings | `~/.local/state/devspace-gateway/devspace.sqlite`, copied using SQLite backup from Asgard |
| Svartal executor state and worktrees | `~/.local/state/devspace-svartal` and `~/.local/share/devspace-svartal/worktrees` |
| Owner auth, configuration, rules | Copied `~/.devspace`, with `role-config-source/auth.json` and `config.json` linked to it |
| Shared public tunnel | LaunchAgent `com.rclair.cloudflared-svartal-public`, config `~/.cloudflared/svartal-public.yml` |
| Asgard private executor | Enabled `devspace-asgard-node.service`, `http://<asgard-tailnet-ip>:7679`, authenticated with `X-DevSpace-Node-Token` |
| Asgard old gateway | Disabled `devspace-asgard-gateway.service`, source configuration and state retained |

The shared tunnel retains its photos, Obsidian and LiveSync routes. Asgard's independent `devspace.service` remains separate from the private node. The node retains its original executor state and worktrees. Copied gateway bindings for Asgard still route to Asgard. Fresh Svartal workspaces use `/Users/rclair/...` paths and machine ID `svartal`.

## Release directories

The gateway can run from an immutable release directory instead of the working checkout. `scripts/local-release.mjs` provides two commands.

`bun run release:prepare [<rev>]` builds `~/.local/opt/devspace/releases/<commit>` from a clean temporary git worktree of `<rev>` (default `HEAD`, resolved in the checkout that runs the command). The release holds `dist`, production `node_modules`, `package.json`, `bun.lock`, and `artifact.json`. Its `dist/build-metadata.js` is replaced with one that reports the release commit, so `/healthz` identifies the build rather than the checkout. Before moving the release into place, `prepare` smoke-tests it by starting a node on port 17679 and a gateway on port 17676. It never creates or changes `current` or `previous` and never restarts anything, so it is safe to run in any checkout, including `~/projects/devspace`. `--app-root <dir>` or `DEVSPACE_APP_ROOT` builds under another root. If the release directory already exists, `prepare` reports it and does nothing.

A release must be built with the Node major the launcher runs. `prepare` uses the Node that runs it unless `--node <absolute path>` is given, refuses any major other than 24, puts that binary first on `PATH` for the install, the build, and the smoke test, and records its exact version as `node_version` in `artifact.json`. The default `node` on Svartal's `PATH` is a newer major, so always pass the launcher's binary:

```bash
bun run release:prepare --node "$HOME/.local/share/mise/installs/node/24/bin/node"
```

The native modules in the current dependencies (`better-sqlite3`, the Pi TUI platform module) are N-API prebuilds that load under either major. The pin makes the smoke test exercise the release under the Node that will run it, and catches a future dependency that compiles against one Node ABI.

`bun run release:activate <rev> --label com.rclair.devspace-gateway --health-url http://127.0.0.1:7679/healthz` switches the live gateway:

1. It points `current` at the prepared release and restarts the LaunchAgent with `launchctl kickstart -k`.
2. It polls the health URL for up to 30 seconds until it reports `ok` and the release commit.
3. If the restart or the health check fails, it points `current` back at the release it replaced, restarts again, and exits non-zero.
4. On success it records the replaced release as `previous` and deletes every other release directory, including prepared releases that were never activated.

`release:activate` has no default label or health URL. Run it from a local terminal on Svartal, not through DevSpace's own shell or terminal tools: restarting the gateway kills its children, including the command performing the switch.

```text
~/.local/opt/devspace/releases/<commit>/   dist/, node_modules/, package.json, bun.lock, artifact.json
~/.local/opt/devspace/current  -> releases/<commit>   what the launcher runs
~/.local/opt/devspace/previous -> releases/<commit>   the release before the last switch
```

After the cutover, the gateway's working directory is the release directory. Settings that would fall back to the working directory, such as allowed roots, must be explicit in `gateway.json`; Svartal's configuration already sets them. The gateway and every node must share a tool-contract hash, so a release whose `artifact.json` `tool_contract_hash` changed also needs the Asgard node redeployed.

### One-time cutover (operator)

Not yet done. Until it is, the gateway runs from `~/projects/devspace`, and the `AGENTS.md` rule about that checkout applies.

1. In a checkout of merged `main`, prepare the release:

   ```bash
   bun run release:prepare --node "$HOME/.local/share/mise/installs/node/24/bin/node"
   ```

2. In the same checkout, point `current` at it:

   ```bash
   ln -sfn "releases/$(git rev-parse HEAD)" ~/.local/opt/devspace/current
   ```

3. Back up the launcher:

   ```bash
   cp -p ~/.local/bin/devspace-gateway ~/.local/bin/devspace-gateway.pre-release-root
   ```

   Then replace the launcher's final `exec` line with:

   ```bash
   cd "$HOME/.local/opt/devspace/current"
   app="$(pwd -P)"
   exec "$HOME/.local/share/mise/installs/node/24/bin/node" "$app/dist/cli.js" gateway --config "$HOME/.config/devspace-svartal/gateway.json"
   ```

   `pwd -P` pins the process to the real release directory. The `cd` also replaces the LaunchAgent's working directory, so the plist needs no change.

4. Restart the gateway:

   ```bash
   launchctl kickstart -k gui/$(id -u)/com.rclair.devspace-gateway
   ```

5. Check that the process runs `releases/<commit>/dist/cli.js` and that local and public health report that commit:

   ```bash
   ps -o command= -p "$(pgrep -f 'dist/cli.js gateway')"
   curl -fsS http://127.0.0.1:7679/healthz
   curl -fsS https://devspace-saga.heliasar.com/healthz
   ```

6. Update the Runtime row of the component table above, and remove the "production gateway runs from" bullet from `AGENTS.md`.

To roll back the cutover, restore `~/.local/bin/devspace-gateway.pre-release-root` over the launcher and restart the gateway with the command in step 4. That brings back the checkout's `dist`, so it must still be intact; this is why the `AGENTS.md` rule applies until the cutover is verified.

### Routine deploy and rollback

After the cutover, deploy a revision from a local terminal on Svartal:

```bash
bun run release:prepare --node "$HOME/.local/share/mise/installs/node/24/bin/node" <rev>
bun run release:activate <rev> --label com.rclair.devspace-gateway --health-url http://127.0.0.1:7679/healthz
curl -fsS https://devspace-saga.heliasar.com/healthz
```

A failed health check rolls back automatically. To return to the previous release by hand, activate it:

```bash
bun run release:activate "$(basename "$(readlink ~/.local/opt/devspace/previous)")" --label com.rclair.devspace-gateway --health-url http://127.0.0.1:7679/healthz
```

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

## T3 Code bridge

The [T3 Code bridge](t3-code.md) runs in the gateway process and reaches T3 Code on Svartal at `http://127.0.0.1:3773`. It is off until enabled. The gateway reads its settings through the `role-config-source/config.json` link to `~/.devspace/config.json`.

To enable it:

1. Deploy a revision that includes the bridge as described in [Routine deploy and rollback](#routine-deploy-and-rollback). Before the [one-time cutover](#one-time-cutover-operator), instead save the current `dist` in `~/projects/devspace` for rollback, update that checkout to a revision that includes the bridge, and run `bun run build:check` there.
2. Add `"t3": { "enabled": true }` to `~/.devspace/config.json`.
3. Restart the gateway and check health:

   ```bash
   launchctl kickstart -k gui/$(id -u)/com.rclair.devspace-gateway
   curl -fsS http://127.0.0.1:7679/healthz
   curl -fsS https://devspace-saga.heliasar.com/healthz
   ```

4. Verify the public chain from `~/projects/devspace`. The suite starts real scratch threads through the public endpoint, then settles and archives them.

   ```bash
   bun run test:t3-deployed
   ```

5. Refresh the DevSpace connector in ChatGPT so it lists the `t3_` tools.

To roll back, set `t3.enabled` to `false` in `~/.devspace/config.json`, restart the gateway with the same `launchctl kickstart` command, and refresh the connector. To remove the code as well, activate the previous release as described in [Routine deploy and rollback](#routine-deploy-and-rollback); before the cutover, restore the saved `dist` before restarting.

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
