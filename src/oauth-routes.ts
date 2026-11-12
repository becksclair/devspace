import express from "express";
import {
  authorizationHandler,
  clientRegistrationHandler,
  createOAuthMetadata,
  mcpAuthMetadataRouter,
  revocationHandler,
  tokenHandler,
  type OAuthServerProvider,
} from "@modelcontextprotocol/server-legacy/auth";

export interface OAuthRoutesOptions {
  provider: OAuthServerProvider;
  issuerUrl: URL;
  baseUrl: URL;
  resourceServerUrl: URL;
  scopesSupported: string[];
  resourceName: string;
}

/**
 * The OAuth authorization-server routes, composed from the legacy SDK's individual handlers.
 *
 * This mirrors `mcpAuthRouter` from `@modelcontextprotocol/sdk` 1.x: the same paths, mount
 * order, handlers, and handler defaults (including their built-in rate limiters). It does not
 * use `mcpAuthRouter` from `@modelcontextprotocol/server-legacy` because that router always
 * appends the RFC 9207 `iss` parameter to authorization redirects and always advertises
 * `authorization_response_iss_parameter_supported`. RFC 9207 is intentionally off here, so the
 * authorization handler gets no issuer and the metadata document omits that key, keeping the
 * wire output identical to the 1.x router.
 */
export function oauthRoutes(options: OAuthRoutesOptions): express.Router {
  const {
    authorization_response_iss_parameter_supported: _rfc9207Advertisement,
    ...oauthMetadata
  } = createOAuthMetadata({
    provider: options.provider,
    issuerUrl: options.issuerUrl,
    baseUrl: options.baseUrl,
    scopesSupported: options.scopesSupported,
  });

  const router = express.Router();
  router.use(new URL(oauthMetadata.authorization_endpoint).pathname, authorizationHandler({ provider: options.provider }));
  router.use(new URL(oauthMetadata.token_endpoint).pathname, tokenHandler({ provider: options.provider }));
  router.use(mcpAuthMetadataRouter({
    oauthMetadata,
    resourceServerUrl: options.resourceServerUrl,
    scopesSupported: options.scopesSupported,
    resourceName: options.resourceName,
  }));
  if (oauthMetadata.registration_endpoint) {
    router.use(new URL(oauthMetadata.registration_endpoint).pathname, clientRegistrationHandler({
      clientsStore: options.provider.clientsStore,
    }));
  }
  if (oauthMetadata.revocation_endpoint) {
    router.use(new URL(oauthMetadata.revocation_endpoint).pathname, revocationHandler({ provider: options.provider }));
  }
  return router;
}
