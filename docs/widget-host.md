# Widget host (developer harness)

`src/testing/widget-host/` is a local MCP Apps host for checking the DevSpace workspace card in a
real browser without ChatGPT, Claude, or the production server. It starts a real DevSpace server
in-process with a throwaway seeded Git workspace, loads the widget resource with `resources/read`,
frames it through a sandbox proxy, and delivers real `tools/call` results to it with `AppBridge`
from `@modelcontextprotocol/ext-apps/app-bridge`.

## Widget structure

The widget is a React 19 app built by Vite from `src/ui/` into `dist/ui`; the server serves it as
the MCP Apps resource.

| File | Role |
|---|---|
| `workspace-app.html`, `workspace-app.tsx` | Entry: mounts `WorkspaceApp` on `#app` and loads `workspace-app.css`. |
| `workspace-root.tsx` | `WorkspaceApp`: `useApp` from `@modelcontextprotocol/ext-apps/react`, the `toolresult` listener and teardown handler (registered before connect), the widget reducer, and the hooks below. |
| `widget-state.ts` | Reducer for the current card and its toggles; builds the card from a tool result (`_meta.tool`, `_meta.card` over `structuredContent`, `isError`). |
| `card-types.ts` | Card types and validators, shared with the harness and the server tests. |
| `tool-display.ts` | Pure display mapping: titles, labels, icons, tones, badges, patch line counts, workspace and terminal text. |
| `review-files.ts` | Pure labelling of review files (added, modified, deleted, renamed, binary). |
| `activity-feed.ts`, `use-activity-feed.ts` | Activity feed state and cursor handling (pure), and the `workspace_activity` long-poll hook that aborts its in-flight call on a new result, teardown, or unmount. |
| `use-host-context.ts` | Host context: `useHostStyles` for theme, variables and fonts, and safe-area insets. |
| `workspace-view.tsx`, `icons.tsx` | Presentational card components, the root error boundary (the error state until the next result), and JSX icons. |
| `payload-body.tsx` | Expanded card bodies; loads `heavy-payload.tsx` (read, write, edit) and `review-payload.tsx` (`show_changes`) with `React.lazy` so `@pierre/diffs` and Shiki stay out of the initial bundle. |
| `payload-fallback.tsx`, `render-fallback.ts`, `highlighter.ts` | Error boundary and plain-text fallback for the lazy renderers, and the shared highlighter setup. |

Tests for `src/ui` are pure-logic scripts plus `react-dom/server` render tests
(`workspace-view.test.tsx`, `review-files.test.tsx`); there is no DOM test framework.

### Highlighting under the host CSP

MCP hosts frame the widget under a CSP without `'wasm-unsafe-eval'`, so the widget cannot compile
WebAssembly. The code and diff renderers select `preferredHighlighter: "shiki-js"` (Shiki's
JavaScript regex engine), and `vite.config.ts` replaces the WebAssembly highlighters that
`@pierre/diffs` can load (`@pierre/highlights`, Shiki's Oniguruma engine) with stubs that throw,
which keeps them out of `dist/ui`. If a renderer chunk fails to load, the highlighter fails, or a
renderer throws, the card shows the error and the content as plain text. The smoke test fails if
any built chunk compiles WebAssembly.

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

A widget failure turns the state to `error` even after `ready`, so check it again after clicking:
an uncaught error, an unhandled rejection, or any CSP violation other than the one known benign
report (zod's `new Function` probe, `script-src` blocking `eval` in the `mcp-app-vendor` chunk).
A blocked WebAssembly compilation reports `blocked wasm-eval`. The page also sets
`data-harness-failures` and `data-harness-csp-violations` on `<html>`.

### Sweep procedure

The smoke test cannot click inside the widget, so after a widget or bundler change run this sweep
with any browser automation at hand (none is a repository dependency):

1. `bun run build:check`, then start `bun run widget:host` once per mode (`full`, `changes`,
   `workspace`); each prints its URL.
2. For every scenario listed as available in `?scenario=index`, at `theme=light` and `theme=dark`
   and `width=480`, under the default CSP (no `csp=wasm`): open the deep link and wait for
   `data-harness-state` to leave `loading`.
3. In the inner widget frame (`iframe[srcdoc]` inside the sandbox frame), click `.tool-header` on
   collapsible cards; on review cards click `Show N more files` and each enabled
   `.review-diff-file-header` (pure renames and binary changes have nothing to open).
4. After about two seconds, require `data-harness-state="ready"`, `data-harness-failures="0"`,
   and no `Loading` text left in the widget.

The theme and width selectors, `Re-send result`, and `Teardown` exercise the host-context,
re-delivery, and teardown paths of the same mounted widget.

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
  request it, and the widget does not need it: the code and diff renderers use Shiki's JavaScript
  engine (`preferredHighlighter: "shiki-js"`), and `vite.config.ts` stubs the WebAssembly
  highlighters (`@pierre/highlights`, Shiki's Oniguruma engine) out of the bundle. The option
  remains a diagnostic switch for comparing behaviour.
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
With `dist/ui` it also fails if any built chunk compiles WebAssembly. Without `dist/ui` it runs
DevSpace with widgets off and skips the resource checks.
