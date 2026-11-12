// The browser page and the smoke test reach DevSpace the same way: JSON over the harness's /api
// proxy. The proxy holds the bearer token; callers never see it.

import type { RpcOutcome } from "./mcp-http-client.js";
import type { HarnessTransport } from "./scenarios.js";

export function createProxyTransport(apiBase: string): HarnessTransport {
  const base = apiBase.replace(/\/+$/, "");
  async function post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${base}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as { error?: unknown };
    if (!response.ok) {
      throw new Error(`harness /api/${path} failed with HTTP ${response.status}: ${String(json.error ?? "")}`);
    }
    return json;
  }
  return {
    rpc: (method, params = {}) => post("mcp", { method, params }) as Promise<RpcOutcome>,
    async createFixture() {
      const { path } = (await post("fixture", {})) as { path: string };
      return path;
    },
  };
}
