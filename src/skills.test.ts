import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { LocalExecutor } from "./executor.js";
import { SqliteOAuthStateStore } from "./oauth-store.js";
import { createServer } from "./server.js";
import {
  formatPathForPrompt,
  loadAutoloadSkillDocuments,
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

  // Autoloaded skills are delivered once per MCP session in the server
  // instructions; open_workspace only unlocks their reference files.
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
    // The MCP initialize check below must not depend on a built dist/ui manifest.
    DEVSPACE_WIDGETS: "off",
    PORT: "1",
  });
  const autoloadExecutor = new LocalExecutor({ config: autoloadConfig });
  try {
    const documents = await loadAutoloadSkillDocuments(autoloadConfig);
    assert.deepEqual(documents.map((doc) => doc.name), ["duplicate-skill"]);
    assert.equal(documents[0]?.path, formatPathForPrompt(join(agentDir, "skills", "global-skill", "SKILL.md")));
    assert.match(documents[0]?.content ?? "", /First duplicate wins\./);

    const opened = await autoloadExecutor.execute("open_workspace", { path: projectRoot }, { requestId: "autoload-open" });
    const initialFiles = opened.structuredContent?.agentsFiles as Array<{ path: string; content: string }>;
    assert.equal(initialFiles.some((file) => file.path.includes("SKILL.md")), false);
    assert.match(opened.content.map((part) => part.type === "text" ? part.text : "").join("\n"), /Autoload skill unavailable: missing-skill/);
    assert.match(opened.content.map((part) => part.type === "text" ? part.text : "").join("\n"), /Autoload skill unavailable: hidden-skill/);
    const instruction = String(opened.structuredContent?.instruction);
    assert.match(instruction, /Autoloaded skills \(duplicate-skill\) were provided in full in the DevSpace server instructions/);
    assert.match(instruction, /do not read their SKILL\.md again/);
    assert.doesNotMatch(instruction, /Read an advertised SKILL\.md before using that skill/);
    assert.match(opened.content.map((part) => part.type === "text" ? part.text : "").join("\n"), /Available skills: .*duplicate-skill \(autoloaded\)/);
    const readRef = await autoloadExecutor.execute("read_file", {
      workspaceId: String(opened.structuredContent?.workspaceId),
      path: join(agentDir, "skills", "global-skill", "reference.md"),
    }, { requestId: "autoload-resource-read" });
    assert.match(readRef.content.map((part) => part.type === "text" ? part.text : "").join("\n"), /preloaded reference/);
  } finally {
    autoloadExecutor.close();
  }

  // MCP initialize carries the autoloaded SKILL.md content, before any workspace is opened.
  const accessToken = "skills-test-access-token";
  const oauthStore = new SqliteOAuthStateStore(autoloadConfig.stateDir);
  oauthStore.saveToken({
    tokenHash: createHash("sha256").update(accessToken).digest("base64url"),
    tokenType: "access",
    clientId: "skills-test",
    scopes: autoloadConfig.oauth.scopes,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    resource: new URL(`${autoloadConfig.publicBaseUrl}/mcp`),
  });
  oauthStore.close();
  const running = createServer(autoloadConfig);
  const httpServer = running.app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("listening", resolve);
      httpServer.once("error", reject);
    });
    const response = await fetch(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "skills-test", version: "1.0.0" } },
      }),
    });
    assert.equal(response.status, 200);
    const dataLine = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
    assert.ok(dataLine);
    const instructions = String((JSON.parse(dataLine.slice("data: ".length)) as { result?: { instructions?: string } }).result?.instructions);
    assert.match(instructions, /## Autoloaded skills/);
    assert.match(instructions, /### Skill duplicate-skill/);
    assert.match(instructions, /First duplicate wins\./);
    assert.doesNotMatch(instructions, /### Skill hidden-skill/);
  } finally {
    httpServer.close();
    running.close?.();
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
