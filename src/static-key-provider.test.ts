import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaticKeyStore, StaticKeyVerifier, mintApiKey, DEFAULT_KEY_TTL_SECONDS } from "./static-key-provider.js";
import { openDatabase } from "./db/client.js";

const TEST_RESOURCE = "https://devspace.example.com/mcp";

async function withIsolatedStore<T>(fn: (store: StaticKeyStore) => T | Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-static-key-test-"));
  const store = new StaticKeyStore(stateDir);
  try {
    return await fn(store);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

// --- Minting ---

// Test 1: minting defaults
await withIsolatedStore(async (store) => {
  const result = store.mint(TEST_RESOURCE, "vault-owner", { scopes: ["devspace"] });
  assert.ok(result.rawKey.startsWith("obsk_"), "raw key starts with obsk_ prefix");
  assert.equal(result.scopes.length, 1);
  assert.equal(result.scopes[0], "devspace");
  assert.ok(result.expiresAt > result.createdAt, "expires_at > created_at");
  assert.equal(result.expiresAt - result.createdAt, DEFAULT_KEY_TTL_SECONDS);
  assert.equal(result.resource, TEST_RESOURCE);
});

// Test 2: custom scopes and TTL
await withIsolatedStore(async (store) => {
  const result = store.mint(TEST_RESOURCE, "vault-owner", {
    scopes: ["devspace", "admin"],
    ttlSeconds: 3600,
  });
  assert.deepEqual(result.scopes, ["devspace", "admin"]);
  assert.equal(result.expiresAt - result.createdAt, 3600);
});

// Test 3: invalid scope rejection
await withIsolatedStore(async (store) => {
  const supported = ["devspace"];
  await assert.rejects(
    () => mintApiKey(store, TEST_RESOURCE, { scopes: ["invalid-scope"] }, supported),
    /Invalid scope/,
  );
});

// Test 4: duplicate ID rejection
await withIsolatedStore(async (store) => {
  store.mint(TEST_RESOURCE, "vault-owner", { scopes: ["devspace"], keyId: "obsk_custom" });
  assert.throws(
    () => store.mint(TEST_RESOURCE, "vault-owner", { scopes: ["devspace"], keyId: "obsk_custom" }),
    /UNIQUE constraint/,
  );
});

// --- Verification ---

// Test 5: valid key returns correct AuthInfo
await withIsolatedStore(async (store) => {
  const minted = store.mint(TEST_RESOURCE, "vault-owner", { scopes: ["devspace"] });
  const verifier = new StaticKeyVerifier(store, TEST_RESOURCE);
  const authInfo = await verifier.verifyAccessToken(minted.rawKey);
  assert.equal(authInfo.clientId, `static-key:${minted.keyId}`);
  assert.deepEqual(authInfo.scopes, ["devspace"]);
  assert.equal(authInfo.expiresAt, minted.expiresAt);
  assert.equal(authInfo.resource?.href, TEST_RESOURCE);
  assert.equal(authInfo.extra?.subject, "vault-owner");
  assert.equal(authInfo.extra?.authMethod, "static-key");
});

// Test 6: rejects unknown key
await withIsolatedStore(async (store) => {
  const verifier = new StaticKeyVerifier(store, TEST_RESOURCE);
  await assert.rejects(
    () => verifier.verifyAccessToken("obsk_nonexistent"),
    /Invalid or expired static API key/,
  );
});

// Test 7: rejects expired key
{
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-static-key-expiry-"));
  const store = new StaticKeyStore(stateDir);
  const minted = store.mint(TEST_RESOURCE, "vault-owner", { scopes: ["devspace"], keyId: "obsk_expiry" });
  // Backdate expires_at to 1 (epoch second 1 = expired)
  const dbHandle = openDatabase(stateDir);
  dbHandle.sqlite.prepare("update api_keys set expires_at = 1 where key_id = ?").run("obsk_expiry");
  dbHandle.close();
  store.close();
  // Reopen store to read the backdated record
  const reopened = new StaticKeyStore(stateDir);
  const verifier = new StaticKeyVerifier(reopened, TEST_RESOURCE);
  await assert.rejects(
    () => verifier.verifyAccessToken(minted.rawKey),
    /expired/,
  );
  reopened.close();
  await rm(stateDir, { recursive: true, force: true });
}

// Test 8: rejects wrong resource
await withIsolatedStore(async (store) => {
  const minted = store.mint("https://other.example.com/mcp", "vault-owner", { scopes: ["devspace"] });
  const verifier = new StaticKeyVerifier(store, TEST_RESOURCE);
  await assert.rejects(
    () => verifier.verifyAccessToken(minted.rawKey),
    /not valid for this resource/,
  );
});

// Test 9: rejects revoked key
await withIsolatedStore(async (store) => {
  const minted = store.mint(TEST_RESOURCE, "vault-owner", { scopes: ["devspace"] });
  store.deleteById(minted.keyId);
  const verifier = new StaticKeyVerifier(store, TEST_RESOURCE);
  await assert.rejects(
    () => verifier.verifyAccessToken(minted.rawKey),
    /Invalid or expired static API key/,
  );
});

// --- Store ---

// Test 10: listAll
await withIsolatedStore(async (store) => {
  assert.deepEqual(store.listAll(), []);
  store.mint(TEST_RESOURCE, "vault-owner", { scopes: ["devspace"], keyId: "obsk_a" });
  store.mint(TEST_RESOURCE, "vault-owner", { scopes: ["devspace"], keyId: "obsk_b" });
  const keys = store.listAll();
  assert.equal(keys.length, 2);
  assert.equal(keys[0].keyId, "obsk_a");
  assert.equal(keys[1].keyId, "obsk_b");
});

// Test 11: cleanupExpired
{
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-static-key-cleanup-"));
  const store = new StaticKeyStore(stateDir);
  store.mint(TEST_RESOURCE, "vault-owner", { scopes: ["devspace"], keyId: "obsk_active" });
  store.mint(TEST_RESOURCE, "vault-owner", { scopes: ["devspace"], keyId: "obsk_expired" });
  // Backdate the expired key's expires_at
  const dbHandle = openDatabase(stateDir);
  dbHandle.sqlite.prepare("update api_keys set expires_at = 1 where key_id = ?").run("obsk_expired");
  dbHandle.close();
  store.close();
  const reopened = new StaticKeyStore(stateDir);
  const cleaned = reopened.cleanupExpired();
  assert.equal(cleaned, 1);
  const remaining = reopened.listAll();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].keyId, "obsk_active");
  reopened.close();
  await rm(stateDir, { recursive: true, force: true });
}

// Test 12: deleteById
await withIsolatedStore(async (store) => {
  store.mint(TEST_RESOURCE, "vault-owner", { scopes: ["devspace"], keyId: "obsk_del" });
  assert.equal(store.deleteById("obsk_del"), true);
  assert.equal(store.deleteById("obsk_del"), false);
  assert.equal(store.findById("obsk_del"), undefined);
});

console.log("All static-key-provider tests passed.");
