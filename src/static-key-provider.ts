import { createHash, randomBytes } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

const KEY_PREFIX = "obsk_";
const KEY_RANDOM_BYTES = 32;
export const DEFAULT_KEY_TTL_SECONDS = 365 * 24 * 60 * 60;

export interface MintApiKeyOptions {
  scopes?: string[];
  ttlSeconds?: number;
  keyId?: string;
}

export interface MintedApiKey {
  keyId: string;
  rawKey: string;
  scopes: string[];
  expiresAt: number;
  createdAt: number;
  resource: string;
}

export interface StaticKeyRecord {
  keyId: string;
  keyHash: string;
  subject: string;
  scopes: string[];
  expiresAt: number;
  resource: string;
  createdAt: number;
}

export class StaticKeyStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    this.migrate();
  }

  private migrate(): void {
    this.database.sqlite.exec(`
      create table if not exists api_keys (
        key_id text primary key,
        key_hash text not null unique,
        subject text not null,
        scopes text not null,
        expires_at integer not null,
        resource text not null,
        created_at integer not null
      );

      create index if not exists api_keys_hash_idx
        on api_keys(key_hash);

      create index if not exists api_keys_expires_idx
        on api_keys(expires_at);
    `);
  }

  mint(
    resource: string,
    subject: string,
    options: MintApiKeyOptions & { scopes: string[] },
  ): MintedApiKey {
    const keyId = options.keyId ?? `${KEY_PREFIX}${randomBytes(16).toString("hex")}`;
    const rawKey = `${KEY_PREFIX}${randomBytes(KEY_RANDOM_BYTES).toString("base64url")}`;
    const keyHash = hashKey(rawKey);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + (options.ttlSeconds ?? DEFAULT_KEY_TTL_SECONDS);

    this.database.sqlite
      .prepare(
        `insert into api_keys (key_id, key_hash, subject, scopes, expires_at, resource, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(keyId, keyHash, subject, JSON.stringify(options.scopes), expiresAt, resource, now);

    return {
      keyId,
      rawKey,
      scopes: options.scopes,
      expiresAt,
      createdAt: now,
      resource,
    };
  }

  findByHash(keyHash: string): StaticKeyRecord | undefined {
    const row = this.database.sqlite
      .prepare(`select * from api_keys where key_hash = ?`)
      .get(keyHash) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return rowToRecord(row);
  }

  findById(keyId: string): StaticKeyRecord | undefined {
    const row = this.database.sqlite
      .prepare(`select * from api_keys where key_id = ?`)
      .get(keyId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return rowToRecord(row);
  }

  listAll(): StaticKeyRecord[] {
    const rows = this.database.sqlite
      .prepare(`select * from api_keys order by created_at`)
      .all() as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  deleteById(keyId: string): boolean {
    const result = this.database.sqlite
      .prepare(`delete from api_keys where key_id = ?`)
      .run(keyId);
    return result.changes > 0;
  }

  cleanupExpired(): number {
    const now = Math.floor(Date.now() / 1000);
    const result = this.database.sqlite
      .prepare(`delete from api_keys where expires_at < ?`)
      .run(now);
    return result.changes;
  }

  close(): void {
    this.database.close();
  }
}

export class StaticKeyVerifier implements OAuthTokenVerifier {
  constructor(
    private readonly store: StaticKeyStore,
    private readonly resource: string,
  ) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const keyHash = hashKey(token);
    const record = this.store.findByHash(keyHash);
    if (!record) {
      throw new InvalidTokenError("Invalid or expired static API key");
    }

    const now = Math.floor(Date.now() / 1000);
    if (record.expiresAt < now) {
      throw new InvalidTokenError("Static API key has expired");
    }

    if (record.resource !== this.resource) {
      throw new InvalidTokenError("Static API key is not valid for this resource");
    }

    return {
      token,
      clientId: `static-key:${record.keyId}`,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: new URL(record.resource),
      extra: { subject: record.subject, authMethod: "static-key" },
    };
  }
}

export async function mintApiKey(
  store: StaticKeyStore,
  resource: string,
  options: MintApiKeyOptions & { scopes: string[] },
  supportedScopes: string[],
): Promise<MintedApiKey> {
  if (options.scopes.some((scope) => !supportedScopes.includes(scope))) {
    throw new Error(`Invalid scope: supported scopes are ${supportedScopes.join(", ")}`);
  }
  return store.mint(resource, "vault-owner", options);
}

export function hashKey(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function rowToRecord(row: Record<string, unknown>): StaticKeyRecord {
  return {
    keyId: row.key_id as string,
    keyHash: row.key_hash as string,
    subject: row.subject as string,
    scopes: JSON.parse(row.scopes as string) as string[],
    expiresAt: row.expires_at as number,
    resource: row.resource as string,
    createdAt: row.created_at as number,
  };
}
