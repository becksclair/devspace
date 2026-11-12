// The sandbox proxy page of the MCP Apps double-iframe architecture.
//
// The host page frames this document from a different origin (its own port). It announces
// `ui/notifications/sandbox-proxy-ready`, receives the widget HTML and its `_meta.ui.csp` in
// `ui/notifications/sandbox-resource-ready`, renders the HTML in an inner `srcdoc` iframe with a
// Content-Security-Policy built from that CSP, and relays every other message in both directions.
//
// The proxy also forwards CSP violations and uncaught errors from the widget document to the
// host as `notifications/message` log entries (logger `widget-host/sandbox`) so they appear in
// the host page's bridge log. The script is plain JavaScript embedded in the page because this
// document is served from the sandbox origin, outside the host page's Vite bundle.

/**
 * Builds the CSP the spec's security section describes for a resource's `_meta.ui.csp`.
 * `allowWasm` adds `'wasm-unsafe-eval'` to script-src; it is a harness opt-in (`?csp=wasm`),
 * not something the spec lets a resource declare.
 */
export function widgetContentSecurityPolicy(csp: {
  resourceDomains?: string[];
  connectDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
} | undefined, allowWasm = false): string {
  const resources = (csp?.resourceDomains ?? []).join(" ");
  const wasm = allowWasm ? "'wasm-unsafe-eval' " : "";
  const connects = (csp?.connectDomains ?? []).join(" ");
  const frames = (csp?.frameDomains ?? []).join(" ") || "'none'";
  const baseUris = (csp?.baseUriDomains ?? []).join(" ") || "'self'";
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${wasm}${resources}`,
    `style-src 'self' 'unsafe-inline' ${resources}`,
    `connect-src 'self' ${connects}`,
    `img-src 'self' data: ${resources}`,
    `font-src 'self' ${resources}`,
    `media-src 'self' data: ${resources}`,
    `frame-src ${frames}`,
    "object-src 'none'",
    `base-uri ${baseUris}`,
  ].map((directive) => directive.trim()).join("; ");
}

/** Sandbox attribute for the inner iframe; matches the reference host's default. */
export const INNER_SANDBOX = "allow-scripts allow-same-origin allow-forms";

export function sandboxProxyHtml(hostOrigin: string): string {
  const config = JSON.stringify({ hostOrigin, innerSandbox: INNER_SANDBOX });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>DevSpace widget host sandbox</title>
<style>html,body{margin:0;padding:0;height:100%;background:transparent;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block;background:transparent}</style>
</head>
<body>
<script>
"use strict";
const CONFIG = ${config};
const ALLOW_WASM = new URLSearchParams(location.search).get("csp") === "wasm";
const buildCsp = ${widgetContentSecurityPolicy.toString().replace(/^function \w+/, "function")};
let inner = null;

function toHost(message) {
  window.parent.postMessage(message, CONFIG.hostOrigin);
}

function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// Runs inside the widget document before its CSP meta tag, so it observes every violation.
const REPORTER = "<script>(" + function () {
  const send = (data) => window.parent.postMessage({ __devspaceHarness: true, data }, "*");
  document.addEventListener("securitypolicyviolation", (event) => send({
    kind: "csp-violation",
    directive: event.effectiveDirective,
    blockedURI: event.blockedURI,
    sourceFile: event.sourceFile,
    line: event.lineNumber,
    sample: event.sample,
  }));
  window.addEventListener("error", (event) => send({ kind: "error", message: String(event.message), source: event.filename, line: event.lineno }));
  window.addEventListener("unhandledrejection", (event) => send({ kind: "unhandledrejection", message: String(event.reason && event.reason.message || event.reason) }));
}.toString() + ")();<\\/script>";

function renderResource(params) {
  const policy = buildCsp(params.csp, ALLOW_WASM);
  const head = REPORTER + '<meta http-equiv="Content-Security-Policy" content="' + escapeAttribute(policy) + '">';
  let html = String(params.html || "");
  const headTag = html.match(/<head[^>]*>/i);
  html = headTag ? html.replace(headTag[0], headTag[0] + head) : head + html;
  if (inner) inner.remove();
  inner = document.createElement("iframe");
  inner.setAttribute("sandbox", typeof params.sandbox === "string" ? params.sandbox : CONFIG.innerSandbox);
  inner.setAttribute("title", "MCP App");
  inner.srcdoc = html;
  document.body.appendChild(inner);
  toHost({ jsonrpc: "2.0", method: "notifications/message", params: { level: "debug", logger: "widget-host/sandbox", data: { kind: "csp-applied", policy } } });
}

// A frame whose color-scheme differs from its embedder's gets an opaque backdrop, so follow the
// theme the host sends (initialize result, host-context-changed) as a real host's proxy page would.
function followTheme(message) {
  const theme = (message && message.result && message.result.hostContext && message.result.hostContext.theme)
    || (message && message.method === "ui/notifications/host-context-changed" && message.params && message.params.theme);
  if (theme === "light" || theme === "dark") document.documentElement.style.colorScheme = theme;
}

window.addEventListener("message", (event) => {
  if (event.source === window.parent) {
    if (event.origin !== CONFIG.hostOrigin) return;
    const message = event.data;
    followTheme(message);
    if (message && typeof message.method === "string" && message.method.startsWith("ui/notifications/sandbox-")) {
      if (message.method === "ui/notifications/sandbox-resource-ready") renderResource(message.params || {});
      return;
    }
    if (inner && inner.contentWindow) inner.contentWindow.postMessage(message, "*");
    return;
  }
  if (inner && event.source === inner.contentWindow) {
    const message = event.data;
    if (message && message.__devspaceHarness === true) {
      const level = message.data && message.data.kind === "csp-violation" ? "warning" : "error";
      toHost({ jsonrpc: "2.0", method: "notifications/message", params: { level, logger: "widget-host/sandbox", data: message.data } });
      return;
    }
    toHost(message);
  }
});

toHost({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} });
</script>
</body>
</html>`;
}
