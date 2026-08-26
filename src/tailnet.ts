function stripBrackets(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1);
  return trimmed;
}

function isCgnatIpv4(host: string): boolean {
  // CGNAT 100.64.0.0/10 = 100.64.0.0 – 100.127.255.255
  const m = host.match(/^100\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const second = Number(m[1]);
  return Number.isInteger(second) && second >= 64 && second <= 127;
}

function isTailscaleUla(host: string): boolean {
  // This tailnet's ULA is fd7a:115c:a1e0::/48. Check that prefix, not any fd7a::/7.
  return host.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

export function isTailnetHost(rawHost: string): boolean {
  const host = stripBrackets(rawHost).toLowerCase();
  if (!host) return false;
  if (host.endsWith(".ts.net")) return true;
  if (isCgnatIpv4(host)) return true;
  if (isTailscaleUla(host)) return true;
  return false;
}

export function isTailnetUrl(url: URL): boolean {
  return isTailnetHost(url.hostname);
}
