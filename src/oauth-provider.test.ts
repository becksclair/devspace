import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response } from "express";
import type {
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { SingleUserOAuthProvider, type OAuthConfig } from "./oauth-provider.js";
import { SqliteOAuthStateStore } from "./oauth-store.js";

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
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

async function authorizeWithPassword(
  provider: SingleUserOAuthProvider,
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  ownerToken: string,
): Promise<string> {
  let redirectUrl: string | undefined;
  const response = {
    req: {
      method: "POST",
      body: {
        owner_token: ownerToken,
      },
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
    send(body: string) {
      throw new Error(`Unexpected authorization response: ${body}`);
    },
  } as unknown as Response;

  await provider.authorize(client, params, response);
  assert.ok(redirectUrl);
  return redirectUrl;
}
