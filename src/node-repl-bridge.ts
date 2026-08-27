import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as z from "zod/v4";
import { jsonSchemaToZod, normalizeAnnotations } from "./mcp-bridge-utils.js";
import { expandHomePath } from "./roots.js";

export interface NodeReplToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema: z.ZodTypeAny;
  outputSchema?: z.ZodTypeAny;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string };
}

export interface NodeReplBridge {
  tools: NodeReplToolDef[];
  rawTools: Array<{ name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: unknown }>;
  healthy: boolean;
  error?: string;
  close(): Promise<void>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<{ content: unknown[]; structuredContent?: unknown; isError?: boolean }>;
}

export function nodeReplBinPath(): string {
  const fromEnv = process.env.DEVSPACE_NODE_REPL_BIN?.trim() || process.env.NODE_REPL_BIN?.trim();
  if (fromEnv) return resolve(expandHomePath(fromEnv));
  const shared = resolve(expandHomePath("~/.local/share/sky-cua/bin/node_repl"));
  if (existsSync(shared)) return shared;
  return join(resolve(expandHomePath("~/projects/sky-cua")), "bin/node_repl");
}

export function nodeReplCwd(): string {
  const fromEnv = process.env.DEVSPACE_NODE_REPL_CWD?.trim();
  if (fromEnv) return resolve(expandHomePath(fromEnv));
  return resolve(expandHomePath("~/.local/share/sky-cua"));
}

export async function createNodeReplBridge(config?: { nodeRepl?: { binPath: string; cwd: string } }): Promise<NodeReplBridge> {
  const binPath = config?.nodeRepl?.binPath ?? nodeReplBinPath();
  const cwd = config?.nodeRepl?.cwd ?? nodeReplCwd();
  if (!existsSync(binPath)) {
    return {
      tools: [], rawTools: [], healthy: false, error: `node_repl binary not found at ${binPath}`,
      async close() {},
      async callTool() { return { content: [{ type: "text", text: `node_repl binary not found at ${binPath}` }], isError: true }; },
    };
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (k === "DEVSPACE_OAUTH_OWNER_TOKEN" || k === "GH_TOKEN" || k === "GITHUB_TOKEN" || k.endsWith("_NODE_TOKEN")) continue;
    env[k] = v;
  }
  const transport = new StdioClientTransport({ command: binPath, args: [], cwd, env, stderr: "inherit" } as never);
  const client = new Client({ name: "devspace-node-repl-bridge", version: "1.0.0" }, { capabilities: {} });
  try { await client.connect(transport); } catch (e) {
    return {
      tools: [], rawTools: [], healthy: false, error: `failed to connect to node_repl mcp: ${e instanceof Error ? e.message : String(e)}`,
      async close() { try { await client.close(); } catch {} },
      async callTool() { const msg = e instanceof Error ? e.message : String(e); return { content: [{ type: "text", text: `node_repl mcp connect failed: ${msg}` }], isError: true }; },
    };
  }
  let rawTools: Array<{ name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: unknown }> = [];
  try { const res = await client.listTools(); rawTools = (res.tools ?? []) as typeof rawTools; } catch (e) {
    await client.close().catch(() => undefined);
    return { tools: [], rawTools: [], healthy: false, error: `node_repl listTools failed: ${e instanceof Error ? e.message : String(e)}`, async close() {}, async callTool() { return { content: [{ type: "text", text: `node_repl unavailable` }], isError: true }; } };
  }
  const tools: NodeReplToolDef[] = rawTools.map((t) => {
    const inputSchema = t.inputSchema ? jsonSchemaToZod(t.inputSchema) : z.looseObject({}).passthrough();
    const outputSchema = t.outputSchema ? jsonSchemaToZod(t.outputSchema) : undefined;
    return { name: t.name, title: (t as { title?: string }).title, description: t.description, inputSchema: inputSchema as z.ZodTypeAny, outputSchema: outputSchema as z.ZodTypeAny | undefined, annotations: normalizeAnnotations(t.annotations) };
  });
  return {
    tools, rawTools, healthy: true,
    async close() { try { await client.close(); } catch {} },
    async callTool(name, args, signal) {
      try {
        const res = await client.callTool({ name, arguments: args as Record<string, unknown> } as never, undefined, { signal } as never);
        const content = (res as { content?: unknown[] }).content ?? [];
        const structuredContent = (res as { structuredContent?: unknown }).structuredContent;
        const isError = (res as { isError?: boolean }).isError;
        return { content: content as unknown[], structuredContent, isError };
      } catch (e) { return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true }; }
    },
  };
}
