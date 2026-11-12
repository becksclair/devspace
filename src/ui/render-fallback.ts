import {
  isEditTool,
  isReviewTool,
  isWriteTool,
  payloadText,
  type ToolResultCard,
} from "./card-types.js";

/**
 * The highlighter every code and diff renderer selects. MCP hosts frame the widget under a CSP
 * without 'wasm-unsafe-eval', so only Shiki's JavaScript regex engine can run there; the
 * WebAssembly highlighters are stubbed out of the bundle by `vite.config.ts`.
 */
export const PREFERRED_HIGHLIGHTER = "shiki-js" as const;

/** The unhighlighted text shown when the code or diff renderer cannot run. */
export function plainRenderText(card: ToolResultCard): string {
  if (isReviewTool(card.tool) || isEditTool(card.tool) || isWriteTool(card.tool)) {
    return card.payload?.patch || card.payload?.diff || payloadText(card.payload);
  }
  return payloadText(card.payload);
}

/** A short, user-facing description of a renderer failure. */
export function renderFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const trimmed = detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
  return `Highlighted view unavailable; showing plain text. ${trimmed}`.trim();
}

/**
 * Splits a multi-file Git patch into one section per file, in order, so a single file's diff can
 * be shown as plain text. A patch without `diff --git` headers is returned whole.
 */
export function splitPatchByFile(patch: string): string[] {
  const lines = patch.split("\n");
  const sections: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") || sections.length === 0) sections.push([]);
    sections[sections.length - 1]!.push(line);
  }
  if (sections.length > 0 && !sections[0]![0]?.startsWith("diff --git ")) {
    const preamble = sections.shift()!;
    if (sections.length === 0) return [preamble.join("\n")];
  }
  return sections.map((section) => section.join("\n").replace(/\n+$/, ""));
}
