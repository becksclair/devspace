# Widget host (developer harness)

`src/testing/widget-host/` is a local MCP Apps host for checking the DevSpace workspace card in a
real browser without ChatGPT, Claude, or the production server. It starts a real DevSpace server
in-process with a throwaway seeded Git workspace, loads the widget resource with `resources/read`,
frames it through a sandbox proxy, and delivers real `tools/call` results to it with `AppBridge`
from `@modelcontextprotocol/ext-apps/app-bridge`.

## Running it

```sh
bun run build:check                 # once, and after widget changes: builds dist/ui
bun run widget:host                 # --widgets full (default)
bun run widget:host --widgets changes
bun run widget:host --widgets workspace
```

The launcher prints one line with the host page URL, for example
`http://127.0.0.1:53817/?scenario=index`. Ctrl-C stops the servers and removes the temporary
directories. Everything binds `127.0.0.1` on ephemeral ports unless `--port`, `--devspace-port`,
or `--sandbox-port` is given; ports 3000 and 7676-7680 are refused. `--tool-naming legacy` switches
DevSpace to the long tool names; scenarios discover names from `tools/list`.

The widget mode decides which scenarios can render, as in production:

| Mode | Renders |
|---|---|
| `full` | every card except the review card (`show_changes` is not registered in standalone `full`) |
| `changes` | `open_workspace`, `workspace_status`, `close_workspace`, `show_changes*` |
| `workspace` | DevSpace runs as a gateway with one local machine; only `open_workspace`, which becomes the live activity feed (`activity_feed`) |

`?scenario=index` lists every scenario and whether the current mode can render it.

## Deep links and automation

`?scenario=<id>&theme=light|dark&width=360|480|768[&csp=wasm]` runs a scenario without clicks.
The page sets `document.documentElement.dataset.harnessState` to `loading`, then `ready` or
`error` (the error text is in `#harness-error`); wait for `ready` before taking a screenshot. The
widget is inside `#stage`. Read, write, and edit cards are collapsed until their header is clicked;
an automated browser reaches it through the two nested frames.

The toolbar can switch theme and width live (sent as `ui/notifications/host-context-changed`),
re-send the last tool result, and send `ui/resource-teardown`. The bridge log panel shows every
message in both directions; the CSP panel shows the policy applied to the widget document.

## How it relates to a real host

- The host page, the sandbox proxy, and DevSpace each have their own origin. The proxy renders the
  widget HTML in a `srcdoc` iframe (`allow-scripts allow-same-origin allow-forms`) with a CSP built
  from the resource's `_meta.ui.csp` as in the MCP Apps specification's security section, so a
  load the declared CSP does not allow fails here too. Violations appear in the status bar and log.
- The CSP is applied as a `<meta>` element inserted at the start of `<head>`, not as an HTTP
  header, and the proxy inserts a small script before it that reports CSP violations and uncaught
  errors to the host. A real host's policy may be stricter or looser than the spec's.
- `?csp=wasm` adds `'wasm-unsafe-eval'` to `script-src`. The spec gives a resource no way to
  request it; the option exists so the syntax-highlighting and diff renderers, which compile
  WebAssembly, can be inspected at all.
- App-initiated `tools/call` is refused for tools whose `_meta.ui.visibility` lacks `"app"`.
- The harness talks to DevSpace through a same-origin JSON proxy (`/api`) that holds a static API
  key minted into the temporary state directory. The sky-cua, node_repl, and T3 capabilities are
  disabled, and skills are off.

It is not a security boundary: the proxy runs real tools, including shell commands, against the
temporary workspace with your account's authority. It is not a substitute for testing in ChatGPT
and Claude, whose sandboxes, CSP, fonts, sizing, and lifecycle differ from this harness.

## Smoke test

`src/widget-host.test.ts` (part of `bun run test`) runs every scenario's tool calls through the
same `/api` proxy without a browser and checks the results with the widget's own card validators.
Without `dist/ui` it runs DevSpace with widgets off and skips the resource checks.
