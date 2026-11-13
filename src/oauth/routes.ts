// DevSpace's OAuth 2.1 authorization-server endpoints.
//
// DevSpace owns this code. The endpoint behavior was ported from the OAuth authorization-server
// helpers of the MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.x, frozen as
// `@modelcontextprotocol/server-legacy` 2.4.0; Copyright Anthropic, PBC; MIT, being relicensed
// to Apache-2.0), which is no longer maintained. The wire behavior is pinned by
// `src/server-oauth-http.test.ts`.
//
// The resource-server half is not here: the discovery documents are served by the SDK's
// maintained `mcpAuthMetadataRouter`, and `/mcp` uses its `requireBearerAuth` (see server.ts).

import express from "express";
import type { OAuthMetadata } from "@modelcontextprotocol/server";
import { mcpAuthMetadataRouter } from "@modelcontextprotocol/express";
import { authorizationEndpoint } from "./authorize.js";
import type { OAuthServerProvider } from "./provider.js";
import { registrationEndpoint } from "./register.js";
import { revocationEndpoint } from "./revoke.js";
import { tokenEndpoint } from "./token.js";

export interface OAuthRoutesOptions {
  provider: OAuthServerProvider;
  issuerUrl: URL;
  baseUrl: URL;
  resourceServerUrl: URL;
  scopesSupported: string[];
  resourceName: string;
}

/**
 * RFC 8414 authorization-server metadata. It does not advertise RFC 9207
 * (`authorization_response_iss_parameter_supported`): no `iss` is sent on authorization responses.
 */
export function authorizationServerMetadata(options: Pick<OAuthRoutesOptions, "issuerUrl" | "baseUrl" | "scopesSupported">): OAuthMetadata {
  // Endpoint paths are absolute, so they sit at the root of `baseUrl`'s origin whatever its path.
  const endpoint = (path: string): string => new URL(path, options.baseUrl).href;
  return {
    issuer: options.issuerUrl.href,
    authorization_endpoint: endpoint("/authorize"),
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint: endpoint("/token"),
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    scopes_supported: options.scopesSupported,
    revocation_endpoint: endpoint("/revoke"),
    revocation_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    registration_endpoint: endpoint("/register"),
  };
}

/**
 * Mounts `/authorize`, `/token`, both discovery documents, `/register`, and `/revoke`. Each
 * endpoint is its own router with its own CORS policy, method check, body parser, and rate
 * limiter. Throws at construction when the issuer is not HTTPS (localhost excepted), has a
 * fragment, or has a query string.
 */
export function oauthRoutes(options: OAuthRoutesOptions): express.Router {
  const router = express.Router();
  // A request without `scope` is granted the first supported scope, the one `/mcp` requires.
  router.use("/authorize", authorizationEndpoint(options.provider, options.scopesSupported.slice(0, 1)));
  router.use("/token", tokenEndpoint(options.provider));
  router.use(mcpAuthMetadataRouter({
    oauthMetadata: authorizationServerMetadata(options),
    resourceServerUrl: options.resourceServerUrl,
    scopesSupported: options.scopesSupported,
    resourceName: options.resourceName,
  }));
  router.use("/register", registrationEndpoint(options.provider.clientsStore));
  router.use("/revoke", revocationEndpoint(options.provider));
  return router;
}
