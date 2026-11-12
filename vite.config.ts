import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const JAVASCRIPT_CHUNK_BUDGET_BYTES = 500 * 1024;
const INITIAL_JAVASCRIPT_BUDGET_BYTES = 500 * 1024;

function isIndivisibleLazyShikiChunk(moduleIds: string[]): boolean {
  return moduleIds.length > 0 && moduleIds.every(
    (id) => id.includes("/node_modules/@shikijs/langs/dist/"),
  );
}

const WASM_HIGHLIGHTER_STUB_PREFIX = "\0devspace-wasm-highlighter-stub:";
const WASM_HIGHLIGHTER_UNAVAILABLE =
  "This WebAssembly highlighter is not bundled: MCP hosts' widget CSP does not allow " +
  "WebAssembly compilation, so the widget uses the shiki-js highlighter.";

/**
 * Replaces the WebAssembly highlighters that @pierre/diffs can load (the Highlights backend and
 * Shiki's Oniguruma engine) with stubs that throw when used. MCP hosts frame the widget under a
 * CSP without 'wasm-unsafe-eval', so those backends cannot run, and @pierre/highlights compiles
 * its module as soon as it is evaluated. The widget selects `preferredHighlighter: "shiki-js"`
 * explicitly; the stubs keep the unreachable WebAssembly out of the bundle.
 */
function excludeWasmHighlighters(): Plugin {
  const stubs: Record<string, string> = {
    "@pierre/highlights": [
      `const message = ${JSON.stringify(WASM_HIGHLIGHTER_UNAVAILABLE)};`,
      "export class LiveTokenizer { constructor() { throw new Error(message); } }",
      "export function codeToTokens() { throw new Error(message); }",
      "export function isSupportedLanguage() { return false; }",
    ].join("\n"),
    "@pierre/highlights/themes/loader": "export const themes = {};",
    "shiki/engine/oniguruma": [
      `export function createOnigurumaEngine() { throw new Error(${JSON.stringify(WASM_HIGHLIGHTER_UNAVAILABLE)}); }`,
    ].join("\n"),
    "shiki/wasm": `export default function loadWasm() { throw new Error(${JSON.stringify(WASM_HIGHLIGHTER_UNAVAILABLE)}); }`,
  };
  return {
    name: "devspace-exclude-wasm-highlighters",
    enforce: "pre",
    resolveId(source) {
      return source in stubs ? `${WASM_HIGHLIGHTER_STUB_PREFIX}${source}` : undefined;
    },
    load(id) {
      if (!id.startsWith(WASM_HIGHLIGHTER_STUB_PREFIX)) return undefined;
      return stubs[id.slice(WASM_HIGHLIGHTER_STUB_PREFIX.length)];
    },
  };
}

function enforceJavaScriptBudgets(): Plugin {
  return {
    name: "devspace-javascript-budgets",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;

        const chunkBytes = Buffer.byteLength(output.code);
        if (
          chunkBytes > JAVASCRIPT_CHUNK_BUDGET_BYTES &&
          !isIndivisibleLazyShikiChunk(output.moduleIds)
        ) {
          this.error(
            `JavaScript chunk ${output.fileName} is ${Math.ceil(chunkBytes / 1024)} kB; ` +
              `the budget is ${JAVASCRIPT_CHUNK_BUDGET_BYTES / 1024} kB.`,
          );
        }

        if (!output.isEntry) continue;

        const initialChunks = new Set<string>();
        const visit = (fileName: string): void => {
          const output = bundle[fileName];
          if (!output || output.type !== "chunk" || initialChunks.has(fileName)) return;
          initialChunks.add(fileName);
          output.imports.forEach(visit);
        };
        visit(output.fileName);

        const initialBytes = Array.from(initialChunks).reduce((total, fileName) => {
          const output = bundle[fileName];
          return output?.type === "chunk"
            ? total + Buffer.byteLength(output.code)
            : total;
        }, 0);

        if (initialBytes > INITIAL_JAVASCRIPT_BUDGET_BYTES) {
          this.error(
            `Initial JavaScript for ${output.fileName} is ${Math.ceil(initialBytes / 1024)} kB; ` +
              `the budget is ${INITIAL_JAVASCRIPT_BUDGET_BYTES / 1024} kB.`,
          );
        }
      }
    },
  };
}

function isShikiRuntimeModule(id: string): boolean {
  return (
    id.includes("/node_modules/shiki/dist/") ||
    id.includes("/node_modules/@shikijs/core/") ||
    id.includes("/node_modules/@shikijs/engine-javascript/") ||
    id.includes("/node_modules/@shikijs/types/") ||
    id.includes("/node_modules/@shikijs/vscode-textmate/")
  );
}

function workspaceAppVendorChunk(id: string): string | undefined {
  if (!id.includes("/node_modules/")) return undefined;

  if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(id)) {
    return "react-vendor";
  }
  if (id.includes("/node_modules/@modelcontextprotocol/ext-apps/")) {
    return "mcp-app-vendor";
  }
  if (id.includes("/node_modules/@pierre/diffs/dist/react/")) {
    return "pierre-react-vendor";
  }
  if (id.includes("/node_modules/diff/")) {
    return "diff-vendor";
  }
  if (id.includes("/node_modules/@pierre/diffs/")) {
    return "pierre-core-vendor";
  }

  return undefined;
}

export default defineConfig({
  root: resolve(__dirname, "src/ui"),
  plugins: [excludeWasmHighlighters(), react(), enforceJavaScriptBudgets()],
  base: "./",
  build: {
    // Vite cannot exempt specific chunks from warnings. The 800 kB ceiling
    // accommodates indivisible lazy Shiki grammar modules; the plugin above
    // still enforces 500 kB per ordinary chunk and initial JS closure.
    chunkSizeWarningLimit: 800,
    outDir: resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: resolve(__dirname, "src/ui/workspace-app.html"),
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
        codeSplitting: {
          groups: [
            // Each group captures its modules' static dependencies, so the
            // @pierre/diffs group would absorb the Shiki runtime. A
            // higher-priority group claims it first so pierre-core-vendor stays
            // within the chunk budget. The preload helper is claimed before
            // Shiki so the entry does not statically import shiki-vendor
            // through it.
            {
              name: "vite-preload-helper",
              test: (id) => id.includes("vite/preload-helper"),
              priority: 2,
            },
            { name: "shiki-vendor", test: isShikiRuntimeModule, priority: 1 },
            { name: workspaceAppVendorChunk },
          ],
        },
      },
    },
  },
});
