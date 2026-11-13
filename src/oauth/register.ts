import { randomBytes } from "node:crypto";
import express, { type RequestHandler } from "express";
import { OAuthClientMetadataSchema } from "@modelcontextprotocol/core";
import { hasFragmentOrUserinfo } from "./authorize.js";
import { OAuthErrorCode, OAuthHttpError, sendOAuthError } from "./errors.js";
import { allowAnyOrigin, allowedMethods, endpointRateLimit } from "./http.js";
import type { OAuthRegisteredClientsStore } from "./provider.js";

const CLIENT_SECRET_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Dynamic client registration (RFC 7591). The metadata is validated against the SDK schema; a
 * redirect URI with a fragment or userinfo, which `/authorize` would never redirect to, is
 * `invalid_redirect_uri`; the clients store applies DevSpace's registration policy and assigns
 * `client_id` and `client_id_issued_at`.
 *
 * A client that registers `token_endpoint_auth_method: "none"`, or omits the method (which the
 * store then records as "none"), is a public client and gets no secret. Any other method is
 * issued a 32-byte hex secret that expires after 30 days.
 */
export function registrationEndpoint(clientsStore: OAuthRegisteredClientsStore): RequestHandler {
  const router = express.Router();
  router.use(allowAnyOrigin());
  router.use(endpointRateLimit(60 * 60 * 1000, 20, "You have exceeded the rate limit for client registration requests"));
  router.use(allowedMethods(["POST"]));
  router.use(express.json());

  router.post("/", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const metadata = OAuthClientMetadataSchema.safeParse(req.body);
      if (!metadata.success) throw new OAuthHttpError(OAuthErrorCode.InvalidClientMetadata, metadata.error.message);
      // The schema only admits parsable URLs.
      if (metadata.data.redirect_uris.some((uri) => hasFragmentOrUserinfo(uri, new URL(uri)))) {
        throw new OAuthHttpError(OAuthErrorCode.InvalidRedirectUri, "Client redirect_uri must not contain a fragment or userinfo");
      }

      const isPublicClient = (metadata.data.token_endpoint_auth_method ?? "none") === "none";
      const issuedAt = Math.floor(Date.now() / 1000);
      const registered = await clientsStore.registerClient({
        ...metadata.data,
        client_secret: isPublicClient ? undefined : randomBytes(32).toString("hex"),
        client_secret_expires_at: isPublicClient ? undefined : issuedAt + CLIENT_SECRET_TTL_SECONDS,
      });
      res.status(201).json(registered);
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  return router;
}
