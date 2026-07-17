import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

test("parses build bump arguments and increments semver", () => {
  assert.deepEqual(parseBuildArgs([]), { bump: "patch" });
  assert.deepEqual(parseBuildArgs(["--bump", "minor"]), { bump: "minor" });
  assert.deepEqual(parseBuildArgs(["--bump=major"]), { bump: "major" });
  assert.equal(incrementVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(incrementVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(incrementVersion("1.2.3", "major"), "2.0.0");
  assert.throws(() => parseBuildArgs(["--bump", "banana"]), /Invalid version bump/);
});

test("parses the latest changelog marker", () => {
  const changelog = [
    "# Changelog",
    "",
    "## 1.2.0 - 2026-07-17",
    "",
    "<!-- devspace-release: version=1.2.0 commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->",
    "",
    "<!-- devspace-release: version=1.1.0 commit=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb -->",
  ].join("\n");

  assert.deepEqual(parseLatestRelease(changelog), {
    version: "1.2.0",
    commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
});

test("requires the release marker on HEAD's first-parent history", () => {
  const firstParentCommits = [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ];

  assert.doesNotThrow(() =>
    assertFirstParentReleaseMarker(
      firstParentCommits,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
  );
  assert.throws(
    () =>
      assertFirstParentReleaseMarker(
        firstParentCommits,
        "cccccccccccccccccccccccccccccccccccccccc",
      ),
    /not on HEAD's first-parent history/,
  );
});

test("rejects a release marker from an unrelated branch history", () => {
  withTempGitRepo((directory) => {
    writeFileSync(join(directory, "root.txt"), "root\n");
    commitAll(directory, "root");
    git(directory, ["checkout", "-b", "release"]);
    writeFileSync(join(directory, "release.txt"), "release\n");
    commitAll(directory, "release");
    const unrelatedMarker = git(directory, ["rev-parse", "HEAD"]);

    git(directory, ["checkout", "main"]);
    writeFileSync(join(directory, "main.txt"), "main\n");
    commitAll(directory, "main");
    const firstParentCommits = git(directory, ["rev-list", "--first-parent", "HEAD"]).split("\n");

    assert.throws(
      () => assertFirstParentReleaseMarker(firstParentCommits, unrelatedMarker),
      /not on HEAD's first-parent history/,
    );
  });
});

test("source renames expose the deleted build-input path", () => {
  withTempGitRepo((directory) => {
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "src", "feature.ts"), "export const feature = true;\n");
    commitAll(directory, "add source");
    mkdirSync(join(directory, "docs"), { recursive: true });
    renameSync(join(directory, "src", "feature.ts"), join(directory, "docs", "feature.ts"));

    const changedPaths = git(directory, ["diff", "--no-renames", "--name-only"]).split("\n");
    assert.ok(changedPaths.includes("src/feature.ts"));
    assert.deepEqual(changedPaths.filter(isBuildInputPath), ["src/feature.ts"]);

    git(directory, ["add", "--all"]);
    const stagedPaths = git(directory, [
      "diff",
      "--cached",
      "--no-renames",
      "--name-only",
    ]).split("\n");
    assert.ok(stagedPaths.includes("src/feature.ts"));
    assert.deepEqual(stagedPaths.filter(isBuildInputPath), ["src/feature.ts"]);
  });
});

test("keeps commit order and ignores release-only commits", () => {
  const notes = releaseNotesFromCommits([
    { subject: "First change", paths: ["src/server.ts"] },
    { subject: "Record release", paths: ["CHANGELOG.md", "package.json", "package-lock.json"] },
    { subject: "Second change", paths: ["README.md"] },
  ]);

  assert.deepEqual(notes, ["First change", "Second change"]);
  assert.deepEqual(releaseNotesFromCommits([]), ["No committed changes."]);
});

test("formats and prepends a release section", () => {
  const section = formatReleaseSection({
    version: "1.0.2",
    date: "2026-07-17",
    commit: "cccccccccccccccccccccccccccccccccccccccc",
    notes: ["Add changelog automation"],
  });
  const changelog = prependRelease(
    "# Changelog\n\n## 1.0.1 - 2026-06-17\n",
    section,
  );

  assert.match(changelog, /^# Changelog\n\n## 1\.0\.2 - 2026-07-17/);
  assert.match(changelog, /- Add changelog automation/);
  assert.ok(changelog.indexOf("## 1.0.2") < changelog.indexOf("## 1.0.1"));
});

test("updates package and lockfile versions", () => {
  withTempDir((directory) => {
    const packagePath = join(directory, "package.json");
    const packageLockPath = join(directory, "package-lock.json");
    writeFileSync(packagePath, '{"name":"devspace","version":"1.0.1"}\n');
    writeFileSync(
      packageLockPath,
      '{"name":"devspace","version":"1.0.1","packages":{"":{"version":"1.0.1"}}}\n',
    );

    updatePackageVersions(packagePath, packageLockPath, "1.0.2");

    assert.equal(JSON.parse(readFileSync(packagePath, "utf8")).version, "1.0.2");
    const packageLock = JSON.parse(readFileSync(packageLockPath, "utf8"));
    assert.equal(packageLock.version, "1.0.2");
    assert.equal(packageLock.packages[""].version, "1.0.2");
  });
});

test("restores release files when the wrapped action fails", () => {
  withTempDir((directory) => {
    const packagePath = join(directory, "package.json");
    const changelogPath = join(directory, "CHANGELOG.md");
    writeFileSync(packagePath, "original package\n");
    writeFileSync(changelogPath, "original changelog\n");

    assert.throws(
      () =>
        withFileRollback([packagePath, changelogPath], () => {
          writeFileSync(packagePath, "changed package\n");
          writeFileSync(changelogPath, "changed changelog\n");
          throw new Error("compile failed");
        }),
      /compile failed/,
    );

    assert.equal(readFileSync(packagePath, "utf8"), "original package\n");
    assert.equal(readFileSync(changelogPath, "utf8"), "original changelog\n");
  });
});

test("restores the previous build directory when compilation fails", () => {
  withTempDir((directory) => {
    const distPath = join(directory, "dist");
    const backupPath = join(directory, "backups");
    writeFileSync(join(mkdir(distPath), "server.js"), "previous build\n");

    assert.throws(
      () =>
        withDirectoryRollback(distPath, backupPath, () => {
          writeFileSync(join(mkdir(distPath), "server.js"), "partial build\n");
          throw new Error("compile failed");
        }),
      /compile failed/,
    );

    assert.equal(readFileSync(join(distPath, "server.js"), "utf8"), "previous build\n");
  });
});

test("keeps the completed build and removes its rollback backup", () => {
  withTempDir((directory) => {
    const distPath = join(directory, "dist");
    const backupPath = join(directory, "backups");
    writeFileSync(join(mkdir(distPath), "server.js"), "previous build\n");

    withDirectoryRollback(distPath, backupPath, () => {
      writeFileSync(join(mkdir(distPath), "server.js"), "completed build\n");
    });

    assert.equal(readFileSync(join(distPath, "server.js"), "utf8"), "completed build\n");
    assert.deepEqual(readdirSync(backupPath), []);
  });
});

function withTempDir(action) {
  const directory = mkdtempSync(join(tmpdir(), "devspace-release-test-"));
  try {
    action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function withTempGitRepo(action) {
  withTempDir((directory) => {
    git(directory, ["init", "-b", "main"]);
    git(directory, ["config", "user.name", "DevSpace Test"]);
    git(directory, ["config", "user.email", "devspace-test@example.invalid"]);
    action(directory);
  });
}

function commitAll(directory, message) {
  git(directory, ["add", "--all"]);
  git(directory, ["commit", "-m", message]);
}

function git(directory, args) {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function mkdir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}
