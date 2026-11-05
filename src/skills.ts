import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import {
  loadSkills,
  type Skill,
  type LoadSkillsResult,
} from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import { canonicalTarget, expandHomePath, isPathInsideRoot } from "./roots.js";

export interface LoadedSkills {
  skills: Skill[];
  diagnostics: LoadSkillsResult["diagnostics"];
}

export interface SkillReadResolution {
  absolutePath: string;
  skill: Skill;
  isSkillFile: boolean;
}

export function loadWorkspaceSkills(config: ServerConfig, cwd: string): LoadedSkills {
  if (!config.skillsEnabled) return { skills: [], diagnostics: [] };

  return loadSkills({
    cwd,
    agentDir: config.agentDir,
    skillPaths: config.skillPaths,
    includeDefaults: true,
  });
}

export const MAX_AUTOLOAD_SKILL_BYTES = 64 * 1024;

export interface AutoloadedSkillDocument {
  name: string;
  path: string;
  content: string;
}

/**
 * Reads the full SKILL.md of each configured autoload skill from the global
 * skill locations (agent dir and configured skill paths, no project skills).
 * Used once per MCP session for the connect-time server instructions.
 */
export async function loadAutoloadSkillDocuments(config: ServerConfig): Promise<AutoloadedSkillDocument[]> {
  const names = config.autoLoadSkills ?? [];
  if (!config.skillsEnabled || names.length === 0) return [];
  const { skills } = loadWorkspaceSkills(config, config.agentDir);
  const documents: AutoloadedSkillDocument[] = [];
  for (const name of names) {
    const skill = skills.find((candidate) => candidate.name === name && !candidate.disableModelInvocation);
    if (!skill) continue;
    try {
      const file = await stat(skill.filePath);
      if (!file.isFile() || file.size > MAX_AUTOLOAD_SKILL_BYTES) continue;
      documents.push({ name, path: formatPathForPrompt(skill.filePath), content: await readFile(skill.filePath, "utf8") });
    } catch {
      continue;
    }
  }
  return documents;
}

export function resolveSkillReadPath(
  skills: Skill[],
  activatedSkillDirs: Set<string>,
  inputPath: string,
): SkillReadResolution | undefined {
  const absolutePath = resolve(expandHomePath(inputPath));
  let canonicalPath: string;
  try {
    canonicalPath = canonicalTarget(absolutePath);
  } catch {
    return undefined;
  }

  for (const skill of skills) {
    let skillFilePath: string;
    try {
      skillFilePath = canonicalTarget(resolve(skill.filePath));
    } catch {
      continue;
    }
    if (canonicalPath === skillFilePath) {
      return { absolutePath: canonicalPath, skill, isSkillFile: true };
    }
  }

  for (const skill of skills) {
    let baseDir: string;
    try {
      baseDir = canonicalTarget(resolve(skill.baseDir));
    } catch {
      continue;
    }
    if (!activatedSkillDirs.has(baseDir)) continue;
    if (!isPathInsideRoot(canonicalPath, baseDir)) continue;

    return { absolutePath: canonicalPath, skill, isSkillFile: false };
  }

  return undefined;
}

export function markSkillActivated(
  activatedSkillDirs: Set<string>,
  skill: Skill,
): void {
  activatedSkillDirs.add(canonicalTarget(resolve(skill.baseDir)));
}

export function formatPathForPrompt(path: string): string {
  const home = resolve(homedir());
  const resolvedPath = resolve(path);

  if (resolvedPath === home) return "~";
  if (resolvedPath.startsWith(`${home}${sep}`)) {
    return `~/${resolvedPath.slice(home.length + 1).split(sep).join("/")}`;
  }

  return resolvedPath.split(sep).join("/");
}
