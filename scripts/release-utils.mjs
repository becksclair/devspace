import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { inc, valid } from "semver";

const RELEASE_MARKER_PATTERN =
  /<!-- devspace-release: version=([^\s]+) commit=([0-9a-f]{40}) -->/;
const RELEASE_METADATA_PATHS = new Set([
  "CHANGELOG.md",
  "package-lock.json",
  "package.json",
]);
const BUILD_INPUT_PATHS = new Set([
  "CHANGELOG.md",
  "package-lock.json",
  "package.json",
  "tsconfig.build.json",
  "tsconfig.json",
  "vite.config.ts",
]);

export function parseBuildArgs(argv) {
  let bump = "patch";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--bump") {
      bump = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--bump=")) {
      bump = argument.slice("--bump=".length);
      continue;
    }
    throw new Error(`Unknown build argument: ${argument}`);
  }

  if (!new Set(["patch", "minor", "major"]).has(bump)) {
    throw new Error(`Invalid version bump: ${bump ?? "missing"}`);
  }

  return { bump };
}

export function incrementVersion(currentVersion, bump) {
  if (!valid(currentVersion)) {
    throw new Error(`Invalid package version: ${currentVersion}`);
  }

  const nextVersion = inc(currentVersion, bump);
  if (!nextVersion) throw new Error(`Could not apply ${bump} bump to ${currentVersion}`);
  return nextVersion;
}

export function parseLatestRelease(changelog) {
  const match = changelog.match(RELEASE_MARKER_PATTERN);
  if (!match) {
    throw new Error("CHANGELOG.md does not contain a DevSpace release marker");
  }

  return { version: match[1], commit: match[2] };
}

export function assertFirstParentReleaseMarker(firstParentCommits, marker) {
  if (!firstParentCommits.includes(marker)) {
    throw new Error(
      `Release marker commit ${marker} is not on HEAD's first-parent history`,
    );
  }
}

export function isBuildInputPath(path) {
  return path.startsWith("src/") || path.startsWith("scripts/") || BUILD_INPUT_PATHS.has(path);
}

export function releaseNotesFromCommits(commits) {
  const notes = commits
    .filter((commit) => !isReleaseMetadataOnly(commit.paths))
    .map((commit) => commit.subject.trim())
    .filter(Boolean);

  return notes.length > 0 ? notes : ["No committed changes."];
}

export function formatReleaseSection({ version, date, commit, notes }) {
  return [
    `## ${version} - ${date}`,
    "",
    ...notes.map((note) => `- ${note}`),
    "",
    `<!-- devspace-release: version=${version} commit=${commit} -->`,
  ].join("\n");
}

export function prependRelease(changelog, section) {
  const heading = "# Changelog\n";
  if (!changelog.startsWith(heading)) {
    throw new Error("CHANGELOG.md must start with '# Changelog'");
  }

  const existingBody = changelog.slice(heading.length).replace(/^\n/, "");
  return `${heading}\n${section}\n${existingBody}`;
}

export function updatePackageVersions(packagePath, packageLockPath, version) {
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const packageLock = JSON.parse(readFileSync(packageLockPath, "utf8"));

  packageJson.version = version;
  packageLock.version = version;
  if (!packageLock.packages?.[""]) {
    throw new Error("package-lock.json is missing the root package metadata");
  }
  packageLock.packages[""].version = version;

  writeJson(packagePath, packageJson);
  writeJson(packageLockPath, packageLock);
}

export function withFileRollback(paths, action) {
  const backups = new Map(paths.map((path) => [path, readFileSync(path)]));

  try {
    return action();
  } catch (error) {
    for (const [path, contents] of backups) writeFileSync(path, contents);
    throw error;
  }
}

export function withDirectoryRollback(directory, backupParent, action) {
  mkdirSync(backupParent, { recursive: true });
  const backupRoot = mkdtempSync(join(backupParent, "build-"));
  const backupDirectory = join(backupRoot, "previous");
  const hadDirectory = existsSync(directory);
  if (hadDirectory) renameSync(directory, backupDirectory);

  let result;
  try {
    result = action();
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    if (hadDirectory) renameSync(backupDirectory, directory);
    removeBackupBestEffort(backupRoot);
    throw error;
  }

  removeBackupBestEffort(backupRoot);
  return result;
}

function isReleaseMetadataOnly(paths) {
  return paths.length > 0 && paths.every((path) => RELEASE_METADATA_PATHS.has(path));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function removeBackupBestEffort(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    console.warn(
      `[devspace:build] Could not remove backup ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
