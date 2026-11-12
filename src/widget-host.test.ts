// Smoke test for the developer widget host (src/testing/widget-host), without a browser.
//
// Starts the harness's server pieces, runs every scenario's tool calls through the same /api
// proxy the host page uses, and checks each display result against the widget's own card
// validators (src/ui/card-types.ts). With a built widget bundle (dist/ui) it also checks the
// widget resource (MIME type, CSP metadata, asset reachability); without one, as in CI before the
// build, it runs the servers with widgets off and skips those checks.

import assert from "node:assert/strict";
import { startHarness, widgetBundleExists, type HarnessOptions, type RunningHarness } from "./testing/widget-host/harness-server.js";
import {
  SCENARIOS,
  ToolCatalog,
  checkDisplayResult,
  createScenarioContext,
  scenarioUnavailableReason,
  toolResourceUri,
  toolVisibility,
  type Scenario,
} from "./testing/widget-host/scenarios.js";
import { widgetContentSecurityPolicy } from "./testing/widget-host/sandbox-proxy.js";
import { createProxyTransport } from "./testing/widget-host/transport.js";

const bundle = widgetBundleExists();
const runs: Array<HarnessOptions & { label: string }> = bundle
  ? [
      { label: "standalone, widgets full", widgets: "full" },
      { label: "standalone, widgets changes, legacy names", widgets: "changes", toolNaming: "legacy" },
      { label: "gateway, widgets workspace", widgets: "workspace" },
    ]
  : [
      { label: "standalone, widgets off", widgets: "off" },
      { label: "gateway, widgets off", widgets: "off", gateway: true },
    ];

if (!bundle) {
  console.log("widget-host: dist/ui is absent; skipping widget resource checks (run `bun run build:check` to include them).");
}

assert.equal(
  widgetContentSecurityPolicy({ resourceDomains: ["http://a.test"], connectDomains: ["http://b.test"] }),
  "default-src 'none'; script-src 'self' 'unsafe-inline' http://a.test; style-src 'self' 'unsafe-inline' http://a.test; " +
    "connect-src 'self' http://b.test; img-src 'self' data: http://a.test; font-src 'self' http://a.test; " +
    "media-src 'self' data: http://a.test; frame-src 'none'; object-src 'none'; base-uri 'self'",
);
assert.match(widgetContentSecurityPolicy(undefined, true), /script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval';/);

const covered = new Set<string>();

async function checkProxyBoundaries(harness: RunningHarness): Promise<void> {
  const api = `${harness.hostUrl}api`;
  const rejectedMethod = await fetch(`${api}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "initialize", params: {} }),
  });
  assert.equal(rejectedMethod.status, 400, "proxy rejects methods outside its allowlist");
  const crossOrigin = await fetch(`${api}/info`, { headers: { Origin: "https://example.com" } });
  assert.equal(crossOrigin.status, 403, "proxy rejects cross-origin requests");
  const info = (await (await fetch(`${api}/info`)).json()) as Record<string, unknown>;
  assert.equal(info.widgets, harness.widgets);
  assert.equal(JSON.stringify(info).includes("obsk_"), false, "info never carries the static key");

  const sandbox = await fetch(`${harness.sandboxOrigin}/sandbox.html`);
  assert.equal(sandbox.status, 200);
  const sandboxHtml = await sandbox.text();
  assert.match(sandboxHtml, /ui\/notifications\/sandbox-proxy-ready/);
  assert.ok(sandboxHtml.includes(JSON.stringify(new URL(harness.hostUrl).origin)), "sandbox only talks to the host origin");
  assert.notEqual(new URL(harness.sandboxOrigin).origin, new URL(harness.hostUrl).origin, "sandbox and host origins differ");
}

async function checkWidgetResource(harness: RunningHarness, catalog: ToolCatalog): Promise<void> {
  const transport = createProxyTransport(`${harness.hostUrl}api`);
  const uris = catalog.resourceUris();
  assert.equal(uris.length, 1, "one widget resource is advertised");
  const outcome = await transport.rpc("resources/read", { uri: uris[0] });
  assert.ok("result" in outcome, "resources/read succeeds");
  const contents = outcome.result.contents as Array<Record<string, unknown>>;
  assert.equal(contents.length, 1);
  const [content] = contents;
  assert.equal(content.mimeType, "text/html;profile=mcp-app");
  assert.equal(typeof content.text, "string");
  const html = content.text as string;
  assert.match(html, /<script type="module"/);
  const csp = (content._meta as { ui?: { csp?: { resourceDomains?: string[]; connectDomains?: string[] } } } | undefined)?.ui?.csp;
  assert.deepEqual(csp?.resourceDomains, [harness.devspaceOrigin]);
  assert.deepEqual(csp?.connectDomains, [harness.devspaceOrigin]);

  // Every asset the widget HTML references is reachable cross-origin, as the sandboxed frame needs.
  const assetUrls = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g), (match) => match[1]);
  assert.ok(assetUrls.length >= 1);
  for (const assetUrl of assetUrls) {
    assert.ok(assetUrl.startsWith(`${harness.devspaceOrigin}/mcp-app-assets/`), `asset ${assetUrl} is under the declared resource domain`);
    const asset = await fetch(assetUrl, { headers: { Origin: harness.sandboxOrigin } });
    assert.equal(asset.status, 200, `asset ${assetUrl}`);
    assert.equal(asset.headers.get("access-control-allow-origin"), "*");
    await asset.body?.cancel();
  }
}

async function runScenario(harness: RunningHarness, catalog: ToolCatalog, scenario: Scenario): Promise<void> {
  const transport = createProxyTransport(`${harness.hostUrl}api`);
  const ctx = createScenarioContext(transport, catalog);
  const prepared = await scenario.prepare(ctx);
  const result = await ctx.call(prepared.display.tool, prepared.display.arguments);
  const failure = checkDisplayResult(scenario, catalog, result);
  assert.equal(failure, undefined, `${scenario.id}: ${failure}`);
  const after = await prepared.afterResult?.(result);
  if (scenario.id === "activity_feed") {
    // The widget renders the feed only when the app-only tool returns a page it accepts.
    const tool = catalog.definition("workspace_activity");
    assert.deepEqual(toolVisibility(tool), ["app"], "workspace_activity is app-only");
    assert.ok((after?.activityOperations ?? 0) >= 5, `activity feed recorded the follow-up calls (${after?.activityOperations})`);
    const workspaceId = result.structuredContent?.workspaceId;
    const page = await ctx.call("workspace_activity", { workspaceId, afterSeq: 0, limit: 200, waitMs: 0 });
    const events = page.structuredContent?.events as Array<Record<string, unknown>> | undefined;
    assert.ok(Array.isArray(events) && events.length >= 5);
    for (const event of events) {
      assert.equal(typeof event.seq, "number");
      assert.equal(typeof event.operationId, "string");
      assert.equal(typeof event.label, "string");
      assert.ok(["running", "success", "error"].includes(event.status as string));
    }
    assert.ok(events.some((event) => event.status === "error"), "the failing shell call shows as an error event");
  }
}

try {
  for (const run of runs) {
    const harness = await startHarness(run);
    try {
      await checkProxyBoundaries(harness);
      const catalog = await ToolCatalog.load(createProxyTransport(`${harness.hostUrl}api`));
      const requireWidget = run.widgets !== "off";
      if (bundle) {
        await checkWidgetResource(harness, catalog);
        for (const tool of catalog.tools) {
          if (toolResourceUri(tool)) assert.ok(toolVisibility(tool).includes("model"), `${tool.name} is model-visible`);
        }
      }
      for (const scenario of SCENARIOS) {
        if (covered.has(scenario.id)) continue;
        if (scenarioUnavailableReason(scenario, catalog, { requireWidget })) continue;
        await runScenario(harness, catalog, scenario);
        covered.add(scenario.id);
        console.log(`ok - ${scenario.id} (${run.label})`);
      }
    } finally {
      await harness.close();
    }
  }

  const uncovered = SCENARIOS.map((scenario) => scenario.id).filter((id) => !covered.has(id));
  if (bundle) {
    assert.deepEqual(uncovered, [], "every scenario ran in some widget mode");
  } else {
    assert.deepEqual(uncovered, ["activity_feed"], "only the widget-dependent activity feed is skipped");
    console.log("widget-host: skipped activity_feed (needs the workspace widget, which needs dist/ui).");
  }
  console.log(`widget-host: ${covered.size} scenarios passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
