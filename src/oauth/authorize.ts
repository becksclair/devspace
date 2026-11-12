import express, { type RequestHandler } from "express";
import type { OAuthClientInformationFull, OAuthError } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { asOAuthError, OAuthErrorCode, OAuthHttpError, sendOAuthError } from "./errors.js";
import { allowedMethods, endpointRateLimit } from "./http.js";
import type { OAuthServerProvider } from "./provider.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a requested redirect URI matches a registered one: exactly, or (RFC 8252 section 7.3)
 * differing only in port when both are on the same loopback host. Scheme, hostname, path, and
 * query must still match; `localhost` and `127.0.0.1` do not match each other.
 */
export function redirectUriMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  let requestedUrl: URL;
  let registeredUrl: URL;
  try {
    requestedUrl = new URL(requested);
    registeredUrl = new URL(registered);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(requestedUrl.hostname) || !LOOPBACK_HOSTS.has(registeredUrl.hostname)) return false;
  return requestedUrl.protocol === registeredUrl.protocol &&
    requestedUrl.hostname === registeredUrl.hostname &&
    requestedUrl.pathname === registeredUrl.pathname &&
    requestedUrl.search === registeredUrl.search;
}

// What must be valid before anything may be sent to the redirect URI.
const ClientParamsSchema = z.object({
  client_id: z.string(),
  redirect_uri: z
    .string()
    .optional()
    .refine((value) => value === undefined || URL.canParse(value), { message: "redirect_uri must be a valid URL" }),
});

// The rest of the request. Failures here are reported to the redirect URI.
const RequestParamsSchema = z.object({
  response_type: z.literal("code"),
  code_challenge: z.string(),
  code_challenge_method: z.literal("S256"),
  scope: z.string().optional(),
  state: z.string().optional(),
  resource: z.string().url().optional(),
});

interface VerifiedClient {
  client: OAuthClientInformationFull;
  redirectUri: string;
}

/**
 * Phase 1: the client and its redirect URI. Every failure here is answered directly with a JSON
 * error and never redirects: a missing or unknown `client_id`, an unparsable or unregistered
 * `redirect_uri`, or an omitted one when the client registered several.
 */
async function verifyClient(provider: OAuthServerProvider, input: unknown): Promise<VerifiedClient> {
  const parsed = ClientParamsSchema.safeParse(input);
  if (!parsed.success) throw new OAuthHttpError(OAuthErrorCode.InvalidRequest, parsed.error.message);

  const client = await provider.clientsStore.getClient(parsed.data.client_id);
  if (!client) throw new OAuthHttpError(OAuthErrorCode.InvalidClient, "Invalid client_id");

  const requested = parsed.data.redirect_uri;
  if (requested !== undefined) {
    if (!client.redirect_uris.some((registered) => redirectUriMatches(requested, registered))) {
      throw new OAuthHttpError(OAuthErrorCode.InvalidRequest, "Unregistered redirect_uri");
    }
    return { client, redirectUri: requested };
  }
  if (client.redirect_uris.length === 1) return { client, redirectUri: client.redirect_uris[0] };
  throw new OAuthHttpError(OAuthErrorCode.InvalidRequest, "redirect_uri must be specified when client has multiple registered URIs");
}

function errorRedirect(redirectUri: string, error: OAuthError, state: string | undefined): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error.code);
  url.searchParams.set("error_description", error.message);
  // `state` is echoed only when it parsed and is non-empty.
  if (state) url.searchParams.set("state", state);
  return url.href;
}

/**
 * The authorization endpoint (RFC 6749 section 3.1), GET or POST. It has no CORS handling: it is
 * navigated to by the user's browser, never fetched cross-origin.
 */
export function authorizationEndpoint(provider: OAuthServerProvider): RequestHandler {
  const router = express.Router();
  router.use(allowedMethods(["GET", "POST"]));
  router.use(express.urlencoded({ extended: false }));
  router.use(endpointRateLimit(15 * 60 * 1000, 100, "You have exceeded the rate limit for authorization requests"));

  router.all("/", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const input: unknown = req.method === "POST" ? req.body : req.query;

    let verified: VerifiedClient;
    try {
      verified = await verifyClient(provider, input);
    } catch (error) {
      sendOAuthError(res, error);
      return;
    }

    // Phase 2: everything else. Failures redirect back to the verified redirect URI. A schema
    // failure loses `state`, because it is read only from a successful parse.
    let state: string | undefined;
    try {
      const parsed = RequestParamsSchema.safeParse(input);
      if (!parsed.success) throw new OAuthHttpError(OAuthErrorCode.InvalidRequest, parsed.error.message);
      state = parsed.data.state;
      const { scope, code_challenge, resource } = parsed.data;

      // RFC 9207 is intentionally not implemented: no `iss` is passed to the provider or appended
      // to its redirect, and the metadata does not advertise it. Adopting it means appending `iss`
      // here, to both the provider's success redirect and `errorRedirect`, and advertising
      // `authorization_response_iss_parameter_supported` in `authorizationServerMetadata`.
      await provider.authorize(
        verified.client,
        {
          state,
          scopes: scope === undefined ? [] : scope.split(" "),
          redirectUri: verified.redirectUri,
          codeChallenge: code_challenge,
          resource: resource ? new URL(resource) : undefined,
        },
        res,
      );
    } catch (error) {
      res.redirect(302, errorRedirect(verified.redirectUri, asOAuthError(error), state));
    }
  });

  return router;
}
