import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const JAVASCRIPT_CHUNK_BUDGET_BYTES = 500 * 1024;
const INITIAL_JAVASCRIPT_BUDGET_BYTES = 500 * 1024;

function isIndivisibleLazyShikiChunk(moduleIds: string[]): boolean {
  return moduleIds.length > 0 && moduleIds.every(
    (id) =>
      id.includes("/node_modules/@shikijs/langs/dist/") ||
      id.endsWith("/node_modules/@shikijs/engine-oniguruma/dist/wasm-inlined.mjs") ||
      id.endsWith("/node_modules/shiki/dist/wasm.mjs"),
  );
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
  if (
    id.includes("/node_modules/@pierre/diffs/") ||
    (id.includes("/node_modules/shiki/dist/") && !id.endsWith("/wasm.mjs")) ||
    id.includes("/node_modules/@shikijs/core/") ||
    id.includes("/node_modules/@shikijs/engine-javascript/") ||
    id.includes("/node_modules/@shikijs/transformers/") ||
    id.includes("/node_modules/@shikijs/types/") ||
    id.includes("/node_modules/@shikijs/vscode-textmate/")
  ) {
    return "pierre-core-vendor";
  }

  return undefined;
}

export default defineConfig({
  root: resolve(__dirname, "src/ui"),
  plugins: [react(), enforceJavaScriptBudgets()],
  base: "./",
  build: {
    // Vite cannot exempt specific chunks from warnings. The 800 kB ceiling
    // accommodates indivisible lazy Shiki grammar/WASM modules; the plugin
    // above still enforces 500 kB per ordinary chunk and initial JS closure.
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
        manualChunks: workspaceAppVendorChunk,
      },
    },
  },
});
