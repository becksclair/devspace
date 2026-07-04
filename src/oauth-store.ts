import { eq, and } from "drizzle-orm";
import {
  OAuthClientInformationFullSchema,
  type OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  oauthClients,
  oauthTokens,
  type OAuthClientRow,
  type OAuthTokenRow,
} from "./db/schema.js";

export type OAuthTokenType = "access" | "refresh";

export interface StoredOAuthToken {
  tokenHash: string;
  tokenType: OAuthTokenType;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

export interface OAuthStateStore {
  getClient(clientId: string): OAuthClientInformationFull | undefined;
  saveClient(client: OAuthClientInformationFull): void;
  getToken(tokenHash: string, tokenType: OAuthTokenType): StoredOAuthToken | undefined;
  saveToken(token: StoredOAuthToken): void;
  deleteToken(tokenHash: string, tokenType?: OAuthTokenType): void;
  close?(): void;
}

export class InMemoryOAuthStateStore implements OAuthStateStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly tokens = new Map<string, StoredOAuthToken>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.clients.set(client.client_id, client);
  }

  getToken(tokenHash: string, tokenType: OAuthTokenType): StoredOAuthToken | undefined {
    const token = this.tokens.get(tokenHash);
    return token?.tokenType === tokenType ? token : undefined;
  }

  saveToken(token: StoredOAuthToken): void {
    this.tokens.set(token.tokenHash, token);
  }

  deleteToken(tokenHash: string, tokenType?: OAuthTokenType): void {
    if (!tokenType) {
      this.tokens.delete(tokenHash);
      return;
    }

    const token = this.tokens.get(tokenHash);
    if (token?.tokenType === tokenType) this.tokens.delete(tokenHash);
  }
}

export class SqliteOAuthStateStore implements OAuthStateStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    this.migrate();
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.database.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .get();

    return row ? rowToOAuthClient(row) : undefined;
  }

  saveClient(client: OAuthClientInformationFull): void {
    const now = new Date().toISOString();
    this.database.db
      .insert(oauthClients)
      .values({
        clientId: client.client_id,
        clientInfo: JSON.stringify(client),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: oauthClients.clientId,
        set: {
          clientInfo: JSON.stringify(client),
          updatedAt: now,
        },
      })
      .run();
  }

  getToken(tokenHash: string, tokenType: OAuthTokenType): StoredOAuthToken | undefined {
    const row = this.database.db
      .select()
      .from(oauthTokens)
      .where(and(eq(oauthTokens.tokenHash, tokenHash), eq(oauthTokens.tokenType, tokenType)))
      .get();

    return row ? rowToOAuthToken(row) : undefined;
  }

  saveToken(token: StoredOAuthToken): void {
    this.database.db
      .insert(oauthTokens)
      .values({
        tokenHash: token.tokenHash,
        tokenType: token.tokenType,
        clientId: token.clientId,
        scopes: JSON.stringify(token.scopes),
        expiresAt: token.expiresAt,
        resource: token.resource?.href ?? null,
        createdAt: new Date().toISOString(),
      })
      .run();
  }

  deleteToken(tokenHash: string, tokenType?: OAuthTokenType): void {
    const condition = tokenType
      ? and(eq(oauthTokens.tokenHash, tokenHash), eq(oauthTokens.tokenType, tokenType))
      : eq(oauthTokens.tokenHash, tokenHash);

    this.database.db.delete(oauthTokens).where(condition).run();
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.sqlite.exec(`
      create table if not exists oauth_clients (
        client_id text primary key,
        client_info text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists oauth_tokens (
        token_hash text primary key,
        token_type text not null,
        client_id text not null,
        scopes text not null,
        expires_at integer not null,
        resource text,
        created_at text not null
      );

      create index if not exists oauth_tokens_client_idx
        on oauth_tokens(client_id);

      create index if not exists oauth_tokens_type_expires_idx
        on oauth_tokens(token_type, expires_at);
    `);
  }
}

export function createOAuthStateStore(stateDir: string): OAuthStateStore {
  return new SqliteOAuthStateStore(stateDir);
}

function rowToOAuthClient(row: OAuthClientRow): OAuthClientInformationFull {
  return OAuthClientInformationFullSchema.parse(JSON.parse(row.clientInfo));
}

function rowToOAuthToken(row: OAuthTokenRow): StoredOAuthToken {
  const tokenType = row.tokenType === "refresh" ? "refresh" : "access";
  return {
    tokenHash: row.tokenHash,
    tokenType,
    clientId: row.clientId,
    scopes: JSON.parse(row.scopes) as string[],
    expiresAt: row.expiresAt,
    resource: row.resource ? new URL(row.resource) : undefined,
  };
}
