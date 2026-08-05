import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaceSessions = sqliteTable(
  "workspace_sessions",
  {
    id: text("id").primaryKey(),
    root: text("root").notNull(),
    canonicalRoot: text("canonical_root"),
    rootPolicyId: text("root_policy_id"),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("checkout"),
    sourceRoot: text("source_root"),
    sourceCanonicalRoot: text("source_canonical_root"),
    strategy: text("strategy"),
    sourceDirty: text("source_dirty").notNull().default("false"),
    managedDevice: text("managed_device"),
    managedInode: text("managed_inode"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    managed: text("managed").notNull().default("false"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("workspace_sessions_root_idx").on(table.root, table.lastUsedAt),
    index("workspace_sessions_status_idx").on(table.status, table.lastUsedAt),
  ],
);

export const loadedAgentFiles = sqliteTable(
  "loaded_agent_files",
  {
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    loadedAt: text("loaded_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceSessionId, table.path] }),
    index("loaded_agent_files_path_idx").on(table.path),
  ],
);

export const terminalSessions = sqliteTable(
  "terminal_sessions",
  {
    id: text("id").primaryKey(),
    workspaceSessionId: text("workspace_session_id").notNull(),
    backendSessionName: text("backend_session_name").notNull(),
    commandSummary: text("command_summary").notNull(),
    workingDirectory: text("working_directory").notNull(),
    status: text("status").notNull().default("active"),
    cols: integer("cols").notNull(),
    rows: integer("rows").notNull(),
    retainOnWorkspaceClose: text("retain_on_workspace_close").notNull().default("false"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
    closedAt: text("closed_at"),
  },
  (table) => [
    index("terminal_sessions_workspace_idx").on(table.workspaceSessionId, table.lastUsedAt),
    index("terminal_sessions_status_idx").on(table.status, table.lastUsedAt),
  ],
);

export const oauthClients = sqliteTable("oauth_clients", {
  clientId: text("client_id").primaryKey(),
  clientInfo: text("client_info").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const oauthTokens = sqliteTable(
  "oauth_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    tokenType: text("token_type").notNull(),
    clientId: text("client_id").notNull(),
    scopes: text("scopes").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("oauth_tokens_client_idx").on(table.clientId),
    index("oauth_tokens_type_expires_idx").on(table.tokenType, table.expiresAt),
  ],
);

export const publicWorkspaceBindings = sqliteTable(
  "public_workspace_bindings",
  {
    publicWorkspaceId: text("public_workspace_id").primaryKey(),
    machineId: text("machine_id").notNull(),
    executorWorkspaceId: text("executor_workspace_id").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [index("public_workspace_bindings_machine_idx").on(table.machineId, table.lastUsedAt)],
);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
export type TerminalSessionRow = typeof terminalSessions.$inferSelect;
export type NewTerminalSessionRow = typeof terminalSessions.$inferInsert;
export type OAuthClientRow = typeof oauthClients.$inferSelect;
export type OAuthTokenRow = typeof oauthTokens.$inferSelect;
export type PublicWorkspaceBindingRow = typeof publicWorkspaceBindings.$inferSelect;
export type NewPublicWorkspaceBindingRow = typeof publicWorkspaceBindings.$inferInsert;
