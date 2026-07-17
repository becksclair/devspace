import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFirstParentReleaseMarker,
  formatReleaseSection,
  incrementVersion,
  isBuildInputPath,
  parseBuildArgs,
  parseLatestRelease,
  prependRelease,
  releaseNotesFromCommits,
  updatePackageVersions,
  withDirectoryRollback,
  withFileRollback,
} from "./release-utils.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = join(repoRoot, "package.json");
const packageLockPath = join(repoRoot, "package-lock.json");
const changelogPath = join(repoRoot, "CHANGELOG.md");
const distPath = join(repoRoot, "dist");
const backupRoot = join(repoRoot, "releases");

try {
  const { bump } = parseBuildArgs(process.argv.slice(2));
  assertCommittedBuildInputs();

  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const changelog = readFileSync(changelogPath, "utf8");
  const previousRelease = parseLatestRelease(changelog);
  if (previousRelease.version !== packageJson.version) {
    throw new Error(
      `Latest changelog version ${previousRelease.version} does not match package version ${packageJson.version}`,
    );
  }

  git(["cat-file", "-e", `${previousRelease.commit}^{commit}`]);
  assertFirstParentReleaseMarker(
    lines(git(["rev-list", "--first-parent", "HEAD"])),
    previousRelease.commit,
  );
  const headCommit = git(["rev-parse", "HEAD"]);
  const commits = commitsSince(previousRelease.commit);
  const notes = releaseNotesFromCommits(commits);
  const nextVersion = incrementVersion(packageJson.version, bump);
  const section = formatReleaseSection({
    version: nextVersion,
    date: new Date().toISOString().slice(0, 10),
    commit: headCommit,
    notes,
  });

  withFileRollback([packagePath, packageLockPath, changelogPath], () => {
    updatePackageVersions(packagePath, packageLockPath, nextVersion);
    writeFileSync(changelogPath, prependRelease(changelog, section));

    withDirectoryRollback(distPath, backupRoot, () => {
      const result = spawnNpm(["run", "build:compile"], {
        cwd: repoRoot,
        env: process.env,
        stdio: "inherit",
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`Compilation failed with exit code ${result.status ?? "unknown"}`);
      }
    });
  });

  console.log(`Built DevSpace ${nextVersion}`);
  for (const note of notes) console.log(`- ${note}`);
} catch (error) {
  console.error(`[devspace:build] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function assertCommittedBuildInputs() {
  const dirtyTracked = [
    ...new Set([
      ...lines(git(["diff", "--no-renames", "--name-only"])),
      ...lines(git(["diff", "--cached", "--no-renames", "--name-only"])),
    ]),
  ].filter(isBuildInputPath);
  const untrackedBuildInputs = lines(
    git(["ls-files", "--others", "--exclude-standard"]),
  ).filter(isBuildInputPath);
  const dirtyInputs = [...dirtyTracked, ...untrackedBuildInputs].sort();

  if (dirtyInputs.length > 0) {
    throw new Error(
      `Versioned builds require committed build inputs. Commit these files or use npm run build:check:\n${dirtyInputs
        .map((path) => `  ${path}`)
        .join("\n")}`,
    );
  }
}

function commitsSince(commit) {
  return lines(git(["rev-list", "--first-parent", "--reverse", `${commit}..HEAD`])).map(
    (hash) => ({
      subject: git(["show", "-s", "--format=%s", hash]),
      paths: lines(git(["diff-tree", "--no-commit-id", "--name-only", "-r", "--first-parent", hash])),
    }),
  );
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function lines(value) {
  return value ? value.split("\n").filter(Boolean) : [];
}

function spawnNpm(args, options) {
  if (process.env.npm_execpath) {
    return spawnSync(process.execPath, [process.env.npm_execpath, ...args], options);
  }

  return spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    ...options,
    shell: process.platform === "win32",
  });
}
