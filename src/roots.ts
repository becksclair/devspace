import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";

export type RootAccess = "read-only" | "read-write";

export interface RootPolicy {
  path: string;
  aliases?: string[];
  access: RootAccess;
}

export interface NormalizedRootPolicy {
  id: string;
  path: string;
  aliases: string[];
  access: RootAccess;
  canonicalPath: string;
  logicalPaths: string[];
}

export interface AuthorizedPath {
  logicalPath: string;
  canonicalPath: string;
  policy: NormalizedRootPolicy;
}

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

export function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(expandHomePath(path));
  const resolvedRoot = resolve(expandHomePath(root));
  const relationship = relative(resolvedRoot, resolvedPath);
  return relationship === "" || (!relationship.startsWith("..") && relationship !== ".." && !relationship.includes(`..${sep}`));
}

/** Legacy lexical allowlist helper retained for DevSpace-owned state paths. */
export function assertAllowedPath(path: string, allowedRoots: string[]): string {
  const resolvedPath = resolve(expandHomePath(path));
  if (allowedRoots.some((root) => isPathInsideRoot(resolvedPath, root))) return resolvedPath;
  throw new AccessDeniedError(`Path is outside allowed roots: ${path}`);
}

/** Legacy lexical resolver retained for callers that intentionally pass simple roots. */
export function resolveAllowedPath(inputPath: string, cwd: string, allowedRoots: string[]): string {
  return assertAllowedPath(resolve(cwd, inputPath), allowedRoots);
}

export function rootPoliciesFromStrings(roots: string[]): RootPolicy[] {
  return roots.map((path) => ({ path, access: "read-write" }));
}

export function normalizeRootPolicies(policies: RootPolicy[]): NormalizedRootPolicy[] {
  if (policies.length === 0) throw new Error("At least one root policy is required");

  const logicalOwners = new Map<string, number>();
  const canonicalOwners = new Map<string, number>();

  return policies.map((input, index) => {
    if (input.access !== "read-only" && input.access !== "read-write") {
      throw new Error(`Invalid root access for ${input.path}: ${String(input.access)}`);
    }

    const path = resolve(expandHomePath(input.path));
    assertExistingDirectory(path, `Root policy path does not exist or is not a directory: ${input.path}`);
    const canonicalPath = realpathSync.native(path);
    const aliases = (input.aliases ?? []).map((alias) => resolve(expandHomePath(alias)));

    for (const alias of aliases) {
      assertExistingDirectory(alias, `Root alias does not exist or is not a directory: ${alias}`);
      const aliasCanonical = realpathSync.native(alias);
      if (aliasCanonical !== canonicalPath) {
        throw new Error(`Root alias ${alias} resolves to ${aliasCanonical}, not ${canonicalPath}`);
      }
    }

    const logicalPaths = [path, ...aliases];
    for (const logicalPath of logicalPaths) {
      const owner = logicalOwners.get(logicalPath);
      if (owner !== undefined) throw new Error(`Duplicate root or alias: ${logicalPath}`);
      logicalOwners.set(logicalPath, index);
    }

    const canonicalOwner = canonicalOwners.get(canonicalPath);
    if (canonicalOwner !== undefined) {
      throw new Error(`Multiple root policies resolve to the same canonical path: ${canonicalPath}`);
    }
    canonicalOwners.set(canonicalPath, index);

    return {
      id: rootPolicyId(path, canonicalPath, input.access),
      path,
      aliases,
      access: input.access,
      canonicalPath,
      logicalPaths,
    };
  });
}

export function configuredLogicalRoots(policies: NormalizedRootPolicy[]): string[] {
  return policies.flatMap((policy) => policy.logicalPaths);
}

/**
 * Resolve a workspace or source path through a configured logical root, then
 * authorize its canonical target. This preserves friendly root aliases while
 * refusing undeclared lexical entry points.
 */
export function authorizeWorkspacePath(
  inputPath: string,
  policies: NormalizedRootPolicy[],
  access: "read" | "write",
  options: { allowMissing?: boolean } = {},
): AuthorizedPath {
  const logicalPath = resolve(expandHomePath(inputPath));
  const logicalPolicy = longestLogicalPolicy(logicalPath, policies);
  if (!logicalPolicy) {
    throw new AccessDeniedError(`Path is outside configured logical roots: ${inputPath}`);
  }
  if (!options.allowMissing && !existsSync(logicalPath)) {
    throw new AccessDeniedError(`Path does not exist: ${inputPath}`);
  }

  const canonicalPath = canonicalTarget(logicalPath);
  const policy = longestCanonicalPolicy(canonicalPath, policies);
  if (!policy || (access === "write" && policy.access !== "read-write")) {
    throw new AccessDeniedError(`Canonical target is outside permitted ${access} roots: ${inputPath}`);
  }

  return { logicalPath, canonicalPath, policy };
}

/**
 * Authorize a workspace-relative operation at the moment it is executed.
 * The lexical path must begin in the logical workspace; its canonical target
 * may enter another explicitly configured root when that root grants access.
 */
export function authorizeWorkspaceTarget(
  inputPath: string,
  workspaceRoot: string,
  policies: NormalizedRootPolicy[],
  access: "read" | "write",
): AuthorizedPath {
  const logicalPath = resolve(workspaceRoot, expandHomePath(inputPath));
  if (!isPathInsideRoot(logicalPath, workspaceRoot)) {
    throw new AccessDeniedError(`Path is outside workspace root: ${inputPath}`);
  }

  const canonicalPath = canonicalTarget(logicalPath);
  const policy = longestCanonicalPolicy(canonicalPath, policies);
  if (!policy || (access === "write" && policy.access !== "read-write")) {
    throw new AccessDeniedError(`Canonical target is outside permitted ${access} roots: ${inputPath}`);
  }

  return { logicalPath, canonicalPath, policy };
}

export function policyById(id: string | undefined, policies: NormalizedRootPolicy[]): NormalizedRootPolicy | undefined {
  return id ? policies.find((policy) => policy.id === id) : undefined;
}

export function canonicalTarget(path: string): string {
  const absolute = resolve(expandHomePath(path));
  if (existsSync(absolute)) return realpathSync.native(absolute);

  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new AccessDeniedError(`Path cannot be resolved: ${path}`);
    existing = parent;
  }

  const canonicalParent = realpathSync.native(existing);
  const suffix = relative(existing, absolute);
  if (!suffix || suffix === ".") return canonicalParent;
  if (suffix === ".." || suffix.startsWith(`..${sep}`)) {
    throw new AccessDeniedError(`Path cannot be resolved safely: ${path}`);
  }
  return resolve(canonicalParent, suffix);
}

function longestLogicalPolicy(path: string, policies: NormalizedRootPolicy[]): NormalizedRootPolicy | undefined {
  return policies
    .flatMap((policy) => policy.logicalPaths.map((root) => ({ policy, root })))
    .filter(({ root }) => isPathInsideRoot(path, root))
    .sort((a, b) => b.root.length - a.root.length)[0]?.policy;
}

export function findCanonicalPolicy(path: string, policies: NormalizedRootPolicy[]): NormalizedRootPolicy | undefined {
  return policies
    .filter((policy) => isPathInsideRoot(path, policy.canonicalPath))
    .sort((a, b) => b.canonicalPath.length - a.canonicalPath.length)[0];
}

function longestCanonicalPolicy(path: string, policies: NormalizedRootPolicy[]): NormalizedRootPolicy | undefined {
  return findCanonicalPolicy(path, policies);
}

function assertExistingDirectory(path: string, message: string): void {
  try {
    if (!statSync(path).isDirectory()) throw new Error(message);
  } catch {
    throw new Error(message);
  }
}

function rootPolicyId(path: string, canonicalPath: string, access: RootAccess): string {
  const digest = createHash("sha256").update(`${path}\0${canonicalPath}\0${access}`, "utf8").digest("hex").slice(0, 16);
  return `root_${digest}`;
}
