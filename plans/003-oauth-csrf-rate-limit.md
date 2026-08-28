# Plan 003: Harden OAuth owner approval with CSRF + rate limit

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ee85288..HEAD -- src/oauth-provider.ts src/server.ts src/config.ts src/oauth-provider.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `ee85288`, 2026-08-28
- **Issue**: —

## Why this matters

The Owner password approval form at `/authorize` is a state-changing POST with no CSRF token, no rate limit, and no throttle logging beyond `auth_denied`. An attacker who lures the owner to an allowed `redirect_uri` can attempt online guessing of the 16-char `DEVSPACE_OAUTH_OWNER_TOKEN` within allowed redirect hosts, and a login-CSRF can trick the owner into approving a attacker-controlled authorization request. Adding a double-submit CSRF token + per-IP rate limiting makes online guessing and CSRF impractical while keeping the single-user local flow.

## Current state

- Relevant files:
  - `src/oauth-provider.ts` — `formHtml()` builds `<form method="post">` from `hiddenFields` + `owner_token` without CSRF (line 105), and `authorize()` handles POST (lines 203-229) with `timingSafeEqual` owner token check but no CSRF, no rate limit
  - `src/server.ts` — `mcpAuthRouter({provider: oauthProvider, ...})` mounts `/authorize` at lines 1872-1881 without middleware
  - `src/config.ts` — `ownerToken` minimum 16 chars (line 307); config loading at 315
  - `src/logger.ts` — `logEvent` for `auth_denied` etc.
  - `src/oauth-provider.test.ts` — happy-path authorize/exchange/verify/refresh/revoke

- Excerpts (`src/oauth-provider.ts:103-120` form):
  ```ts
  formHtml(hiddenFields: string, redirectUri?: string): string {
    // builds <form method="post"> with hiddenFields + <input name="owner_token">
    // no csrf field
  }
  ```

- Excerpts (`src/oauth-provider.ts:203-229` authorize POST):
  ```ts
  async authorize(req: Request, res: Response): Promise<void> {
    if (req.method !== "POST") { /* render form */ }
    // verify resource, scope, redirect_uri
    const providedToken = req.body?.owner_token;
    if (!timingSafeEqual(providedToken, this.config.ownerToken)) { /* deny */ }
    // issue code, redirect
  }
  ```

- Excerpts (`src/server.ts:1872-1881`):
  ```ts
  const oauthProvider = new SingleUserOAuthProvider(...);
  app.use(mcpAuthRouter({ provider: oauthProvider, ... }));
  // no rateLimit middleware
  ```

- Excerpts (`src/server.ts:836` CORS wildcard, `805` CSP `wasm-unsafe-eval` are separate findings; not in this plan's scope)
- Current mitigation: `timingSafeEqual` + `allowedRedirectHosts` check (`src/oauth-provider.ts:146`). No CSRF cookie, no `SameSite`, no throttle.

- Repo conventions:
  - Express app built in `src/server.ts:1640-1916`, uses `express` 5, `requireBearerAuth` from MCP SDK.
  - Tests use `node:assert/strict` + `tsx`, no `supertest`; `src/oauth-provider.test.ts:32-95` uses direct provider method calls with mocked request/response.
  - Logging via `logEvent(config.logging, level, event, fields)`; see `src/logger.ts:8-96` structured JSON.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `npm run typecheck` | exit 0 |
| OAuth tests | `npx tsx src/oauth-provider.test.ts` | all pass (including new CSRF/rate cases) |
| Headless auth test | `npx tsx src/headless-auth.test.ts` | all pass |
| Full suite | `npm test` | all pass (modulo known terminal flake) |

## Scope

**In scope** (the only files you should modify):
- `src/oauth-provider.ts`
- `src/server.ts`
- `src/oauth-provider.test.ts` (add CSRF tests)
- `package.json` (if adding `express-rate-limit` dep)

**Out of scope** (do NOT touch, even though they look related):
- `src/config.ts` — owner token length/entropy policy unchanged
- `src/static-key-provider.ts` — separate token flow
- `src/oauth-store.ts` — code storage unchanged
- Frontend assets/CSP/CORS — separate plan
- `/healthz` auth — separate finding

## Git workflow

- Branch: `advisor/003-oauth-csrf`
- Commit per step; message style: `fix: ...`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Install and wire rate-limit dependency

Check if `express-rate-limit` already in `package.json` (it is not). Run:
```
npm install express-rate-limit@^7.5.0
```
Verify `package.json` and `package-lock.json` updated.

Add a thin wrapper in `src/server.ts` or `src/oauth-provider.ts` for rate limiting `POST /authorize` and `POST /token`. Prefer creating `src/rate-limit.ts` small helper so `oauth-provider.test.ts` can unit-test CSRF without Express, but for minimal diff, instantiate in `src/server.ts` where `mcpAuthRouter` is mounted.

Option A (minimal): In `src/server.ts` before `app.use(mcpAuthRouter(...))`, create:
```ts
import rateLimit from "express-rate-limit";
const authorizeLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: "too_many_requests", error_description: "Too many authorization attempts" } });
const tokenLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
```
Then wrap: `app.use("/authorize", authorizeLimiter)` and `app.use("/token", tokenLimiter)` *before* `mcpAuthRouter`.

Verify Express 5 compat: `express-rate-limit@7` supports Express 5.

**Verify**: `npm run typecheck` → exit 0. `npm ls express-rate-limit` shows installed.

### Step 2: Add CSRF nonce to OAuth form and verification

In `src/oauth-provider.ts`:

- Add a per-authorization CSRF token. The OAuth `AuthorizationParams` already flows via hidden fields; reuse it. Generate `csrfToken = randomUUID()` or `randomBytes(32).toString("hex")` when rendering the form (GET path). Store it in the `AuthorizationParams` state or as a signed cookie. Simplest for single-user local: use a double-submit cookie pattern that doesn't require server session store:

  - On GET `/authorize`, generate `csrf = randomBytes(32).toString("hex")`; set cookie `__Host-devspace-csrf` with `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600` (if not HTTPS on loopback, omit Secure but keep `SameSite=Lax`). Also inject hidden field `<input type="hidden" name="csrf_token" value="${csrf}">` into form HTML. Use `crypto.randomBytes`.

  - On POST `/authorize`, verify `req.body.csrf_token` equals `req.cookies?.["__Host-devspace-csrf"]` (or `__Host-devspace-csrf`) using `timingSafeEqual`. If missing/mismatch, return `400` with `invalid_request` and log `auth_denied` with `reason: "csrf_mismatch"` without revealing token.

- CSRF cookie handling: Express needs `cookie-parser` if not already present. Check `package.json`; if absent, add `cookie-parser@^1.4.7` (`npm install cookie-parser`) and `app.use(cookieParser())` before auth router. If you prefer to avoid a new dependency, store CSRF token inside the OAuth `AuthorizationParams` `code_challenge` flow? Simpler: embed CSRF as part of hidden fields that are already validated via `state` param? Inspect existing `hiddenFields` serialization in `formHtml` to see if it already encodes `client_id`/`redirect_uri`/`state`/`code_challenge`. Add `csrf_token` there and validate against a server-side Map keyed by `state`. The `state` is already client-controlled; using it for CSRF would not add protection. So cookie is correct.

- Modify `formHtml(hiddenFields, csrfToken, redirectUri?)` to render the extra hidden input. Update call site that generates `hiddenFields` (in `authorize` GET branch) to generate and set cookie.

- Add `clearCookie` after successful POST (one-time).

**Verify**: Manual: `npx tsx src/oauth-provider.test.ts` new CSRF test fails before fix, passes after.

### Step 3: Add negative tests for CSRF and rate limit

In `src/oauth-provider.test.ts`, add (model after existing `authorize` happy test at line 32):

- `rejects authorize without csrf_token` — POST with valid owner_token but no csrf → `InvalidRequestError` or 400.
- `rejects authorize with mismatched csrf` — POST with csrf_token != cookie → 400.
- `accepts authorize with valid csrf + owner_token` — 302 redirect with `code` (happy).
- Rate limit: since `express-rate-limit` is integration-level, add a lightweight integration test in `src/server-mcp-routing.test.ts` or a new inline test that creates a fresh Express app with the limiter and fires 11 POSTs to `/authorize` → 11th returns 429. Or skip rate limit unit test and document manual verification via `curl` loop. For this plan, at least add CSRF tests; rate limit can be verified via `curl` + `npm test` not breaking.

**Verify**: `npx tsx src/oauth-provider.test.ts` → all new CSRF tests pass; happy path still passes.

### Step 4: Harden cookie and form attributes

Ensure:
- Form rendered by `formHtml` has no `action` that leaks to cross-origin (default self).
- Cookie uses `SameSite=Lax`, `Path=/`, `HttpOnly`, `Secure` when `config.publicBaseUrl` is `https:`; otherwise `Secure` omitted for `http://127.0.0.1` loopback dev.
- No `csrf_token` logged; `logEvent` for `auth_denied` includes `reason` but not token value.
- If `cookie-parser` added, ensure it is wired before `mcpAuthRouter` and after `express.json()` etc., and does not parse unsigned cookie as secret.

**Verify**: `npm run typecheck` → exit 0. `npx tsx src/oauth-provider.test.ts` → pass.

## Test plan

- New tests in `src/oauth-provider.test.ts`:
  - CSRF missing → 400
  - CSRF mismatch → 400
  - CSRF valid + owner_token valid → 302 with code
  - Scope/redirect validation still fails before CSRF check (ordering)
- Existing tests: `oauth-provider.test.ts` happy path + `headless-auth.test.ts` (which mocks fetch discovery and dynamic client registration) still pass — headless auth's `auth mint` flow uses the same provider and must include CSRF cookie handling if it hits the form path; verify `headless-auth.test.ts:102` does not assume no cookie (it likely mocks fetch directly, so unaffected).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npx tsx src/oauth-provider.test.ts` exits 0 and includes the 3 new CSRF tests
- [ ] `grep -rn "csrf" src/oauth-provider.ts` returns matches (token generation + verification + cookie)
- [ ] `grep -rn "rateLimit\|express-rate-limit" src/server.ts` returns matches and limiter is mounted before `mcpAuthRouter`
- [ ] `grep -rn "owner_token" src/oauth-provider.ts` still uses `timingSafeEqual`
- [ ] No files outside in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 003 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `src/oauth-provider.ts:105` or `203-229` doesn't match the excerpts (drift).
- `mcpAuthRouter` API changed (e.g., no longer mounts `/authorize` via `app.use`) — the limiter mounting point must move with it.
- `cookie-parser` collides with existing cookie handling (search `cookie` in src); if a cookie middleware already exists, reuse it.
- `express-rate-limit` is incompatible with the installed Express version (`5.2.1`) or `trust proxy` settings for `requestIp` — check `app.set("trust proxy", ...)` in `src/server.ts` before assuming IP key.
- Headless auth `devspace auth mint` (src/headless-auth.ts) automates approval without a browser/cookie — it will need to fetch the CSRF cookie on GET before POST. If it fails, update that flow to handle the cookie (fetch GET, extract `set-cookie`, send `csrf_token` + cookie on POST) or mark the plan BLOCKED and refine.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- If a new OAuth endpoint is added (e.g., `/par`), apply the same limiter pattern; extract the `authorizeLimiter`/`tokenLimiter` configs to `src/rate-limit.ts`.
- When `trustProxy` is enabled behind Cloudflare Tunnel, the rate limiter's key is `req.ip` derived via `X-Forwarded-For` — ensure `app.set("trust proxy", 1)` is set consistently with `src/config.ts` allowedHosts logic, otherwise all clients share one bucket.
- Rotation note: a committed secret is burned even after removal; if any prior `DEVSPACE_OAUTH_OWNER_TOKEN` was logged or persisted in event/history stores, rotate `~/.devspace/auth.json` owner token and `X-DevSpace-Node-Token` values for gateway nodes.
- Reviewer should scrutinize that the CSRF cookie is not readable via JS (`HttpOnly`) but the hidden field is — the double-submit pattern is sufficient for same-site POST; consider switching to `SameSite=Lax` cookie + `Origin` header check as second layer if the form is ever framed.
