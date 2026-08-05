import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { createShellRuntime } from "./shell-environment.js";
import { TerminalManager } from "./terminal-manager.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-terminal-test-"));
const stateDir = join(root, "state");
const runtimeDir = join(root, "runtime");
const config = {
  backend: "tmux" as const,
  runtimeDir,
  maxPerWorkspace: 2,
  maxTotal: 3,
  idleTtlSeconds: 3600,
  useUserSystemd: false,
};
const runtime = createShellRuntime({ path: "/bin/bash", mode: "service" }, [], process.env);
let manager = new TerminalManager(config, runtime, stateDir);
let terminalId: string | undefined;

try {
  const started = await manager.start({
    workspaceId: "ws_terminal",
    command: "cat",
    workingDirectory: root,
    cols: 100,
    rows: 30,
  });
  const id = started.terminalId;
  terminalId = id;
  assert.equal(started.status, "active");
  assert.equal(started.persistentAcrossDevspaceRestart, false);

  await manager.write({ workspaceId: "ws_terminal", terminalId: id, text: "hello terminal", submit: true });
  await delay(150);
  const firstRead = await manager.read({ workspaceId: "ws_terminal", terminalId: id, mode: "screen" });
  assert.match(firstRead.output, /hello terminal/);

  const resized = await manager.resize({ workspaceId: "ws_terminal", terminalId: id, cols: 120, rows: 40 });
  assert.equal(resized.cols, 120);
  assert.equal(resized.rows, 40);
  await assert.rejects(() => manager.read({ workspaceId: "wrong", terminalId: id, mode: "screen" }), /Unknown terminalId/);

  manager.closeStore();
  manager = new TerminalManager(config, runtime, stateDir);
  const recovered = await manager.status("ws_terminal", id);
  assert.equal(recovered[0]?.status, "active");
  const recoveredRead = await manager.read({ workspaceId: "ws_terminal", terminalId: id, mode: "history", lines: 100 });
  assert.match(recoveredRead.output, /hello terminal/);

  const closed = await manager.close({ workspaceId: "ws_terminal", terminalId: id });
  assert.equal(closed.status, "closed");
  const summarized = await manager.start({
    workspaceId: "ws_terminal",
    command: "API_KEY=super-secret cat --token also-secret",
    workingDirectory: root,
  });
  assert.equal(summarized.commandSummary, "cat ...");
  assert.equal(summarized.commandSummary.includes("secret"), false);
  await manager.close({ workspaceId: "ws_terminal", terminalId: summarized.terminalId, force: true });
  await assert.rejects(() => manager.read({ workspaceId: "ws_terminal", terminalId: id, mode: "screen" }), /not active/);
  await delay(100);
  await access(runtimeDir);

  const failureState = join(root, "failure-state");
  const failureRuntimeDir = join(root, "failure-runtime");
  const failureManager = new TerminalManager({ ...config, runtimeDir: failureRuntimeDir }, runtime, failureState);
  const failureDb = new Database(join(failureState, "devspace.sqlite"));
  failureDb.exec("create trigger fail_terminal_insert before insert on terminal_sessions begin select raise(abort, 'forced terminal insert failure'); end");
  failureDb.close();
  await assert.rejects(
    () => failureManager.start({ workspaceId: "ws_failure", command: "cat", workingDirectory: root }),
    /forced terminal insert failure/,
  );
  await assert.rejects(
    () => execFileAsync("tmux", ["-S", join(failureRuntimeDir, "tmux.sock"), "list-sessions"]),
  );
  failureManager.closeStore();

  const realTmux = (await execFileAsync("sh", ["-c", "command -v tmux"], { encoding: "utf8" })).stdout.trim();
  const wrapperBin = join(root, "wrapper-bin");
  await mkdir(wrapperBin);
  const wrapperTmux = join(wrapperBin, "tmux");
  await writeFile(wrapperTmux, [
    "#!/bin/sh",
    "for arg in \"$@\"; do",
    "  [ \"$arg\" = kill-session ] && exit 2",
    "done",
    `exec ${realTmux} \"$@\"`,
    "",
  ].join("\n"));
  await chmod(wrapperTmux, 0o755);
  const closeFailureRuntime = createShellRuntime(
    { path: "/bin/bash", mode: "service" },
    [],
    { ...process.env, PATH: `${wrapperBin}:${process.env.PATH ?? ""}` },
  );
  const closeFailureState = join(root, "close-failure-state");
  const closeFailureRuntimeDir = join(root, "close-failure-runtime");
  const closeFailureManager = new TerminalManager({ ...config, runtimeDir: closeFailureRuntimeDir }, closeFailureRuntime, closeFailureState);
  const closeFailureStarted = await closeFailureManager.start({ workspaceId: "ws_close_failure", command: "cat", workingDirectory: root });
  await assert.rejects(
    () => closeFailureManager.close({ workspaceId: "ws_close_failure", terminalId: closeFailureStarted.terminalId, force: true }),
  );
  const afterFailedClose = await closeFailureManager.status("ws_close_failure", closeFailureStarted.terminalId);
  assert.equal(afterFailedClose[0]?.status, "active");
  await execFileAsync(realTmux, ["-S", join(closeFailureRuntimeDir, "tmux.sock"), "kill-server"]);
  closeFailureManager.closeStore();

  const uncertainBin = join(root, "uncertain-bin");
  await mkdir(uncertainBin);
  await writeFile(join(uncertainBin, "systemctl"), "#!/bin/sh\nexit 0\n");
  await writeFile(join(uncertainBin, "systemd-run"), [
    "#!/bin/sh",
    "while [ \"$#\" -gt 0 ] && [ \"$1\" != -- ]; do shift; done",
    "[ \"$#\" -gt 0 ] && shift",
    "\"$@\"",
    "exit 1",
    "",
  ].join("\n"));
  await chmod(join(uncertainBin, "systemctl"), 0o755);
  await chmod(join(uncertainBin, "systemd-run"), 0o755);
  const uncertainRuntime = createShellRuntime(
    { path: "/bin/bash", mode: "service" },
    [],
    { ...process.env, PATH: `${uncertainBin}:${process.env.PATH ?? ""}` },
  );
  const uncertainState = join(root, "uncertain-state");
  const uncertainRuntimeDir = join(root, "uncertain-runtime");
  const uncertainManager = new TerminalManager(
    { ...config, runtimeDir: uncertainRuntimeDir, useUserSystemd: true },
    uncertainRuntime,
    uncertainState,
  );
  const uncertainStarted = await uncertainManager.start({
    workspaceId: "ws_uncertain",
    command: "cat",
    workingDirectory: root,
  });
  assert.equal(uncertainStarted.persistentAcrossDevspaceRestart, true);
  await uncertainManager.close({ workspaceId: "ws_uncertain", terminalId: uncertainStarted.terminalId, force: true });
  uncertainManager.closeStore();
} finally {
  if (terminalId) await manager.close({ workspaceId: "ws_terminal", terminalId, force: true }).catch(() => undefined);
  manager.closeStore();
  await rm(root, { recursive: true, force: true });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
