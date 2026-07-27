import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGatewayWorkspaceStore } from "./gateway-workspace-store.js";

const stateDir = mkdtempSync(join(tmpdir(), "devspace-gateway-store-"));

try {
  const createdAt = "2026-07-27T00:00:00.000Z";
  const first = new SqliteGatewayWorkspaceStore(stateDir);
  first.save({
    publicWorkspaceId: "ws_public",
    machineId: "asgard",
    executorWorkspaceId: "ws_private",
    createdAt,
    lastUsedAt: createdAt,
  });
  first.close();

  const reopened = new SqliteGatewayWorkspaceStore(stateDir);
  assert.deepEqual(reopened.get("ws_public"), {
    publicWorkspaceId: "ws_public",
    machineId: "asgard",
    executorWorkspaceId: "ws_private",
    createdAt,
    lastUsedAt: createdAt,
  });
  reopened.touch("ws_public");
  assert.notEqual(reopened.get("ws_public")?.lastUsedAt, createdAt);
  reopened.ping();
  reopened.close();
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
