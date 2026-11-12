import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  activateRelease,
  assertReleaseNodeVersion,
  buildMetadataSource,
  currentRelease,
  defaultAppRoot,
  healthReportsCommit,
  parseNodeMajor,
  linkedRelease,
  pointLink,
  releaseEnvironment,
  removeStaleStages,
  resolveActivationCommit,
} from "./local-release.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function appRootWith(...releases) {
  const appRoot = mkdtempSync(join(tmpdir(), "devspace-local-release-test-"));
  for (const name of releases) {
    mkdirSync(join(appRoot, "releases", name, "dist"), { recursive: true });
    writeFileSync(join(appRoot, "releases", name, "dist", "cli.js"), "");
  }
  return appRoot;
}

function recorder(healthy = () => true) {
  const calls = { restart: 0, probes: [] };
  return {
    calls,
    restart: async () => {
      calls.restart += 1;
    },
    probe: async (commit) => {
      calls.probes.push(commit);
      return healthy(commit);
    },
  };
}

test("first activation points current at the release without a previous link", async (t) => {
  const appRoot = appRootWith("a");
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));
  const fake = recorder();
  const result = await activateRelease({ appRoot, commit: "a", restart: fake.restart, probe: fake.probe });
  assert.deepEqual(result, { commit: "a", previous: undefined });
  assert.equal(readlinkSync(join(appRoot, "current")), join("releases", "a"));
  assert.equal(currentRelease(appRoot, "previous"), undefined);
  assert.equal(fake.calls.restart, 1);
  assert.deepEqual(fake.calls.probes, ["a"]);
});

test("second activation moves current forward and records previous", async (t) => {
  const appRoot = appRootWith("a", "b");
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));
  pointLink(appRoot, "current", "a");
  const fake = recorder();
  const result = await activateRelease({ appRoot, commit: "b", restart: fake.restart, probe: fake.probe });
  assert.deepEqual(result, { commit: "b", previous: "a" });
  assert.equal(currentRelease(appRoot), "b");
  assert.equal(currentRelease(appRoot, "previous"), "a");
});

test("a failed health check restores the previous release", async (t) => {
  const appRoot = appRootWith("a", "b");
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));
  pointLink(appRoot, "current", "a");
  const fake = recorder((commit) => commit !== "b");
  await assert.rejects(
    activateRelease({ appRoot, commit: "b", restart: fake.restart, probe: fake.probe }),
    /did not become healthy; restored a/,
  );
  assert.equal(currentRelease(appRoot), "a");
  assert.equal(currentRelease(appRoot, "previous"), undefined);
  assert.equal(fake.calls.restart, 2);
  assert.deepEqual(fake.calls.probes, ["b", "a"]);
  assert.deepEqual(readdirSync(join(appRoot, "releases")).sort(), ["a", "b"]);
});

test("a failed restart is treated like a failed health check", async (t) => {
  const appRoot = appRootWith("a", "b");
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));
  pointLink(appRoot, "current", "a");
  let restarts = 0;
  await assert.rejects(
    activateRelease({
      appRoot,
      commit: "b",
      restart: async () => {
        restarts += 1;
        if (restarts === 1) throw new Error("kickstart failed");
      },
      probe: async () => true,
    }),
    /did not become healthy \(kickstart failed\); restored a/,
  );
  assert.equal(currentRelease(appRoot), "a");
  assert.equal(restarts, 2);
});

test("activation prunes releases other than current and previous", async (t) => {
  const appRoot = appRootWith("a", "b", "c", "d");
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));
  mkdirSync(join(appRoot, "releases", ".stage-1"));
  pointLink(appRoot, "current", "b");
  pointLink(appRoot, "previous", "a");
  const fake = recorder();
  await activateRelease({ appRoot, commit: "d", restart: fake.restart, probe: fake.probe });
  assert.equal(currentRelease(appRoot), "d");
  assert.equal(currentRelease(appRoot, "previous"), "b");
  assert.deepEqual(readdirSync(join(appRoot, "releases")).sort(), [".stage-1", "b", "d"]);
});

test("activating an unprepared release changes nothing", async (t) => {
  const appRoot = appRootWith("a");
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));
  pointLink(appRoot, "current", "a");
  const fake = recorder();
  await assert.rejects(
    activateRelease({ appRoot, commit: "missing", restart: fake.restart, probe: fake.probe }),
    /release missing is not prepared/,
  );
  assert.equal(currentRelease(appRoot), "a");
  assert.equal(fake.calls.restart, 0);
  assert.deepEqual(readdirSync(appRoot).sort(), ["current", "releases"]);
});

test("a dangling current is not a rollback target and does not displace previous", async (t) => {
  const appRoot = appRootWith("a", "c");
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));
  pointLink(appRoot, "previous", "a");
  pointLink(appRoot, "current", "gone");
  assert.equal(linkedRelease(appRoot, "current"), undefined);
  const fake = recorder();
  const result = await activateRelease({ appRoot, commit: "c", restart: fake.restart, probe: fake.probe });
  assert.deepEqual(result, { commit: "c", previous: undefined });
  assert.equal(readlinkSync(join(appRoot, "previous")), join("releases", "a"));
  assert.deepEqual(readdirSync(join(appRoot, "releases")).sort(), ["a", "c"]);
});

test("a failed activation over a dangling current restores the recorded previous release", async (t) => {
  const appRoot = appRootWith("a", "c");
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));
  pointLink(appRoot, "previous", "a");
  pointLink(appRoot, "current", "gone");
  const fake = recorder((commit) => commit === "a");
  await assert.rejects(
    activateRelease({ appRoot, commit: "c", restart: fake.restart, probe: fake.probe }),
    /did not become healthy; restored a$/,
  );
  assert.equal(readlinkSync(join(appRoot, "current")), join("releases", "a"));
});

test("a current link that leaves the releases directory is not a rollback target", async (t) => {
  const appRoot = appRootWith("c");
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));
  mkdirSync(join(appRoot, "elsewhere", "c", "dist"), { recursive: true });
  writeFileSync(join(appRoot, "elsewhere", "c", "dist", "cli.js"), "");
  symlinkSync(join("elsewhere", "c"), join(appRoot, "current"));
  assert.equal(linkedRelease(appRoot, "current"), undefined);
  const fake = recorder(() => false);
  await assert.rejects(
    activateRelease({ appRoot, commit: "c", restart: fake.restart, probe: fake.probe }),
    /no previous release to restore; current still points at c$/,
  );
  assert.equal(readlinkSync(join(appRoot, "current")), join("releases", "c"));
  assert.equal(fake.calls.restart, 1);
});

test("re-activating the current release falls back to previous when it fails", async (t) => {
  const appRoot = appRootWith("a", "b");
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));
  pointLink(appRoot, "previous", "a");
  pointLink(appRoot, "current", "b");
  const fake = recorder((commit) => commit === "a");
  await assert.rejects(
    activateRelease({ appRoot, commit: "b", restart: fake.restart, probe: fake.probe }),
    /release b did not become healthy; restored a$/,
  );
  assert.equal(readlinkSync(join(appRoot, "current")), join("releases", "a"));
  assert.deepEqual(readdirSync(join(appRoot, "releases")).sort(), ["a", "b"]);
});

test("a rollback whose restart fails still reports whether the old release is serving", async (t) => {
  const appRoot = appRootWith("a", "b");
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));
  pointLink(appRoot, "current", "a");
  const probes = [];
  const options = {
    appRoot,
    commit: "b",
    restart: async () => {
      throw new Error("kickstart failed");
    },
    probe: async (commit) => {
      probes.push(commit);
      return commit === "a";
    },
  };
  // No restart went through in either direction, so the old process is still serving `a`.
  await assert.rejects(
    activateRelease(options),
    /did not become healthy \(kickstart failed\); restored a; the rollback restart failed \(kickstart failed\)$/,
  );
  assert.deepEqual(probes, ["a"]);
  assert.equal(readlinkSync(join(appRoot, "current")), join("releases", "a"));
});

test("a rollback that does not become healthy says where current points", async (t) => {
  const appRoot = appRootWith("a", "b");
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));
  pointLink(appRoot, "current", "a");
  const fake = recorder(() => false);
  await assert.rejects(
    activateRelease({ appRoot, commit: "b", restart: fake.restart, probe: fake.probe }),
    /restoring a also failed: current points at a, but it does not report healthy$/,
  );
  assert.equal(readlinkSync(join(appRoot, "current")), join("releases", "a"));
  assert.equal(fake.calls.restart, 2);
  // A failed activation never prunes.
  assert.deepEqual(readdirSync(join(appRoot, "releases")).sort(), ["a", "b"]);
});

test("a prepared release named by its full commit activates without a git lookup", (t) => {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const appRoot = appRootWith(commit);
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));
  // appRoot is not a git repository, so consulting git would throw.
  assert.equal(resolveActivationCommit(appRoot, commit, appRoot), commit);
  assert.throws(() => resolveActivationCommit(appRoot, "f".repeat(40), appRoot));
});

test("prepare removes stages left by runs that are no longer alive", (t) => {
  const appRoot = appRootWith("a");
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  mkdirSync(join(appRoot, "releases", `.stage-${dead}`));
  mkdirSync(join(appRoot, "releases", `.stage-${process.pid}`));
  mkdirSync(join(appRoot, "releases", ".stage-notes"));
  removeStaleStages(appRoot);
  assert.deepEqual(readdirSync(join(appRoot, "releases")).sort(), [".stage-notes", `.stage-${process.pid}`, "a"].sort());
});

test("release Node must be the launcher's major version", () => {
  assert.equal(parseNodeMajor("v24.22.2"), 24);
  assert.equal(parseNodeMajor("26.13.1"), 26);
  assert.equal(parseNodeMajor("v24"), undefined);
  assert.equal(parseNodeMajor(""), undefined);
  assert.equal(parseNodeMajor(undefined), undefined);
  assert.doesNotThrow(() => assertReleaseNodeVersion("v24.0.0", "/opt/node24/bin/node"));
  assert.throws(() => assertReleaseNodeVersion("v26.13.1", "/usr/local/bin/node"), /\/usr\/local\/bin\/node is Node v26\.13\.1.*--node/);
  assert.throws(() => assertReleaseNodeVersion("v22.14.0", "node"), /Node 24/);
  assert.throws(() => assertReleaseNodeVersion("", "node"), /<unknown version>/);
});

test("release environment resolves node from the pinned directory first", () => {
  assert.equal(releaseEnvironment("/pinned/bin", { PATH: "/usr/bin" }).PATH, `/pinned/bin${delimiter}/usr/bin`);
  assert.equal(releaseEnvironment("/pinned/bin", {}).PATH, "/pinned/bin");
  assert.equal(releaseEnvironment("/pinned/bin", { PATH: "/usr/bin", KEEP: "1" }).KEEP, "1");
});

test("default app root honors DEVSPACE_APP_ROOT", () => {
  assert.equal(defaultAppRoot({ DEVSPACE_APP_ROOT: "/srv/devspace" }), "/srv/devspace");
  assert.match(defaultAppRoot({}), /\/\.local\/opt\/devspace$/);
});

test("health check requires ok and the expected commit", () => {
  assert.equal(healthReportsCommit({ ok: true, sourceCommit: "abc" }, "abc"), true);
  assert.equal(healthReportsCommit({ ok: true, sourceCommit: "def" }, "abc"), false);
  assert.equal(healthReportsCommit({ ok: false, sourceCommit: "abc" }, "abc"), false);
  assert.equal(healthReportsCommit(undefined, "abc"), false);
});

test("baked build metadata exports everything src imports from build-metadata", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "devspace-local-release-metadata-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const hash = `sha256:${"a".repeat(64)}`;
  const file = join(dir, "build-metadata.mjs");
  writeFileSync(file, buildMetadataSource({ commit, packageVersion: "9.9.9", toolContractHash: hash }));
  const baked = await import(pathToFileURL(file).href);
  assert.deepEqual(baked.getBuildMetadata("gateway"), {
    protocolMajor: 1,
    packageVersion: "9.9.9",
    sourceCommit: commit,
    toolContractHash: hash,
    role: "gateway",
  });

  const imported = new Set();
  for (const name of readdirSync(join(repoRoot, "src"), { recursive: true })) {
    if (!String(name).endsWith(".ts") || String(name).endsWith(".test.ts")) continue;
    const source = readFileSync(join(repoRoot, "src", String(name)), "utf8");
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.{1,2}\/(?:[\w-]+\/)*build-metadata\.js"/g)) {
      for (const specifier of match[1].split(",")) {
        const binding = specifier.trim();
        if (!binding || binding.startsWith("type ")) continue;
        imported.add(binding.split(/\s+as\s+/)[0].trim());
      }
    }
  }
  assert.ok(imported.size > 0, "expected src to import from build-metadata.js");
  for (const name of imported) assert.ok(name in baked, `baked build-metadata.js does not export ${name}`);
});

test("activate without a label or health URL exits with usage and does nothing", () => {
  const appRoot = mkdtempSync(join(tmpdir(), "devspace-local-release-cli-"));
  try {
    const result = spawnSync(process.execPath, [join(repoRoot, "scripts/local-release.mjs"), "activate", "HEAD"], {
      encoding: "utf8",
      env: { ...process.env, DEVSPACE_APP_ROOT: appRoot },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[devspace:release\] activate requires --label/);
    assert.match(result.stderr, /usage:/);
    assert.deepEqual(readdirSync(appRoot), []);
    assert.equal(existsSync(join(appRoot, "current")), false);
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});
