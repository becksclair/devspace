import { execFileSync } from "node:child_process";
import { DEVSPACE_VERSION } from "./version.js";
import { TOOL_CONTRACT_HASH } from "./tool-contract.js";

export const PROTOCOL_MAJOR = 1;
export interface BuildMetadata { protocolMajor: number; packageVersion: string; sourceCommit: string; toolContractHash: string; role?: string; }
function sourceCommit(): string {
  if (process.env.DEVSPACE_SOURCE_COMMIT?.trim()) return process.env.DEVSPACE_SOURCE_COMMIT.trim();
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown"; } catch { return "unknown"; }
}
export function getBuildMetadata(role?: string): BuildMetadata {
  return { protocolMajor: PROTOCOL_MAJOR, packageVersion: DEVSPACE_VERSION, sourceCommit: sourceCommit(), toolContractHash: TOOL_CONTRACT_HASH, ...(role ? { role } : {}) };
}
