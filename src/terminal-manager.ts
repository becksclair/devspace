import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TerminalConfig } from "./config.js";
import type { ShellRuntime } from "./shell-environment.js";
import { prepareShellCommand, runConfiguredShell } from "./shell-environment.js";
import { TerminalStore, type TerminalSession } from "./terminal-store.js";

const execFileAsync = promisify(execFile);
const MIN_COLS = 40;
const MAX_COLS = 400;
const MIN_ROWS = 10;
const MAX_ROWS = 200;
const MAX_CAPTURE_LINES = 2_000;
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 128 * 1024;

export interface TerminalStartInput {
  workspaceId: string;
  command: string;
  workingDirectory: string;
  cols?: number;
  rows?: number;
  shellMode?: "service" | "login";
  retainOnWorkspaceClose?: boolean;
}

export interface TerminalReadResult {
  terminal: PublicTerminal;
  output: string;
  truncated: boolean;
}

export interface PublicTerminal {
  terminalId: string;
  workspaceId: string;
  commandSummary: string;
  workingDirectory: string;
  status: "active" | "closed" | "dead";
  cols: number;
  rows: number;
  retainOnWorkspaceClose: boolean;
  createdAt: string;
  lastUsedAt: string;
  closedAt?: string;
  persistentAcrossDevspaceRestart: boolean;
}

export class TerminalManager {
  private readonly store: TerminalStore;
  private readonly socketPath: string;
  private tmuxPath?: string;
  private persistenceAvailable?: boolean;

  constructor(
    private readonly config: TerminalConfig,
    private readonly shellRuntime: ShellRuntime,
    stateDir: string,
  ) {
    this.store = new TerminalStore(stateDir);
    this.socketPath = join(config.runtimeDir, "tmux.sock");
  }

  async start(input: TerminalStartInput): Promise<PublicTerminal> {
    const command = input.command.trim();
    if (!command) throw new Error("terminal command is required");
    if (Buffer.byteLength(command) > MAX_TEXT_BYTES) throw new Error("terminal command is too large");
    await this.ensureRuntime();
    await this.reconcile();

    const workspaceActive = this.store.listForWorkspace(input.workspaceId, true);
    if (workspaceActive.length >= this.config.maxPerWorkspace) {
      throw new Error(`Workspace terminal limit reached (${this.config.maxPerWorkspace})`);
    }
    if (this.store.listActive().length >= this.config.maxTotal) {
      throw new Error(`Executor terminal limit reached (${this.config.maxTotal})`);
    }

    const cols = boundedInteger(input.cols ?? 160, MIN_COLS, MAX_COLS, "cols");
    const rows = boundedInteger(input.rows ?? 50, MIN_ROWS, MAX_ROWS, "rows");
    const terminalId = `term_${randomUUID()}`;
    const backendSessionName = `dsp-${createHash("sha256").update(terminalId).digest("hex").slice(0, 20)}`;
    const shellMode = input.shellMode ?? this.shellRuntime.mode;
    const tmux = await this.resolveTmux();
    const args = [
      "-S", this.socketPath,
      "new-session", "-d",
      "-s", backendSessionName,
      "-x", String(cols),
      "-y", String(rows),
      "-c", input.workingDirectory,
      "--",
      this.shellRuntime.shellPath,
      shellMode === "login" ? "-lc" : "-c",
      prepareShellCommand(this.shellRuntime, command),
    ];

    const persistent = await this.startTmux(tmux, args, backendSessionName);
    try {
      const session = this.store.create({
        id: terminalId,
        workspaceSessionId: input.workspaceId,
        backendSessionName,
        commandSummary: summarizeCommand(command),
        workingDirectory: input.workingDirectory,
        cols,
        rows,
        retainOnWorkspaceClose: input.retainOnWorkspaceClose === true,
      });
      return this.publicTerminal(session, persistent);
    } catch (error) {
      try {
        await this.killBackendSession(tmux, backendSessionName, true);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Failed to persist terminal ${terminalId} and could not remove its tmux session`);
      }
      throw error;
    }
  }

  async read(input: { workspaceId: string; terminalId: string; mode?: "screen" | "history"; lines?: number }): Promise<TerminalReadResult> {
    const session = await this.requireSession(input.workspaceId, input.terminalId);
    const tmux = await this.resolveTmux();
    const lines = boundedInteger(input.lines ?? (input.mode === "history" ? 500 : session.rows), 1, MAX_CAPTURE_LINES, "lines");
    const args = ["-S", this.socketPath, "capture-pane", "-p", "-J", "-t", session.backendSessionName];
    if (input.mode === "history") args.push("-S", `-${lines}`);
    const { stdout } = await this.exec(tmux, args);
    this.store.touch(session.id);
    const bounded = boundOutput(stdout, MAX_CAPTURE_BYTES);
    return {
      terminal: this.publicTerminal(this.store.get(session.id) ?? session, await this.persistentAcrossRestart()),
      output: bounded.output,
      truncated: bounded.truncated,
    };
  }

  async write(input: { workspaceId: string; terminalId: string; text?: string; keys?: string[]; submit?: boolean }): Promise<PublicTerminal> {
    const session = await this.requireSession(input.workspaceId, input.terminalId);
    const tmux = await this.resolveTmux();
    const text = input.text ?? "";
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error("terminal input is too large");
    if (text) {
      const buffer = `dsp-${randomUUID().replaceAll("-", "")}`;
      await this.exec(tmux, ["-S", this.socketPath, "set-buffer", "-b", buffer, "--", text]);
      await this.exec(tmux, ["-S", this.socketPath, "paste-buffer", "-b", buffer, "-t", session.backendSessionName, "-d"]);
    }
    if (input.keys?.length) {
      const keys = input.keys.map(validateKey);
      await this.exec(tmux, ["-S", this.socketPath, "send-keys", "-t", session.backendSessionName, ...keys]);
    }
    if (input.submit) await this.exec(tmux, ["-S", this.socketPath, "send-keys", "-t", session.backendSessionName, "Enter"]);
    this.store.touch(session.id);
    return this.publicTerminal(this.store.get(session.id) ?? session, await this.persistentAcrossRestart());
  }

  async resize(input: { workspaceId: string; terminalId: string; cols: number; rows: number }): Promise<PublicTerminal> {
    const session = await this.requireSession(input.workspaceId, input.terminalId);
    const cols = boundedInteger(input.cols, MIN_COLS, MAX_COLS, "cols");
    const rows = boundedInteger(input.rows, MIN_ROWS, MAX_ROWS, "rows");
    const tmux = await this.resolveTmux();
    await this.exec(tmux, ["-S", this.socketPath, "resize-window", "-t", session.backendSessionName, "-x", String(cols), "-y", String(rows)]);
    this.store.resize(session.id, cols, rows);
    return this.publicTerminal(this.store.get(session.id) ?? { ...session, cols, rows }, await this.persistentAcrossRestart());
  }

  async status(workspaceId: string, terminalId?: string): Promise<PublicTerminal[]> {
    await this.reconcile();
    const persistence = await this.persistentAcrossRestart();
    if (terminalId) return [this.publicTerminal(await this.requireSession(workspaceId, terminalId), persistence)];
    return this.store.listForWorkspace(workspaceId).map((session) => this.publicTerminal(session, persistence));
  }

  async close(input: { workspaceId: string; terminalId: string; force?: boolean }): Promise<PublicTerminal> {
    const session = await this.requireSession(input.workspaceId, input.terminalId, false);
    if (session.status === "active") {
      const tmux = await this.resolveTmux();
      await this.killBackendSession(tmux, session.backendSessionName, input.force === true);
      this.store.mark(session.id, "closed");
    }
    return this.publicTerminal(this.store.get(session.id) ?? { ...session, status: "closed" }, await this.persistentAcrossRestart());
  }

  async closeWorkspace(workspaceId: string): Promise<{ closed: string[]; retained: string[] }> {
    const closed: string[] = [];
    const retained: string[] = [];
    for (const terminal of this.store.listForWorkspace(workspaceId, true)) {
      if (terminal.retainOnWorkspaceClose) {
        retained.push(terminal.id);
        continue;
      }
      await this.close({ workspaceId, terminalId: terminal.id, force: true });
      closed.push(terminal.id);
    }
    return { closed, retained };
  }

  async maintenance(
    now = Date.now(),
    isWorkspaceActive?: (workspaceId: string) => boolean,
  ): Promise<{ dead: number; expired: number; orphaned: number; pruned: number; activeWorkspaceIds: string[] }> {
    const dead = await this.reconcile();
    let expired = 0;
    let orphaned = 0;
    for (const terminal of this.store.listActive()) {
      if (isWorkspaceActive && !isWorkspaceActive(terminal.workspaceSessionId)) {
        await this.close({ workspaceId: terminal.workspaceSessionId, terminalId: terminal.id, force: true });
        orphaned += 1;
        continue;
      }
      if (terminal.retainOnWorkspaceClose) continue;
      if (now - Date.parse(terminal.lastUsedAt) < this.config.idleTtlSeconds * 1000) continue;
      await this.close({ workspaceId: terminal.workspaceSessionId, terminalId: terminal.id, force: true });
      expired += 1;
    }
    const activeWorkspaceIds = Array.from(new Set(this.store.listActive().map((terminal) => terminal.workspaceSessionId)));
    const cutoff = new Date(now - this.config.idleTtlSeconds * 1000).toISOString();
    const pruned = this.store.pruneInactiveBefore(cutoff);
    return { dead, expired, orphaned, pruned, activeWorkspaceIds };
  }

  closeStore(): void {
    this.store.close();
  }

  private async requireSession(workspaceId: string, terminalId: string, requireActive = true): Promise<TerminalSession> {
    const session = this.store.get(terminalId);
    if (!session || session.workspaceSessionId !== workspaceId) throw new Error(`Unknown terminalId for this workspace: ${terminalId}`);
    if (requireActive && session.status !== "active") throw new Error(`Terminal is not active: ${terminalId}`);
    if (session.status === "active" && !(await this.sessionExists(session.backendSessionName))) {
      this.store.mark(session.id, "dead");
      if (requireActive) throw new Error(`Terminal process is no longer running: ${terminalId}`);
      return this.store.get(session.id) ?? { ...session, status: "dead" };
    }
    return session;
  }

  private async reconcile(): Promise<number> {
    let dead = 0;
    for (const session of this.store.listActive()) {
      if (await this.sessionExists(session.backendSessionName)) continue;
      this.store.mark(session.id, "dead");
      dead += 1;
    }
    return dead;
  }

  private async sessionExists(name: string): Promise<boolean> {
    const tmux = await this.resolveTmux();
    return this.backendSessionExists(tmux, name);
  }

  private async backendSessionExists(tmux: string, name: string): Promise<boolean> {
    try {
      await this.exec(tmux, ["-S", this.socketPath, "has-session", "-t", name]);
      return true;
    } catch (error) {
      if (isTmuxMissingSession(error)) return false;
      throw error;
    }
  }

  private async killBackendSession(tmux: string, name: string, force: boolean): Promise<void> {
    if (!force) {
      await this.exec(tmux, ["-S", this.socketPath, "send-keys", "-t", name, "C-c"]).catch(() => undefined);
      await delay(500);
    }
    try {
      await this.exec(tmux, ["-S", this.socketPath, "kill-session", "-t", name]);
    } catch (error) {
      if (await this.backendSessionExists(tmux, name)) throw error;
    }
  }

  private async ensureRuntime(): Promise<void> {
    await mkdir(this.config.runtimeDir, { recursive: true, mode: 0o700 });
    await chmod(this.config.runtimeDir, 0o700);
  }

  private async resolveTmux(): Promise<string> {
    if (this.tmuxPath) return this.tmuxPath;
    const { stdout } = await runConfiguredShell(this.shellRuntime, "command -v tmux", process.cwd(), 5_000);
    const path = stdout.trim();
    if (!path) throw new Error("tmux is not available in the configured shell environment");
    this.tmuxPath = path;
    return path;
  }

  private async startTmux(tmux: string, args: string[], backendSessionName: string): Promise<boolean> {
    const persistent = await this.persistentAcrossRestart();
    if (persistent && await this.tmuxServerExists(tmux)) {
      await this.exec(tmux, args);
      return true;
    }
    if (persistent) {
      const unit = `devspace-tmux-${createHash("sha256").update(this.socketPath).digest("hex").slice(0, 16)}`;
      const environmentPath = join(this.config.runtimeDir, `terminal-${process.pid}-${randomUUID()}.env`);
      await writeFile(environmentPath, systemdEnvironment(this.shellRuntime.environment), { mode: 0o600 });
      try {
        await this.exec("systemd-run", [
          "--user", "--quiet", "--collect",
          `--unit=${unit}`,
          "--property=Type=forking",
          `--property=EnvironmentFile=${environmentPath}`,
          "--",
          tmux,
          ...args,
        ]);
        return true;
      } catch (error) {
        try {
          if (await this.backendSessionExists(tmux, backendSessionName)) return true;
        } catch (verificationError) {
          throw new AggregateError(
            [error, verificationError],
            `systemd-run outcome for terminal ${backendSessionName} could not be verified`,
          );
        }
        this.persistenceAvailable = false;
      } finally {
        await rm(environmentPath, { force: true }).catch(() => undefined);
      }
    }
    await this.exec(tmux, args);
    return false;
  }

  private async tmuxServerExists(tmux: string): Promise<boolean> {
    try {
      await this.exec(tmux, ["-S", this.socketPath, "list-sessions"]);
      return true;
    } catch (error) {
      if (isTmuxMissingSession(error)) return false;
      throw error;
    }
  }

  private async persistentAcrossRestart(): Promise<boolean> {
    if (!this.config.useUserSystemd) return false;
    if (this.persistenceAvailable !== undefined) return this.persistenceAvailable;
    try {
      await runConfiguredShell(this.shellRuntime, "systemctl --user show-environment >/dev/null", process.cwd(), 5_000);
      this.persistenceAvailable = true;
    } catch {
      this.persistenceAvailable = false;
    }
    return this.persistenceAvailable;
  }

  private publicTerminal(session: TerminalSession, persistentAcrossDevspaceRestart: boolean): PublicTerminal {
    return {
      terminalId: session.id,
      workspaceId: session.workspaceSessionId,
      commandSummary: session.commandSummary,
      workingDirectory: session.workingDirectory,
      status: session.status,
      cols: session.cols,
      rows: session.rows,
      retainOnWorkspaceClose: session.retainOnWorkspaceClose,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      closedAt: session.closedAt,
      persistentAcrossDevspaceRestart,
    };
  }

  private async exec(command: string, args: string[]) {
    return execFileAsync(command, args, {
      env: this.shellRuntime.environment,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: MAX_CAPTURE_BYTES * 2,
    });
  }
}


function isTmuxMissingSession(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === 1);
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function validateKey(value: string): string {
  const key = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(key)) throw new Error(`Invalid terminal key: ${value}`);
  return key;
}

function summarizeCommand(command: string): string {
  let normalized = command.replace(/\s+/g, " ").trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+/.test(normalized)) {
    normalized = normalized.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+/, "");
  }
  const executable = normalized.match(/^[^\s;&|]+/)?.[0] ?? "command";
  return normalized === executable ? executable.slice(0, 200) : `${executable.slice(0, 196)} ...`;
}

function boundOutput(output: string, maxBytes: number): { output: string; truncated: boolean } {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= maxBytes) return { output, truncated: false };
  return { output: bytes.subarray(bytes.length - maxBytes).toString("utf8"), truncated: true };
}

function systemdEnvironment(environment: NodeJS.ProcessEnv): string {
  return Object.entries(environment)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && !entry[1].includes("\0") && !entry[1].includes("\n"))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n") + "\n";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
