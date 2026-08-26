import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { WorkspaceRegistry, ALWAYS_HEAVY_SKIPPED_DIRS, HOMEDIR_HEAVY_SKIPPED_DIRS, HOMEDIR_MAX_DEPTH, walkWorkspace, isHomedirWorkspaceRoot } from "./workspaces.js";

const root = await mkdtemp(join(tmpdir(), "devspace-opt-test-"));

try {
  // --- unit: walkWorkspace pruning ---

  // helper: collect visited files for a directory
  async function collect(dir: string, opts?: { maxDepth?: number; extraSkippedDirs?: Set<string> }) {
    const files: string[] = [];
    await walkWorkspace(dir, (p, e) => { if (e.isFile()) files.push(p); }, undefined, opts);
    return files.sort();
  }

  // 1) ALWAYS heavy dirs are pruned even without homedir depth
  const alwaysPrunedRoot = join(root, "always-pruned");
  await mkdir(join(alwaysPrunedRoot, "out", "deep"), { recursive: true });
  await mkdir(join(alwaysPrunedRoot, "vendor", "lib"), { recursive: true });
  await mkdir(join(alwaysPrunedRoot, "keep", "sub"), { recursive: true });
  await writeFile(join(alwaysPrunedRoot, "out", "AGENTS.md"), "out\n");
  await writeFile(join(alwaysPrunedRoot, "out", "deep", "AGENTS.md"), "deep\n");
  await writeFile(join(alwaysPrunedRoot, "vendor", "lib", "AGENTS.md"), "vendor\n");
  await writeFile(join(alwaysPrunedRoot, "keep", "AGENTS.md"), "keep\n");
  await writeFile(join(alwaysPrunedRoot, "keep", "sub", "AGENTS.md"), "sub\n");
  // without extraSkipped -> out/vendor WOULD be visited (control)
  const withoutExtra = await collect(alwaysPrunedRoot);
  assert.ok(withoutExtra.includes(join(alwaysPrunedRoot, "out", "AGENTS.md")), "without extraSkipped, out/AGENTS.md should be visited");
  // with ALWAYS_HEAVY pruned -> out/vendor not visited
  const withAlways = await collect(alwaysPrunedRoot, { extraSkippedDirs: ALWAYS_HEAVY_SKIPPED_DIRS });
  assert.equal(withAlways.includes(join(alwaysPrunedRoot, "out", "AGENTS.md")), false, "out/ pruned");
  assert.equal(withAlways.includes(join(alwaysPrunedRoot, "vendor", "lib", "AGENTS.md")), false, "vendor/ pruned");
  assert.ok(withAlways.includes(join(alwaysPrunedRoot, "keep", "AGENTS.md")), "keep/ not pruned");
  assert.ok(withAlways.includes(join(alwaysPrunedRoot, "keep", "sub", "AGENTS.md")), "keep/sub not pruned");

  // 2) HOMEDIR heavy includes src, ALWAYS not include src for non-homedir
  const srcRoot = join(root, "src-test");
  await mkdir(join(srcRoot, "src", "deep"), { recursive: true });
  await mkdir(join(srcRoot, "keep2"), { recursive: true });
  await writeFile(join(srcRoot, "src", "AGENTS.md"), "src root\n");
  await writeFile(join(srcRoot, "src", "deep", "AGENTS.md"), "src deep\n");
  await writeFile(join(srcRoot, "keep2", "AGENTS.md"), "keep2\n");
  const withAlwaysSrc = await collect(srcRoot, { extraSkippedDirs: ALWAYS_HEAVY_SKIPPED_DIRS });
  assert.ok(withAlwaysSrc.includes(join(srcRoot, "src", "AGENTS.md")), "src NOT pruned with ALWAYS set");
  assert.ok(withAlwaysSrc.includes(join(srcRoot, "src", "deep", "AGENTS.md")), "src/deep NOT pruned with ALWAYS");
  const withHomedir = await collect(srcRoot, { extraSkippedDirs: HOMEDIR_HEAVY_SKIPPED_DIRS });
  assert.equal(withHomedir.includes(join(srcRoot, "src", "AGENTS.md")), false, "src pruned with HOMEDIR set");
  assert.equal(withHomedir.includes(join(srcRoot, "src", "deep", "AGENTS.md")), false, "src/deep pruned with HOMEDIR");

  // 3) depth cap
  const deepRoot = join(root, "deep-root");
  await mkdir(join(deepRoot, "a", "b", "c", "d", "e"), { recursive: true });
  await writeFile(join(deepRoot, "a", "AGENTS.md"), "a\n");
  await writeFile(join(deepRoot, "a", "b", "AGENTS.md"), "b\n");
  await writeFile(join(deepRoot, "a", "b", "c", "AGENTS.md"), "c\n");
  await writeFile(join(deepRoot, "a", "b", "c", "d", "AGENTS.md"), "d\n"); // depth 4 parent d file depth? file at 4
  await writeFile(join(deepRoot, "a", "b", "c", "d", "e", "AGENTS.md"), "e\n"); // depth 5 -> should be capped at 4
  const uncapped = await collect(deepRoot);
  assert.ok(uncapped.includes(join(deepRoot, "a", "b", "c", "d", "e", "AGENTS.md")), "uncapped includes e");
  const capped = await collect(deepRoot, { maxDepth: HOMEDIR_MAX_DEPTH });
  assert.ok(capped.includes(join(deepRoot, "a", "AGENTS.md")));
  assert.ok(capped.includes(join(deepRoot, "a", "b", "c", "AGENTS.md")));
  assert.ok(capped.includes(join(deepRoot, "a", "b", "c", "d", "AGENTS.md")), "d is at limit and files inside d are still visited");
  assert.equal(capped.includes(join(deepRoot, "a", "b", "c", "d", "e", "AGENTS.md")), false, "e beyond maxDepth pruned");

  // 4) isHomedirWorkspaceRoot sanity
  assert.equal(isHomedirWorkspaceRoot(homedir()), true);
  assert.equal(isHomedirWorkspaceRoot(join(homedir(), "projects")), false);
  assert.equal(isHomedirWorkspaceRoot(root), false);

  // --- integration: WorkspaceRegistry with homedir-like fixture via mock ---

  // Simulate Brave-scale: create a fake homedir structure under tmp and test that
  // openWorkspace via registry respects heavy skip + depth cap when root is homedir.
  // We do this by directly using walkWorkspace opts the registry would use:
  // For non-homedir project root, src should still be searchable.
  // Build a project root that has src/AGENTS.md and out/AGENTS.md
  const projectRoot = join(root, "my-project");
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await mkdir(join(projectRoot, "out", "build"), { recursive: true });
  await writeFile(join(projectRoot, "AGENTS.md"), "root\n");
  await writeFile(join(projectRoot, "src", "AGENTS.md"), "src-in-project\n");
  await writeFile(join(projectRoot, "out", "AGENTS.md"), "out-in-project\n");

  // Simulate what Registry does for non-homedir (ALWAYS skips out but not src)
  const projectFiles = await collect(projectRoot, { extraSkippedDirs: ALWAYS_HEAVY_SKIPPED_DIRS });
  assert.ok(projectFiles.includes(join(projectRoot, "src", "AGENTS.md")), "project src not pruned (non-homedir)");
  assert.equal(projectFiles.includes(join(projectRoot, "out", "AGENTS.md")), false, "project out pruned even for non-homedir");

  // Also test actual Registry openWorkspace for this project (real integration)
  const agentDir = join(root, ".pi-agent");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(root, ".devspace-reg"), { recursive: true });
  const cfg = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_GLOBAL_INSTRUCTIONS_FILE: join(root, ".devspace-reg", "AGENTS.md"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  await writeFile(join(root, ".devspace-reg", "AGENTS.md"), "global\n");
  const registry = new WorkspaceRegistry(cfg);
  const opened = await registry.openWorkspace(projectRoot);
  // availableAgentsFiles should include src/AGENTS.md but not out/AGENTS.md
  const avail = opened.availableAgentsFiles.map((f) => f.path);
  assert.ok(avail.includes(join(projectRoot, "src", "AGENTS.md")), "Registry: src available for project root");
  assert.equal(avail.includes(join(projectRoot, "out", "AGENTS.md")), false, "Registry: out not available");

  // Verify SKIPPED_CONTEXT_DIRS still pruned via registry (node_modules)
  await mkdir(join(projectRoot, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(projectRoot, "node_modules", "pkg", "AGENTS.md"), "nm\n");
  const opened2 = await registry.openWorkspace({ path: projectRoot, fresh: true });
  const avail2 = opened2.availableAgentsFiles.map((f) => f.path);
  assert.equal(avail2.includes(join(projectRoot, "node_modules", "pkg", "AGENTS.md")), false, "node_modules pruned");

  console.log("✓ all workspace-optimized checks passed");
  console.log(`  HOMEDIR_MAX_DEPTH=${HOMEDIR_MAX_DEPTH}`);
  console.log(`  ALWAYS_HEAVY=${[...ALWAYS_HEAVY_SKIPPED_DIRS].join(",")}`);
  console.log(`  HOMEDIR_HEAVY=${[...HOMEDIR_HEAVY_SKIPPED_DIRS].join(",")}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
