import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { isBinaryPatchSection, reviewFileDisplay } from "./review-files.js";
import ReviewPayload from "./review-payload.js";

assert.equal(isBinaryPatchSection("diff --git a/x.png b/x.png\nindex 1..2 100644\nGIT binary patch\nliteral 4"), true);
assert.equal(isBinaryPatchSection("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ"), true);
assert.equal(isBinaryPatchSection("diff --git a/x b/x\n@@ -1 +1 @@\n-GIT binary patch\n+y"), false);
assert.equal(isBinaryPatchSection(undefined), false);

const file = (type: string, hunkCount = 1, prevName?: string) => ({ type, name: "b.ts", prevName, hunkCount });
assert.deepEqual(reviewFileDisplay(file("new"), ""), { kind: "added", previousPath: undefined, showStats: true, expandable: true });
assert.deepEqual(reviewFileDisplay(file("deleted"), ""), { kind: "deleted", previousPath: undefined, showStats: true, expandable: true });
assert.deepEqual(reviewFileDisplay(file("change"), ""), { kind: "modified", previousPath: undefined, showStats: true, expandable: true });
assert.deepEqual(reviewFileDisplay(file("rename-pure", 0, "a.ts"), ""), { kind: "renamed", previousPath: "a.ts", showStats: false, expandable: false });
assert.deepEqual(reviewFileDisplay(file("rename-changed", 1, "a.ts"), ""), { kind: "renamed", previousPath: "a.ts", showStats: true, expandable: true });
assert.deepEqual(reviewFileDisplay(file("change", 0), "GIT binary patch"), { kind: "binary", previousPath: undefined, showStats: false, expandable: false });

// The review list as rendered from a patch with every change type.
const patch = [
  "diff --git a/assets/logo.png b/assets/logo.png",
  "index 08cd6f2..af7aff9 100644",
  "GIT binary patch",
  "literal 4",
  "LcmZQzWMT#Y01f~L",
  "",
  "literal 0",
  "HcmV?d00001",
  "",
  "diff --git a/docs/notes.txt b/docs/notes.txt",
  "deleted file mode 100644",
  "index d8ffe30..0000000",
  "--- a/docs/notes.txt",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-one",
  "-two",
  "diff --git a/src/legacy-name.ts b/src/display-name.ts",
  "similarity index 100%",
  "rename from src/legacy-name.ts",
  "rename to src/display-name.ts",
  "diff --git a/src/feature-flags.ts b/src/feature-flags.ts",
  "new file mode 100644",
  "index 0000000..eeaea97",
  "--- /dev/null",
  "+++ b/src/feature-flags.ts",
  "@@ -0,0 +1,2 @@",
  "+export const a = 1;",
  "+export const b = 2;",
  "diff --git a/src/greeting.ts b/src/greeting.ts",
  "index 06545a3..60cca7c 100644",
  "--- a/src/greeting.ts",
  "+++ b/src/greeting.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "",
].join("\n");
const html = renderToStaticMarkup(
  <ReviewPayload card={{ tool: "show_changes", payload: { patch } }} themeType="light" />,
);
const headers = html.match(/<button[^>]*class="review-diff-file-header"[^>]*>.*?<\/button>/g) ?? [];
assert.equal(headers.length, 5, html);
const summary = headers.map((header) => header
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim());
assert.deepEqual(summary, [
  "assets/logo.png binary",
  "docs/notes.txt deleted +0 -2",
  "src/legacy-name.ts → src/display-name.ts renamed",
  "src/feature-flags.ts added +2 -0",
  "src/greeting.ts modified +1 -1",
]);
assert.match(headers[0]!, /disabled=""/);
assert.equal(headers[0]!.includes("aria-expanded"), false);
assert.match(headers[2]!, /disabled=""/);
assert.match(headers[4]!, /aria-expanded="false"/);
assert.equal(headers[4]!.includes("disabled"), false);

console.log("review-files tests passed");
