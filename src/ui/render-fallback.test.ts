import assert from "node:assert/strict";
import {
  PREFERRED_HIGHLIGHTER,
  plainRenderText,
  renderFailureMessage,
  splitPatchByFile,
} from "./render-fallback.js";

// The hosts' CSP has no 'wasm-unsafe-eval'; only Shiki's JavaScript engine can run.
assert.equal(PREFERRED_HIGHLIGHTER, "shiki-js");

// Diff cards fall back to their patch, read cards to their text content.
assert.equal(
  plainRenderText({ tool: "edit_file", payload: { patch: "--- a\n+++ b\n", content: [{ type: "text", text: "Edited" }] } }),
  "--- a\n+++ b\n",
);
assert.equal(plainRenderText({ tool: "write", payload: { diff: "+x" } }), "+x");
assert.equal(plainRenderText({ tool: "show_changes", payload: { patch: "diff --git a/x b/x" } }), "diff --git a/x b/x");
assert.equal(plainRenderText({ tool: "read_file", payload: { content: [{ type: "text", text: "line 1\nline 2" }] } }), "line 1\nline 2");
assert.equal(plainRenderText({ tool: "read_file" }), "");

assert.equal(
  renderFailureMessage(new Error("Compiling WebAssembly is blocked")),
  "Highlighted view unavailable; showing plain text. Compiling WebAssembly is blocked",
);
assert.ok(renderFailureMessage("x".repeat(500)).endsWith("…"));

const patch = [
  "diff --git a/one.ts b/one.ts",
  "index 1..2 100644",
  "--- a/one.ts",
  "+++ b/one.ts",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "diff --git a/old.ts b/new.ts",
  "similarity index 100%",
  "rename from old.ts",
  "rename to new.ts",
  "",
].join("\n");
assert.deepEqual(splitPatchByFile(patch), [
  "diff --git a/one.ts b/one.ts\nindex 1..2 100644\n--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-a\n+b",
  "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts",
]);
assert.deepEqual(splitPatchByFile("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b"), ["--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b"]);

console.log("render-fallback tests passed");
