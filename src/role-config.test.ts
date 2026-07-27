import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRoleConfig, envSecret } from "./role-config.js";

const dir = mkdtempSync(join(tmpdir(), "devspace-role-test-"));
const write = (value: unknown) => { const p = join(dir, `${Math.random()}.json`); writeFileSync(p, JSON.stringify(value)); return p; };
const base = { role: "gateway", host: "127.0.0.1", publicBaseUrl: "https://example.test/", stateDir: join(dir, "gateway-state"), machines: [
  { id: "Local", displayName: "Local", kind: "local", allowedRoots: [join(dir, "roots")], stateDir: join(dir, "local-state"), worktreeRoot: join(dir, "worktrees"), canonical: true },
] };
const loaded = loadRoleConfig(write(base)); assert.equal(loaded.role, "gateway");
if (loaded.role === "gateway") assert.equal(loaded.publicBaseUrl, "https://example.test");
assert.throws(() => loadRoleConfig(write({ ...base, machines: [{ ...base.machines[0], canonical: undefined }] })), /exactly one canonical/);
assert.throws(() => loadRoleConfig(write({ ...base, machines: [{ ...base.machines[0], canonical: true }, { ...base.machines[0], id: "other", displayName: "Other", canonical: true }] })), /exactly one canonical/);
const reordered = loadRoleConfig(write({ ...base, machines: [
  { ...base.machines[0], id: "other", displayName: "Other", stateDir: join(dir, "other-state"), worktreeRoot: join(dir, "other-worktrees"), canonical: false },
  { ...base.machines[0], canonical: true },
] }));
assert.equal(reordered.role, "gateway");
if (reordered.role === "gateway") { assert.equal(reordered.machines[0]?.canonical, false); assert.equal(reordered.machines[1]?.canonical, true); }
assert.throws(() => loadRoleConfig(write({ ...base, machines: [{ ...base.machines[0], aliases: [" HOME "] }, { id: "remote", displayName: "Remote", kind: "remote", aliases: ["home"], url: "https://remote.test", accessClientIdEnv: "ID", accessClientSecretEnv: "SECRET", nodeTokenEnv: "TOKEN", canonical: false }] })), /Duplicate machine/);
for (const field of ["stateDir", "worktreeRoot"]) {
  const machine = { ...base.machines[0], [field]: join(dir, "gateway-state", "nested") };
  assert.throws(() => loadRoleConfig(write({ ...base, machines: [machine] })), /must not overlap/);
}
assert.throws(() => envSecret("MISSING_DEVSPACE_TEST", {}), /required environment variable is missing/);
