import { desc, eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { workspaceSessions, type WorkspaceSessionRow } from "./db/schema.js";

export type WorkspaceMode = "checkout" | "worktree" | "isolated";
export type WorkspaceStrategy = "worktree" | "clone";

export interface WorkspaceSession {
  id: string;
  root: string;
  canonicalRoot?: string;
  rootPolicyId?: string;
  status: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  sourceCanonicalRoot?: string;
  strategy?: WorkspaceStrategy;
  sourceDirty: boolean;
  managedDevice?: string;
  managedInode?: string;
  baseRef?: string;
  baseSha?: string;
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceSessionInput {
  id: string;
  root: string;
  canonicalRoot?: string;
  rootPolicyId?: string;
  mode?: WorkspaceMode;
  sourceRoot?: string;
  sourceCanonicalRoot?: string;
  strategy?: WorkspaceStrategy;
  sourceDirty?: boolean;
  managedDevice?: string;
  managedInode?: string;
  baseRef?: string;
  baseSha?: string;
  managed?: boolean;
}

export interface WorkspaceStore {
  createSession(input: WorkspaceSessionInput): WorkspaceSession;
  getSession(id: string): WorkspaceSession | undefined;
  touchSession(id: string): void;
  closeSession(id: string): void;
  listSessions(status?: string): WorkspaceSession[];
  deleteSession(id: string): void;
  checkpoint(): void;
  close?(): void;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    this.migrate();
  }

  createSession(input: WorkspaceSessionInput): WorkspaceSession {
    const now = new Date().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      root: input.root,
      canonicalRoot: input.canonicalRoot,
      rootPolicyId: input.rootPolicyId,
      status: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      sourceCanonicalRoot: input.sourceCanonicalRoot,
      strategy: input.strategy,
      sourceDirty: input.sourceDirty ?? false,
      managedDevice: input.managedDevice,
      managedInode: input.managedInode,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      managed: input.managed ?? false,
      createdAt: now,
      lastUsedAt: now,
    };

    this.database.db.insert(workspaceSessions).values({
      id: session.id,
      root: session.root,
      canonicalRoot: session.canonicalRoot ?? null,
      rootPolicyId: session.rootPolicyId ?? null,
      status: session.status,
      mode: session.mode,
      sourceRoot: session.sourceRoot ?? null,
      sourceCanonicalRoot: session.sourceCanonicalRoot ?? null,
      strategy: session.strategy ?? null,
      sourceDirty: String(session.sourceDirty),
      managedDevice: session.managedDevice ?? null,
      managedInode: session.managedInode ?? null,
      baseRef: session.baseRef ?? null,
      baseSha: session.baseSha ?? null,
      managed: String(session.managed),
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
    }).run();

    return session;
  }

  getSession(id: string): WorkspaceSession | undefined {
    const row = this.database.db.select().from(workspaceSessions).where(eq(workspaceSessions.id, id)).get();
    return row ? rowToWorkspaceSession(row) : undefined;
  }

  touchSession(id: string): void {
    this.database.db.update(workspaceSessions).set({ lastUsedAt: new Date().toISOString() }).where(eq(workspaceSessions.id, id)).run();
  }

  closeSession(id: string): void {
    this.database.db.update(workspaceSessions).set({ status: "closed", lastUsedAt: new Date().toISOString() }).where(eq(workspaceSessions.id, id)).run();
  }

  listSessions(status?: string): WorkspaceSession[] {
    const rows = status
      ? this.database.db.select().from(workspaceSessions).where(eq(workspaceSessions.status, status)).orderBy(desc(workspaceSessions.lastUsedAt)).all()
      : this.database.db.select().from(workspaceSessions).orderBy(desc(workspaceSessions.lastUsedAt)).all();
    return rows.map(rowToWorkspaceSession);
  }

  deleteSession(id: string): void {
    this.database.db.delete(workspaceSessions).where(eq(workspaceSessions.id, id)).run();
  }

  checkpoint(): void {
    this.database.sqlite.pragma("wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.sqlite.exec(`
      create table if not exists workspace_sessions (
        id text primary key,
        root text not null,
        canonical_root text,
        root_policy_id text,
        status text not null default 'active',
        mode text not null default 'checkout',
        source_root text,
        source_canonical_root text,
        strategy text,
        source_dirty text not null default 'false',
        managed_device text,
        managed_inode text,
        base_ref text,
        base_sha text,
        managed text not null default 'false',
        created_at text not null,
        last_used_at text not null
      );

      create index if not exists workspace_sessions_root_idx
        on workspace_sessions(root, last_used_at desc);

      create index if not exists workspace_sessions_status_idx
        on workspace_sessions(status, last_used_at desc);

      create table if not exists loaded_agent_files (
        workspace_session_id text not null,
        path text not null,
        content_hash text not null,
        content text not null,
        loaded_at text not null,
        last_seen_at text not null,
        primary key (workspace_session_id, path),
        foreign key (workspace_session_id)
          references workspace_sessions(id)
          on delete cascade
      );

      create index if not exists loaded_agent_files_path_idx
        on loaded_agent_files(path);
    `);

    this.addColumnIfMissing("workspace_sessions", "mode", "text not null default 'checkout'");
    this.addColumnIfMissing("workspace_sessions", "canonical_root", "text");
    this.addColumnIfMissing("workspace_sessions", "root_policy_id", "text");
    this.addColumnIfMissing("workspace_sessions", "source_root", "text");
    this.addColumnIfMissing("workspace_sessions", "source_canonical_root", "text");
    this.addColumnIfMissing("workspace_sessions", "strategy", "text");
    this.addColumnIfMissing("workspace_sessions", "source_dirty", "text not null default 'false'");
    this.addColumnIfMissing("workspace_sessions", "managed_device", "text");
    this.addColumnIfMissing("workspace_sessions", "managed_inode", "text");
    this.addColumnIfMissing("workspace_sessions", "base_ref", "text");
    this.addColumnIfMissing("workspace_sessions", "base_sha", "text");
    this.addColumnIfMissing("workspace_sessions", "managed", "text not null default 'false'");
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.database.sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((existingColumn) => existingColumn.name === column)) return;
    this.database.sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
  }
}

export function createWorkspaceStore(stateDir: string): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDir);
}

function rowToWorkspaceSession(row: WorkspaceSessionRow): WorkspaceSession {
  return {
    id: row.id,
    root: row.root,
    canonicalRoot: row.canonicalRoot ?? undefined,
    rootPolicyId: row.rootPolicyId ?? undefined,
    status: row.status,
    mode: row.mode === "worktree" ? "worktree" : row.mode === "isolated" ? "isolated" : "checkout",
    sourceRoot: row.sourceRoot ?? undefined,
    sourceCanonicalRoot: row.sourceCanonicalRoot ?? undefined,
    strategy: row.strategy === "clone" ? "clone" : row.strategy === "worktree" ? "worktree" : undefined,
    sourceDirty: row.sourceDirty === "true",
    managedDevice: row.managedDevice ?? undefined,
    managedInode: row.managedInode ?? undefined,
    baseRef: row.baseRef ?? undefined,
    baseSha: row.baseSha ?? undefined,
    managed: row.managed === "true",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}
