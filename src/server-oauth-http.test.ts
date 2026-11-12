// Black-box HTTP oracle for DevSpace's OAuth authorization server and /mcp authentication.
//
// This suite pins the behavior a real client can observe today (status codes, the relevant
// response headers, and JSON bodies) so the SDK v2 migration and the later first-party OAuth
// endpoints can be checked against it. It deliberately talks to the server only over HTTP:
// it must not import anything from `@modelcontextprotocol/*` and must not reach into the OAuth
// provider or its stores. Static API keys are minted and revoked through the public CLI.
//
// Cases marked "KNOWN DEFECT" pin current behavior that deviates from the relevant RFC or is
// otherwise questionable. They are recorded, not endorsed; a reimplementation may fix them
// deliberately and update the assertion in the same change.
//
// Never print tokens, authorization codes, client secrets, CSRF tokens, or the owner token.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./config.js";
import { normalizeRootPolicies } from "./roots.js";
import { createServer } from "./server.js";

const stateDir = await mkdtemp(join(tmpdir(), "devspace-oauth-http-test-"));
const ownerToken = randomBytes(24).toString("base64url");

// The issuer, endpoints, and resource are derived from publicBaseUrl, so the listening port has to
// be known before the DevSpace app is created: bind a bare HTTP server first, then attach the app.
const httpServer = createHttpServer();
await new Promise<void>((resolve, reject) => {
  httpServer.once("error", reject);
  httpServer.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
const mcpUrl = `${origin}/mcp`;
const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;

const config = {
  host: "127.0.0.1",
  port: 0,
  oauth: {
    ownerToken,
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 2592000,
    // Two scopes so narrowing on refresh is observable; /mcp requires the first one.
    scopes: ["devspace", "audit"],
    allowedRedirectHosts: ["chatgpt.com"],
  },
  allowedRoots: [process.cwd()],
  rootPolicies: normalizeRootPolicies([{ path: process.cwd(), access: "read-write" }]),
  allowedHosts: ["127.0.0.1"],
  publicBaseUrl: origin,
  minimalTools: true,
  toolNaming: "short",
  widgets: "off",
  annotationProfile: "trusted-owner",
  stateDir,
  worktreeRoot: join(stateDir, "worktrees"),
  skillsEnabled: false,
  skillPaths: [],
  agentDir: stateDir,
  globalInstructionsFile: join(stateDir, "AGENTS.md"),
  shell: { mode: "service" },
  secretNames: ["DEVSPACE_OAUTH_OWNER_TOKEN"],
  terminals: {
    backend: "tmux",
    runtimeDir: join(stateDir, "terminal-runtime"),
    maxPerWorkspace: 2,
    maxTotal: 4,
    idleTtlSeconds: 3600,
    useUserSystemd: false,
  },
  maintenance: {
    intervalSeconds: 3600,
    closedSessionTtlSeconds: 604800,
    checkoutIdleTtlSeconds: 2592000,
    isolatedIdleTtlSeconds: 604800,
  },
  sessions: { idleTtlSeconds: 1800, sweepIntervalSeconds: 60 },
  logging: {
    level: "silent",
    format: "json",
    requests: false,
    assets: false,
    toolCalls: false,
    shellCommands: false,
    // A tunnel-fronted deployment sees clients through a loopback proxy. Every request below
    // carries its own X-Forwarded-For address, so each starts in a fresh rate-limit bucket and
    // the RateLimit-* headers are deterministic.
    trustProxy: "loopback",
  },
} satisfies ServerConfig;

const running = createServer(config);
httpServer.on("request", running.app);

// --- HTTP helpers -----------------------------------------------------------------------------

let clientIpCounter = 0;
function nextClientIp(): string {
  clientIpCounter += 1;
  return `10.${(clientIpCounter >> 16) & 255}.${(clientIpCounter >> 8) & 255}.${clientIpCounter & 255}`;
}

interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  json(): unknown;
}

async function http(path: string, init: RequestInit = {}): Promise<HttpResult> {
  const headers = new Headers(init.headers);
  headers.set("x-forwarded-for", nextClientIp());
  const response = await fetch(`${origin}${path}`, { redirect: "manual", ...init, headers });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: () => JSON.parse(text) as unknown,
  };
}

function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<HttpResult> {
  return http(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function postForm(path: string, fields: Record<string, string | undefined>, headers: Record<string, string> = {}): Promise<HttpResult> {
  return http(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(definedEntries(fields)).toString(),
  });
}

function definedEntries(fields: Record<string, string | undefined>): Array<[string, string]> {
  return Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined);
}

/** A short, credential-free excerpt of a response body for assertion messages. */
function bodyHint(result: HttpResult): string {
  return result.text
    .replace(/("(?:access_token|refresh_token|client_secret|raw_key)"\s*:\s*")[^"]*/g, "$1<redacted>")
    .replace(/(name="csrf_token" value=")[^"]*/g, "$1<redacted>")
    .slice(0, 200);
}

/** Like assert.match, but never prints the (secret) value on failure. */
function assertSecretMatches(value: string | null | undefined, pattern: RegExp, label: string): void {
  assert.ok(typeof value === "string" && pattern.test(value), `${label} does not match ${pattern}`);
}

/** Like assert.notEqual, but never prints the (secret) values on failure. */
function assertSecretsDiffer(left: string, right: string, label: string): void {
  assert.ok(left !== right, label);
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
const CORS_PREFLIGHT_METHODS = "GET,HEAD,PUT,PATCH,POST,DELETE";

function expectedCsp(): string {
  return [
    "default-src 'none'",
    "base-uri 'self'",
    "form-action *",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: ${origin}`,
    `font-src 'self' data: ${origin}`,
    `connect-src 'self' ${origin}`,
    `media-src 'self' ${origin}`,
    "worker-src 'none'",
    "frame-src 'none'",
  ].join("; ");
}

function assertSecurityHeaders(result: HttpResult, label: string): void {
  assert.equal(result.headers.get("content-security-policy"), expectedCsp(), `${label}: CSP`);
  assert.equal(result.headers.get("referrer-policy"), "no-referrer", `${label}: Referrer-Policy`);
  assert.equal(result.headers.get("x-content-type-options"), "nosniff", `${label}: X-Content-Type-Options`);
}

/**
 * An OAuth error body: exactly `error` and `error_description`. `description` is either the exact
 * text or, for SDK schema failures whose text is a serialized Zod issue list, a pattern that only
 * pins the offending field name.
 */
function assertOAuthError(
  result: HttpResult,
  status: number,
  error: string,
  description: string | RegExp,
  label: string,
): void {
  assert.equal(result.status, status, `${label}: status (body ${bodyHint(result)})`);
  assert.equal(result.headers.get("content-type"), JSON_CONTENT_TYPE, `${label}: content-type`);
  const body = result.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["error", "error_description"], `${label}: body keys`);
  assert.equal(body.error, error, `${label}: error code`);
  if (typeof description === "string") assert.equal(body.error_description, description, `${label}: description`);
  else assert.match(String(body.error_description), description, `${label}: description`);
}

function assertRateLimitHeaders(result: HttpResult, limit: number, windowSeconds: number, label: string): void {
  assert.equal(result.headers.get("ratelimit-policy"), `${limit};w=${windowSeconds}`, `${label}: RateLimit-Policy`);
  assert.equal(result.headers.get("ratelimit-limit"), String(limit), `${label}: RateLimit-Limit`);
  assert.equal(result.headers.get("ratelimit-remaining"), String(limit - 1), `${label}: RateLimit-Remaining`);
  const reset = Number(result.headers.get("ratelimit-reset"));
  assert.ok(reset > 0 && reset <= windowSeconds, `${label}: RateLimit-Reset ${reset}`);
}

function assertNoRateLimitHeaders(result: HttpResult, label: string): void {
  for (const name of ["ratelimit-policy", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset"]) {
    assert.equal(result.headers.get(name), null, `${label}: ${name}`);
  }
}

function assertPreflight(result: HttpResult, label: string): void {
  assert.equal(result.status, 204, `${label}: status`);
  assert.equal(result.headers.get("access-control-allow-origin"), "*", `${label}: ACAO`);
  assert.equal(result.headers.get("access-control-allow-methods"), CORS_PREFLIGHT_METHODS, `${label}: ACAM`);
  assert.equal(result.text, "", `${label}: body`);
}

// --- OAuth flow helpers -----------------------------------------------------------------------

interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
  [key: string]: unknown;
}

async function registerPublicClient(redirectUris: string[], extra: Record<string, unknown> = {}): Promise<RegisteredClient> {
  const result = await postJson("/register", {
    client_name: "Oracle client",
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...extra,
  });
  assert.equal(result.status, 201, `register: ${bodyHint(result)}`);
  return result.json() as RegisteredClient;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

type AuthorizeParams = Record<string, string | undefined>;

function authorizeParams(client: RegisteredClient, challenge: string, overrides: AuthorizeParams = {}): AuthorizeParams {
  return {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "devspace audit",
    state: "oracle-state",
    resource: mcpUrl,
    ...overrides,
  };
}

function authorizeGet(params: AuthorizeParams): Promise<HttpResult> {
  return http(`/authorize?${new URLSearchParams(definedEntries(params)).toString()}`);
}

const CSRF_COOKIE = "__Host-devspace-csrf";

function csrfCookieValue(result: HttpResult): string {
  const match = new RegExp(`${CSRF_COOKIE}=([^;]*)`).exec(result.headers.get("set-cookie") ?? "");
  assert.ok(match, "approval page sets the CSRF cookie");
  return decodeURIComponent(match[1]);
}

/** The approval page carries the CSRF token in a hidden `csrf_token` field (headless-auth relies on it). */
async function approvalPage(params: AuthorizeParams): Promise<{ page: HttpResult; csrf: string }> {
  const page = await authorizeGet(params);
  assert.equal(page.status, 200, `approval page: ${bodyHint(page)}`);
  const field = /name="csrf_token" value="([^"]+)"/.exec(page.text);
  assert.ok(field, "approval page has a csrf_token field");
  assert.ok(field[1] === csrfCookieValue(page), "csrf_token field matches the CSRF cookie");
  return { page, csrf: field[1] };
}

function htmlUnescape(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** The approval form's hidden fields in document order: what a browser submits besides the password. */
function hiddenFields(page: HttpResult): Array<[string, string]> {
  return [...page.text.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)" \/>/g)]
    .map((match): [string, string] => [htmlUnescape(match[1]), htmlUnescape(match[2])]);
}

/**
 * Submits the approval form the way a browser would: the form has no `action`, so it posts to the
 * page's own URL, with the hidden fields, the owner password, and the CSRF cookie the page set.
 */
function approveAsBrowser(pagePath: string, page: HttpResult): Promise<HttpResult> {
  return http(pagePath, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `${CSRF_COOKIE}=${csrfCookieValue(page)}` },
    body: new URLSearchParams([...hiddenFields(page), ["owner_token", ownerToken]]).toString(),
  });
}

function approve(params: AuthorizeParams, fields: { owner_token?: string; csrf_token?: string }, cookie?: string): Promise<HttpResult> {
  return postForm("/authorize", { ...params, ...fields }, cookie === undefined ? {} : { cookie: `${CSRF_COOKIE}=${cookie}` });
}

async function authorizationCode(params: AuthorizeParams): Promise<{ code: string; location: URL }> {
  const { csrf } = await approvalPage(params);
  const result = await approve(params, { owner_token: ownerToken, csrf_token: csrf }, csrf);
  assert.equal(result.status, 302, `approval: ${bodyHint(result)}`);
  const location = new URL(result.headers.get("location") ?? "");
  const code = location.searchParams.get("code");
  assert.ok(code, "approval redirect carries a code");
  return { code, location };
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function tokenRequest(fields: Record<string, string | undefined>): Promise<HttpResult> {
  return postForm("/token", fields);
}

async function issueTokens(client: RegisteredClient, overrides: AuthorizeParams = {}): Promise<TokenResponse> {
  const pair = pkcePair();
  const params = authorizeParams(client, pair.challenge, overrides);
  const { code } = await authorizationCode(params);
  const result = await tokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: pair.verifier,
    redirect_uri: params.redirect_uri,
    client_id: client.client_id,
    resource: mcpUrl,
  });
  assert.equal(result.status, 200, `token: ${bodyHint(result)}`);
  return result.json() as TokenResponse;
}

function assertTokenResponse(result: HttpResult, scope: string, label: string): TokenResponse {
  assert.equal(result.status, 200, `${label}: status (body ${bodyHint(result)})`);
  assert.equal(result.headers.get("content-type"), JSON_CONTENT_TYPE, `${label}: content-type`);
  assert.equal(result.headers.get("cache-control"), "no-store", `${label}: Cache-Control`);
  // KNOWN DEFECT: RFC 6749 section 5.1 also requires `Pragma: no-cache`; it is not sent today.
  assert.equal(result.headers.get("pragma"), null, `${label}: Pragma`);
  assert.equal(result.headers.get("access-control-allow-origin"), "*", `${label}: ACAO`);
  const body = result.json() as TokenResponse;
  assert.deepEqual(Object.keys(body).sort(), ["access_token", "expires_in", "refresh_token", "scope", "token_type"], `${label}: keys`);
  assert.equal(body.token_type, "bearer", `${label}: token_type`);
  assert.equal(body.expires_in, 3600, `${label}: expires_in`);
  assert.equal(body.scope, scope, `${label}: scope`);
  assertSecretMatches(body.access_token, /^[A-Za-z0-9_-]{43}$/, `${label}: access_token shape`);
  assertSecretMatches(body.refresh_token, /^[A-Za-z0-9_-]{43}$/, `${label}: refresh_token shape`);
  assertSecretsDiffer(body.access_token, body.refresh_token, `${label}: distinct tokens`);
  return body;
}

// --- /mcp helpers -----------------------------------------------------------------------------

function mcpInitialize(authorization?: string): Promise<HttpResult> {
  return http("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oauth-oracle", version: "1.0.0" } },
    }),
  });
}

async function assertMcpAccepted(token: string, label: string): Promise<void> {
  const result = await mcpInitialize(`Bearer ${token}`);
  assert.equal(result.status, 200, `${label}: status (body ${bodyHint(result)})`);
  assert.equal(result.headers.get("content-type"), "text/event-stream", `${label}: content-type`);
  const sessionId = result.headers.get("mcp-session-id");
  assert.ok(sessionId, `${label}: session id`);
  assert.match(result.text, /"protocolVersion":"2025-06-18"/, `${label}: initialize result`);
  const closed = await http("/mcp", {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}`, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
  });
  assert.equal(closed.status, 200, `${label}: session close`);
}

function wwwAuthenticate(error: string, description: string): string {
  return `Bearer error="${error}", error_description="${description}", scope="devspace", resource_metadata="${resourceMetadataUrl}"`;
}

async function assertMcpRejected(
  authorization: string | undefined,
  status: 401 | 403,
  error: string,
  description: string,
  label: string,
): Promise<void> {
  const result = await mcpInitialize(authorization);
  assert.equal(result.status, status, `${label}: status (body ${bodyHint(result)})`);
  assert.equal(result.headers.get("www-authenticate"), wwwAuthenticate(error, description), `${label}: WWW-Authenticate`);
  assert.equal(result.headers.get("content-type"), JSON_CONTENT_TYPE, `${label}: content-type`);
  assert.equal(result.headers.get("mcp-session-id"), null, `${label}: no session`);
  assert.deepEqual(result.json(), { error, error_description: description }, `${label}: body`);
}

// --- Static keys through the public CLI -------------------------------------------------------

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

function runCli(args: string[], publicBaseUrl = origin): string {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, "auth", ...args, "--state-dir", stateDir], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: stateDir,
      DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
      DEVSPACE_OAUTH_SCOPES: config.oauth.scopes.join(","),
    },
  });
  // stdout carries the raw key; never include it in a failure message.
  assert.equal(result.status, 0, `devspace auth ${args[0]} failed: ${result.stderr.slice(0, 300)}`);
  return result.stdout;
}

interface MintedKey {
  key_id: string;
  raw_key: string;
  scopes: string[];
  expires_at: number;
  resource: string;
}

function mintStaticKey(options: { scope?: string; ttlSeconds?: number; publicBaseUrl?: string } = {}): MintedKey {
  const args = ["mint-key", "--json"];
  if (options.scope) args.push("--scope", options.scope);
  if (options.ttlSeconds) args.push("--ttl", String(options.ttlSeconds));
  return JSON.parse(runCli(args, options.publicBaseUrl)) as MintedKey;
}

// --- Tests ------------------------------------------------------------------------------------

try {
  // Minted first so it has expired by the time the static-key cases run.
  const shortLivedKey = mintStaticKey({ ttlSeconds: 1 });

  // 1. Discovery ------------------------------------------------------------------------------

  const protectedResource = await http("/.well-known/oauth-protected-resource/mcp");
  assert.equal(protectedResource.status, 200);
  assert.equal(protectedResource.headers.get("content-type"), JSON_CONTENT_TYPE);
  assert.equal(protectedResource.headers.get("access-control-allow-origin"), "*");
  assertSecurityHeaders(protectedResource, "protected resource metadata");
  assert.deepEqual(protectedResource.json(), {
    resource: mcpUrl,
    authorization_servers: [`${origin}/`],
    scopes_supported: ["devspace", "audit"],
    resource_name: "DevSpace",
  });

  const authorizationServer = await http("/.well-known/oauth-authorization-server");
  assert.equal(authorizationServer.status, 200);
  assert.equal(authorizationServer.headers.get("content-type"), JSON_CONTENT_TYPE);
  assert.equal(authorizationServer.headers.get("access-control-allow-origin"), "*");
  assertSecurityHeaders(authorizationServer, "authorization server metadata");
  assert.deepEqual(authorizationServer.json(), {
    issuer: `${origin}/`,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    revocation_endpoint: `${origin}/revoke`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    scopes_supported: ["devspace", "audit"],
    revocation_endpoint_auth_methods_supported: ["client_secret_post"],
  });

  // Only the two documents above are served. Every other well-known variant is Express's
  // default 404 page.
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server/mcp",
    "/.well-known/openid-configuration",
    "/.well-known/openid-configuration/mcp",
    "/mcp/.well-known/oauth-protected-resource",
  ]) {
    const missing = await http(path);
    assert.equal(missing.status, 404, `${path}: status`);
    assert.equal(missing.headers.get("content-type"), HTML_CONTENT_TYPE, `${path}: content-type`);
  }

  // 2. Dynamic client registration -----------------------------------------------------------

  const loopbackRedirect = "http://127.0.0.1:43123/callback";
  const registration = await postJson("/register", {
    client_name: "Oracle client",
    redirect_uris: [loopbackRedirect],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "devspace audit",
  });
  assert.equal(registration.status, 201);
  assert.equal(registration.headers.get("content-type"), JSON_CONTENT_TYPE);
  assert.equal(registration.headers.get("cache-control"), "no-store");
  assert.equal(registration.headers.get("access-control-allow-origin"), "*");
  assertSecurityHeaders(registration, "registration");
  assertRateLimitHeaders(registration, 20, 3600, "registration");
  const client = registration.json() as RegisteredClient;
  assert.match(client.client_id, /^devspace-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(typeof client.client_id_issued_at, "number");
  assert.ok(Math.abs((client.client_id_issued_at as number) - Date.now() / 1000) < 60);
  assert.deepEqual({ ...client, client_id: undefined, client_id_issued_at: undefined }, {
    client_id: undefined,
    client_id_issued_at: undefined,
    client_name: "Oracle client",
    redirect_uris: [loopbackRedirect],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "devspace audit",
  });

  // Defaults: grant and response types are filled in.
  const allowedHostClient = await postJson("/register", {
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    token_endpoint_auth_method: "none",
  });
  assert.equal(allowedHostClient.status, 201);
  const allowedHostBody = allowedHostClient.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(allowedHostBody).sort(), [
    "client_id", "client_id_issued_at", "grant_types", "redirect_uris", "response_types", "token_endpoint_auth_method",
  ]);
  assert.deepEqual(allowedHostBody.grant_types, ["authorization_code", "refresh_token"]);
  assert.deepEqual(allowedHostBody.response_types, ["code"]);

  // A registration that omits token_endpoint_auth_method is a public client: no secret, reported
  // as "none". It completes /token and /revoke without a secret (see the revocation cases below).
  const publicByDefault = await postJson("/register", { redirect_uris: ["http://localhost:43124/cb"] });
  assert.equal(publicByDefault.status, 201);
  const publicByDefaultBody = publicByDefault.json() as RegisteredClient;
  assert.deepEqual(Object.keys(publicByDefaultBody).sort(), [
    "client_id", "client_id_issued_at", "grant_types", "redirect_uris", "response_types", "token_endpoint_auth_method",
  ]);
  assert.equal(publicByDefaultBody.token_endpoint_auth_method, "none");

  // client_secret_post is issued a 32-byte hex secret that expires after 30 days.
  const confidentialRegistration = await postJson("/register", {
    redirect_uris: ["http://localhost:43124/cb"],
    token_endpoint_auth_method: "client_secret_post",
  });
  assert.equal(confidentialRegistration.status, 201);
  const confidentialBody = confidentialRegistration.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(confidentialBody).sort(), [
    "client_id", "client_id_issued_at", "client_secret", "client_secret_expires_at", "grant_types",
    "redirect_uris", "response_types", "token_endpoint_auth_method",
  ]);
  assert.equal(confidentialBody.token_endpoint_auth_method, "client_secret_post");
  assertSecretMatches(String(confidentialBody.client_secret), /^[0-9a-f]{64}$/, "issued client_secret");
  assert.equal(
    confidentialBody.client_secret_expires_at,
    (confidentialBody.client_id_issued_at as number) + 30 * 24 * 60 * 60,
  );

  // A redirect host outside the allowlist is invalid_redirect_uri (RFC 7591 section 3.2.2).
  const disallowedHost = await postJson("/register", { redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" });
  assertOAuthError(disallowedHost, 400, "invalid_redirect_uri", "Client redirect_uri is not allowed for this DevSpace server", "register disallowed host");
  assert.equal(disallowedHost.headers.get("cache-control"), "no-store");
  assert.equal(disallowedHost.headers.get("access-control-allow-origin"), "*");

  // A non-loopback host is rejected even over http when it is not allowlisted; one disallowed URI
  // among allowed ones rejects the whole registration.
  assertOAuthError(
    await postJson("/register", { redirect_uris: [loopbackRedirect, "http://chatgpt.example/cb"], token_endpoint_auth_method: "none" }),
    400, "invalid_redirect_uri", "Client redirect_uri is not allowed for this DevSpace server", "register mixed redirects",
  );
  assertOAuthError(
    await postJson("/register", { redirect_uris: ["javascript:alert(1)"] }),
    400, "invalid_client_metadata", /redirect_uris[\s\S]*javascript:, data:, or vbscript:/, "register javascript: redirect",
  );
  assertOAuthError(
    await postJson("/register", { redirect_uris: ["not a url"] }),
    400, "invalid_client_metadata", /redirect_uris/, "register unparsable redirect",
  );
  assertOAuthError(
    await postJson("/register", { client_name: "no redirects" }),
    400, "invalid_client_metadata", /redirect_uris/, "register missing redirect_uris",
  );
  assertOAuthError(
    await postJson("/register", { redirect_uris: [loopbackRedirect], grant_types: "authorization_code" }),
    400, "invalid_client_metadata", /grant_types/, "register non-array grant_types",
  );
  const nonJsonRegistration = await http("/register", { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" });
  assertOAuthError(nonJsonRegistration, 400, "invalid_client_metadata", /expected object/, "register non-JSON body");
  assert.equal(nonJsonRegistration.headers.get("cache-control"), "no-store");

  // 3. /authorize -----------------------------------------------------------------------------

  const pair = pkcePair();
  const baseParams = authorizeParams(client, pair.challenge);

  const page = await authorizeGet(baseParams);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), HTML_CONTENT_TYPE);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assertSecurityHeaders(page, "approval page");
  assertRateLimitHeaders(page, 100, 900, "approval page");
  // The CSRF cookie is HttpOnly, SameSite=Lax, Path=/, 600 s; Secure only when the public URL is https.
  assertSecretMatches(
    page.headers.get("set-cookie"),
    new RegExp(`^${CSRF_COOKIE}=[0-9a-f]{64}; Max-Age=600; Path=/; Expires=[^;]+; HttpOnly; SameSite=Lax$`),
    "approval page Set-Cookie",
  );
  assert.equal(page.headers.get("access-control-allow-origin"), null);
  assertSecretMatches(page.text, /name="csrf_token" value="[0-9a-f]{64}"/, "approval page csrf_token field");
  assertSecretMatches(page.text, /name="owner_token"/, "approval page owner_token field");
  // The hidden fields carry the request back unchanged, so the hand-built approvals below submit
  // what the page itself would.
  assert.deepEqual(
    hiddenFields(page).filter(([name]) => name !== "csrf_token"),
    definedEntries(baseParams),
    "approval page hidden fields",
  );

  // Pre-redirect failures are direct 400 JSON responses and never redirect.
  const noClient = await authorizeGet({ ...baseParams, client_id: undefined });
  assertOAuthError(noClient, 400, "invalid_request", /client_id/, "authorize missing client_id");
  assert.equal(noClient.headers.get("location"), null);
  assert.equal(noClient.headers.get("cache-control"), "no-store");
  assertOAuthError(await authorizeGet({ ...baseParams, client_id: "devspace-unknown" }), 400, "invalid_client", "Invalid client_id", "authorize unknown client_id");
  const unregisteredRedirect = await authorizeGet({ ...baseParams, redirect_uri: "http://127.0.0.1:43123/other" });
  assertOAuthError(unregisteredRedirect, 400, "invalid_request", "Unregistered redirect_uri", "authorize unregistered redirect_uri");
  assert.equal(unregisteredRedirect.headers.get("location"), null);
  const foreignRedirect = await authorizeGet({ ...baseParams, redirect_uri: "https://evil.example/callback" });
  assertOAuthError(foreignRedirect, 400, "invalid_request", "Unregistered redirect_uri", "authorize foreign redirect_uri");
  assert.equal(foreignRedirect.headers.get("location"), null);
  assertOAuthError(
    await authorizeGet({ ...baseParams, redirect_uri: "not a url" }),
    400, "invalid_request", /redirect_uri must be a valid URL/, "authorize unparsable redirect_uri",
  );

  // RFC 8252 loopback port relaxation: a different port on the registered loopback URI is accepted,
  // and an omitted redirect_uri resolves to the single registered one.
  assert.equal((await authorizeGet({ ...baseParams, redirect_uri: "http://127.0.0.1:50001/callback" })).status, 200);
  assert.equal((await authorizeGet({ ...baseParams, redirect_uri: undefined })).status, 200);

  // Post-redirect failures are 302s to the redirect URI with error parameters.
  async function assertErrorRedirect(params: AuthorizeParams, expected: Record<string, string | RegExp>, label: string): Promise<void> {
    const result = await authorizeGet(params);
    assert.equal(result.status, 302, `${label}: status (body ${bodyHint(result)})`);
    assert.equal(result.headers.get("cache-control"), "no-store", `${label}: Cache-Control`);
    const location = new URL(result.headers.get("location") ?? "");
    assert.equal(`${location.origin}${location.pathname}`, loopbackRedirect, `${label}: redirect target`);
    assert.deepEqual([...location.searchParams.keys()].sort(), Object.keys(expected).sort(), `${label}: parameters`);
    for (const [name, value] of Object.entries(expected)) {
      if (typeof value === "string") assert.equal(location.searchParams.get(name), value, `${label}: ${name}`);
      else assert.match(location.searchParams.get(name) ?? "", value, `${label}: ${name}`);
    }
  }

  // Parameter failures (RFC 6749 section 4.1.2.1) redirect with `state` whenever the request
  // carried a non-empty one, even when another parameter fails validation.
  await assertErrorRedirect({ ...baseParams, code_challenge: undefined }, { error: "invalid_request", error_description: /code_challenge/, state: "oracle-state" }, "authorize missing code_challenge");
  await assertErrorRedirect({ ...baseParams, code_challenge_method: "plain" }, { error: "invalid_request", error_description: /code_challenge_method/, state: "oracle-state" }, "authorize plain PKCE");
  await assertErrorRedirect({ ...baseParams, code_challenge_method: undefined }, { error: "invalid_request", error_description: /code_challenge_method/, state: "oracle-state" }, "authorize missing code_challenge_method");
  await assertErrorRedirect({ ...baseParams, resource: "not a url" }, { error: "invalid_request", error_description: /resource/, state: "oracle-state" }, "authorize unparsable resource");
  // Without a usable `state` the redirect carries only the error.
  await assertErrorRedirect({ ...baseParams, code_challenge: undefined, state: undefined }, { error: "invalid_request", error_description: /code_challenge/ }, "authorize schema failure without state");
  await assertErrorRedirect({ ...baseParams, code_challenge: undefined, state: "" }, { error: "invalid_request", error_description: /code_challenge/ }, "authorize schema failure with empty state");
  // A missing (or empty) response_type is invalid_request; any other value is unsupported_response_type,
  // which is checked before the remaining parameters.
  await assertErrorRedirect({ ...baseParams, response_type: undefined }, { error: "invalid_request", error_description: /response_type/, state: "oracle-state" }, "authorize missing response_type");
  await assertErrorRedirect({ ...baseParams, response_type: "" }, { error: "invalid_request", error_description: /response_type/, state: "oracle-state" }, "authorize empty response_type");
  const unsupportedResponseType = { error: "unsupported_response_type", error_description: 'Only response_type "code" is supported', state: "oracle-state" };
  await assertErrorRedirect({ ...baseParams, response_type: "token" }, unsupportedResponseType, "authorize response_type=token");
  await assertErrorRedirect({ ...baseParams, response_type: "code token" }, unsupportedResponseType, "authorize response_type=code token");
  await assertErrorRedirect({ ...baseParams, response_type: "token", code_challenge: undefined }, unsupportedResponseType, "authorize response_type=token without code_challenge");
  // Client and redirect URI failures still answer 400 JSON and never redirect, whatever else is wrong.
  const unregisteredWithBadType = await authorizeGet({ ...baseParams, response_type: "token", redirect_uri: "http://127.0.0.1:43123/other" });
  assertOAuthError(unregisteredWithBadType, 400, "invalid_request", "Unregistered redirect_uri", "authorize unregistered redirect_uri with response_type=token");
  assert.equal(unregisteredWithBadType.headers.get("location"), null);
  assertOAuthError(await authorizeGet({ ...baseParams, response_type: "token", client_id: "devspace-unknown" }), 400, "invalid_client", "Invalid client_id", "authorize unknown client_id with response_type=token");

  // Provider-level failures keep `state`.
  const resourceError = { error: "invalid_request", error_description: "Invalid or missing OAuth resource", state: "oracle-state" };
  await assertErrorRedirect({ ...baseParams, resource: undefined }, resourceError, "authorize missing resource");
  await assertErrorRedirect({ ...baseParams, resource: "https://evil.example/mcp" }, resourceError, "authorize foreign-origin resource");
  await assertErrorRedirect({ ...baseParams, resource: `${origin}/` }, resourceError, "authorize root resource");
  await assertErrorRedirect({ ...baseParams, resource: `${origin}/mcpx` }, resourceError, "authorize sibling-path resource");
  await assertErrorRedirect(
    { ...baseParams, scope: "devspace admin" },
    { error: "invalid_request", error_description: "Requested scope is not supported", state: "oracle-state" },
    "authorize unsupported scope",
  );
  // Resource indicators below the /mcp path are accepted.
  assert.equal((await authorizeGet({ ...baseParams, resource: `${mcpUrl}/nested` })).status, 200);
  assert.equal((await authorizeGet({ ...baseParams, resource: `${mcpUrl}#fragment` })).status, 200);

  // Approval POST: CSRF double-submit (cookie + csrf_token field) and the owner token.
  const { csrf } = await approvalPage(baseParams);
  const missingCsrf = await approve(baseParams, { owner_token: ownerToken });
  assert.equal(missingCsrf.status, 400);
  assert.equal(missingCsrf.headers.get("content-type"), HTML_CONTENT_TYPE);
  assert.equal(missingCsrf.headers.get("location"), null);
  assertSecretMatches(missingCsrf.headers.get("set-cookie"), new RegExp(`^${CSRF_COOKIE}=[0-9a-f]{64};`), "CSRF rejection Set-Cookie");
  assert.equal((await approve(baseParams, { owner_token: ownerToken, csrf_token: csrf })).status, 400, "csrf field without cookie");
  assert.equal((await approve(baseParams, { owner_token: ownerToken }, csrf)).status, 400, "csrf cookie without field");
  assert.equal((await approve(baseParams, { owner_token: ownerToken, csrf_token: "0".repeat(64) }, csrf)).status, 400, "csrf mismatch");
  const wrongOwner = await approve(baseParams, { owner_token: "not-the-owner-token", csrf_token: csrf }, csrf);
  assert.equal(wrongOwner.status, 401);
  assert.equal(wrongOwner.headers.get("content-type"), HTML_CONTENT_TYPE);
  assert.equal(wrongOwner.headers.get("cache-control"), "no-store");
  assert.equal(wrongOwner.headers.get("location"), null);
  assertSecurityHeaders(wrongOwner, "wrong owner token");
  assertSecretMatches(wrongOwner.headers.get("set-cookie"), new RegExp(`^${CSRF_COOKIE}=[0-9a-f]{64};`), "wrong owner Set-Cookie");

  // The CSRF token is not single-use: the same cookie/field pair still approves after a failure.
  const approved = await approve(baseParams, { owner_token: ownerToken, csrf_token: csrf }, csrf);
  assert.equal(approved.status, 302);
  assert.equal(approved.headers.get("cache-control"), "no-store");
  assertRateLimitHeaders(approved, 100, 900, "approval");
  assertSecretMatches(
    approved.headers.get("set-cookie"),
    new RegExp(`^${CSRF_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax$`),
    "approval clears the CSRF cookie",
  );
  const approvedLocation = new URL(approved.headers.get("location") ?? "");
  assert.equal(`${approvedLocation.origin}${approvedLocation.pathname}`, loopbackRedirect);
  // Exactly `code` and `state`; KNOWN DEFECT (RFC 9207): no `iss` parameter.
  assert.deepEqual([...approvedLocation.searchParams.keys()], ["code", "state"]);
  assert.equal(approvedLocation.searchParams.get("state"), "oracle-state");
  const code = approvedLocation.searchParams.get("code") ?? "";
  assertSecretMatches(code, /^code-[0-9a-f-]{36}$/, "authorization code shape");

  // Without `state`, the redirect carries only `code`; a relaxed loopback port is used verbatim.
  const statelessPair = pkcePair();
  const stateless = await authorizationCode(
    authorizeParams(client, statelessPair.challenge, { state: undefined, redirect_uri: "http://127.0.0.1:50002/callback" }),
  );
  assert.equal(`${stateless.location.origin}${stateless.location.pathname}`, "http://127.0.0.1:50002/callback");
  assert.deepEqual([...stateless.location.searchParams.keys()], ["code"]);

  // 4. /token ---------------------------------------------------------------------------------

  const codeGrant = {
    grant_type: "authorization_code",
    code,
    code_verifier: pair.verifier,
    redirect_uri: loopbackRedirect,
    client_id: client.client_id,
    resource: mcpUrl,
  };
  const otherClient = await registerPublicClient([loopbackRedirect]);

  // Failed exchanges do not consume the code: each case below is followed by a successful exchange.
  const wrongVerifier = await tokenRequest({ ...codeGrant, code_verifier: pkcePair().verifier });
  assertOAuthError(wrongVerifier, 400, "invalid_grant", "code_verifier does not match the challenge", "token wrong verifier");
  assert.equal(wrongVerifier.headers.get("cache-control"), "no-store");
  assert.equal(wrongVerifier.headers.get("access-control-allow-origin"), "*");
  assertOAuthError(await tokenRequest({ ...codeGrant, code_verifier: undefined }), 400, "invalid_request", /code_verifier/, "token missing verifier");
  assertOAuthError(
    await tokenRequest({ ...codeGrant, redirect_uri: "http://127.0.0.1:43123/other" }),
    400, "invalid_grant", "redirect_uri does not match the authorization request", "token wrong redirect_uri",
  );
  assertOAuthError(await tokenRequest({ ...codeGrant, resource: "https://evil.example/mcp" }), 400, "invalid_grant", "Invalid resource", "token foreign resource");
  assertOAuthError(await tokenRequest({ ...codeGrant, resource: "not a url" }), 400, "invalid_request", /resource/, "token unparsable resource");
  assertOAuthError(await tokenRequest({ ...codeGrant, client_id: otherClient.client_id }), 400, "invalid_grant", "Invalid authorization code", "token code of another client");
  const unknownClient = await tokenRequest({ ...codeGrant, client_id: "devspace-unknown" });
  assertOAuthError(unknownClient, 400, "invalid_client", "Invalid client_id", "token unknown client_id");
  // Client authentication failures are answered before Cache-Control is set.
  assert.equal(unknownClient.headers.get("cache-control"), null);
  assertOAuthError(await tokenRequest({ ...codeGrant, client_id: undefined }), 400, "invalid_request", /client_id/, "token missing client_id");
  assertOAuthError(await tokenRequest({ ...codeGrant, code: "code-unknown" }), 400, "invalid_grant", "Invalid authorization code", "token unknown code");

  const exchanged = await tokenRequest(codeGrant);
  const tokens = assertTokenResponse(exchanged, "devspace audit", "authorization_code exchange");
  assertRateLimitHeaders(exchanged, 50, 900, "token");
  assertOAuthError(await tokenRequest(codeGrant), 400, "invalid_grant", "Invalid authorization code", "token reused code");

  // KNOWN DEFECT: redirect_uri may be omitted at the token endpoint even though the authorization
  // request carried one (RFC 6749 section 4.1.3 requires it).
  {
    const omittedPair = pkcePair();
    const omitted = await authorizationCode(authorizeParams(client, omittedPair.challenge));
    assertTokenResponse(
      await tokenRequest({ grant_type: "authorization_code", code: omitted.code, code_verifier: omittedPair.verifier, client_id: client.client_id }),
      "devspace audit", "exchange without redirect_uri or resource",
    );
  }
  // The stateless code was issued for a relaxed loopback port; the token request must repeat that URI.
  assertOAuthError(
    await tokenRequest({ grant_type: "authorization_code", code: stateless.code, code_verifier: statelessPair.verifier, redirect_uri: loopbackRedirect, client_id: client.client_id }),
    400, "invalid_grant", "redirect_uri does not match the authorization request", "token registered URI for relaxed-port code",
  );
  assertTokenResponse(
    await tokenRequest({ grant_type: "authorization_code", code: stateless.code, code_verifier: statelessPair.verifier, redirect_uri: "http://127.0.0.1:50002/callback", client_id: client.client_id }),
    "devspace audit", "exchange with relaxed loopback port",
  );

  assertOAuthError(
    await tokenRequest({ grant_type: "client_credentials", client_id: client.client_id }),
    400, "unsupported_grant_type", "The grant type is not supported by this authorization server.", "token client_credentials",
  );
  assertOAuthError(
    await tokenRequest({ grant_type: "password", client_id: client.client_id }),
    400, "unsupported_grant_type", "The grant type is not supported by this authorization server.", "token password grant",
  );
  assertOAuthError(await tokenRequest({ client_id: client.client_id }), 400, "invalid_request", /grant_type/, "token missing grant_type");

  // Refresh: rotation, scope narrowing, and rejections.
  const refreshGrant = { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id };
  // Requesting a broader scope is invalid_scope (RFC 6749 sections 5.2 and 6).
  assertOAuthError(
    await tokenRequest({ ...refreshGrant, scope: "devspace audit admin" }),
    400, "invalid_scope", "Refresh token cannot grant requested scopes", "refresh broader scope",
  );
  assertOAuthError(await tokenRequest({ ...refreshGrant, resource: "https://evil.example/mcp" }), 400, "invalid_grant", "Invalid resource", "refresh foreign resource");
  assertOAuthError(await tokenRequest({ ...refreshGrant, client_id: otherClient.client_id }), 400, "invalid_grant", "Invalid refresh token", "refresh by another client");
  assertOAuthError(await tokenRequest({ ...refreshGrant, refresh_token: "unknown" }), 400, "invalid_grant", "Invalid refresh token", "refresh unknown token");
  assertOAuthError(await tokenRequest({ ...refreshGrant, refresh_token: undefined }), 400, "invalid_request", /refresh_token/, "refresh missing token");
  // An access token is not accepted as a refresh token.
  assertOAuthError(await tokenRequest({ ...refreshGrant, refresh_token: tokens.access_token }), 400, "invalid_grant", "Invalid refresh token", "refresh with access token");

  // None of the failures above consumed the refresh token.
  const refreshed = assertTokenResponse(await tokenRequest({ ...refreshGrant, resource: mcpUrl }), "devspace audit", "refresh");
  assertSecretsDiffer(refreshed.refresh_token, tokens.refresh_token, "refresh rotates the refresh token");
  assertSecretsDiffer(refreshed.access_token, tokens.access_token, "refresh issues a new access token");
  assertOAuthError(await tokenRequest(refreshGrant), 400, "invalid_grant", "Invalid refresh token", "refresh reused rotated token");

  const narrowed = assertTokenResponse(
    await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshed.refresh_token, client_id: client.client_id, scope: "audit" }),
    "audit", "refresh narrower scope",
  );
  // The narrowed refresh token cannot widen back.
  assertOAuthError(
    await tokenRequest({ grant_type: "refresh_token", refresh_token: narrowed.refresh_token, client_id: client.client_id, scope: "devspace" }),
    400, "invalid_scope", "Refresh token cannot grant requested scopes", "refresh re-widen narrowed token",
  );
  // The rejected widening did not consume the narrowed refresh token.
  assertTokenResponse(
    await tokenRequest({ grant_type: "refresh_token", refresh_token: narrowed.refresh_token, client_id: client.client_id }),
    "audit", "refresh after a rejected widening",
  );

  // 6 (OAuth half). /mcp with OAuth tokens ----------------------------------------------------

  await assertMcpAccepted(refreshed.access_token, "OAuth access token");
  // KNOWN DEFECT (or at least undocumented): rotating the refresh token leaves the previous
  // access token valid until it expires.
  await assertMcpAccepted(tokens.access_token, "access token from before refresh rotation");
  await assertMcpRejected(`Bearer ${narrowed.access_token}`, 403, "insufficient_scope", "Insufficient scope", "token without the devspace scope");
  await assertMcpRejected(undefined, 401, "invalid_token", "Missing Authorization header", "no Authorization header");
  await assertMcpRejected("Basic dXNlcjpwYXNz", 401, "invalid_token", "Invalid Authorization header format, expected 'Bearer TOKEN'", "Basic scheme");
  await assertMcpRejected("Bearer", 401, "invalid_token", "Invalid Authorization header format, expected 'Bearer TOKEN'", "Bearer without token");
  await assertMcpRejected("bearer   ", 401, "invalid_token", "Invalid Authorization header format, expected 'Bearer TOKEN'", "Bearer with blank token");
  await assertMcpRejected("Bearer not-a-real-token", 401, "invalid_token", "Invalid or expired access token", "unknown token");
  await assertMcpRejected(`Bearer ${refreshed.refresh_token}`, 401, "invalid_token", "Invalid or expired access token", "refresh token used as access token");
  // The scheme name is case-insensitive.
  await assertMcpAccepted(refreshed.access_token, "OAuth access token (repeat)");
  {
    const lowercase = await http("/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json", authorization: `bearer ${refreshed.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oauth-oracle", version: "1.0.0" } } }),
    });
    assert.equal(lowercase.status, 200, "lowercase bearer scheme");
  }
  const getWithoutAuth = await http("/mcp", { method: "GET" });
  assert.equal(getWithoutAuth.status, 401);
  assert.equal(getWithoutAuth.headers.get("www-authenticate"), wwwAuthenticate("invalid_token", "Missing Authorization header"));

  // An absent or empty `scope` is granted the first supported scope, the one /mcp requires. The page
  // shows it, its hidden field carries it, and the approval is submitted exactly as the page would.
  for (const [label, scope] of [["omitted scope", undefined], ["empty scope", ""]] as const) {
    const unscopedPair = pkcePair();
    const params = authorizeParams(client, unscopedPair.challenge, { scope });
    const pagePath = `/authorize?${new URLSearchParams(definedEntries(params)).toString()}`;
    const unscopedPage = await http(pagePath);
    assert.equal(unscopedPage.status, 200, `${label}: approval page (body ${bodyHint(unscopedPage)})`);
    assert.match(unscopedPage.text, /<dt>Scope<\/dt><dd>devspace<\/dd>/, `${label}: displayed scope`);
    assert.equal(new Map(hiddenFields(unscopedPage)).get("scope"), "devspace", `${label}: hidden scope field`);
    const unscopedApproval = await approveAsBrowser(pagePath, unscopedPage);
    assert.equal(unscopedApproval.status, 302, `${label}: approval (body ${bodyHint(unscopedApproval)})`);
    const unscopedLocation = new URL(unscopedApproval.headers.get("location") ?? "");
    assert.deepEqual([...unscopedLocation.searchParams.keys()], ["code", "state"], `${label}: redirect parameters`);
    const unscopedTokens = assertTokenResponse(
      await tokenRequest({
        grant_type: "authorization_code",
        code: unscopedLocation.searchParams.get("code") ?? "",
        code_verifier: unscopedPair.verifier,
        redirect_uri: params.redirect_uri,
        client_id: client.client_id,
        resource: mcpUrl,
      }),
      "devspace",
      `${label}: token`,
    );
    await assertMcpAccepted(unscopedTokens.access_token, `${label}: /mcp`);
  }

  // 5. /revoke --------------------------------------------------------------------------------

  const revokeAccess = await postForm("/revoke", { token: refreshed.access_token, client_id: client.client_id });
  assert.equal(revokeAccess.status, 200);
  assert.equal(revokeAccess.headers.get("content-type"), JSON_CONTENT_TYPE);
  assert.equal(revokeAccess.headers.get("cache-control"), "no-store");
  assert.equal(revokeAccess.headers.get("access-control-allow-origin"), "*");
  assertRateLimitHeaders(revokeAccess, 50, 900, "revoke");
  assert.deepEqual(revokeAccess.json(), {});
  await assertMcpRejected(`Bearer ${refreshed.access_token}`, 401, "invalid_token", "Invalid or expired access token", "revoked access token");

  // Revoking a refresh token kills it for refresh. KNOWN DEFECT: the access token issued with it
  // stays valid, and token_type_hint is ignored.
  const pairForRevocation = await issueTokens(client);
  const revokeRefresh = await postForm("/revoke", { token: pairForRevocation.refresh_token, client_id: client.client_id, token_type_hint: "access_token" });
  assert.equal(revokeRefresh.status, 200);
  assert.deepEqual(revokeRefresh.json(), {});
  assertOAuthError(
    await tokenRequest({ grant_type: "refresh_token", refresh_token: pairForRevocation.refresh_token, client_id: client.client_id }),
    400, "invalid_grant", "Invalid refresh token", "refresh with revoked refresh token",
  );
  await assertMcpAccepted(pairForRevocation.access_token, "access token whose refresh token was revoked");

  // KNOWN DEFECT: revocation does not check that the token belongs to the requesting client.
  const revokeOtherClients = await postForm("/revoke", { token: pairForRevocation.access_token, client_id: otherClient.client_id });
  assert.equal(revokeOtherClients.status, 200);
  await assertMcpRejected(`Bearer ${pairForRevocation.access_token}`, 401, "invalid_token", "Invalid or expired access token", "token revoked by another client");

  // RFC 7009: unknown tokens are not an error.
  const revokeUnknown = await postForm("/revoke", { token: "not-a-token", client_id: client.client_id });
  assert.equal(revokeUnknown.status, 200);
  assert.deepEqual(revokeUnknown.json(), {});
  const revokeNoClient = await postForm("/revoke", { token: "not-a-token" });
  assertOAuthError(revokeNoClient, 400, "invalid_request", /client_id/, "revoke missing client_id");
  assert.equal(revokeNoClient.headers.get("cache-control"), null);
  assertOAuthError(await postForm("/revoke", { token: "not-a-token", client_id: "devspace-unknown" }), 400, "invalid_client", "Invalid client_id", "revoke unknown client_id");
  assertOAuthError(await postForm("/revoke", { client_id: client.client_id }), 400, "invalid_request", /token/, "revoke missing token");
  // The client registered without token_endpoint_auth_method uses /token and /revoke with no secret.
  {
    const defaultTokens = await issueTokens(publicByDefaultBody);
    const defaultRefreshed = assertTokenResponse(
      await tokenRequest({ grant_type: "refresh_token", refresh_token: defaultTokens.refresh_token, client_id: publicByDefaultBody.client_id }),
      "devspace audit", "refresh by client registered without an auth method",
    );
    const defaultRevoke = await postForm("/revoke", { token: defaultRefreshed.access_token, client_id: publicByDefaultBody.client_id });
    assert.equal(defaultRevoke.status, 200, `revoke by client registered without an auth method (body ${bodyHint(defaultRevoke)})`);
    assert.deepEqual(defaultRevoke.json(), {});
    await assertMcpRejected(`Bearer ${defaultRefreshed.access_token}`, 401, "invalid_token", "Invalid or expired access token", "token revoked by client registered without an auth method");
  }
  // The client_secret_post client must present its secret.
  assertOAuthError(
    await postForm("/revoke", { token: "not-a-token", client_id: String(confidentialBody.client_id) }),
    400, "invalid_client", "Client secret is required", "revoke secret-holding client without secret",
  );
  assertOAuthError(
    await postForm("/revoke", { token: "not-a-token", client_id: String(confidentialBody.client_id), client_secret: "0".repeat(64) }),
    400, "invalid_client", "Invalid client_secret", "revoke with wrong client secret",
  );
  assert.equal(
    (await postForm("/revoke", { token: "not-a-token", client_id: String(confidentialBody.client_id), client_secret: String(confidentialBody.client_secret) })).status,
    200,
    "revoke with the issued client secret",
  );

  // 6 (static-key half). /mcp with static API keys minted by `devspace auth mint-key` ----------

  const staticKey = mintStaticKey();
  assert.deepEqual(staticKey.scopes, ["devspace"]);
  assert.equal(staticKey.resource, mcpUrl);
  assertSecretMatches(staticKey.raw_key, /^obsk_[A-Za-z0-9_-]{43}$/, "static key shape");
  await assertMcpAccepted(staticKey.raw_key, "static API key");

  const auditOnlyKey = mintStaticKey({ scope: "audit" });
  await assertMcpRejected(`Bearer ${auditOnlyKey.raw_key}`, 403, "insufficient_scope", "Insufficient scope", "static key without the devspace scope");

  // Every static-key failure falls through to the OAuth verifier, so it reports the OAuth message.
  const foreignKey = mintStaticKey({ publicBaseUrl: "https://other.example" });
  assert.equal(foreignKey.resource, "https://other.example/mcp");
  await assertMcpRejected(`Bearer ${foreignKey.raw_key}`, 401, "invalid_token", "Invalid or expired access token", "static key for another resource");
  await assertMcpRejected(`Bearer obsk_${randomBytes(32).toString("base64url")}`, 401, "invalid_token", "Invalid or expired access token", "unknown static key");

  const revokedKey = mintStaticKey();
  await assertMcpAccepted(revokedKey.raw_key, "static key before revocation");
  runCli(["revoke-key", "--key-id", revokedKey.key_id]);
  await assertMcpRejected(`Bearer ${revokedKey.raw_key}`, 401, "invalid_token", "Invalid or expired access token", "revoked static key");

  const waitMs = (shortLivedKey.expires_at + 1) * 1000 - Date.now();
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs + 50));
  await assertMcpRejected(`Bearer ${shortLivedKey.raw_key}`, 401, "invalid_token", "Invalid or expired access token", "expired static key");

  // 7. Method handling and CORS preflight -----------------------------------------------------

  async function assertMethodNotAllowed(path: string, method: string, allow: string): Promise<HttpResult> {
    const result = await http(path, { method });
    assertOAuthError(result, 405, "method_not_allowed", `The method ${method} is not allowed for this endpoint`, `${method} ${path}`);
    assert.equal(result.headers.get("allow"), allow, `${method} ${path}: Allow`);
    return result;
  }

  const getToken = await assertMethodNotAllowed("/token", "GET", "POST");
  assert.equal(getToken.headers.get("access-control-allow-origin"), "*");
  await assertMethodNotAllowed("/token", "PUT", "POST");
  const getRegister = await assertMethodNotAllowed("/register", "GET", "POST");
  assert.equal(getRegister.headers.get("access-control-allow-origin"), "*");
  await assertMethodNotAllowed("/register", "DELETE", "POST");
  await assertMethodNotAllowed("/revoke", "GET", "POST");
  const putAuthorize = await assertMethodNotAllowed("/authorize", "PUT", "GET, POST");
  assert.equal(putAuthorize.headers.get("access-control-allow-origin"), null);
  await assertMethodNotAllowed("/.well-known/oauth-authorization-server", "POST", "GET, OPTIONS");
  await assertMethodNotAllowed("/.well-known/oauth-protected-resource/mcp", "POST", "GET, OPTIONS");

  function preflight(path: string, requestHeaders?: string): Promise<HttpResult> {
    return http(path, {
      method: "OPTIONS",
      headers: {
        origin: "https://client.example",
        "access-control-request-method": "POST",
        ...(requestHeaders ? { "access-control-request-headers": requestHeaders } : {}),
      },
    });
  }

  for (const path of ["/token", "/register", "/revoke", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
    assertPreflight(await preflight(path), `OPTIONS ${path}`);
  }
  // Requested headers are reflected.
  assert.equal((await preflight("/register", "content-type, x-custom")).headers.get("access-control-allow-headers"), "content-type, x-custom");
  // /authorize has no CORS handling: OPTIONS is a 405 like any other unlisted method.
  const authorizePreflight = await assertMethodNotAllowed("/authorize", "OPTIONS", "GET, POST");
  assert.equal(authorizePreflight.headers.get("access-control-allow-origin"), null);

  // 8. Rate-limit headers -----------------------------------------------------------------------
  // /authorize and /token each pass through DevSpace's own limiter (10/60 s and 30/60 s) and then the
  // SDK's (100/900 s and 50/900 s). Responses that reach the SDK limiter carry its headers, which
  // overwrite DevSpace's; only responses produced before it (405s, /token preflight) show
  // DevSpace's. Exhaustion is covered by src/server-rate-limit.test.ts.
  assertRateLimitHeaders(await authorizeGet(baseParams), 100, 900, "GET /authorize");
  assertRateLimitHeaders(putAuthorize, 10, 60, "PUT /authorize");
  assertRateLimitHeaders(await tokenRequest({ grant_type: "client_credentials", client_id: client.client_id }), 50, 900, "POST /token");
  assertRateLimitHeaders(getToken, 30, 60, "GET /token");
  assertRateLimitHeaders(await preflight("/token"), 30, 60, "OPTIONS /token");
  assertNoRateLimitHeaders(await preflight("/revoke"), "OPTIONS /revoke");
  assertNoRateLimitHeaders(await mcpInitialize(), "POST /mcp");
} finally {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
  running.close?.();
  await rm(stateDir, { recursive: true, force: true });
}
