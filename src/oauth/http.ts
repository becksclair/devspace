import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { OAuthErrorCode, OAuthHttpError } from "./errors.js";

/** The methods every CORS preflight answer advertises (the `cors` package's default list). */
const PREFLIGHT_ALLOWED_METHODS = "GET,HEAD,PUT,PATCH,POST,DELETE";

/**
 * Permissive CORS for the endpoints browser-based MCP clients call directly.
 *
 * Every response gets `Access-Control-Allow-Origin: *`. A preflight (`OPTIONS`) is answered here
 * with an empty 204 that advertises the fixed method list and echoes the requested headers, before
 * any method check, body parsing, or rate limiting runs. No credentials, max-age, or exposed
 * headers are sent. This is byte-compatible with `cors()` at its defaults.
 */
export function allowAnyOrigin(): RequestHandler {
  return (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method.toUpperCase() !== "OPTIONS") {
      next();
      return;
    }
    res.setHeader("Access-Control-Allow-Methods", PREFLIGHT_ALLOWED_METHODS);
    res.vary("Access-Control-Request-Headers");
    const requestedHeaders = req.headers["access-control-request-headers"];
    if (requestedHeaders) res.setHeader("Access-Control-Allow-Headers", requestedHeaders);
    res.statusCode = 204;
    res.setHeader("Content-Length", "0");
    res.end();
  };
}

/** Answers any method outside `allowed` with 405, an `Allow` header, and an OAuth error body. */
export function allowedMethods(allowed: string[]): RequestHandler {
  return (req, res, next) => {
    if (allowed.includes(req.method)) {
      next();
      return;
    }
    const error = new OAuthHttpError(OAuthErrorCode.MethodNotAllowed, `The method ${req.method} is not allowed for this endpoint`);
    res.status(405).set("Allow", allowed.join(", ")).json(error.toResponseObject());
  };
}

/**
 * The one rate limiter of an OAuth endpoint, keyed on the client address (`req.ip`, which honors
 * the app's `trust proxy` setting). Each endpoint installs it first, right after its CORS handling:
 * a preflight is answered before it and never counted, and every other request that reaches the
 * endpoint is counted before the endpoint's own method check and body parser. The app-wide JSON
 * parser in `createMcpApp` runs earlier still: a body it rejects (malformed or over its size limit)
 * is answered 400 or 413 there, never reaches the endpoint and is not counted. A request over the
 * limit that does reach the endpoint is answered 429 with a `too_many_requests` OAuth error body
 * and `Retry-After`; every counted response carries the `RateLimit-*` headers of this limit.
 */
export function endpointRateLimit(windowMs: number, limit: number, description: string): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: new OAuthHttpError(OAuthErrorCode.TooManyRequests, description).toResponseObject(),
  });
}
