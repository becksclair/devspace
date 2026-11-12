// Seeds the throwaway Git repository that every widget-host scenario operates on.
//
// Each scenario run gets a fresh copy so scenarios are independent and can be deep-linked in any
// order. The repository has a few text and TypeScript files, one binary file, a file with mixed
// line endings, a large generated file for the lazy diff renderer, and three commits of history.

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gitChildEnvironment } from "../../shell-environment.js";
import { LARGE_FILE_PATH, largeFileContent } from "./fixture-content.js";

const execFileAsync = promisify(execFile);

/** A 1x1 PNG. Scenarios append bytes to it so `show_changes` reports a binary modification. */
export const FIXTURE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const COMMITS: Array<{ message: string; files: Record<string, string | Buffer> }> = [
  {
    message: "chore: initial fixture",
    files: {
      "README.md": "# Widget host fixture\n\nA small repository the DevSpace widget host seeds for every scenario.\n",
      "AGENTS.md": "# Fixture instructions\n\nKeep functions small and prefer named exports.\n",
      ".gitignore": "node_modules/\ndist/\n",
      "package.json": `${JSON.stringify({ name: "widget-host-fixture", version: "1.0.0", type: "module" }, null, 2)}\n`,
      "src/index.ts": [
        'import { greet } from "./greeting.js";',
        'import { legacyName } from "./legacy-name.js";',
        "",
        "export function main(): string {",
        '  return greet(legacyName("world"));',
        "}",
        "",
        "console.log(main());",
        "",
      ].join("\n"),
      "src/legacy-name.ts": [
        "// Scenarios rename this file to exercise rename detection.",
        "export function legacyName(name: string): string {",
        "  return name.trim();",
        "}",
        "",
      ].join("\n"),
      "docs/notes.txt": "Release notes\n=============\n\n- First fixture release.\n",
      "docs/mixed-endings.txt": "first line uses CRLF\r\nsecond line uses LF\nthird line uses CRLF\r\nfourth line uses LF\n",
      "assets/logo.png": FIXTURE_PNG,
    },
  },
  {
    message: "feat: add greeting helper",
    files: {
      "src/greeting.ts": [
        "export interface GreetingOptions {",
        "  punctuation?: string;",
        "}",
        "",
        "export function greet(name: string, options: GreetingOptions = {}): string {",
        '  const punctuation = options.punctuation ?? "!";',
        "  return `Hello, ${name}${punctuation}`;",
        "}",
        "",
      ].join("\n"),
    },
  },
  {
    message: "feat: add generated table",
    files: { [LARGE_FILE_PATH]: largeFileContent("original") },
  },
];

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: gitChildEnvironment({
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Widget Host",
      GIT_AUTHOR_EMAIL: "widget-host@example.invalid",
      GIT_COMMITTER_NAME: "Widget Host",
      GIT_COMMITTER_EMAIL: "widget-host@example.invalid",
    }),
  });
}

/** Creates `directory` as a seeded Git repository with three commits. */
export async function seedFixtureRepository(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "--quiet", "--initial-branch=main"]);
  for (const commit of COMMITS) {
    for (const [path, content] of Object.entries(commit.files)) {
      const target = join(directory, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await git(directory, ["add", "--all"]);
    await git(directory, ["commit", "--quiet", "-m", commit.message]);
  }
}
