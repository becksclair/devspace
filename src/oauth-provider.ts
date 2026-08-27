import { timingSafeEqual, randomBytes, randomUUID, createHash } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { AccessDeniedError, InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  InMemoryOAuthStateStore,
  type OAuthStateStore,
  type StoredOAuthToken,
} from "./oauth-store.js";

export interface OAuthConfig {
  ownerToken: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  scopes: string[];
  allowedRedirectHosts: string[];
  maxRetainedClients?: number;
}

interface AuthorizationCodeRecord {
  clientId: string;
  params: AuthorizationParams;
  expiresAtMs: number;
}

const CODE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RETAINED_CLIENTS = 500;
export const CSRF_COOKIE_NAME = "__Host-devspace-csrf";
const CSRF_TOKEN_BYTES = 32;
const CSRF_MAX_AGE_SECONDS = 600;

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function generateCsrfToken(): string {
  return randomBytes(CSRF_TOKEN_BYTES).toString("hex");
}

function getCsrfCookie(req: Request): string | undefined {
  const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
  if (cookies && typeof cookies[CSRF_COOKIE_NAME] === "string") return cookies[CSRF_COOKIE_NAME];
  // fallback manual parse for environments without cookie-parser
  const header = (req.headers as Record<string, unknown>)?.cookie as string | undefined;
  if (!header || typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (name === CSRF_COOKIE_NAME) return decodeURIComponent(value);
  }
  return undefined;
}

function isSecureRequest(resourceServerUrl: URL): boolean {
  return resourceServerUrl.protocol === "https:";
}

function setCsrfCookie(res: Response, token: string, secure: boolean): void {
  const cookieOpts: Record<string, unknown> = {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: CSRF_MAX_AGE_SECONDS * 1000,
  };
  const anyRes = res as unknown as { cookie?: (name: string, value: string, opts: unknown) => void };
  if (typeof anyRes.cookie === "function") {
    anyRes.cookie(CSRF_COOKIE_NAME, token, cookieOpts);
    return;
  }
  // fallback manual Set-Cookie
  let cookie = `${CSRF_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${CSRF_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax`;
  if (secure) cookie += "; Secure";
  const existing = res.getHeader?.("Set-Cookie");
  if (existing) {
    const arr = Array.isArray(existing) ? existing : [String(existing)];
    res.setHeader("Set-Cookie", [...arr, cookie]);
  } else {
    res.setHeader("Set-Cookie", cookie);
  }
}

function clearCsrfCookie(res: Response, secure: boolean): void {
  const anyRes = res as unknown as { clearCookie?: (name: string, opts: unknown) => void };
  if (typeof anyRes.clearCookie === "function") {
    anyRes.clearCookie(CSRF_COOKIE_NAME, { httpOnly: true, secure, sameSite: "lax" as const, path: "/" });
    return;
  }
  let cookie = `${CSRF_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
  if (secure) cookie += "; Secure";
  const existing = res.getHeader?.("Set-Cookie");
  if (existing) {
    const arr = Array.isArray(existing) ? existing : [String(existing)];
    res.setHeader("Set-Cookie", [...arr, cookie]);
  } else {
    res.setHeader("Set-Cookie", cookie);
  }
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formHtml(params: {
  error?: string;
  clientName: string;
  scopes: string[];
  resource?: URL;
  fields: Record<string, string | undefined>;
}): string {
  const scopeText = params.scopes.length > 0 ? params.scopes.join(" ") : "devspace";
  const resourceText = params.resource?.href ?? "DevSpace MCP endpoint";
  const error = params.error
    ? `<p class="error">${htmlEscape(params.error)}</p>`
    : "";
  const hiddenFields = Object.entries(params.fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `        <input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}" />`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect DevSpace</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
      main { max-width: 440px; margin: 12vh auto; padding: 32px; background: #111827; border: 1px solid #334155; border-radius: 18px; box-shadow: 0 24px 80px rgba(0,0,0,.35); }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p { line-height: 1.5; color: #cbd5e1; }
      dl { padding: 16px; background: #020617; border-radius: 12px; }
      dt { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
      dd { margin: 4px 0 12px; word-break: break-word; }
      label { display: block; margin: 18px 0 8px; font-weight: 600; }
      input { box-sizing: border-box; width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid #475569; background: #020617; color: #e2e8f0; font-size: 16px; }
      button { margin-top: 18px; width: 100%; border: 0; border-radius: 10px; padding: 12px 14px; font-weight: 700; color: #020617; background: #38bdf8; cursor: pointer; }
      .error { color: #fecaca; background: #7f1d1d; border-radius: 10px; padding: 10px 12px; }
      .warning { color: #fde68a; }
    </style>
  </head>
  <body>
    <main>
      <h1>Connect DevSpace</h1>
      <p class="warning">Only approve this if you are intentionally connecting your own ChatGPT or MCP client to this local machine.</p>
      ${error}
      <dl>
        <dt>Client</dt><dd>${htmlEscape(params.clientName)}</dd>
        <dt>Scope</dt><dd>${htmlEscape(scopeText)}</dd>
        <dt>Resource</dt><dd>${htmlEscape(resourceText)}</dd>
      </dl>
      <form method="post">
${hiddenFields}
        <label for="owner_token">Owner password</label>
        <input id="owner_token" name="owner_token" type="password" autocomplete="current-password" autofocus required />
        <button type="submit">Authorize DevSpace</button>
      </form>
    </main>
  </body>
</html>`;
}

function requestedScopesAllowed(requested: string[], supported: string[]): boolean {
  return requested.every((scope) => supported.includes(scope));
}

function redirectHostAllowed(redirectUri: string, allowedHosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }

  if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return true;
  return allowedHosts.includes(parsed.hostname);
}

export class OAuthClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private readonly allowedRedirectHosts: string[],
    private readonly stateStore: OAuthStateStore,
    private readonly maxRetainedClients = DEFAULT_MAX_RETAINED_CLIENTS,
  ) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.stateStore.getClient(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    if (!client.redirect_uris.every((uri) => redirectHostAllowed(uri, this.allowedRedirectHosts))) {
      throw new InvalidRequestError("Client redirect_uri is not allowed for this DevSpace server");
    }

    const now = Math.floor(Date.now() / 1000);
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: `devspace-${randomUUID()}`,
      client_id_issued_at: now,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? "none",
      grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: client.response_types ?? ["code"],
    };
    if (!this.stateStore.saveClientIfBelowLimit(registered, this.maxRetainedClients)) {
      throw new InvalidClientMetadataError("Client registration capacity reached");
    }
    return registered;
  }
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly resourceServerUrl: URL;
  private readonly stateStore: OAuthStateStore;

  constructor(
    private readonly config: OAuthConfig,
    resourceServerUrl: URL,
    stateStore: OAuthStateStore = new InMemoryOAuthStateStore(),
  ) {
    const maxRetainedClients = config.maxRetainedClients ?? DEFAULT_MAX_RETAINED_CLIENTS;
    if (!Number.isSafeInteger(maxRetainedClients) || maxRetainedClients <= 0 ||
      maxRetainedClients > DEFAULT_MAX_RETAINED_CLIENTS) {
      throw new Error("OAuth maxRetainedClients must be an integer between 1 and 500");
    }
    this.resourceServerUrl = resourceUrlFromServerUrl(resourceServerUrl);
    this.stateStore = stateStore;
    this.clientsStore = new OAuthClientsStore(
      config.allowedRedirectHosts,
      stateStore,
      maxRetainedClients,
    );
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    if (!params.resource || !checkResourceAllowed({ requestedResource: params.resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidRequestError("Invalid or missing OAuth resource");
    }
    if (!requestedScopesAllowed(params.scopes ?? [], this.config.scopes)) {
      throw new InvalidRequestError("Requested scope is not supported");
    }

    const secure = isSecureRequest(this.resourceServerUrl);
    if (res.req.method !== "POST") {
      const csrf = generateCsrfToken();
      setCsrfCookie(res, csrf, secure);
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          fields: { ...authorizationFormFields(client, params), csrf_token: csrf },
        }),
      );
      return;
    }

    const cookieCsrf = getCsrfCookie(res.req);
    const bodyCsrf = String((res.req.body as Record<string, unknown>)?.csrf_token ?? "");
    if (!cookieCsrf || !bodyCsrf || !safeEquals(bodyCsrf, cookieCsrf)) {
      const nextCsrf = generateCsrfToken();
      setCsrfCookie(res, nextCsrf, secure);
      res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          error: "Invalid request.",
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          fields: { ...authorizationFormFields(client, params), csrf_token: nextCsrf },
        }),
      );
      return;
    }

    const providedToken = String(res.req.body?.owner_token ?? "");
    if (!safeEquals(providedToken, this.config.ownerToken)) {
      const nextCsrf = generateCsrfToken();
      setCsrfCookie(res, nextCsrf, secure);
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          error: "The Owner password was not accepted.",
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          fields: { ...authorizationFormFields(client, params), csrf_token: nextCsrf },
        }),
      );
      return;
    }

    clearCsrfCookie(res, secure);
    const code = `code-${randomUUID()}`;
    this.codes.set(code, {
      clientId: client.client_id,
      params,
      expiresAtMs: Date.now() + CODE_TTL_MS,
    });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state !== undefined) redirectUrl.searchParams.set("state", params.state);
    res.redirect(302, redirectUrl.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = this.validCodeRecord(client, authorizationCode);
    return record.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.validCodeRecord(client, authorizationCode);
    if (redirectUri && redirectUri !== record.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidGrantError("Invalid resource");
    }

    this.codes.delete(authorizationCode);
    return this.issueTokens(client.client_id, record.params.scopes ?? this.config.scopes, record.params.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const hashedRefreshToken = hashToken(refreshToken);
    const record = this.stateStore.getToken(hashedRefreshToken, "refresh");
    if (!record || record.clientId !== client.client_id || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidGrantError("Invalid resource");
    }

    const requestedScopes = scopes ?? record.scopes;
    if (!requestedScopes.every((scope) => record.scopes.includes(scope))) {
      throw new AccessDeniedError("Refresh token cannot grant requested scopes");
    }

    this.stateStore.deleteToken(hashedRefreshToken, "refresh");
    return this.issueTokens(client.client_id, requestedScopes, resource ?? record.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.stateStore.getToken(hashToken(token), "access");
    if (!record || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidTokenError("Invalid or expired access token");
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hashed = hashToken(request.token);
    this.stateStore.deleteToken(hashed);
  }

  private validCodeRecord(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): AuthorizationCodeRecord {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAtMs < Date.now()) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return record;
  }

  private issueTokens(clientId: string, scopes: string[], resource?: URL): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessExpiresAt = now + this.config.accessTokenTtlSeconds;
    const refreshExpiresAt = now + this.config.refreshTokenTtlSeconds;

    const accessRecord: StoredOAuthToken = {
      tokenHash: hashToken(accessToken),
      tokenType: "access",
      clientId,
      scopes,
      expiresAt: accessExpiresAt,
      resource,
    };
    const refreshRecord: StoredOAuthToken = {
      tokenHash: hashToken(refreshToken),
      tokenType: "refresh",
      clientId,
      scopes,
      expiresAt: refreshExpiresAt,
      resource,
    };

    this.stateStore.saveToken(accessRecord);
    this.stateStore.saveToken(refreshRecord);

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}

function authorizationFormFields(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
): Record<string, string | undefined> {
  return {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    scope: params.scopes?.join(" "),
    state: params.state,
    resource: params.resource?.href,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
