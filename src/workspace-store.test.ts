import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-store-migration-test-"));
try {
  const database = new Database(join(stateDir, "devspace.sqlite"));
  database.exec(`
    create table workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      created_at text not null,
      last_used_at text not null
    );
    insert into workspace_sessions (id, root, status, created_at, last_used_at)
      values ('legacy', '/tmp/legacy', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  database.close();

  const store = new SqliteWorkspaceStore(stateDir);
  const legacy = store.getSession("legacy");
  assert.equal(legacy?.mode, "checkout");
  assert.equal(legacy?.managed, false);
  assert.equal(legacy?.sourceDirty, false);

  const created = store.createSession({
    id: "managed",
    root: "/tmp/managed",
    canonicalRoot: "/tmp/managed",
    rootPolicyId: "managed-isolated",
    mode: "isolated",
    strategy: "clone",
    managedDevice: "42",
    managedInode: "99",
    managed: true,
  });
  assert.equal(created.managedDevice, "42");
  assert.equal(store.getSession("managed")?.managedInode, "99");
  store.close();
} finally {
  await rm(stateDir, { recursive: true, force: true });
}
