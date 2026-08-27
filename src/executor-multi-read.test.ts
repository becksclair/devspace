import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { LocalExecutor } from "./executor.js";

const root = await mkdtemp(join(tmpdir(), "devspace-multi-read-test-"));
try {
  const project = join(root, "project");
  const stateDir = join(root, "state");
  await mkdir(project, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_WORKTREE_ROOT: join(root, "worktrees"),
    DEVSPACE_AGENT_DIR: join(root, "agent"),
    DEVSPACE_GLOBAL_INSTRUCTIONS_FILE: join(root, "missing-global-instructions.md"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_LOG_LEVEL: "silent",
    PORT: "1",
  });

  const executor = new LocalExecutor({ config });
  try {
    const opened = await executor.execute("open_workspace", { path: project }, { requestId: "open" });
    const workspaceId = String((opened.structuredContent as { workspaceId: string })?.workspaceId);
    assert.ok(workspaceId);

    // Setup files for basic multi_read test
    await writeFile(join(project, "small.txt"), "hello world\n");
    await writeFile(join(project, "large.txt"), "a".repeat(300 * 1024));

    const result = await executor.execute(
      "multi_read",
      {
        workspaceId,
        reads: [{ path: "small.txt" }, { path: "large.txt" }, { path: "missing.txt" }],
        maxBytesPerFile: 256_000,
        maxTotalBytes: 1_000_000,
      },
      { requestId: "test01", signal: AbortSignal.timeout(5000) },
    );

    assert.equal(result.isError, false, "partial success should not be isError");
    const structured = result.structuredContent as { results: Array<Record<string, unknown>>; totalBytes: number };
    assert.ok(structured);
    assert.equal(structured.results.length, 3);

    const small = structured.results[0] as { status: string; truncated: boolean; bytes: number; content: string };
    const large = structured.results[1] as { status: string; truncated: boolean; bytes: number; content: string };
    const missing = structured.results[2] as { status: string; error: { code: string } };

    assert.equal(small.status, "ok");
    assert.equal(small.truncated, false);
    assert.ok(typeof small.bytes === "number" && small.bytes > 0);
    assert.equal(small.content, "hello world\n");

    assert.equal(large.status, "ok");
    assert.equal(large.truncated, true, "large file should be truncated");
    // bytes should be exactly maxBytesPerFile for ascii
    assert.ok(Math.abs((large.bytes as number) - 256_000) <= 4, `bytes ${large.bytes} should be close to 256000`);
    assert.equal(Buffer.byteLength(large.content, "utf8"), large.bytes);
    assert.equal(large.bytes, 256_000);

    assert.equal(missing.status, "error");

    const expectedTotal = (small.bytes as number) + (large.bytes as number);
    assert.equal(structured.totalBytes, expectedTotal);

    // Edge cases
    // 1. Exactly maxBytesPerFile — use small limit to avoid Pi's 50KB truncate interfering
    await writeFile(join(project, "exact.txt"), "b".repeat(100));
    const exactRes = await executor.execute(
      "multi_read",
      { workspaceId, reads: [{ path: "exact.txt" }], maxBytesPerFile: 100, maxTotalBytes: 1_000_000 },
      { requestId: "exact", signal: AbortSignal.timeout(5000) },
    );
    const exact = (exactRes.structuredContent as { results: Array<Record<string, unknown>> }).results[0] as {
      status: string;
      truncated: boolean;
      bytes: number;
      content: string;
    };
    assert.equal(exact.status, "ok");
    assert.equal(exact.truncated, false, "exact size should not be truncated");
    assert.equal(exact.bytes, 100);
    assert.equal(Buffer.byteLength(exact.content, "utf8"), 100);

    // 2. maxBytesPerFile + 1 — also small limit, this file > max so fast path will truncate
    await writeFile(join(project, "plusone.txt"), "c".repeat(101));
    const plusOneRes = await executor.execute(
      "multi_read",
      { workspaceId, reads: [{ path: "plusone.txt" }], maxBytesPerFile: 100, maxTotalBytes: 1_000_000 },
      { requestId: "plusone", signal: AbortSignal.timeout(5000) },
    );
    const plusOne = (plusOneRes.structuredContent as { results: Array<Record<string, unknown>> }).results[0] as {
      status: string;
      truncated: boolean;
      bytes: number;
      content: string;
    };
    assert.equal(plusOne.status, "ok");
    assert.equal(plusOne.truncated, true, "plus one should be truncated");
    assert.equal(plusOne.bytes, 100);
    assert.equal(Buffer.byteLength(plusOne.content, "utf8"), 100);

    // 3. Multi-byte UTF-8 at boundary
    // Use 'é' which is 2 bytes in utf8. Fill file so that truncation lands mid? Use 256_000 bytes of 'é' -> 128k chars. Add one more char -> truncated.
    // Create file with (128000 * 'é') = 256000 bytes, then plus one 'é' => 256002 bytes
    // But to test boundary slicing, create file with maxBytesPerFile = 10, content = 'a' *8 + 'é' (2 bytes) + 'é' extra beyond => first truncate should cut cleanly.
    await writeFile(join(project, "utf8.txt"), "a".repeat(255_999) + "é" + "é_extra_tail");
    // This file is 255999 +2 + >0 bytes -> >256000
    const utf8Res = await executor.execute(
      "multi_read",
      { workspaceId, reads: [{ path: "utf8.txt" }], maxBytesPerFile: 256_000, maxTotalBytes: 1_000_000 },
      { requestId: "utf8", signal: AbortSignal.timeout(5000) },
    );
    const utf8 = (utf8Res.structuredContent as { results: Array<Record<string, unknown>> }).results[0] as {
      status: string;
      truncated: boolean;
      bytes: number;
      content: string;
    };
    assert.equal(utf8.status, "ok");
    assert.equal(utf8.truncated, true);
    assert.ok(Buffer.byteLength(utf8.content, "utf8") <= 256_000);
    assert.equal(utf8.bytes, Buffer.byteLength(utf8.content, "utf8"));
    // No half char: should be valid utf8, last char not broken
    assert.equal(utf8.content.endsWith("�"), false);

    // More precise utf8 boundary: file exactly 256001 bytes where last byte is part of 2-byte char
    // Create 127999 * 'é' (255998 bytes) + 'a' (1 byte) = 255999, + 'é' (2 bytes) =256001 -> truncated should drop last char cleanly
    const preciseUtf8Content = "é".repeat(127999) + "a" + "é";
    // Verify byte length
    assert.equal(Buffer.byteLength(preciseUtf8Content, "utf8"), 256_001);
    await writeFile(join(project, "utf8-precise.txt"), preciseUtf8Content);
    const preciseRes = await executor.execute(
      "multi_read",
      { workspaceId, reads: [{ path: "utf8-precise.txt" }], maxBytesPerFile: 256_000, maxTotalBytes: 1_000_000 },
      { requestId: "utf8p", signal: AbortSignal.timeout(5000) },
    );
    const precise = (preciseRes.structuredContent as { results: Array<Record<string, unknown>> }).results[0] as {
      status: string;
      truncated: boolean;
      bytes: number;
      content: string;
    };
    assert.equal(precise.status, "ok");
    assert.equal(precise.truncated, true);
    assert.ok(Buffer.byteLength(precise.content, "utf8") <= 256_000);
    assert.equal(precise.bytes, Buffer.byteLength(precise.content, "utf8"));
    // Should have dropped the final 'é' and contain 127999 é + 'a' = 255999 bytes? Actually 127999*2=255998 +1=255999
    // But also could include up to 256000, so might be 255999 or 256000 depending on implementation
    assert.ok(precise.bytes <= 256_000 && precise.bytes >= 255_999);

    // 4. offset/limit on large file should NOT use fast path
    // Use multiline to avoid Pi's 50KB first-line limit interfering with line-based offset/limit
    await writeFile(join(project, "large2.txt"), "x\n".repeat(150 * 1024));
    const slicedRes = await executor.execute(
      "multi_read",
      { workspaceId, reads: [{ path: "large2.txt", offset: 1, limit: 10 }], maxBytesPerFile: 256_000, maxTotalBytes: 1_000_000 },
      { requestId: "sliced", signal: AbortSignal.timeout(5000) },
    );
    const sliced = (slicedRes.structuredContent as { results: Array<Record<string, unknown>> }).results[0] as {
      status: string;
      truncated: boolean;
      bytes: number;
      content: string;
    };
    assert.equal(sliced.status, "ok");
    // limit 10 lines on large file should not be truncated (< max) and must not use fast path
    assert.equal(sliced.truncated, false);
    assert.ok(sliced.bytes < 256_000);
    assert.equal(Buffer.byteLength(sliced.content, "utf8"), sliced.bytes);
    assert.ok(sliced.content.includes("x"));

    console.log("all executor-multi-read checks passed");
  } finally {
    executor.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
