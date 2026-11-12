#!/usr/bin/env node
// Local release directories for a host that runs the DevSpace gateway from a
// prepared build instead of a working checkout.
//
//   prepare [<rev>] [--app-root <dir>] [--node <path>]
//     Builds <app-root>/releases/<commit> from a clean temporary worktree with
//     the given Node 24 binary, smoke-tests it, and never touches `current`,
//     `previous`, or any running service.
//
//   activate <rev> --label <launchd-label> --health-url <url> [--app-root <dir>]
//     Points `current` at a prepared release, restarts the LaunchAgent, waits
//     for /healthz to report the release commit, and switches back on failure.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const LOG_PREFIX = "[devspace:release]";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The Node major the gateway launcher runs and that artifact.json and the smoke test require. */
export const RELEASE_NODE_MAJOR = 24;

const USAGE = `usage:
  local-release.mjs prepare [<rev>] [--app-root <dir>] [--node <path-to-node-${RELEASE_NODE_MAJOR}>]
  local-release.mjs activate <rev> --label <launchd-label> --health-url <url> [--app-root <dir>]`;

class UsageError extends Error {}

export function defaultAppRoot(env = process.env) {
  return resolve(env.DEVSPACE_APP_ROOT || join(homedir(), ".local", "opt", "devspace"));
}

/** Returns the major version of a `process.version` string such as `v24.22.2`, or undefined. */
export function parseNodeMajor(version) {
  const match = /^v?(\d+)\.\d+\.\d+/.exec(String(version ?? "").trim());
  return match ? Number(match[1]) : undefined;
}

/** Throws unless `version` is a Node release of the major the launcher runs. */
export function assertReleaseNodeVersion(version, nodePath) {
  const major = parseNodeMajor(version);
  if (major === RELEASE_NODE_MAJOR) return;
  throw new Error(
    `${nodePath} is Node ${version || "<unknown version>"}, but a release must be built and smoke-tested with Node ${RELEASE_NODE_MAJOR}, ` +
      `the version the gateway launcher runs. Pass --node <path to the launcher's Node ${RELEASE_NODE_MAJOR} binary>.`,
  );
}

/**
 * The replacement for dist/build-metadata.js in a release. The text is the one
 * scripts/package-runtime-artifact.mjs writes, so a release reports a baked
 * commit instead of asking git at runtime.
 */
export function buildMetadataSource({ commit, packageVersion, toolContractHash }) {
  return `export const PROTOCOL_MAJOR = 1;\nexport function toolContractHash() { return ${JSON.stringify(toolContractHash)}; }\nexport function getBuildMetadata(role) { return { protocolMajor: 1, packageVersion: ${JSON.stringify(packageVersion)}, sourceCommit: ${JSON.stringify(commit)}, toolContractHash: ${JSON.stringify(toolContractHash)}, ...(role ? { role } : {}) }; }\n`;
}

/**
 * The caller's environment minus DevSpace's control-plane secrets, for every child this script
 * starts: git, installs with their lifecycle scripts, the build, and the smoke test all run
 * programs the repository or its dependencies choose. It strips the same names as the
 * child-environment helpers in src/shell-environment.ts, which a plain .mjs script cannot import.
 */
export function releaseChildEnvironment(env = process.env) {
  const listed = new Set(
    (env.DEVSPACE_INFRA_SECRET_NAMES ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const filtered = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (name === "DEVSPACE_OAUTH_OWNER_TOKEN" || name.endsWith("_NODE_TOKEN") || listed.has(name)) continue;
    filtered[name] = value;
  }
  return filtered;
}

/** The filtered child environment with the release's Node directory first on PATH. */
export function releaseEnvironment(binDir, env = process.env) {
  const filtered = releaseChildEnvironment(env);
  return { ...filtered, PATH: filtered.PATH ? `${binDir}${delimiter}${filtered.PATH}` : binDir };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === "EPERM";
  }
}

export function resolveCommit(repoRoot, rev) {
  const commit = execFileSync("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8",
    env: releaseChildEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`could not resolve ${rev} to a full commit`);
  return commit;
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: "inherit", env: releaseChildEnvironment(), ...options });
  if (result.error) throw new Error(`${command} ${args.join(" ")} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal})`);
  }
}

function describeNode(nodePath, env = releaseChildEnvironment()) {
  const output = execFileSync(
    nodePath,
    ["-p", "JSON.stringify({ version: process.version, platform: process.platform, arch: process.arch, execPath: process.execPath })"],
    { encoding: "utf8", env },
  );
  return JSON.parse(output);
}

function readToolContractHash(cwd, nodePath) {
  if (!existsSync(join(cwd, "dist/tool-contract.js"))) throw new Error("dist/tool-contract.js is missing after the build");
  const hash = execFileSync(
    nodePath,
    ["--input-type=module", "-e", 'import { TOOL_CONTRACT_HASH } from "./dist/tool-contract.js"; console.log(TOOL_CONTRACT_HASH)'],
    { cwd, encoding: "utf8", env: releaseChildEnvironment() },
  ).trim();
  const bare = hash.startsWith("sha256:") ? hash.slice(7) : hash;
  if (!/^[0-9a-f]{64}$/.test(bare)) throw new Error("tool contract hash is not a lowercase SHA-256");
  return `sha256:${bare}`;
}

export function prepareRelease({
  rev = "HEAD",
  appRoot = defaultAppRoot(),
  repoRoot = REPO_ROOT,
  nodePath = process.execPath,
  log = console.log,
} = {}) {
  const requested = resolve(nodePath);
  if (!existsSync(requested)) throw new Error(`Node binary ${requested} does not exist`);
  const nodeInfo = describeNode(requested);
  assertReleaseNodeVersion(nodeInfo.version, requested);
  // Pin the binary the probe actually ran, so a version-manager shim cannot
  // pick a different Node later depending on the working directory.
  const node = nodeInfo.execPath;

  const commit = resolveCommit(repoRoot, rev);
  const releases = join(appRoot, "releases");
  const target = join(releases, commit);
  if (existsSync(target)) {
    log(`release ${commit} already prepared at ${target}`);
    return { commit, target, prepared: false };
  }

  mkdirSync(releases, { recursive: true });
  removeStaleStages(appRoot);
  const build = mkdtempSync(join(tmpdir(), "devspace-release-build-"));
  const checkout = join(build, "checkout");
  const binDir = join(build, "bin");
  const stage = join(releases, `.stage-${process.pid}`);
  let worktreeAdded = false;
  try {
    // Every child (bun, build scripts, lifecycle scripts, the smoke test)
    // resolves `node` to the release's Node binary, not whatever PATH has.
    mkdirSync(binDir);
    symlinkSync(node, join(binDir, "node"));
    const env = releaseEnvironment(binDir);
    const pathNode = describeNode("node", env);
    if (pathNode.version !== nodeInfo.version) {
      throw new Error(`node on the release PATH is ${pathNode.version} (${pathNode.execPath}), expected ${nodeInfo.version}`);
    }
    log(`${LOG_PREFIX} building ${commit} with Node ${nodeInfo.version} (${node})`);

    run("git", ["worktree", "add", "--detach", checkout, commit], { cwd: repoRoot });
    worktreeAdded = true;
    run("bun", ["install", "--frozen-lockfile"], { cwd: checkout, env });
    run("bun", ["run", "build:check"], { cwd: checkout, env });

    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage);
    cpSync(join(checkout, "dist"), join(stage, "dist"), { recursive: true });
    cpSync(join(checkout, "package.json"), join(stage, "package.json"));
    cpSync(join(checkout, "bun.lock"), join(stage, "bun.lock"));
    const packageJson = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
    const toolContractHash = readToolContractHash(checkout, node);
    writeFileSync(
      join(stage, "dist/build-metadata.js"),
      buildMetadataSource({ commit, packageVersion: packageJson.version, toolContractHash }),
    );
    run("bun", ["install", "--production", "--frozen-lockfile"], { cwd: stage, env });

    const lockHash = createHash("sha256").update(readFileSync(join(stage, "bun.lock"))).digest("hex");
    const manifest = {
      schema_version: "saga-service-artifact/v1",
      service_id: "devspace",
      source_commit: commit,
      package_version: packageJson.version,
      package_lock_sha256: `sha256:${lockHash}`,
      platform: `${nodeInfo.platform}-${nodeInfo.arch}`,
      node_major: RELEASE_NODE_MAJOR,
      node_version: nodeInfo.version,
      protocol_major: 1,
      tool_contract_hash: toolContractHash,
      entrypoints: { gateway: ["node", "dist/cli.js", "gateway"], node: ["node", "dist/cli.js", "node"] },
      health_path: "/healthz",
    };
    writeFileSync(join(stage, "artifact.json"), `${JSON.stringify(manifest)}\n`);

    // The smoke test starts the staged gateway and node with its own
    // process.execPath, so running it with the release Node proves the
    // release loads (native modules included) under that binary.
    run(node, [join(repoRoot, "scripts/smoke-runtime-artifact.mjs"), stage], { env });

    renameSync(stage, target);
    log(target);
    return { commit, target, prepared: true };
  } finally {
    rmSync(stage, { recursive: true, force: true });
    if (worktreeAdded) {
      spawnSync("git", ["worktree", "remove", "--force", checkout], { cwd: repoRoot, env: releaseChildEnvironment(), stdio: "ignore" });
    }
    rmSync(build, { recursive: true, force: true });
  }
}

/** Removes `.stage-<pid>` directories whose `prepare` run is no longer alive. */
export function removeStaleStages(appRoot) {
  const releases = join(appRoot, "releases");
  if (!existsSync(releases)) return;
  for (const entry of readdirSync(releases)) {
    const pid = /^\.stage-(\d+)$/.exec(entry)?.[1];
    if (pid === undefined) continue;
    if (!processAlive(Number(pid))) rmSync(join(releases, entry), { recursive: true, force: true });
  }
}

/** The commit directory name `<appRoot>/<name>` points to, or undefined when the link does not exist. */
export function currentRelease(appRoot, name = "current") {
  try {
    return basename(readlinkSync(join(appRoot, name)));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Atomically points `<appRoot>/<name>` at `releases/<commit>`. */
export function pointLink(appRoot, name, commit) {
  const temporary = join(appRoot, `${name}.tmp-${process.pid}`);
  rmSync(temporary, { force: true });
  symlinkSync(join("releases", commit), temporary);
  renameSync(temporary, join(appRoot, name));
}

/** Removes every release directory except those in `keep` and names starting with `.`. */
export function pruneReleases(appRoot, keep) {
  const releases = join(appRoot, "releases");
  for (const entry of readdirSync(releases)) {
    if (entry.startsWith(".") || keep.has(entry)) continue;
    rmSync(join(releases, entry), { recursive: true, force: true });
  }
}

/** The release `<appRoot>/<name>` points to, when the link targets a prepared release directory. */
export function linkedRelease(appRoot, name) {
  let target;
  try {
    target = readlinkSync(join(appRoot, name));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  // Compare resolved paths, so an absolute target or a trailing slash still counts.
  const directory = resolve(appRoot, target);
  const release = basename(directory);
  const pointsIntoReleases = release !== "" && directory === resolve(appRoot, "releases", release);
  return pointsIntoReleases && existsSync(join(directory, "dist", "cli.js")) ? release : undefined;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Takes the per-app-root activation lock and returns its release function. Two overlapping
 * activations would each prune the release the other selected, so the whole switch, health
 * check, rollback and prune runs under one lock. A lock left by a dead process is replaced.
 */
function acquireActivationLock(appRoot) {
  const lock = join(appRoot, ".activate-lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), `${process.pid}\n`);
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = Number(readFileSync(join(lock, "pid"), "utf8"));
      } catch {}
      if (!Number.isInteger(owner)) {
        throw new Error(`another activation holds ${lock}; remove it if no activation is running`);
      }
      if (processAlive(owner)) throw new Error(`another activation (pid ${owner}) is running for ${appRoot}`);
      rmSync(lock, { recursive: true, force: true });
    }
  }
  throw new Error(`could not take the activation lock at ${lock}`);
}

export async function activateRelease({ appRoot, commit, restart, probe }) {
  const prepared = () => existsSync(join(appRoot, "releases", commit, "dist", "cli.js"));
  if (!prepared()) throw new Error(`release ${commit} is not prepared under ${appRoot}`);
  const releaseLock = acquireActivationLock(appRoot);
  try {
    // An activation that held the lock until now may have pruned this release.
    if (!prepared()) throw new Error(`release ${commit} is no longer prepared under ${appRoot}`);
    return await switchRelease({ appRoot, commit, restart, probe });
  } finally {
    releaseLock();
  }
}

async function switchRelease({ appRoot, commit, restart, probe }) {
  // Only a link that targets a prepared release is a rollback target. A dangling or hand-made
  // link must neither be restored nor replace a good `previous`.
  const replaced = linkedRelease(appRoot, "current");
  const recorded = linkedRelease(appRoot, "previous");
  const fallback = [replaced, recorded].find((release) => release && release !== commit);

  pointLink(appRoot, "current", commit);
  let failure;
  try {
    await restart();
    if (!(await probe(commit))) failure = "";
  } catch (error) {
    failure = ` (${errorMessage(error)})`;
  }

  if (failure !== undefined) {
    if (!fallback) {
      throw new Error(
        `release ${commit} did not become healthy${failure} and there is no previous release to restore; current still points at ${commit}`,
      );
    }
    pointLink(appRoot, "current", fallback);
    // Probe even when the restart fails: if no restart went through in either direction (a
    // mistyped label, for example), the process that was running before is still serving.
    let restartFailure = "";
    try {
      await restart();
    } catch (error) {
      restartFailure = `; the rollback restart failed (${errorMessage(error)})`;
    }
    let restored = false;
    try {
      restored = await probe(fallback);
    } catch {}
    throw new Error(
      `release ${commit} did not become healthy${failure}; ` +
        (restored
          ? `restored ${fallback}`
          : `restoring ${fallback} also failed: current points at ${fallback}, but it does not report healthy`) +
        restartFailure,
    );
  }

  if (replaced && replaced !== commit) pointLink(appRoot, "previous", replaced);
  // The switch is complete and healthy. A prune failure must not read as a failed activation.
  try {
    pruneReleases(appRoot, new Set([commit, linkedRelease(appRoot, "previous")].filter(Boolean)));
  } catch (error) {
    return { commit, previous: replaced, pruneFailure: errorMessage(error) };
  }
  return { commit, previous: replaced };
}

/**
 * The commit `activate <rev>` names. A prepared release named by its full commit (a rollback,
 * typically) needs no git lookup, so it works from a checkout that no longer has that commit.
 */
export function resolveActivationCommit(appRoot, rev, repoRoot = REPO_ROOT) {
  const prepared = /^[0-9a-f]{40}$/.test(rev) && existsSync(join(appRoot, "releases", rev, "dist", "cli.js"));
  return prepared ? rev : resolveCommit(repoRoot, rev);
}

/** True when a /healthz body reports a healthy process built from `commit`. */
export function healthReportsCommit(body, commit) {
  return body?.ok === true && body?.sourceCommit === commit;
}

async function probeHealth(url, commit, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(intervalMs * 4) });
      if (response.ok && healthReportsCommit(await response.json(), commit)) return true;
    } catch {}
    await new Promise((done) => setTimeout(done, intervalMs));
  }
  return false;
}

/** The app root a command works on. An empty `--app-root` is an error, not the default root. */
function appRootOption(value) {
  if (value === undefined) return defaultAppRoot();
  if (value === "") throw new UsageError("--app-root must not be empty");
  return resolve(value);
}

function parseCommandArgs(args, options) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
}

async function runPrepare(args) {
  const { values, positionals } = parseCommandArgs(args, { "app-root": { type: "string" }, node: { type: "string" } });
  if (positionals.length > 1) throw new UsageError("prepare takes at most one revision");
  if (values.node !== undefined && !isAbsolute(values.node)) throw new UsageError("--node must be an absolute path");
  const appRoot = appRootOption(values["app-root"]);
  // prepareRelease runs synchronously. With a handler installed, an interrupt ends the running
  // child and lets the cleanup in `finally` run, instead of killing this process before it can.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {});
  prepareRelease({ rev: positionals[0] ?? "HEAD", appRoot, nodePath: values.node ?? process.execPath });
}

async function runActivate(args) {
  const { values, positionals } = parseCommandArgs(args, {
    "app-root": { type: "string" },
    label: { type: "string" },
    "health-url": { type: "string" },
  });
  if (positionals.length !== 1) throw new UsageError("activate takes exactly one revision");
  if (!values.label) throw new UsageError("activate requires --label <launchd-label>");
  if (!values["health-url"]) throw new UsageError("activate requires --health-url <url>");
  if (!/^[A-Za-z0-9._-]+$/.test(values.label)) throw new UsageError("--label must be a launchd label such as com.example.service");
  let healthUrl;
  try {
    healthUrl = new URL(values["health-url"]);
  } catch {
    throw new UsageError("--health-url must be an absolute URL");
  }
  if (healthUrl.protocol !== "http:" && healthUrl.protocol !== "https:") throw new UsageError("--health-url must use http or https");
  // Argument errors come before the platform check, so they read the same on every host.
  const appRoot = appRootOption(values["app-root"]);
  if (process.platform !== "darwin") throw new UsageError("activate restarts a launchd LaunchAgent and runs only on macOS");

  const commit = resolveActivationCommit(appRoot, positionals[0]);
  const target = `gui/${process.getuid()}/${values.label}`;
  const result = await activateRelease({
    appRoot,
    commit,
    restart: async () => run("launchctl", ["kickstart", "-k", target], {}),
    probe: (expected) => probeHealth(healthUrl.href, expected),
  });
  console.log(
    `${LOG_PREFIX} ${values.label} now runs ${result.commit}${result.previous && result.previous !== result.commit ? ` (previous ${result.previous})` : ""}`,
  );
  if (result.pruneFailure) console.error(`${LOG_PREFIX} warning: old releases were not pruned (${result.pruneFailure})`);
}

export async function main(argv) {
  const [command, ...rest] = argv;
  try {
    if (command === "prepare") await runPrepare(rest);
    else if (command === "activate") await runActivate(rest);
    else throw new UsageError(command ? `unknown command ${command}` : "missing command");
  } catch (error) {
    console.error(`${LOG_PREFIX} ${errorMessage(error)}`);
    if (error instanceof UsageError) console.error(USAGE);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
