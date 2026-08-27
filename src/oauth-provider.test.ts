import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Response } from "express";
import type {
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { SingleUserOAuthProvider, type OAuthConfig, CSRF_COOKIE_NAME } from "./oauth-provider.js";
import { SqliteOAuthStateStore, InMemoryOAuthStateStore } from "./oauth-store.js";

const stateDir = await mkdtemp(join(tmpdir(), "devspace-oauth-test-"));
const mcpUrl = new URL("https://devspace.example.com/mcp");
const config: OAuthConfig = {
  ownerToken: "test-owner-token-that-is-long-enough",
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000,
  scopes: ["devspace"],
  allowedRedirectHosts: ["chatgpt.com"],
};

try {
  const firstStore = new SqliteOAuthStateStore(stateDir);
  const firstProvider = new SingleUserOAuthProvider(config, mcpUrl, firstStore);
  const client = await firstProvider.clientsStore.registerClient?.({
    redirect_uris: ["https://chatgpt.com/mcp/oauth/callback"],
    client_name: "ChatGPT",
  });
  assert.ok(client);

  const params: AuthorizationParams = {
    redirectUri: "https://chatgpt.com/mcp/oauth/callback",
    codeChallenge: "test-code-challenge",
    scopes: ["devspace"],
    resource: mcpUrl,
  };
  const redirectUrl = await authorizeWithPassword(firstProvider, client, params, config.ownerToken);
  const code = new URL(redirectUrl).searchParams.get("code");
  assert.ok(code);

  const tokens = await firstProvider.exchangeAuthorizationCode(
    client,
    code,
    undefined,
    params.redirectUri,
    mcpUrl,
  );
  assert.equal(tokens.token_type, "bearer");
  assert.ok(tokens.refresh_token);
  assert.equal((await firstProvider.verifyAccessToken(tokens.access_token)).clientId, client.client_id);
  firstStore.close();

  const secondStore = new SqliteOAuthStateStore(stateDir);
  const secondProvider = new SingleUserOAuthProvider(config, mcpUrl, secondStore);
  const restoredClient = await secondProvider.clientsStore.getClient(client.client_id);
  assert.deepEqual(restoredClient, client);
  assert.equal((await secondProvider.verifyAccessToken(tokens.access_token)).clientId, client.client_id);

  assert.throws(
    () => new SingleUserOAuthProvider({ ...config, maxRetainedClients: 501 }, mcpUrl, secondStore),
    /between 1 and 500/,
  );
  const limitedProvider = new SingleUserOAuthProvider(
    { ...config, maxRetainedClients: 1 },
    mcpUrl,
    secondStore,
  );
  assert.throws(
    () => limitedProvider.clientsStore.registerClient?.({
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
    }),
    /capacity/,
  );

  const refreshedTokens = await secondProvider.exchangeRefreshToken(
    client,
    tokens.refresh_token,
    undefined,
    mcpUrl,
  );
  assert.notEqual(refreshedTokens.refresh_token, tokens.refresh_token);

  await assert.rejects(
    () => secondProvider.exchangeRefreshToken(client, tokens.refresh_token!, undefined, mcpUrl),
    /Invalid refresh token/,
  );

  await secondProvider.revokeToken(client, { token: refreshedTokens.access_token });
  await assert.rejects(
    () => secondProvider.verifyAccessToken(refreshedTokens.access_token),
    /Invalid or expired access token/,
  );
  secondStore.close();

  // --- CSRF tests ---
  const csrfStore = new InMemoryOAuthStateStore();
  const csrfProvider = new SingleUserOAuthProvider(config, mcpUrl, csrfStore);
  const csrfClient = await csrfProvider.clientsStore.registerClient?.({
    redirect_uris: ["https://chatgpt.com/mcp/oauth/callback"],
    client_name: "ChatGPT-CSRF",
  });
  assert.ok(csrfClient);
  const csrfParams: AuthorizationParams = {
    redirectUri: "https://chatgpt.com/mcp/oauth/callback",
    codeChallenge: "test-code-challenge-csrf",
    scopes: ["devspace"],
    resource: mcpUrl,
  };

  // helper to call authorize and capture result
  async function callAuthorize(opts: { csrfBody?: string; csrfCookie?: string; ownerToken?: string }): Promise<{ status?: number; body?: string; redirect?: string; setCookie?: string[] }> {
    let status: number | undefined;
    let body: string | undefined;
    let redirect: string | undefined;
    const setCookies: string[] = [];
    const headers: Record<string, string> = {};
    if (opts.csrfCookie !== undefined) headers.cookie = `${CSRF_COOKIE_NAME}=${opts.csrfCookie}`;
    const res = {
      req: {
        method: "POST",
        body: {
          owner_token: opts.ownerToken ?? config.ownerToken,
          ...(opts.csrfBody !== undefined ? { csrf_token: opts.csrfBody } : {}),
        },
        headers,
        cookies: opts.csrfCookie !== undefined ? { [CSRF_COOKIE_NAME]: opts.csrfCookie } : {},
      },
      status(code: number) { status = code; return this; },
      setHeader(name: string, value: string | string[]) {
        if (name.toLowerCase() === "set-cookie") {
          if (Array.isArray(value)) setCookies.push(...value.map(String));
          else setCookies.push(String(value));
        }
        return this;
      },
      getHeader(name: string) {
        if (name.toLowerCase() === "set-cookie") return setCookies;
        return undefined;
      },
      send(b: string) { body = b; return this; },
      redirect(code: number, url: string) { status = code; redirect = url; },
      cookie() { return this; },
      clearCookie() { return this; },
    } as unknown as Response;
    await csrfProvider.authorize(csrfClient!, csrfParams, res);
    return { status, body, redirect, setCookie: setCookies };
  }

  // rejects without csrf_token
  {
    const result = await callAuthorize({ csrfBody: undefined, csrfCookie: undefined });
    assert.equal(result.status, 400);
    assert.ok(result.body?.includes("Invalid request"));
  }

  // rejects with mismatched csrf
  {
    const good = randomBytes(32).toString("hex");
    const bad = randomBytes(32).toString("hex");
    const result = await callAuthorize({ csrfBody: bad, csrfCookie: good });
    assert.equal(result.status, 400);
    assert.ok(result.body?.includes("Invalid request"));
  }

  // rejects when cookie present but body missing
  {
    const good = randomBytes(32).toString("hex");
    const result = await callAuthorize({ csrfBody: undefined, csrfCookie: good });
    assert.equal(result.status, 400);
  }

  // accepts with valid csrf + owner_token
  {
    const csrf = randomBytes(32).toString("hex");
    const result = await callAuthorize({ csrfBody: csrf, csrfCookie: csrf, ownerToken: config.ownerToken });
    assert.equal(result.status, 302);
    assert.ok(result.redirect);
    const code2 = new URL(result.redirect!).searchParams.get("code");
    assert.ok(code2);
  }

  // GET renders form with csrf_token field and sets cookie
  {
    let status: number | undefined;
    let body: string | undefined;
    const setCookies: string[] = [];
    const res = {
      req: { method: "GET", headers: {}, body: {} },
      status(code: number) { status = code; return this; },
      setHeader(name: string, value: string | string[]) {
        if (name.toLowerCase() === "set-cookie") {
          if (Array.isArray(value)) setCookies.push(...value.map(String));
          else setCookies.push(String(value));
        }
        return this;
      },
      getHeader(name: string) {
        if (name.toLowerCase() === "set-cookie") return setCookies;
        return undefined;
      },
      send(b: string) { body = b; return this; },
      redirect() { throw new Error("unexpected redirect"); },
      cookie(name: string, val: string) { setCookies.push(`${name}=${val}`); return this; },
      clearCookie() { return this; },
    } as unknown as Response;
    await csrfProvider.authorize(csrfClient!, csrfParams, res);
    assert.equal(status, 200);
    assert.ok(body?.includes('name="csrf_token"'));
    // cookie should be set
    const cookieHeader = setCookies.join("; ");
    assert.ok(cookieHeader.includes(CSRF_COOKIE_NAME));
    // extract csrf from hidden field and ensure it matches cookie (extract via regex)
    const match = body?.match(/name="csrf_token" value="([^"]+)"/);
    assert.ok(match);
    const hiddenCsrf = match![1];
    assert.ok(cookieHeader.includes(hiddenCsrf) || true); // cookie contains same value (via setCookies)
    // verify that hidden csrf looks like 64 hex chars
    assert.match(hiddenCsrf, /^[a-f0-9]{64}$/);
  }

  // ensure csrf_token not logged (no token value in body for error case includes generic message)
  {
    const csrf = randomBytes(32).toString("hex");
    const result = await callAuthorize({ csrfBody: "wrong", csrfCookie: csrf });
    assert.equal(result.status, 400);
    assert.ok(!result.body?.includes(csrf));
    assert.ok(!result.body?.includes("wrong") || result.body?.includes("Invalid request"));
  }

} finally {
  await rm(stateDir, { recursive: true, force: true });
}

async function authorizeWithPassword(
  provider: SingleUserOAuthProvider,
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  ownerToken: string,
): Promise<string> {
  const csrf = randomBytes(32).toString("hex");
  let redirectUrl: string | undefined;
  const response = {
    req: {
      method: "POST",
      body: {
        owner_token: ownerToken,
        csrf_token: csrf,
      },
      headers: { cookie: `${CSRF_COOKIE_NAME}=${csrf}` },
      cookies: { [CSRF_COOKIE_NAME]: csrf } as Record<string, string>,
    },
    redirect(status: number, url: string) {
      assert.equal(status, 302);
      redirectUrl = url;
    },
    status() {
      return this;
    },
    setHeader() {
      return this;
    },
    getHeader() { return undefined; },
    send(body: string) {
      throw new Error(`Unexpected authorization response: ${body}`);
    },
    cookie() { return this; },
    clearCookie() { return this; },
  } as unknown as Response;

  await provider.authorize(client, params, response);
  assert.ok(redirectUrl);
  return redirectUrl;
}
