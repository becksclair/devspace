import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { git, getGitEligibility, safeWorkspaceRefSegment } from "./git.js";

export type ReviewSince = "last_shown" | "last_review" | "workspace_open";

export interface ReviewSummary {
  files: number;
  additions: number;
  removals: number;
}

export interface ReviewFile {
  path: string;
  previousPath?: string;
  type: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
  additions: number;
  removals: number;
}

export interface ReviewChangesResult {
  result: string;
  summary: ReviewSummary;
  files: ReviewFile[];
  patch: string;
}

interface WorkspaceReviewState {
  root: string;
  canonicalRoot?: string;
  gitRoot?: string;
  sourceObjects?: string;
  shadowGitDir: string;
  openRef: string;
  baselineRef: string;
  diagnostic?: string;
}

interface ReviewMetadata {
  version: 1;
  workspaceId: string;
  canonicalRoot: string;
  gitRoot: string;
  sourceObjects: string;
  createdAt: string;
}

export interface ReviewCheckpointManager {
  initializeWorkspace(input: { workspaceId: string; root: string }): Promise<void>;
  reviewChanges(input: {
    workspaceId: string;
    root: string;
    since?: ReviewSince;
    markReviewed?: boolean;
  }): Promise<ReviewChangesResult>;
  removeWorkspace(input: { workspaceId: string }): Promise<void>;
  status(input: { workspaceId: string }): { initialized: boolean; diagnostic?: string; shadowGitDir?: string };
}

const OPEN_REF = "refs/devspace/open";
const BASELINE_REF = "refs/devspace/baseline";

export function createReviewCheckpointManager(stateDir: string): ReviewCheckpointManager {
  const states = new Map<string, WorkspaceReviewState>();
  const operations = new Map<string, Promise<void>>();
  const reviewRoot = join(stateDir, "reviews");

  const serialize = async <T>(workspaceId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = operations.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => gate);
    operations.set(workspaceId, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (operations.get(workspaceId) === queued) operations.delete(workspaceId);
    }
  };

  const initializeUnlocked = async (workspaceId: string, root: string): Promise<void> => {
    const state = await prepareState(reviewRoot, workspaceId, root);
    states.set(workspaceId, state);
    if (state.diagnostic) return;

    try {
      const env = reviewEnv(state);
      const existingOpen = await resolveReviewRef(root, state.openRef, env);
      const existingBaseline = await resolveReviewRef(root, state.baselineRef, env);
      if (existingOpen && existingBaseline) return;

      const commit = await createWorkingTreeSnapshot(state);
      await git(root, ["update-ref", state.openRef, commit], { env });
      await git(root, ["update-ref", state.baselineRef, commit], { env });
    } catch (error) {
      state.diagnostic = error instanceof Error ? error.message : String(error);
    }
  };


  return {
    async initializeWorkspace({ workspaceId, root }) {
      await serialize(workspaceId, () => initializeUnlocked(workspaceId, root));
    },

    async reviewChanges({ workspaceId, root, since = "last_shown", markReviewed = true }) {
      return serialize(workspaceId, async () => {
        let state = states.get(workspaceId);
        if (!state) {
          await initializeUnlocked(workspaceId, root);
          state = states.get(workspaceId);
        }
        if (!state?.gitRoot || state.diagnostic) {
          throw new Error(state?.diagnostic ?? "show_changes requires a Git workspace in this version.");
        }

        const env = reviewEnv(state);
        const baselineRef = since === "workspace_open" ? state.openRef : state.baselineRef;
        const baseline = (await git(root, ["rev-parse", "--verify", `${baselineRef}^{commit}`], { env })).stdout.trim();
        const current = await createWorkingTreeSnapshot(state);
        const patch = (await git(root, ["diff", "--binary", "--no-color", baseline, current], {
          env,
          maxBuffer: 50 * 1024 * 1024,
        })).stdout;
        const numstat = (await git(root, ["diff", "--numstat", "-z", baseline, current], {
          env,
          maxBuffer: 50 * 1024 * 1024,
        })).stdout;
        const files = parseNumstat(numstat);
        const summary = summarizeFiles(files);

        if (markReviewed) await git(root, ["update-ref", state.baselineRef, current], { env });

        return {
          result: summary.files === 0
            ? `No changes since ${since === "workspace_open" ? "workspace open" : "last shown changes"}.`
            : `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`,
          summary,
          files,
          patch,
        };
      });
    },

    async removeWorkspace({ workspaceId }) {
      await serialize(workspaceId, async () => {
        const state = states.get(workspaceId);
        states.delete(workspaceId);
        const shadowGitDir = state?.shadowGitDir ?? join(reviewRoot, safeWorkspaceRefSegment(workspaceId));
        await rm(shadowGitDir, { recursive: true, force: true });
      });
    },

    status({ workspaceId }) {
      const state = states.get(workspaceId);
      return {
        initialized: Boolean(state?.gitRoot && !state.diagnostic),
        diagnostic: state?.diagnostic,
        shadowGitDir: state?.shadowGitDir,
      };
    },
  };
}

async function prepareState(reviewRoot: string, workspaceId: string, root: string): Promise<WorkspaceReviewState> {
  const shadowGitDir = join(reviewRoot, safeWorkspaceRefSegment(workspaceId));
  const state: WorkspaceReviewState = { root, shadowGitDir, openRef: OPEN_REF, baselineRef: BASELINE_REF };
  const eligibility = await getGitEligibility(root);
  if (!eligibility.ok || !eligibility.gitRoot) {
    state.diagnostic = eligibility.message ?? "show_changes requires a Git workspace in this version.";
    return state;
  }

  try {
    const canonicalRoot = await realpath(root);
    const gitRoot = await realpath(eligibility.gitRoot);
    const rawObjects = (await git(gitRoot, ["rev-parse", "--git-path", "objects"])).stdout.trim();
    const sourceObjects = await realpath(resolve(gitRoot, rawObjects));
    state.canonicalRoot = canonicalRoot;
    state.gitRoot = gitRoot;
    state.sourceObjects = sourceObjects;

    await mkdir(reviewRoot, { recursive: true });
    const exists = await stat(join(shadowGitDir, "HEAD")).then(() => true, () => false);
    if (!exists) await git(reviewRoot, ["init", "--bare", shadowGitDir]);

    await mkdir(join(shadowGitDir, "objects", "info"), { recursive: true });
    await writeFile(join(shadowGitDir, "objects", "info", "alternates"), `${sourceObjects}\n`, { mode: 0o600 });

    const metadataPath = join(shadowGitDir, "devspace-metadata.json");
    const existingMetadata = await readMetadata(metadataPath);
    if (existingMetadata) {
      if (
        existingMetadata.workspaceId !== workspaceId ||
        existingMetadata.canonicalRoot !== canonicalRoot ||
        existingMetadata.gitRoot !== gitRoot ||
        existingMetadata.sourceObjects !== sourceObjects
      ) {
        throw new Error(`Stored review state no longer matches workspace ${workspaceId}`);
      }
    } else {
      const metadata: ReviewMetadata = {
        version: 1,
        workspaceId,
        canonicalRoot,
        gitRoot,
        sourceObjects,
        createdAt: new Date().toISOString(),
      };
      await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600 });
    }
  } catch (error) {
    state.diagnostic = error instanceof Error ? error.message : String(error);
  }
  return state;
}

async function readMetadata(path: string): Promise<ReviewMetadata | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ReviewMetadata;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

async function resolveReviewRef(root: string, ref: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    return (await git(root, ["rev-parse", "--verify", `${ref}^{commit}`], { env })).stdout.trim();
  } catch {
    return undefined;
  }
}

async function createWorkingTreeSnapshot(state: WorkspaceReviewState): Promise<string> {
  if (!state.gitRoot) throw new Error("Review state is not initialized");
  const tempDir = await mkdtemp(join(tmpdir(), "devspace-review-index-"));
  const indexPath = join(tempDir, "index");
  const env = { ...reviewEnv(state), ...checkpointIdentity(), GIT_INDEX_FILE: indexPath };

  try {
    const parent = (await git(state.gitRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    await git(state.root, ["read-tree", parent], { env });
    await git(state.root, ["add", "-A", "--", "."], { env });
    const tree = (await git(state.root, ["write-tree"], { env })).stdout.trim();
    return (await git(state.root, ["commit-tree", tree, "-p", parent, "-m", "DevSpace review snapshot"], { env })).stdout.trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function reviewEnv(state: WorkspaceReviewState): NodeJS.ProcessEnv {
  return {
    GIT_DIR: state.shadowGitDir,
    GIT_WORK_TREE: state.root,
  };
}

function checkpointIdentity(): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: "DevSpace",
    GIT_AUTHOR_EMAIL: "devspace@users.noreply.local",
    GIT_COMMITTER_NAME: "DevSpace",
    GIT_COMMITTER_EMAIL: "devspace@users.noreply.local",
  };
}

function parseNumstat(output: string): ReviewFile[] {
  const fields = output.split("\0").filter((field) => field.length > 0);
  const files: ReviewFile[] = [];
  for (let index = 0; index < fields.length;) {
    const header = fields[index++] ?? "";
    const parts = header.split("\t");
    const additions = parseStatNumber(parts[0]);
    const removals = parseStatNumber(parts[1]);
    if (parts.length >= 3) {
      const path = parts[2] ?? "";
      if (path) files.push({ path, type: fileType(path, undefined, additions, removals), additions, removals });
      continue;
    }
    const previousPath = fields[index++];
    const path = fields[index++];
    if (!path) continue;
    files.push({ path, previousPath, type: fileType(path, previousPath, additions, removals), additions, removals });
  }
  return files;
}

function parseStatNumber(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fileType(_path: string, previousPath: string | undefined, additions: number, removals: number): ReviewFile["type"] {
  if (previousPath) return additions === 0 && removals === 0 ? "rename-pure" : "rename-changed";
  if (additions > 0 && removals === 0) return "new";
  if (additions === 0 && removals > 0) return "deleted";
  return "change";
}

function summarizeFiles(files: ReviewFile[]): ReviewSummary {
  return files.reduce<ReviewSummary>(
    (summary, file) => ({ files: summary.files + 1, additions: summary.additions + file.additions, removals: summary.removals + file.removals }),
    { files: 0, additions: 0, removals: 0 },
  );
}
