import assert from "node:assert/strict";
import { mcpRequestTraceFields } from "./server.js";

assert.deepEqual(
  mcpRequestTraceFields({
    jsonrpc: "2.0",
    id: 7,
    method: "resources/read",
    params: {
      uri: "ui://devspace/workspace-app-old.html?token=secret#fragment",
    },
  }),
  {
    rpcType: "request",
    rpcMethod: "resources/read",
    rpcId: 7,
    resourceUri: "ui://devspace/workspace-app-old.html",
    toolName: undefined,
    promptName: undefined,
    requestedLogLevel: undefined,
    relatedRpcId: undefined,
  },
);

assert.equal(
  mcpRequestTraceFields({
    jsonrpc: "2.0",
    id: 8,
    method: "resources/read",
    params: { uri: "ui://user:must-not-be-logged@[" },
  }).resourceUri,
  "<invalid-uri>",
);

const toolTrace = mcpRequestTraceFields({
  jsonrpc: "2.0",
  id: "tool-request",
  method: "tools/call",
  params: {
    name: "write",
    arguments: {
      path: "secret/path.txt",
      content: "must not be logged",
    },
  },
});

assert.equal(toolTrace.rpcMethod, "tools/call");
assert.equal(toolTrace.toolName, "write");
assert.doesNotMatch(JSON.stringify(toolTrace), /secret|content|arguments/);

assert.deepEqual(
  mcpRequestTraceFields({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: "original-request", reason: "private detail" },
  }),
  {
    rpcType: "notification",
    rpcMethod: "notifications/cancelled",
    rpcId: undefined,
    resourceUri: undefined,
    toolName: undefined,
    promptName: undefined,
    requestedLogLevel: undefined,
    relatedRpcId: "original-request",
  },
);

assert.deepEqual(
  mcpRequestTraceFields([
    { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://one/app.html" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read", arguments: { path: "private" } } },
    { jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: "summarize" } },
    { jsonrpc: "2.0", id: 4, method: "logging/setLevel", params: { level: "debug" } },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } },
  ]),
  {
    rpcType: "batch",
    rpcBatchSize: 5,
    rpcMessages: [
      {
        rpcType: "request",
        rpcMethod: "resources/read",
        rpcId: 1,
        resourceUri: "ui://one/app.html",
      },
      {
        rpcType: "request",
        rpcMethod: "tools/call",
        rpcId: 2,
        toolName: "read",
      },
      {
        rpcType: "request",
        rpcMethod: "prompts/get",
        rpcId: 3,
        promptName: "summarize",
      },
      {
        rpcType: "request",
        rpcMethod: "logging/setLevel",
        rpcId: 4,
        requestedLogLevel: "debug",
      },
      {
        rpcType: "notification",
        rpcMethod: "notifications/cancelled",
        relatedRpcId: 2,
      },
    ],
  },
);

assert.deepEqual(mcpRequestTraceFields(undefined, "GET"), {
  rpcType: "transport",
  transportMethod: "GET",
});

assert.deepEqual(mcpRequestTraceFields(undefined, "delete"), {
  rpcType: "transport",
  transportMethod: "DELETE",
});

assert.deepEqual(mcpRequestTraceFields(null), {
  rpcType: "invalid",
  rpcBodyType: "null",
});
