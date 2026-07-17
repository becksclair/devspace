import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distPath = join(repoRoot, "dist");
const metadataPaths = [
  join(repoRoot, "package.json"),
  join(repoRoot, "package-lock.json"),
  join(repoRoot, "CHANGELOG.md"),
];
const healthUrl =
  process.env.DEVSPACE_HEALTH_URL ??
  `http://127.0.0.1:${process.env.DEVSPACE_PORT ?? process.env.PORT ?? "7676"}/healthz`;

try {
  assertLocalSystemdService();
  assertPreviousBuild();

  const metadataBackups = new Map(metadataPaths.map((path) => [path, readFileSync(path)]));
  const previousVersion = JSON.parse(metadataBackups.get(metadataPaths[0]).toString()).version;
  const releasesPath = join(repoRoot, "releases");
  mkdirSync(releasesPath, { recursive: true });
  const backupRoot = mkdtempSync(join(releasesPath, "rebuild-"));
  const distBackupPath = join(backupRoot, "dist");
  renameSync(distPath, distBackupPath);

  let buildSucceeded = false;
  let deployedVersion;
  try {
    const buildResult = spawnNpm(["run", "build", "--", ...process.argv.slice(2)], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    assertCommandSucceeded(buildResult, "versioned build");
    buildSucceeded = true;

    const restartResult = spawnSync("systemctl", ["--user", "restart", "devspace.service"], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    assertCommandSucceeded(restartResult, "service restart");

    const { version } = JSON.parse(readFileSync(metadataPaths[0], "utf8"));
    await waitForVersion(version);
    deployedVersion = version;
  } catch (error) {
    for (const [path, contents] of metadataBackups) writeFileSync(path, contents);
    rmSync(distPath, { recursive: true, force: true });
    renameSync(distBackupPath, distPath);

    let rollbackError;
    if (buildSucceeded) {
      try {
        const restartResult = spawnSync(
          "systemctl",
          ["--user", "restart", "devspace.service"],
          { cwd: repoRoot, env: process.env, stdio: "inherit" },
        );
        assertCommandSucceeded(restartResult, "rollback service restart");
        await waitForVersion(previousVersion);
      } catch (cause) {
        rollbackError = cause;
      }
    }

    removeBackupBestEffort(backupRoot);
    if (rollbackError) {
      throw new Error(
        `${errorMessage(error)}; rollback also failed: ${errorMessage(rollbackError)}`,
      );
    }
    throw error;
  }

  removeBackupBestEffort(backupRoot);
  console.log(`DevSpace ${deployedVersion} is healthy at ${healthUrl}`);
} catch (error) {
  console.error(`[devspace:rebuild] ${errorMessage(error)}`);
  process.exitCode = 1;
}

function assertPreviousBuild() {
  if (!existsSync(distPath)) {
    throw new Error("rebuild:local requires an existing dist; run npm run build:check first");
  }
}

function assertLocalSystemdService() {
  if (process.platform !== "linux") {
    throw new Error("rebuild:local requires Linux and a user systemd service");
  }

  const result = spawnSync(
    "systemctl",
    ["--user", "show", "devspace.service", "--property=LoadState", "--value"],
    { cwd: repoRoot, env: process.env, encoding: "utf8" },
  );
  assertCommandSucceeded(result, "systemd service check");
  if (result.stdout.trim() !== "loaded") {
    throw new Error("devspace.service is not loaded in the user systemd manager");
  }
}

async function waitForVersion(expectedVersion) {
  const deadline = Date.now() + 15_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      const response = await fetch(healthUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(Math.min(2_000, remainingMs)),
      });
      const body = await response.json();
      if (response.ok && body?.ok === true && body?.version === expectedVersion) return;
      lastError = new Error(
        `expected version ${expectedVersion}, received ${JSON.stringify(body)} with HTTP ${response.status}`,
      );
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`health verification failed: ${errorMessage(lastError)}`);
}

function assertCommandSucceeded(result, label) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function spawnNpm(args, options) {
  if (process.env.npm_execpath) {
    return spawnSync(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return spawnSync("npm", args, options);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function removeBackupBestEffort(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[devspace:rebuild] Could not remove backup ${path}: ${errorMessage(error)}`);
  }
}
