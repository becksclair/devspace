import { and, desc, eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { terminalSessions, type TerminalSessionRow } from "./db/schema.js";

export type TerminalStatus = "active" | "closed" | "dead";

export interface TerminalSession {
  id: string;
  workspaceSessionId: string;
  backendSessionName: string;
  commandSummary: string;
  workingDirectory: string;
  status: TerminalStatus;
  cols: number;
  rows: number;
  retainOnWorkspaceClose: boolean;
  createdAt: string;
  lastUsedAt: string;
  closedAt?: string;
}

export class TerminalStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    this.migrate();
  }

  create(input: Omit<TerminalSession, "status" | "createdAt" | "lastUsedAt" | "closedAt">): TerminalSession {
    const now = new Date().toISOString();
    const session: TerminalSession = { ...input, status: "active", createdAt: now, lastUsedAt: now };
    this.database.db.insert(terminalSessions).values({
      id: session.id,
      workspaceSessionId: session.workspaceSessionId,
      backendSessionName: session.backendSessionName,
      commandSummary: session.commandSummary,
      workingDirectory: session.workingDirectory,
      status: session.status,
      cols: session.cols,
      rows: session.rows,
      retainOnWorkspaceClose: String(session.retainOnWorkspaceClose),
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      closedAt: null,
    }).run();
    return session;
  }

  get(id: string): TerminalSession | undefined {
    const row = this.database.db.select().from(terminalSessions).where(eq(terminalSessions.id, id)).get();
    return row ? rowToTerminal(row) : undefined;
  }

  listForWorkspace(workspaceSessionId: string, activeOnly = false): TerminalSession[] {
    const rows = activeOnly
      ? this.database.db.select().from(terminalSessions).where(and(eq(terminalSessions.workspaceSessionId, workspaceSessionId), eq(terminalSessions.status, "active"))).orderBy(desc(terminalSessions.lastUsedAt)).all()
      : this.database.db.select().from(terminalSessions).where(eq(terminalSessions.workspaceSessionId, workspaceSessionId)).orderBy(desc(terminalSessions.lastUsedAt)).all();
    return rows.map(rowToTerminal);
  }

  listActive(): TerminalSession[] {
    return this.database.db.select().from(terminalSessions).where(eq(terminalSessions.status, "active")).orderBy(desc(terminalSessions.lastUsedAt)).all().map(rowToTerminal);
  }

  touch(id: string): void {
    this.database.db.update(terminalSessions).set({ lastUsedAt: new Date().toISOString() }).where(eq(terminalSessions.id, id)).run();
  }

  resize(id: string, cols: number, rows: number): void {
    this.database.db.update(terminalSessions).set({ cols, rows, lastUsedAt: new Date().toISOString() }).where(eq(terminalSessions.id, id)).run();
  }

  mark(id: string, status: TerminalStatus): void {
    const now = new Date().toISOString();
    this.database.db.update(terminalSessions).set({ status, lastUsedAt: now, closedAt: status === "active" ? null : now }).where(eq(terminalSessions.id, id)).run();
  }

  delete(id: string): void {
    this.database.db.delete(terminalSessions).where(eq(terminalSessions.id, id)).run();
  }

  pruneInactiveBefore(cutoff: string): number {
    const result = this.database.sqlite
      .prepare("delete from terminal_sessions where status <> 'active' and last_used_at < ?")
      .run(cutoff);
    return Number(result.changes);
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.sqlite.exec(`
      create table if not exists terminal_sessions (
        id text primary key,
        workspace_session_id text not null,
        backend_session_name text not null,
        command_summary text not null,
        working_directory text not null,
        status text not null default 'active',
        cols integer not null,
        rows integer not null,
        retain_on_workspace_close text not null default 'false',
        created_at text not null,
        last_used_at text not null,
        closed_at text
      );
      create index if not exists terminal_sessions_workspace_idx
        on terminal_sessions(workspace_session_id, last_used_at desc);
      create index if not exists terminal_sessions_status_idx
        on terminal_sessions(status, last_used_at desc);
    `);
  }
}

function rowToTerminal(row: TerminalSessionRow): TerminalSession {
  return {
    id: row.id,
    workspaceSessionId: row.workspaceSessionId,
    backendSessionName: row.backendSessionName,
    commandSummary: row.commandSummary,
    workingDirectory: row.workingDirectory,
    status: row.status === "closed" ? "closed" : row.status === "dead" ? "dead" : "active",
    cols: row.cols,
    rows: row.rows,
    retainOnWorkspaceClose: row.retainOnWorkspaceClose === "true",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    closedAt: row.closedAt ?? undefined,
  };
}
