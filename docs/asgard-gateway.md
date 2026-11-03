# Asgard gateway and return to Saga

## Current setup on Asgard (2026-11-03)

ChatGPT’s **DevSpace Gateway** plugin uses `https://devspace-saga.heliasar.com/mcp`. The hostname stays the same when the gateway moves. It currently routes through the shared `asgard-public` Cloudflare tunnel to `127.0.0.1:7679`. Asgard is the only configured machine, runs its executor locally, and is selected when `open_workspace` omits `machine`.

| Asgard user unit | Current role |
| --- | --- |
| `devspace-asgard-gateway.service` | Enabled and active. Runs the installed Node 24 artifact in `~/.local/opt/devspace` with `gateway --config ~/.config/devspace-asgard/gateway.json`. |
| `devspace-asgard-node.service` | Disabled and inactive. Its `node.json` and protected `node.env` remain in `~/.config/devspace-asgard/` for the return to Saga. |
| `cloudflared-asgard-public.service` | Serves the public hostname using `~/.cloudflared/asgard-public.yml`. The same tunnel serves other applications. |
| `devspace.service` | Independent standalone MCP service on `127.0.0.1:7676`. Leave it running through the switch. |

The local executor uses the node’s allowed roots, workspace state in `~/.local/state/devspace-asgard`, and worktrees in `~/.local/share/devspace-asgard/worktrees`. The gateway keeps its own OAuth database and public workspace bindings in `~/.local/state/devspace-gateway`. Its owner password comes from `~/.devspace/auth.json` through the gateway’s `role-config-source/auth.json` symlink.

## Switch back when Saga is available

1. **Prepare Saga before interrupting Asgard.** On Saga, verify the deployed `/srv/services-state/devspace/gateway.json` declares canonical `asgard` as remote at `http://100.120.202.119:7679` and `saga` as local. Check that the shared `saga-public` tunnel has an active connector and its ingress rule maps `devspace-saga.heliasar.com` to `http://127.0.0.1:7676`. Start the existing Saga gateway if needed, then check its local health.

   ```bash
   sudo systemctl start devspace.service
   systemctl is-active devspace.service cloudflared-saga-public.service
   curl -fsS http://127.0.0.1:7676/healthz
   ```

   Expect `role: gateway` and the intended source commit. Keep Saga’s gateway database at `/srv/services-state/devspace/gateway`. The Asgard cutover recovered ChatGPT’s public client ID and exact callback URI from its reconnect request. Saga may already have that registration, but the current tokens were issued on Asgard. Use **Reconnect** on the existing account if prompted. If Saga returns `invalid_client`, verify that registration before retrying.

2. **Hand the Asgard executor back to the node.** Check `tailscale ip -4` on Asgard for the configured node address and verify tailnet connectivity from Saga. The gateway and node use the same executor state, so stop the Asgard gateway before starting the node. This begins a short interruption on the public route. Run on Asgard as the service user:

   ```bash
   systemctl --user disable --now devspace-asgard-gateway.service
   systemctl --user enable --now devspace-asgard-node.service
   systemctl --user is-active devspace-asgard-node.service
   ss -ltn 'sport = :7679'
   ```

   Expect the node listener on `100.120.202.119:7679`. From Saga, request `GET /internal/v1/hello` at that address with the gateway’s configured `DEVSPACE_ASGARD_NODE_TOKEN` in the `X-DevSpace-Node-Token` header. Use the protected service environment without printing the token. Require `machineId: asgard` and a protocol major and tool-contract hash matching Saga’s installed artifact. The node uses the tailnet directly. Its old dedicated Cloudflare tunnel can stay disabled.

3. **Move only the DevSpace DNS record.** From a host authorized to manage the zone, verify the `saga-public` tunnel identity and active connections with `cloudflared tunnel list`, then route the existing hostname back to it:

   ```bash
   cloudflared tunnel route dns --overwrite-dns saga-public devspace-saga.heliasar.com
   curl -fsS https://devspace-saga.heliasar.com/healthz
   curl -sS -o /dev/null -w '%{http_code}\n' https://devspace-saga.heliasar.com/mcp
   ```

   Allow for DNS propagation. Expect Saga’s gateway identity and HTTP 401 on unauthenticated MCP. Keep the Asgard ingress rule available for rollback and keep the shared tunnel running.

4. **Verify both machines from ChatGPT.** Through the existing **DevSpace Gateway** connection, call `open_workspace({path: "/home/bex/projects/devspace"})` and read `package.json`. Require machine `asgard`. Then call `open_workspace({machine: "saga", path: "/opt/homelab"})` and require machine `saga`. Use the workspace IDs returned by the restored gateway. The two gateways have separate binding databases.

**Rollback.** If the node check or plugin verification fails and service needs restoring, run `systemctl --user disable --now devspace-asgard-node.service` on Asgard, then `systemctl --user enable --now devspace-asgard-gateway.service`. Verify `curl -fsS http://127.0.0.1:7679/healthz`. If DNS moved, run `cloudflared tunnel route dns --overwrite-dns asgard-public devspace-saga.heliasar.com`. Repeat the public health, authentication, and default Asgard workspace checks. Reconnect the plugin if it acquired Saga-issued credentials during the attempt.
