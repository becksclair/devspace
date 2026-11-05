import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { LocalExecutor } from "./executor.js";
import {
  formatPathForPrompt,
  loadWorkspaceSkills,
  resolveSkillReadPath,
} from "./skills.js";

const root = await mkdtemp(join(tmpdir(), "devspace-skills-test-"));

try {
  const projectRoot = join(root, "project");
  const agentDir = join(root, "agent");
  const explicitSkills = join(root, "explicit-skills");
  await mkdir(join(projectRoot, ".pi", "skills", "project-skill"), { recursive: true });
  await mkdir(join(agentDir, "skills", "global-skill"), { recursive: true });
  await mkdir(join(explicitSkills, "duplicate"), { recursive: true });
  await mkdir(join(explicitSkills, "disabled"), { recursive: true });

  await writeFile(
    join(projectRoot, ".pi", "skills", "project-skill", "SKILL.md"),
    [
      "---",
      "name: project-skill",
      "description: Project skill description.",
      "---",
      "",
      "# Project Skill",
    ].join("\n"),
  );
  await writeFile(
    join(agentDir, "skills", "global-skill", "SKILL.md"),
    [
      "---",
      "name: duplicate-skill",
      "description: First duplicate wins.",
      "---",
      "",
      "# Global Skill",
    ].join("\n"),
  );
  await writeFile(
    join(explicitSkills, "duplicate", "SKILL.md"),
    [
      "---",
      "name: duplicate-skill",
      "description: Duplicate loser.",
      "---",
      "",
      "# Duplicate Skill",
    ].join("\n"),
  );
  await writeFile(
    join(explicitSkills, "disabled", "SKILL.md"),
    [
      "---",
      "name: hidden-skill",
      "description: Hidden skill.",
      "disable-model-invocation: true",
      "---",
      "",
      "# Hidden Skill",
    ].join("\n"),
  );

  const disabledConfig = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SKILL_PATHS: explicitSkills,
    DEVSPACE_SKILLS: "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  assert.deepEqual(loadWorkspaceSkills(disabledConfig, projectRoot).skills, []);

  const config = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SKILL_PATHS: explicitSkills,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const loaded = loadWorkspaceSkills(config, projectRoot);
  assert.equal(loaded.skills.some((skill) => skill.name === "project-skill"), true);
  assert.equal(loaded.skills.filter((skill) => skill.name === "duplicate-skill").length, 1);
  assert.equal(loaded.skills.some((skill) => skill.name === "hidden-skill"), true);
  assert.equal(loaded.diagnostics.some((diagnostic) => diagnostic.type === "collision"), true);

  const projectSkill = loaded.skills.find((skill) => skill.name === "project-skill");
  assert.ok(projectSkill);
  assert.match(formatPathForPrompt(projectSkill.filePath), /SKILL\.md$/);

  const skillFileRead = resolveSkillReadPath(loaded.skills, new Set(), projectSkill.filePath);
  assert.equal(skillFileRead?.isSkillFile, true);
  assert.equal(skillFileRead?.absolutePath, projectSkill.filePath);

  const resourcePath = join(projectSkill.baseDir, "references.md");
  await writeFile(resourcePath, "reference\n");
  assert.equal(resolveSkillReadPath(loaded.skills, new Set(), resourcePath), undefined);
  assert.equal(
    resolveSkillReadPath(loaded.skills, new Set([projectSkill.baseDir]), resourcePath)
      ?.isSkillFile,
    false,
  );

  // Preloaded skills become part of the initial open_workspace response,
  // including their reference-file access without an extra SKILL.md read.
  await writeFile(join(agentDir, "skills", "global-skill", "reference.md"), "preloaded reference\n");
  const autoloadConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "autoload-config"),
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_STATE_DIR: join(root, "autoload-state"),
    DEVSPACE_WORKTREE_ROOT: join(root, "autoload-worktrees"),
    DEVSPACE_GLOBAL_INSTRUCTIONS_FILE: join(root, "missing-global-AGENTS.md"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SKILL_PATHS: explicitSkills,
    DEVSPACE_AUTOLOAD_SKILLS: "duplicate-skill,hidden-skill,missing-skill",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_TERMINAL_USER_SYSTEMD: "0",
    PORT: "1",
  });
  const autoloadExecutor = new LocalExecutor({ config: autoloadConfig });
  try {
    const opened = await autoloadExecutor.execute("open_workspace", { path: projectRoot }, { requestId: "autoload-open" });
    const initialFiles = opened.structuredContent?.agentsFiles as Array<{ path: string; content: string }>;
    assert.equal(initialFiles.some((file) => file.path === formatPathForPrompt(join(agentDir, "skills", "global-skill", "SKILL.md")) && file.content.includes("First duplicate wins.")), true);
    assert.equal(initialFiles.some((file) => file.path.includes("hidden-skill")), false);
    assert.match(opened.content.map((part) => part.type === "text" ? part.text : "").join("\n"), /Autoload skill unavailable: missing-skill/);
    assert.match(opened.content.map((part) => part.type === "text" ? part.text : "").join("\n"), /Autoload skill unavailable: hidden-skill/);
    assert.match(String(opened.structuredContent?.instruction), /already loaded in agentsFiles/);
    const readRef = await autoloadExecutor.execute("read_file", {
      workspaceId: String(opened.structuredContent?.workspaceId),
      path: join(agentDir, "skills", "global-skill", "reference.md"),
    }, { requestId: "autoload-resource-read" });
    assert.match(readRef.content.map((part) => part.type === "text" ? part.text : "").join("\n"), /preloaded reference/);
  } finally {
    autoloadExecutor.close();
  }

  const staleSkill = {
    ...projectSkill,
    filePath: join(root, "missing-skill", "SKILL.md"),
    baseDir: join(root, "missing-skill"),
  };
  assert.equal(
    resolveSkillReadPath([staleSkill, projectSkill], new Set(), projectSkill.filePath)?.skill.name,
    "project-skill",
  );

  if (platform() !== "win32") {
    const outside = join(root, "outside-reference.md");
    const linked = join(projectSkill.baseDir, "outside-link.md");
    await writeFile(outside, "outside\n");
    await symlink(outside, linked);
    assert.equal(resolveSkillReadPath(loaded.skills, new Set([projectSkill.baseDir]), linked), undefined);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
