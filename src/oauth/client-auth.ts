import type { Request, RequestHandler } from "express";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { OAuthErrorCode, OAuthHttpError, sendOAuthError } from "./errors.js";
import type { OAuthRegisteredClientsStore } from "./provider.js";
import { constantTimeEqual } from "./secrets.js";

const ClientCredentialsSchema = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
});

const authenticatedClients = new WeakMap<Request, OAuthClientInformationFull>();

/** The client `authenticateClient` accepted for this request. */
export function authenticatedClient(req: Request): OAuthClientInformationFull {
  const client = authenticatedClients.get(req);
  if (!client) throw new OAuthHttpError(OAuthErrorCode.ServerError, "Internal Server Error");
  return client;
}

/**
 * Client authentication for the token and revocation endpoints (`client_secret_post` or `none`).
 *
 * In order: the body must carry a string `client_id`; the client must exist; a client that holds
 * a secret must present it, it must match, and it must not have expired. A client registered
 * without a secret (`token_endpoint_auth_method: "none"`) authenticates by `client_id` alone.
 * Failures are answered here, before the endpoint sets `Cache-Control`.
 */
export function authenticateClient(clientsStore: OAuthRegisteredClientsStore): RequestHandler {
  return async (req, res, next) => {
    try {
      const credentials = ClientCredentialsSchema.safeParse(req.body);
      if (!credentials.success) {
        throw new OAuthHttpError(OAuthErrorCode.InvalidRequest, String(credentials.error));
      }
      const { client_id, client_secret } = credentials.data;
      const client = await clientsStore.getClient(client_id);
      if (!client) {
        throw new OAuthHttpError(OAuthErrorCode.InvalidClient, "Invalid client_id");
      }
      if (client.client_secret) {
        if (!client_secret) {
          throw new OAuthHttpError(OAuthErrorCode.InvalidClient, "Client secret is required");
        }
        if (!constantTimeEqual(client.client_secret, client_secret)) {
          throw new OAuthHttpError(OAuthErrorCode.InvalidClient, "Invalid client_secret");
        }
        if (client.client_secret_expires_at && client.client_secret_expires_at < Math.floor(Date.now() / 1000)) {
          throw new OAuthHttpError(OAuthErrorCode.InvalidClient, "Client secret has expired");
        }
      }
      authenticatedClients.set(req, client);
      next();
    } catch (error) {
      sendOAuthError(res, error);
    }
  };
}
