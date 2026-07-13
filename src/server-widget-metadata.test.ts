import assert from "node:assert/strict";
import { toolWidgetDescriptorMeta, workspaceAppResourceUri } from "./server.js";

const workspaceAppUri = workspaceAppResourceUri({
  file: "assets/workspace-app-abc123.js",
  css: ["assets/workspace-app-def456.css"],
});
const fullMetadata = toolWidgetDescriptorMeta(
  { widgets: "full" },
  "search",
  workspaceAppUri,
)._meta;

assert.match(workspaceAppUri, /^ui:\/\/devspace\/workspace-app-[a-f0-9]{12}\.html$/);
assert.equal(fullMetadata["openai/outputTemplate"], workspaceAppUri);
assert.equal(fullMetadata.ui?.resourceUri, workspaceAppUri);
assert.deepEqual(fullMetadata.ui?.visibility, ["model"]);

assert.notEqual(
  workspaceAppResourceUri({
    file: "assets/workspace-app-abc123.js",
    css: ["assets/workspace-app-updated.css"],
  }),
  workspaceAppUri,
);
assert.notEqual(
  workspaceAppResourceUri({
    file: "assets/workspace-app-abc123.js",
    css: ["assets/b.css", "assets/a.css"],
  }),
  workspaceAppResourceUri({
    file: "assets/workspace-app-abc123.js",
    css: ["assets/a.css", "assets/b.css"],
  }),
);

assert.deepEqual(toolWidgetDescriptorMeta({ widgets: "off" }, "search"), {
  _meta: {},
});
assert.deepEqual(toolWidgetDescriptorMeta({ widgets: "changes" }, "search", workspaceAppUri), {
  _meta: {},
});
assert.throws(
  () => toolWidgetDescriptorMeta({ widgets: "full" }, "search"),
  /Widget resource URI is required/,
);

const changesMetadata = toolWidgetDescriptorMeta(
  { widgets: "changes" },
  "show_changes",
  workspaceAppUri,
)._meta;

assert.equal(changesMetadata["openai/outputTemplate"], workspaceAppUri);
assert.equal(changesMetadata.ui?.resourceUri, workspaceAppUri);
