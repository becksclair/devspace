import express, { type RequestHandler } from "express";
import { OAuthTokenRevocationRequestSchema } from "@modelcontextprotocol/core";
import { authenticateClient, authenticatedClient } from "./client-auth.js";
import { OAuthErrorCode, OAuthHttpError, sendOAuthError } from "./errors.js";
import { allowAnyOrigin, allowedMethods, endpointRateLimit } from "./http.js";
import type { OAuthServerProvider } from "./provider.js";

/**
 * Token revocation (RFC 7009). The client is authenticated; the provider revokes the token.
 * Unknown tokens are not an error: the answer is 200 `{}` either way.
 */
export function revocationEndpoint(provider: OAuthServerProvider): RequestHandler {
  const router = express.Router();
  router.use(allowAnyOrigin());
  router.use(allowedMethods(["POST"]));
  router.use(express.urlencoded({ extended: false }));
  router.use(endpointRateLimit(15 * 60 * 1000, 50, "You have exceeded the rate limit for token revocation requests"));
  router.use(authenticateClient(provider.clientsStore));

  router.post("/", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const request = OAuthTokenRevocationRequestSchema.safeParse(req.body);
      if (!request.success) throw new OAuthHttpError(OAuthErrorCode.InvalidRequest, request.error.message);
      await provider.revokeToken(authenticatedClient(req), request.data);
      res.status(200).json({});
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  return router;
}
