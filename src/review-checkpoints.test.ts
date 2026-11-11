import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, rename as renameFile, rm, stat, unlink, writeFile } from "node:fs/promises";
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

    // File types come from git's own status, and a rename is one entry.
    await writeFile(join(root, "rename-me.txt"), "a\nb\nc\nd\ne\nf\n");
    await writeFile(join(root, "shrink.txt"), "1\n2\n3\n");
    await writeFile(join(root, "append.txt"), "x\n");
    await writeFile(join(root, "remove-me.txt"), "gone\n");
    const seeded = await restartedManager.reviewChanges({ workspaceId: "ws_review", root });
    assert.deepEqual(seeded.files.map((file) => file.type), ["new", "new", "new", "new"]);

    await renameFile(join(root, "rename-me.txt"), join(root, "renamed.txt"));
    await writeFile(join(root, "renamed.txt"), "a\nb\nc\nd\ne\nf\ng\n");
    await writeFile(join(root, "shrink.txt"), "1\n");
    await writeFile(join(root, "append.txt"), "x\ny\n");
    await unlink(join(root, "remove-me.txt"));
    await writeFile(join(root, "added.txt"), "n\n");
    const mixed = await restartedManager.reviewChanges({ workspaceId: "ws_review", root });
    const byPath = new Map(mixed.files.map((file) => [file.path, file]));
    assert.equal(mixed.files.length, 5);
    assert.deepEqual(byPath.get("renamed.txt"), { path: "renamed.txt", previousPath: "rename-me.txt", type: "rename-changed", additions: 1, removals: 0 });
    assert.deepEqual(byPath.get("shrink.txt"), { path: "shrink.txt", type: "change", additions: 0, removals: 2 });
    assert.deepEqual(byPath.get("append.txt"), { path: "append.txt", type: "change", additions: 1, removals: 0 });
    assert.deepEqual(byPath.get("remove-me.txt"), { path: "remove-me.txt", type: "deleted", additions: 0, removals: 1 });
    assert.deepEqual(byPath.get("added.txt"), { path: "added.txt", type: "new", additions: 1, removals: 0 });
    assert.equal(mixed.result, "Changed 5 files (+3 -3).");

    await renameFile(join(root, "added.txt"), join(root, "moved.txt"));
    const pureRename = await restartedManager.reviewChanges({ workspaceId: "ws_review", root });
    assert.deepEqual(pureRename.files, [{ path: "moved.txt", previousPath: "added.txt", type: "rename-pure", additions: 0, removals: 0 }]);

    // Changed binaries have no line counts, and reordered content can still score 100.
    const binary = Buffer.from(Array.from({ length: 4096 }, (_value, index) => (index * 7 + (index >> 6)) % 256));
    await writeFile(join(root, "logo.bin"), binary);
    await writeFile(join(root, "order.txt"), "alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot\n");
    await restartedManager.reviewChanges({ workspaceId: "ws_review", root });
    binary[100] ^= 0xff;
    await renameFile(join(root, "logo.bin"), join(root, "brand.bin"));
    await writeFile(join(root, "brand.bin"), binary);
    await renameFile(join(root, "order.txt"), join(root, "reordered.txt"));
    await writeFile(join(root, "reordered.txt"), "bravo\nalpha\ncharlie\ndelta\necho\nfoxtrot\n");
    const changedRenames = await restartedManager.reviewChanges({ workspaceId: "ws_review", root });
    assert.deepEqual(changedRenames.files, [
      { path: "brand.bin", previousPath: "logo.bin", type: "rename-changed", additions: 0, removals: 0 },
      { path: "reordered.txt", previousPath: "order.txt", type: "rename-changed", additions: 1, removals: 1 },
    ]);

    // Binary block reordering preserves Git's similarity score without preserving content.
    const blocks = Buffer.concat([Buffer.alloc(64), Buffer.alloc(64, 1)]);
    await writeFile(join(root, "blocks.bin"), blocks);
    await restartedManager.reviewChanges({ workspaceId: "ws_review", root });
    await renameFile(join(root, "blocks.bin"), join(root, "swapped.bin"));
    await writeFile(join(root, "swapped.bin"), Buffer.concat([blocks.subarray(64), blocks.subarray(0, 64)]));
    const reorderedBinary = await restartedManager.reviewChanges({ workspaceId: "ws_review", root });
    assert.match(reorderedBinary.patch, /similarity index 100%/);
    assert.match(reorderedBinary.patch, /GIT binary patch/);
    assert.deepEqual(reorderedBinary.files, [
      { path: "swapped.bin", previousPath: "blocks.bin", type: "rename-changed", additions: 0, removals: 0 },
    ]);

    await renameFile(join(root, "swapped.bin"), join(root, "moved-binary.bin"));
    const pureBinaryRename = await restartedManager.reviewChanges({ workspaceId: "ws_review", root });
    assert.deepEqual(pureBinaryRename.files, [
      { path: "moved-binary.bin", previousPath: "swapped.bin", type: "rename-pure", additions: 0, removals: 0 },
    ]);

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
