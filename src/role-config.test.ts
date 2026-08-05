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
const rootsOnly = loadRoleConfig(write({
  ...base,
  machines: [{
    ...base.machines[0],
    allowedRoots: undefined,
    roots: [{ path: join(dir, "roots"), aliases: [], access: "read-write" }],
    shell: { path: "/bin/bash", mode: "login", environment: { DEV_MODE: "1" } },
  }],
}));
if (rootsOnly.role === "gateway") {
  assert.equal(rootsOnly.machines[0]?.allowedRoots, undefined);
  assert.equal(rootsOnly.machines[0]?.roots?.[0]?.access, "read-write");
  assert.equal(rootsOnly.machines[0]?.shell?.mode, "login");
}
assert.throws(
  () => loadRoleConfig(write({ ...base, machines: [{ ...base.machines[0], roots: [{ path: join(dir, "roots"), access: "read-write" }] }] })),
  /cannot define both allowedRoots and roots/,
);
assert.throws(() => loadRoleConfig(write({ ...base, machines: [{ ...base.machines[0], canonical: undefined }] })), /exactly one canonical/);
assert.throws(() => loadRoleConfig(write({ ...base, machines: [{ ...base.machines[0], canonical: true }, { ...base.machines[0], id: "other", displayName: "Other", canonical: true }] })), /exactly one canonical/);
const reordered = loadRoleConfig(write({ ...base, machines: [
  { ...base.machines[0], id: "other", displayName: "Other", stateDir: join(dir, "other-state"), worktreeRoot: join(dir, "other-worktrees"), canonical: false },
  { ...base.machines[0], canonical: true },
] }));
assert.equal(reordered.role, "gateway");
if (reordered.role === "gateway") { assert.equal(reordered.machines[0]?.canonical, false); assert.equal(reordered.machines[1]?.canonical, true); }
const legacyRemote = loadRoleConfig(write({ ...base, machines: [
  { ...base.machines[0], canonical: true },
  { id: "remote", displayName: "Remote", kind: "remote", url: "https://remote.test", accessClientIdEnv: "REMOVED_ID", accessClientSecretEnv: "REMOVED_SECRET", nodeTokenEnv: "TOKEN", canonical: false },
] }), { TOKEN: "node-secret" });
if (legacyRemote.role === "gateway") {
  const remote = legacyRemote.machines.find((machine) => machine.id === "remote");
  assert.equal(remote?.nodeTokenEnv, "TOKEN");
  assert.equal("accessClientIdEnv" in (remote ?? {}), false);
  assert.equal("accessClientSecretEnv" in (remote ?? {}), false);
}
assert.throws(() => loadRoleConfig(write({ ...base, machines: [{ ...base.machines[0], aliases: [" HOME "] }, { id: "remote", displayName: "Remote", kind: "remote", aliases: ["home"], url: "https://remote.test", accessClientIdEnv: "ID", accessClientSecretEnv: "SECRET", nodeTokenEnv: "TOKEN", canonical: false }] })), /Duplicate machine/);
for (const field of ["stateDir", "worktreeRoot"]) {
  const machine = { ...base.machines[0], [field]: join(dir, "gateway-state", "nested") };
  assert.throws(() => loadRoleConfig(write({ ...base, machines: [machine] })), /must not overlap/);
}
const nodeRoots = loadRoleConfig(write({
  role: "node",
  machineId: "asgard",
  port: 7679,
  roots: [{ path: join(dir, "node-root"), access: "read-only" }],
  stateDir: join(dir, "node-state"),
  worktreeRoot: join(dir, "node-worktrees"),
  nodeTokenEnv: "NODE_TOKEN",
  shell: { mode: "login" },
}), { NODE_TOKEN: "secret" });
assert.equal(nodeRoots.role, "node");
if (nodeRoots.role === "node") {
  assert.equal(nodeRoots.allowedRoots, undefined);
  assert.equal(nodeRoots.roots?.[0]?.access, "read-only");
  assert.equal(nodeRoots.shell?.mode, "login");
}
assert.throws(() => envSecret("MISSING_DEVSPACE_TEST", {}), /required environment variable is missing/);
