// Unit and HTTP tests for the first-party OAuth endpoint layer in src/oauth/, covering the branches
// the black-box oracle (src/server-oauth-http.test.ts) cannot reach through SingleUserOAuthProvider.
// Never print tokens, codes, secrets, or verifiers.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Response } from "express";
import { requireBearerAuth } from "@modelcontextprotocol/express";
import { OAuthError, type OAuthClientInformationFull, type OAuthTokens } from "@modelcontextprotocol/server";
import { redirectUriMatches } from "./oauth/authorize.js";
import { OAuthErrorCode, OAuthHttpError, oauthErrorStatus } from "./oauth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "./oauth/provider.js";
import { oauthRoutes } from "./oauth/routes.js";
import { constantTimeEqual, pkceS256Matches } from "./oauth/secrets.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";

// --- Pure helpers -------------------------------------------------------------------------------

// RFC 8252 section 7.3: only the port of a loopback redirect URI is relaxed.
const loopback = "http://127.0.0.1:43123/callback";
assert.equal(redirectUriMatches(loopback, loopback), true);
assert.equal(redirectUriMatches("http://127.0.0.1:50000/callback", loopback), true);
assert.equal(redirectUriMatches("http://127.0.0.1/callback", loopback), true);
assert.equal(redirectUriMatches("http://localhost:50000/cb", "http://localhost:1/cb"), true);
assert.equal(redirectUriMatches("http://[::1]:50000/cb", "http://[::1]:1/cb"), true);
assert.equal(redirectUriMatches("http://localhost:43123/callback", loopback), false, "localhost does not match 127.0.0.1");
assert.equal(redirectUriMatches("https://127.0.0.1:43123/callback", loopback), false, "scheme must match");
assert.equal(redirectUriMatches("http://127.0.0.1:43123/other", loopback), false, "path must match");
assert.equal(redirectUriMatches("http://127.0.0.1:43123/callback?x=1", loopback), false, "query must match");
assert.equal(redirectUriMatches("https://chatgpt.com:444/cb", "https://chatgpt.com/cb"), false, "no relaxation off loopback");
assert.equal(redirectUriMatches("https://chatgpt.com/cb/", "https://chatgpt.com/cb"), false, "exact match off loopback");
assert.equal(redirectUriMatches("not a url", loopback), false);
assert.equal(redirectUriMatches(loopback, "not a url"), false);

// constantTimeEqual has exactly the semantics of ===, including for lone surrogates, which UTF-8
// would collapse into the same replacement bytes.
assert.equal(constantTimeEqual("abc", "abc"), true);
assert.equal(constantTimeEqual("abc", "abd"), false);
assert.equal(constantTimeEqual("abc", "abcd"), false);
assert.equal(constantTimeEqual("", ""), true);
assert.equal(constantTimeEqual("\uD800", "\uDBFF"), false);

// RFC 7636 Appendix B test vector.
const rfcVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const rfcChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
assert.equal(pkceS256Matches(rfcVerifier, rfcChallenge), true);
assert.equal(pkceS256Matches(`${rfcVerifier}x`, rfcChallenge), false);
assert.equal(pkceS256Matches(rfcVerifier, `${rfcChallenge}=`), false, "padded challenge is not S256 output");
assert.equal(pkceS256Matches(rfcVerifier, rfcVerifier), false, "plain method is not accepted");

// Error codes, statuses, and serialization.
for (const [code, status] of [
  [OAuthErrorCode.InvalidRequest, 400],
  [OAuthErrorCode.InvalidClient, 400],
  [OAuthErrorCode.InvalidGrant, 400],
  [OAuthErrorCode.AccessDenied, 400],
  [OAuthErrorCode.InvalidClientMetadata, 400],
  [OAuthErrorCode.UnsupportedGrantType, 400],
  [OAuthErrorCode.InvalidToken, 401],
  [OAuthErrorCode.InsufficientScope, 403],
  [OAuthErrorCode.MethodNotAllowed, 405],
  [OAuthErrorCode.TooManyRequests, 429],
  [OAuthErrorCode.ServerError, 500],
] as const) {
  const error = new OAuthHttpError(code, "described");
  assert.equal(error.status, status, code);
  assert.equal(oauthErrorStatus(code), status, code);
  assert.deepEqual(error.toResponseObject(), { error: code, error_description: "described" });
  assert.ok(error instanceof OAuthError, "an SDK OAuthError, so requireBearerAuth recognizes it");
}

// --- HTTP: a fake provider drives the branches SingleUserOAuthProvider never takes ---------------

interface Calls {
  authorize: AuthorizationParams[];
  exchange: Array<{ codeVerifier: string | undefined }>;
}

const calls: Calls = { authorize: [], exchange: [] };
const nowSeconds = Math.floor(Date.now() / 1000);
const clients = new Map<string, OAuthClientInformationFull>([
  ["two-uris", { client_id: "two-uris", redirect_uris: ["http://127.0.0.1:1/a", "http://127.0.0.1:1/b"] }],
  ["one-uri", { client_id: "one-uri", redirect_uris: [loopback] }],
  ["secret", { client_id: "secret", redirect_uris: [loopback], client_secret: "s3cret", client_secret_expires_at: nowSeconds + 3600 }],
  ["expired", { client_id: "expired", redirect_uris: [loopback], client_secret: "s3cret", client_secret_expires_at: nowSeconds - 10 }],
  ["no-expiry", { client_id: "no-expiry", redirect_uris: [loopback], client_secret: "s3cret", client_secret_expires_at: 0 }],
]);

let authorizeFailure: unknown;
let exchangeFailure: unknown;
let registerFailure: unknown;
const tokens: OAuthTokens = { access_token: "a", token_type: "bearer" };

const fakeProvider: OAuthServerProvider = {
  clientsStore: {
    getClient(clientId) {
      if (clientId === "explodes") throw new Error("store unavailable");
      return clients.get(clientId);
    },
    registerClient(client) {
      if (registerFailure) throw registerFailure;
      return { ...client, client_id: "registered", client_id_issued_at: nowSeconds };
    },
  },
  async authorize(_client, params, res: Response) {
    calls.authorize.push(params);
    if (authorizeFailure) throw authorizeFailure;
    res.status(200).send("approval page");
  },
  async challengeForAuthorizationCode(_client, code) {
    if (code !== "good-code") throw new OAuthHttpError(OAuthErrorCode.InvalidGrant, "Invalid authorization code");
    return rfcChallenge;
  },
  async exchangeAuthorizationCode(_client, _code, codeVerifier) {
    calls.exchange.push({ codeVerifier });
    if (exchangeFailure) throw exchangeFailure;
    return tokens;
  },
  async exchangeRefreshToken() {
    return tokens;
  },
  async verifyAccessToken() {
    throw new OAuthHttpError(OAuthErrorCode.InvalidToken, "Invalid or expired access token");
  },
  async revokeToken() {},
};

async function listen(app: express.Express): Promise<{ server: Server; origin: string }> {
  const server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const app = express();
const { server, origin } = await listen(app);
app.use(oauthRoutes({
  provider: fakeProvider,
  issuerUrl: new URL(origin),
  baseUrl: new URL(origin),
  resourceServerUrl: new URL(`${origin}/mcp`),
  scopesSupported: ["devspace"],
  resourceName: "DevSpace",
}));

async function request(path: string, init: RequestInit = {}): Promise<{ status: number; headers: Headers; body: unknown }> {
  const response = await fetch(`${origin}${path}`, { redirect: "manual", ...init });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, headers: response.headers, body };
}

function form(path: string, fields: Record<string, string>): ReturnType<typeof request> {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

const challenge = createHash("sha256").update(rfcVerifier).digest("base64url");
function authorizeQuery(overrides: Record<string, string | undefined>): string {
  const params: Record<string, string | undefined> = {
    response_type: "code",
    client_id: "one-uri",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s",
    ...overrides,
  };
  const entries = Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return `/authorize?${new URLSearchParams(entries).toString()}`;
}

try {
  // /authorize: an omitted redirect_uri is only resolved when exactly one is registered.
  const ambiguous = await request(authorizeQuery({ client_id: "two-uris" }));
  assert.equal(ambiguous.status, 400);
  assert.equal(ambiguous.headers.get("location"), null);
  assert.deepEqual(ambiguous.body, {
    error: "invalid_request",
    error_description: "redirect_uri must be specified when client has multiple registered URIs",
  });
  assert.equal(calls.authorize.length, 0);

  // /authorize: a store failure is an opaque 500, never a redirect.
  const storeFailure = await request(authorizeQuery({ client_id: "explodes" }));
  assert.equal(storeFailure.status, 500);
  assert.equal(storeFailure.headers.get("cache-control"), "no-store");
  assert.deepEqual(storeFailure.body, { error: "server_error", error_description: "Internal Server Error" });

  // /authorize: what the provider receives. Omitted scope is an empty list (the KNOWN DEFECT
  // pinned by the oracle), there is no `issuer`, and POST reads the form body.
  const approved = await form("/authorize", {
    response_type: "code",
    client_id: "one-uri",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  });
  assert.equal(approved.status, 200);
  assert.deepEqual(Object.keys(calls.authorize[0]).sort(), ["codeChallenge", "redirectUri", "resource", "scopes", "state"]);
  assert.deepEqual(calls.authorize[0].scopes, []);
  assert.equal(calls.authorize[0].redirectUri, loopback);
  assert.equal(calls.authorize[0].state, undefined);
  assert.equal(calls.authorize[0].resource?.href, `${origin}/mcp`);

  // /authorize: a provider failure that is not an OAuth error redirects as server_error, with state.
  authorizeFailure = new Error("provider bug");
  const crashed = await request(authorizeQuery({}));
  assert.equal(crashed.status, 302);
  const crashedLocation = new URL(crashed.headers.get("location") ?? "");
  assert.deepEqual(Object.fromEntries(crashedLocation.searchParams), {
    error: "server_error",
    error_description: "Internal Server Error",
    state: "s",
  });
  // An empty state is not echoed.
  authorizeFailure = new OAuthHttpError(OAuthErrorCode.InvalidRequest, "Requested scope is not supported");
  const emptyState = new URL((await request(authorizeQuery({ state: "" }))).headers.get("location") ?? "");
  assert.deepEqual([...emptyState.searchParams.keys()], ["error", "error_description"]);
  authorizeFailure = undefined;

  // Client authentication: secret present, matching, and unexpired, in that order.
  const codeGrant = { grant_type: "authorization_code", code: "good-code", code_verifier: rfcVerifier };
  assert.deepEqual((await form("/token", { ...codeGrant, client_id: "secret" })).body, {
    error: "invalid_client", error_description: "Client secret is required",
  });
  assert.deepEqual((await form("/token", { ...codeGrant, client_id: "secret", client_secret: "s3cres" })).body, {
    error: "invalid_client", error_description: "Invalid client_secret",
  });
  const expired = await form("/token", { ...codeGrant, client_id: "expired", client_secret: "s3cret" });
  assert.equal(expired.status, 400);
  assert.equal(expired.headers.get("cache-control"), null);
  assert.deepEqual(expired.body, { error: "invalid_client", error_description: "Client secret has expired" });
  assert.deepEqual((await form("/token", { ...codeGrant, client_id: "expired", client_secret: "wrong!" })).body, {
    error: "invalid_client", error_description: "Invalid client_secret",
  }, "the secret is checked before its expiry");
  // client_secret_expires_at 0 means the secret does not expire.
  assert.equal((await form("/token", { ...codeGrant, client_id: "no-expiry", client_secret: "s3cret" })).status, 200);

  // /token: PKCE is verified locally, so the provider never receives the verifier.
  calls.exchange.length = 0;
  const exchanged = await form("/token", { ...codeGrant, client_id: "secret", client_secret: "s3cret" });
  assert.equal(exchanged.status, 200);
  assert.equal(exchanged.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls.exchange, [{ codeVerifier: undefined }]);
  const wrongVerifier = await form("/token", { ...codeGrant, code_verifier: `${rfcVerifier}x`, client_id: "one-uri" });
  assert.deepEqual(wrongVerifier.body, { error: "invalid_grant", error_description: "code_verifier does not match the challenge" });
  assert.equal(calls.exchange.length, 1, "a failed PKCE check never reaches the provider");

  // /token: a provider failure that is not an OAuth error is an opaque 500.
  exchangeFailure = new Error("database is locked");
  const tokenCrash = await form("/token", { ...codeGrant, client_id: "one-uri" });
  assert.equal(tokenCrash.status, 500);
  assert.equal(tokenCrash.headers.get("cache-control"), "no-store");
  assert.deepEqual(tokenCrash.body, { error: "server_error", error_description: "Internal Server Error" });
  exchangeFailure = undefined;

  // /register: store policy errors keep their code; other failures are opaque 500s.
  const registration = { redirect_uris: [loopback], token_endpoint_auth_method: "none" };
  const postRegistration = () => request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registration),
  });
  registerFailure = new OAuthHttpError(OAuthErrorCode.InvalidClientMetadata, "Client registration capacity reached");
  assert.deepEqual((await postRegistration()).body, { error: "invalid_client_metadata", error_description: "Client registration capacity reached" });
  registerFailure = new Error("disk full");
  const registerCrash = await postRegistration();
  assert.equal(registerCrash.status, 500);
  assert.deepEqual(registerCrash.body, { error: "server_error", error_description: "Internal Server Error" });
  registerFailure = undefined;
  const publicClient = await postRegistration();
  assert.equal(publicClient.status, 201);
  assert.deepEqual(Object.keys(publicClient.body as object).sort(), ["client_id", "client_id_issued_at", "redirect_uris", "token_endpoint_auth_method"]);

  // A preflight without requested headers advertises none, but still varies on them.
  const preflight = await request("/revoke", { method: "OPTIONS", headers: { origin: "https://client.example", "access-control-request-method": "POST" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-headers"), null);
  assert.equal(preflight.headers.get("vary"), "Access-Control-Request-Headers");
  assert.equal(preflight.headers.get("content-length"), "0");

  // The registration limiter (20 per hour; 4 used above) answers 429 with an OAuth body.
  let limited: Awaited<ReturnType<typeof request>> | undefined;
  for (let attempt = 0; attempt < 30 && !limited; attempt += 1) {
    const result = await postRegistration();
    if (result.status === 429) limited = result;
  }
  assert.ok(limited, "registration is rate limited");
  assert.deepEqual(limited.body, { error: "too_many_requests", error_description: "You have exceeded the rate limit for client registration requests" });
  assert.equal(limited.headers.get("ratelimit-remaining"), "0");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// --- Bearer authentication: a verifier failure is a 401 challenge, never a 500 -------------------

{
  const realProvider = new SingleUserOAuthProvider(
    { ownerToken: "owner-token-for-tests-only", accessTokenTtlSeconds: 60, refreshTokenTtlSeconds: 60, scopes: ["devspace"], allowedRedirectHosts: [] },
    new URL("http://127.0.0.1:1/mcp"),
  );
  const metadataUrl = "http://127.0.0.1:1/.well-known/oauth-protected-resource/mcp";
  const bearerApp = express();
  bearerApp.get("/provider", requireBearerAuth({ verifier: realProvider, requiredScopes: ["devspace"], resourceMetadataUrl: metadataUrl }), (_req, res) => {
    res.json({ ok: true });
  });
  bearerApp.get("/crashing", requireBearerAuth({
    verifier: { verifyAccessToken: async () => { throw new Error("verifier bug"); } },
    requiredScopes: ["devspace"],
    resourceMetadataUrl: metadataUrl,
  }), (_req, res) => {
    res.json({ ok: true });
  });
  const bearer = await listen(bearerApp);
  try {
    const rejected = await fetch(`${bearer.origin}/provider`, { headers: { authorization: "Bearer unknown" } });
    assert.equal(rejected.status, 401);
    assert.equal(
      rejected.headers.get("www-authenticate"),
      `Bearer error="invalid_token", error_description="Invalid or expired access token", scope="devspace", resource_metadata="${metadataUrl}"`,
    );
    assert.deepEqual(await rejected.json(), { error: "invalid_token", error_description: "Invalid or expired access token" });

    // Anything a verifier throws that is not an OAuth error is a 500 without a challenge, which is
    // why every DevSpace verifier throws OAuthHttpError.
    const crashed = await fetch(`${bearer.origin}/crashing`, { headers: { authorization: "Bearer unknown" } });
    assert.equal(crashed.status, 500);
    assert.equal(crashed.headers.get("www-authenticate"), null);
  } finally {
    await new Promise<void>((resolve) => bearer.server.close(() => resolve()));
  }
}

console.log("oauth endpoint tests passed");
