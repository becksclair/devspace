import express, { type RequestHandler } from "express";
import * as z from "zod/v4";
import { authenticateClient, authenticatedClient } from "./client-auth.js";
import { OAuthErrorCode, OAuthHttpError, sendOAuthError } from "./errors.js";
import { allowAnyOrigin, allowedMethods, endpointRateLimit } from "./http.js";
import type { OAuthServerProvider } from "./provider.js";
import { pkceS256Matches } from "./secrets.js";

const TokenRequestSchema = z.object({
  grant_type: z.string(),
});

const AuthorizationCodeGrantSchema = z.object({
  code: z.string(),
  code_verifier: z.string(),
  redirect_uri: z.string().optional(),
  resource: z.string().url().optional(),
});

const RefreshTokenGrantSchema = z.object({
  refresh_token: z.string(),
  scope: z.string().optional(),
  resource: z.string().url().optional(),
});

/**
 * The token endpoint (RFC 6749 section 3.2): `authorization_code` with PKCE S256, and
 * `refresh_token`. The client is authenticated before `Cache-Control: no-store` is set, so client
 * authentication failures carry no `Cache-Control`.
 */
export function tokenEndpoint(provider: OAuthServerProvider): RequestHandler {
  const router = express.Router();
  router.use(allowAnyOrigin());
  router.use(allowedMethods(["POST"]));
  router.use(express.urlencoded({ extended: false }));
  router.use(endpointRateLimit(15 * 60 * 1000, 50, "You have exceeded the rate limit for token requests"));
  router.use(authenticateClient(provider.clientsStore));

  router.post("/", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const request = TokenRequestSchema.safeParse(req.body);
      if (!request.success) throw new OAuthHttpError(OAuthErrorCode.InvalidRequest, request.error.message);
      const client = authenticatedClient(req);

      switch (request.data.grant_type) {
        case "authorization_code": {
          const grant = AuthorizationCodeGrantSchema.safeParse(req.body);
          if (!grant.success) throw new OAuthHttpError(OAuthErrorCode.InvalidRequest, grant.error.message);
          const { code, code_verifier, redirect_uri, resource } = grant.data;

          // PKCE is always verified here, before the provider sees the code.
          const challenge = await provider.challengeForAuthorizationCode(client, code);
          if (!pkceS256Matches(code_verifier, challenge)) {
            throw new OAuthHttpError(OAuthErrorCode.InvalidGrant, "code_verifier does not match the challenge");
          }

          const tokens = await provider.exchangeAuthorizationCode(
            client,
            code,
            undefined,
            redirect_uri,
            resource ? new URL(resource) : undefined,
          );
          res.status(200).json(tokens);
          return;
        }
        case "refresh_token": {
          const grant = RefreshTokenGrantSchema.safeParse(req.body);
          if (!grant.success) throw new OAuthHttpError(OAuthErrorCode.InvalidRequest, grant.error.message);
          const { refresh_token, scope, resource } = grant.data;
          const tokens = await provider.exchangeRefreshToken(
            client,
            refresh_token,
            // An empty `scope` is an omitted one, as at /authorize: the granted scope is kept.
            scope ? scope.split(" ") : undefined,
            resource ? new URL(resource) : undefined,
          );
          res.status(200).json(tokens);
          return;
        }
        default:
          throw new OAuthHttpError(OAuthErrorCode.UnsupportedGrantType, "The grant type is not supported by this authorization server.");
      }
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  return router;
}
