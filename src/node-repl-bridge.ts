import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as z from "zod/v4";

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

function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.looseObject({}).passthrough();
  const s = schema as Record<string, unknown>;
  const rawType = s.type as string | string[] | undefined;
  if (Array.isArray(rawType)) {
    const nonNull = (rawType as string[]).filter((t) => t !== "null");
    const nullable = (rawType as string[]).includes("null");
    let base: z.ZodTypeAny;
    if (nonNull.length === 0) base = z.string().nullable();
    else if (nonNull.length === 1) base = jsonSchemaToZod({ ...s, type: nonNull[0] });
    else base = (z as unknown as { union: (opts: z.ZodTypeAny[]) => z.ZodTypeAny }).union(nonNull.map((t) => jsonSchemaToZod({ ...s, type: t })));
    return nullable ? base.nullable().optional() : base;
  }
  if (Array.isArray(s.allOf) && (s.allOf as unknown[]).length > 0) {
    const parts = (s.allOf as unknown[]).map((p) => jsonSchemaToZod(p));
    return parts.reduce((acc, cur) => {
      try { return (acc as unknown as { merge: (o: z.ZodTypeAny) => z.ZodTypeAny }).merge ? (acc as unknown as { merge: (o: z.ZodTypeAny) => z.ZodTypeAny }).merge(cur) : (z as unknown as { intersection: (a: z.ZodTypeAny, b: z.ZodTypeAny) => z.ZodTypeAny }).intersection(acc, cur); } catch { return cur; }
    });
  }
  const type = rawType as string | undefined;
  if (Array.isArray(s.enum)) {
    const vals = s.enum as string[];
    if (vals.length === 0) return z.string();
    if (vals.length === 1) return z.literal(vals[0]);
    return z.enum(vals as [string, ...string[]]);
  }
  switch (type) {
    case "string": {
      let zodStr = z.string();
      if (typeof s.minLength === "number") zodStr = zodStr.min(Math.trunc(s.minLength as number));
      if (typeof s.maxLength === "number") zodStr = zodStr.max(Math.trunc(s.maxLength as number));
      if (typeof s.pattern === "string") { try { zodStr = zodStr.regex(new RegExp(s.pattern as string)); } catch {} }
      if (Array.isArray(s.enum)) {
        const vals = s.enum as string[];
        return vals.length === 1 ? z.literal(vals[0]) : z.enum(vals as [string, ...string[]]);
      }
      if (s.description && typeof s.description === "string") zodStr = zodStr.describe(s.description);
      return zodStr;
    }
    case "number":
    case "integer": {
      let n = z.number();
      if (type === "integer") n = n.int();
      if (typeof s.minimum === "number") n = n.min(s.minimum as number);
      if (typeof s.maximum === "number") n = n.max(s.maximum as number);
      if (Array.isArray(s.enum)) {
        const vals = s.enum as number[];
        if (vals.length === 1) return z.literal(vals[0]);
        return (z as unknown as { union: (opts: z.ZodTypeAny[]) => z.ZodTypeAny }).union(vals.map((v) => z.literal(v)));
      }
      return n;
    }
    case "boolean": return z.boolean();
    case "array": {
      const items = (s.items as unknown) ?? {};
      const inner = jsonSchemaToZod(items);
      let arr = z.array(inner as z.ZodTypeAny);
      if (typeof s.minItems === "number") arr = arr.min(s.minItems as number);
      if (typeof s.maxItems === "number") arr = arr.max(s.maxItems as number);
      return arr;
    }
    case "object": {
      const props = (s.properties as Record<string, unknown>) ?? {};
      const required = Array.isArray(s.required) ? (s.required as string[]) : [];
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, propSchema] of Object.entries(props)) {
        let zodProp = jsonSchemaToZod(propSchema);
        const propDesc = (propSchema as Record<string, unknown>).description;
        if (propDesc && typeof propDesc === "string") zodProp = zodProp.describe(propDesc);
        if (!required.includes(key)) zodProp = zodProp.optional();
        shape[key] = zodProp;
      }
      if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
        const unions = (s.anyOf as unknown[]).map((sub) => jsonSchemaToZod(sub));
        if (Object.keys(shape).length === 0 && unions.length === 1) return unions[0]!;
        if (Object.keys(shape).length === 0) return z.union(unions as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
      }
      if (Array.isArray(s.oneOf) && s.oneOf.length > 0 && Object.keys(shape).length === 0) {
        const unions = (s.oneOf as unknown[]).map((sub) => jsonSchemaToZod(sub));
        return z.union(unions as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
      }
      let obj = z.object(shape);
      if (s.additionalProperties === true || s.additionalProperties === undefined) obj = obj.passthrough();
      else if (s.additionalProperties === false) obj = obj.strip();
      else if (typeof s.additionalProperties === "object") obj = obj.passthrough();
      if (s.description && typeof s.description === "string") obj = obj.describe(s.description);
      return obj;
    }
    default: {
      if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
        const unions = (s.anyOf as unknown[]).map((sub) => jsonSchemaToZod(sub));
        return z.union(unions as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
      }
      if (Array.isArray(s.oneOf) && s.oneOf.length > 0) {
        const unions = (s.oneOf as unknown[]).map((sub) => jsonSchemaToZod(sub));
        return z.union(unions as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
      }
      if (s.properties) return jsonSchemaToZod({ type: "object", properties: s.properties, required: s.required, description: s.description, additionalProperties: s.additionalProperties });
      return z.looseObject({}).passthrough();
    }
  }
}

function normalizeAnnotations(raw: unknown): NodeReplToolDef["annotations"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint", "title"]) {
    if (typeof r[k] === "boolean" || typeof r[k] === "string") out[k] = r[k];
  }
  return Object.keys(out).length ? (out as NodeReplToolDef["annotations"]) : undefined;
}

export function nodeReplBinPath(): string {
  const fromEnv = process.env.DEVSPACE_NODE_REPL_BIN?.trim() || process.env.NODE_REPL_BIN?.trim();
  if (fromEnv) return fromEnv;
  return "/home/bex/.local/share/sky-cua/bin/node_repl";
}

export function nodeReplCwd(): string {
  const fromEnv = process.env.DEVSPACE_NODE_REPL_CWD?.trim();
  if (fromEnv) return fromEnv;
  return "/home/bex/.local/share/sky-cua";
}

export async function createNodeReplBridge(): Promise<NodeReplBridge> {
  const binPath = nodeReplBinPath();
  const cwd = nodeReplCwd();
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
