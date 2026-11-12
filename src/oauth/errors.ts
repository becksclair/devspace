import type { Response } from "express";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";

export { OAuthErrorCode };

/**
 * The HTTP status DevSpace answers for each OAuth error code.
 *
 * This is the mapping the endpoint handlers and the bearer middleware have always applied:
 * `server_error` is 500, `invalid_token` is 401 and `insufficient_scope` is 403 (both only ever
 * raised on the resource-server side), `method_not_allowed` is 405 and `too_many_requests` is
 * 429 (both answered directly by middleware, never thrown), and every other code is 400.
 */
export function oauthErrorStatus(code: string): number {
  switch (code) {
    case OAuthErrorCode.ServerError:
      return 500;
    case OAuthErrorCode.InvalidToken:
      return 401;
    case OAuthErrorCode.InsufficientScope:
      return 403;
    case OAuthErrorCode.MethodNotAllowed:
      return 405;
    case OAuthErrorCode.TooManyRequests:
      return 429;
    default:
      return 400;
  }
}

/**
 * The one OAuth error type DevSpace throws: an RFC 6749 error code, a human-readable description,
 * and the HTTP status it is answered with. It serializes as `{error, error_description}`.
 *
 * It extends the SDK's `OAuthError` so that token verifiers can throw it straight into the SDK's
 * `requireBearerAuth` middleware, which turns `invalid_token` into a 401 challenge and anything
 * that is not an `OAuthError` into a 500.
 */
export class OAuthHttpError extends OAuthError {
  readonly status: number;

  constructor(code: OAuthErrorCode, description: string) {
    super(code, description);
    this.name = "OAuthHttpError";
    this.status = oauthErrorStatus(code);
  }
}

/** The error as an OAuth error; anything else becomes an opaque `server_error`. */
export function asOAuthError(error: unknown): OAuthError {
  return error instanceof OAuthError ? error : new OAuthHttpError(OAuthErrorCode.ServerError, "Internal Server Error");
}

/** Sends an OAuth error body with its status. */
export function sendOAuthError(res: Response, error: unknown): void {
  const oauthError = asOAuthError(error);
  res.status(oauthErrorStatus(oauthError.code)).json(oauthError.toResponseObject());
}
