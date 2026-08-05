import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createReviewCheckpointManager } from "./review-checkpoints.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-review-checkpoints-test-"));
const stateDir = await mkdtemp(join(tmpdir(), "devspace-review-state-test-"));

try {
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial commit"]);

  await chmod(join(root, ".git"), 0o555);
  try {
    const manager = createReviewCheckpointManager(stateDir);
    await manager.initializeWorkspace({ workspaceId: "ws_review", root });
    const managerStatus = manager.status({ workspaceId: "ws_review" });
    assert.equal(managerStatus.initialized, true);
    assert.ok(managerStatus.shadowGitDir?.startsWith(join(stateDir, "reviews")));

    const clean = await manager.reviewChanges({ workspaceId: "ws_review", root });
    assert.equal(clean.summary.files, 0);
    assert.equal(clean.patch, "");

    await writeFile(join(root, "README.md"), "hello\nworld\n");
    await writeFile(join(root, "new.txt"), "new\n");

    const firstReview = await manager.reviewChanges({ workspaceId: "ws_review", root, markReviewed: false });
    assert.equal(firstReview.summary.files, 2);
    assert.equal(firstReview.summary.additions, 2);
    assert.match(firstReview.patch, /world/);

    const restartedManager = createReviewCheckpointManager(stateDir);
    const afterRestart = await Promise.race([
      restartedManager.reviewChanges({ workspaceId: "ws_review", root, markReviewed: true }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("restart review timed out")), 5_000)),
    ]);
    assert.equal(afterRestart.summary.files, 2);

    const concurrent = await Promise.all([
      restartedManager.reviewChanges({ workspaceId: "ws_review", root, markReviewed: false }),
      restartedManager.reviewChanges({ workspaceId: "ws_review", root, markReviewed: false }),
    ]);
    assert.deepEqual(concurrent.map((result) => result.summary.files), [0, 0]);

    const afterReviewed = await restartedManager.reviewChanges({ workspaceId: "ws_review", root });
    assert.equal(afterReviewed.summary.files, 0);

    await assert.rejects(() => access(join(root, ".git", "refs", "devspace")));
    const shadowPath = restartedManager.status({ workspaceId: "ws_review" }).shadowGitDir!;
    assert.equal((await stat(shadowPath)).isDirectory(), true);
    await restartedManager.removeWorkspace({ workspaceId: "ws_review" });
    await assert.rejects(() => access(shadowPath));
  } finally {
    await chmod(join(root, ".git"), 0o755);
  }
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
