import { and, desc, eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { publicWorkspaceBindings } from "./db/schema.js";

export interface PublicWorkspaceBinding {
  publicWorkspaceId: string;
  machineId: string;
  executorWorkspaceId: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface GatewayWorkspaceStore {
  save(binding: PublicWorkspaceBinding): void;
  get(publicWorkspaceId: string): PublicWorkspaceBinding | undefined;
  findByExecutor(machineId: string, executorWorkspaceId: string): PublicWorkspaceBinding | undefined;
  touch(publicWorkspaceId: string): void;
  delete(publicWorkspaceId: string): void;
  deleteByExecutor(machineId: string, executorWorkspaceId: string): void;
  ping(): void;
  close(): void;
}

export class SqliteGatewayWorkspaceStore implements GatewayWorkspaceStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    this.migrate();
  }

  save(binding: PublicWorkspaceBinding): void {
    this.database.db.insert(publicWorkspaceBindings).values(binding).run();
  }

  get(publicWorkspaceId: string): PublicWorkspaceBinding | undefined {
    const row = this.database.db
      .select()
      .from(publicWorkspaceBindings)
      .where(eq(publicWorkspaceBindings.publicWorkspaceId, publicWorkspaceId))
      .get();
    if (!row) return undefined;
    return row;
  }

  findByExecutor(machineId: string, executorWorkspaceId: string): PublicWorkspaceBinding | undefined {
    return this.database.db
      .select()
      .from(publicWorkspaceBindings)
      .where(and(
        eq(publicWorkspaceBindings.machineId, machineId),
        eq(publicWorkspaceBindings.executorWorkspaceId, executorWorkspaceId),
      ))
      .orderBy(desc(publicWorkspaceBindings.lastUsedAt))
      .get();
  }

  touch(publicWorkspaceId: string): void {
    this.database.db
      .update(publicWorkspaceBindings)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(publicWorkspaceBindings.publicWorkspaceId, publicWorkspaceId))
      .run();
  }

  delete(publicWorkspaceId: string): void {
    this.database.db.delete(publicWorkspaceBindings).where(eq(publicWorkspaceBindings.publicWorkspaceId, publicWorkspaceId)).run();
  }

  deleteByExecutor(machineId: string, executorWorkspaceId: string): void {
    this.database.db.delete(publicWorkspaceBindings).where(and(
      eq(publicWorkspaceBindings.machineId, machineId),
      eq(publicWorkspaceBindings.executorWorkspaceId, executorWorkspaceId),
    )).run();
  }

  ping(): void {
    this.database.sqlite.prepare("select 1").get();
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.sqlite.exec(`
      create table if not exists public_workspace_bindings (
        public_workspace_id text primary key,
        machine_id text not null,
        executor_workspace_id text not null,
        created_at text not null,
        last_used_at text not null
      );

      create index if not exists public_workspace_bindings_machine_idx
        on public_workspace_bindings(machine_id, last_used_at desc);
      create index if not exists public_workspace_bindings_executor_idx
        on public_workspace_bindings(machine_id, executor_workspace_id, last_used_at desc);
    `);
  }
}

export function createGatewayWorkspaceStore(stateDir: string): GatewayWorkspaceStore {
  return new SqliteGatewayWorkspaceStore(stateDir);
}
