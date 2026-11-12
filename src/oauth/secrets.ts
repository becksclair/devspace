import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality with exactly the semantics of `===`.
 *
 * Both strings are compared as UTF-16 code units, so no two distinct strings compare equal (UTF-8
 * would map different lone surrogates to the same replacement bytes). Only the length can leak.
 */
export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf16le");
  const b = Buffer.from(right, "utf16le");
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

/** RFC 7636 S256: `BASE64URL(SHA256(code_verifier))` must equal the recorded challenge. */
export function pkceS256Matches(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
  return constantTimeEqual(computed, codeChallenge);
}
