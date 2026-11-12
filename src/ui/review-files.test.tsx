import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { isBinaryPatchSection, reviewFileDisplay, reviewFileKindLabel } from "./review-files.js";
import ReviewPayload from "./review-payload.js";

assert.equal(isBinaryPatchSection("diff --git a/x.png b/x.png\nindex 1..2 100644\nGIT binary patch\nliteral 4"), true);
assert.equal(isBinaryPatchSection("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ"), true);
assert.equal(isBinaryPatchSection("diff --git a/x b/x\n@@ -1 +1 @@\n-GIT binary patch\n+y"), false);
assert.equal(isBinaryPatchSection(undefined), false);

const file = (type: string, hunkCount = 1, prevName?: string) => ({ type, name: "b.ts", prevName, hunkCount });
assert.deepEqual(reviewFileDisplay(file("new"), ""), { kind: "added", binary: false, previousPath: undefined, showStats: true, expandable: true });
assert.deepEqual(reviewFileDisplay(file("deleted"), ""), { kind: "deleted", binary: false, previousPath: undefined, showStats: true, expandable: true });
assert.deepEqual(reviewFileDisplay(file("change"), ""), { kind: "modified", binary: false, previousPath: undefined, showStats: true, expandable: true });
assert.deepEqual(reviewFileDisplay(file("rename-pure", 0, "a.ts"), ""), { kind: "renamed", binary: false, previousPath: "a.ts", showStats: false, expandable: false });
assert.deepEqual(reviewFileDisplay(file("rename-changed", 1, "a.ts"), ""), { kind: "renamed", binary: false, previousPath: "a.ts", showStats: true, expandable: true });

// Binary changes keep their change type; "binary" is an extra marker, not the type.
const binarySection = "Binary files a/b.ts and b/b.ts differ";
assert.deepEqual(reviewFileDisplay(file("change", 0), "GIT binary patch"), { kind: "modified", binary: true, previousPath: undefined, showStats: false, expandable: false });
assert.deepEqual(reviewFileDisplay(file("new", 0), binarySection), { kind: "added", binary: true, previousPath: undefined, showStats: false, expandable: false });
assert.deepEqual(reviewFileDisplay(file("deleted", 0), binarySection), { kind: "deleted", binary: true, previousPath: undefined, showStats: false, expandable: false });
assert.deepEqual(reviewFileDisplay(file("rename-changed", 0, "a.ts"), binarySection), { kind: "renamed", binary: true, previousPath: "a.ts", showStats: false, expandable: false });
assert.equal(reviewFileKindLabel({ kind: "deleted", binary: true }), "deleted · binary");
assert.equal(reviewFileKindLabel({ kind: "deleted", binary: false }), "deleted");

// The review list as rendered from a patch with every change type.
const patch = [
  "diff --git a/assets/new.png b/assets/new.png",
  "new file mode 100644",
  "index 0000000..af7aff9",
  "Binary files /dev/null and b/assets/new.png differ",
  "diff --git a/assets/old.png b/assets/old.png",
  "deleted file mode 100644",
  "index 08cd6f2..0000000",
  "Binary files a/assets/old.png and /dev/null differ",
  "diff --git a/assets/a.bin b/assets/b.bin",
  "similarity index 90%",
  "rename from assets/a.bin",
  "rename to assets/b.bin",
  "index 1111111..2222222 100644",
  "Binary files a/assets/a.bin and b/assets/b.bin differ",
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
assert.equal(headers.length, 8, html);
const summary = headers.map((header) => header
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim());
assert.deepEqual(summary, [
  "assets/new.png added · binary",
  "assets/old.png deleted · binary",
  "assets/a.bin → assets/b.bin renamed · binary",
  "assets/logo.png modified · binary",
  "docs/notes.txt deleted +0 -2",
  "src/legacy-name.ts → src/display-name.ts renamed",
  "src/feature-flags.ts added +2 -0",
  "src/greeting.ts modified +1 -1",
]);
for (const binaryHeader of headers.slice(0, 4)) {
  assert.match(binaryHeader, /disabled=""/);
  assert.equal(binaryHeader.includes("aria-expanded"), false);
}
assert.match(headers[0]!, /class="review-diff-file-kind added"/);
assert.match(headers[1]!, /class="review-diff-file-kind deleted"/);
assert.match(headers[2]!, /class="review-diff-file-kind renamed"/);
assert.match(headers[3]!, /class="review-diff-file-kind modified"/);
assert.match(headers[5]!, /disabled=""/);
assert.match(headers[7]!, /aria-expanded="false"/);
assert.equal(headers[7]!.includes("disabled"), false);

console.log("review-files tests passed");
