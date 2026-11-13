import express, { type RequestHandler } from "express";
import type { OAuthClientInformationFull, OAuthError } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { asOAuthError, OAuthErrorCode, OAuthHttpError, sendOAuthError } from "./errors.js";
import { allowedMethods, endpointRateLimit } from "./http.js";
import type { OAuthServerProvider } from "./provider.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a redirect URI carries a fragment (RFC 6749 section 3.1.2) or userinfo, including an
 * empty one such as `http://@host/`, which the URL parser would otherwise drop silently. Such a URI
 * is never a redirect target, and `/register` refuses to register one.
 */
export function hasFragmentOrUserinfo(uri: string, url: URL): boolean {
  if (uri.includes("#")) return true;
  if (url.username !== "" || url.password !== "") return true;
  if (url.host === "") return false;
  // The URL parser's own preprocessing: trim C0 controls and spaces, drop tabs and newlines.
  const input = uri.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "").replace(/[\t\n\r]/g, "");
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:[\\/]*([^\\/?#]*)/.exec(input)?.[1] ?? "";
  return authority.includes("@");
}

/**
 * Whether a requested redirect URI matches a registered one. A requested URI with a fragment or
 * userinfo never matches. Otherwise it must match exactly, or (RFC 8252 section 7.3) differ only in
 * port when both are on the same loopback host; `localhost` and `127.0.0.1` do not match each other.
 */
export function redirectUriMatches(requested: string, registered: string): boolean {
  let requestedUrl: URL;
  try {
    requestedUrl = new URL(requested);
  } catch {
    return false;
  }
  if (hasFragmentOrUserinfo(requested, requestedUrl)) return false;
  if (requested === registered) return true;
  let registeredUrl: URL;
  try {
    registeredUrl = new URL(registered);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(requestedUrl.hostname) || !LOOPBACK_HOSTS.has(registeredUrl.hostname)) return false;
  // Only the port is relaxed: everything else in the serialized URL must be identical.
  requestedUrl.port = "";
  registeredUrl.port = "";
  return requestedUrl.href === registeredUrl.href;
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
  if (client.redirect_uris.length === 1) {
    // The same rule as for a requested URI: one with a fragment or userinfo is never a target.
    const [registered] = client.redirect_uris;
    if (!redirectUriMatches(registered, registered)) {
      throw new OAuthHttpError(OAuthErrorCode.InvalidRequest, "Registered redirect_uri is not usable");
    }
    return { client, redirectUri: registered };
  }
  throw new OAuthHttpError(OAuthErrorCode.InvalidRequest, "redirect_uri must be specified when client has multiple registered URIs");
}

function requestParam(input: unknown, name: string): unknown {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>)[name] : undefined;
}

/** The request's `state`, read before any schema check: a non-empty string, or nothing. */
function requestState(input: unknown): string | undefined {
  const state = requestParam(input, "state");
  return typeof state === "string" && state !== "" ? state : undefined;
}

function errorRedirect(redirectUri: string, error: OAuthError, state: string | undefined): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error.code);
  url.searchParams.set("error_description", error.message);
  if (state !== undefined) url.searchParams.set("state", state);
  return url.href;
}

/**
 * The authorization endpoint (RFC 6749 section 3.1), GET or POST. It has no CORS handling: it is
 * navigated to by the user's browser, never fetched cross-origin.
 *
 * An absent or empty `scope` resolves here, once, to `defaultScopes` (RFC 6749 section 3.3), so
 * the approval page, its hidden `scope` field, the code, and the issued tokens all carry it.
 */
export function authorizationEndpoint(provider: OAuthServerProvider, defaultScopes: string[]): RequestHandler {
  const router = express.Router();
  router.use(endpointRateLimit(60 * 1000, 10, "You have exceeded the rate limit for authorization requests"));
  router.use(allowedMethods(["GET", "POST"]));
  router.use(express.urlencoded({ extended: false }));

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

    // Phase 2: everything else. Failures redirect back to the verified redirect URI, echoing
    // `state` whenever the request carried a non-empty string, even if other parameters fail.
    const errorState = requestState(input);
    try {
      const responseType = requestParam(input, "response_type");
      // A repeated parameter arrives as an array and is left to the schema (invalid_request).
      if (typeof responseType === "string" && responseType !== "" && responseType !== "code") {
        throw new OAuthHttpError(OAuthErrorCode.UnsupportedResponseType, "Only response_type \"code\" is supported");
      }
      const parsed = RequestParamsSchema.safeParse(input);
      if (!parsed.success) throw new OAuthHttpError(OAuthErrorCode.InvalidRequest, parsed.error.message);
      const { state, scope, code_challenge, resource } = parsed.data;

      // RFC 9207 is intentionally not implemented: no `iss` is passed to the provider or appended
      // to its redirect, and the metadata does not advertise it. Adopting it means appending `iss`
      // here, to both the provider's success redirect and `errorRedirect`, and advertising
      // `authorization_response_iss_parameter_supported` in `authorizationServerMetadata`.
      await provider.authorize(
        verified.client,
        {
          state,
          scopes: scope === undefined || scope === "" ? [...defaultScopes] : scope.split(" "),
          redirectUri: verified.redirectUri,
          codeChallenge: code_challenge,
          resource: resource ? new URL(resource) : undefined,
        },
        res,
      );
    } catch (error) {
      res.redirect(302, errorRedirect(verified.redirectUri, asOAuthError(error), errorState));
    }
  });

  return router;
}
