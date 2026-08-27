import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as z from "zod/v4";
import type { SkyCuaConfig } from "../config.js";
import { jsonSchemaToZod, normalizeAnnotations } from "../mcp-bridge-utils.js";

export interface SkyToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema: z.ZodTypeAny;
  outputSchema?: z.ZodTypeAny;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string };
}

export interface SkyBridge {
  tools: SkyToolDef[];
  rawTools: Array<{ name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: unknown }>;
  healthy: boolean;
  error?: string;
  close(): Promise<void>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<{ content: unknown[]; structuredContent?: unknown; isError?: boolean }>;
}

export async function createSkyBridge(config: SkyCuaConfig): Promise<SkyBridge> {
  const binPath = config.binPath;
  if (!existsSync(binPath)) {
    return {
      tools: [],
      rawTools: [],
      healthy: false,
      error: `sky-cua binary not found at ${binPath} (projectRoot ${config.projectRoot})`,
      async close() {},
      async callTool() {
        return { content: [{ type: "text", text: `sky-cua binary not found at ${binPath}` }], isError: true };
      },
    };
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (k === "DEVSPACE_OAUTH_OWNER_TOKEN" || k === "GH_TOKEN" || k === "GITHUB_TOKEN" || k.endsWith("_NODE_TOKEN")) continue;
    env[k] = v;
  }
  // System services (devspace.service User=ubuntu) don't inherit XDG_RUNTIME_DIR, so sky-cua falls back to /run/saga-brave-origin and times out 24s.
  // Ensure a sane default so initialize is <1s even when the parent has no XDG_RUNTIME_DIR.
  if (!env.XDG_RUNTIME_DIR) {
    try {
      const uid = typeof (process as unknown as { getuid?: () => number }).getuid === "function" ? (process as unknown as { getuid: () => number }).getuid() : 1000;
      env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
    } catch {
      env.XDG_RUNTIME_DIR = "/run/user/1000";
    }
  }
  if (!env.SKY_CUA_SERVICE_SOCKET_PATH) {
    env.SKY_CUA_SERVICE_SOCKET_PATH = `${env.XDG_RUNTIME_DIR}/sky-cua/service.sock`;
  }

  const transport = new StdioClientTransport({
    command: binPath,
    args: ["mcp"],
    env,
    stderr: "inherit",
  } as never);

  const client = new Client({ name: "devspace-sky-cua-bridge", version: "1.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
  } catch (e) {
    return {
      tools: [],
      rawTools: [],
      healthy: false,
      error: `failed to connect to sky-cua mcp: ${e instanceof Error ? e.message : String(e)}`,
      async close() { try { await client.close(); } catch {} },
      async callTool() {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `sky-cua mcp connect failed: ${msg}` }], isError: true };
      },
    };
  }

  let rawTools: Array<{ name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: unknown }> = [];
  try {
    const res = await client.listTools();
    rawTools = (res.tools ?? []) as typeof rawTools;
  } catch (e) {
    await client.close().catch(() => undefined);
    return {
      tools: [],
      rawTools: [],
      healthy: false,
      error: `sky-cua listTools failed: ${e instanceof Error ? e.message : String(e)}`,
      async close() {},
      async callTool() {
        return { content: [{ type: "text", text: `sky-cua unavailable` }], isError: true };
      },
    };
  }

  const tools: SkyToolDef[] = rawTools.map((t) => {
    const inputSchema = t.inputSchema ? jsonSchemaToZod(t.inputSchema) : z.looseObject({}).passthrough();
    const outputSchema = t.outputSchema ? jsonSchemaToZod(t.outputSchema) : undefined;
    return {
      name: t.name,
      title: (t as { title?: string }).title,
      description: t.description,
      inputSchema: inputSchema as z.ZodTypeAny,
      outputSchema: outputSchema as z.ZodTypeAny | undefined,
      annotations: normalizeAnnotations(t.annotations),
    };
  });

  return {
    tools,
    rawTools,
    healthy: true,
    async close() { try { await client.close(); } catch {} },
    async callTool(name, args, signal) {
      try {
        const res = await client.callTool({ name, arguments: args as Record<string, unknown> } as never, undefined, { signal } as never);
        // normalize SDK result shape
        const content = (res as { content?: unknown[] }).content ?? [];
        const structuredContent = (res as { structuredContent?: unknown }).structuredContent;
        const isError = (res as { isError?: boolean }).isError;
        return { content: content as unknown[], structuredContent, isError };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // surface SKY_CUA error codes transparently
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  };
}
