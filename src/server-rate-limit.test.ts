import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "./config.js";
import { createServer } from "./server.js";
import { normalizeRootPolicies } from "./roots.js";

const stateDir = await mkdtemp(join(tmpdir(), "devspace-rate-limit-test-"));
const publicBaseUrl = "http://127.0.0.1:7676";
const config = {
  host: "127.0.0.1",
  port: 7676,
  oauth: {
    ownerToken: "test-owner-token-that-is-long-enough",
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 2592000,
    scopes: ["devspace"],
    allowedRedirectHosts: [],
  },
  allowedRoots: [process.cwd()],
  rootPolicies: normalizeRootPolicies([{ path: process.cwd(), access: "read-write" }]),
  allowedHosts: ["127.0.0.1"],
  publicBaseUrl,
  minimalTools: true,
  toolNaming: "short",
  widgets: "off",
  annotationProfile: "trusted-owner",
  stateDir,
  worktreeRoot: join(stateDir, "worktrees"),
  skillsEnabled: false,
  skillPaths: [],
  agentDir: stateDir,
  globalInstructionsFile: join(stateDir, "AGENTS.md"),
  shell: { mode: "service" },
  secretNames: ["DEVSPACE_OAUTH_OWNER_TOKEN"],
  terminals: {
    backend: "tmux",
    runtimeDir: join(stateDir, "terminal-runtime"),
    maxPerWorkspace: 2,
    maxTotal: 4,
    idleTtlSeconds: 3600,
    useUserSystemd: false,
  },
  maintenance: {
    intervalSeconds: 3600,
    closedSessionTtlSeconds: 604800,
    checkoutIdleTtlSeconds: 2592000,
    isolatedIdleTtlSeconds: 604800,
  },
  sessions: {
    idleTtlSeconds: 1800,
    sweepIntervalSeconds: 60,
  },
  logging: {
    level: "silent",
    format: "json",
    requests: false,
    assets: false,
    toolCalls: false,
    shellCommands: false,
    trustProxy: "loopback",
  },
} satisfies ServerConfig;

async function assertLimited(
  result: Response,
  limit: number,
  windowSeconds: number,
  description: string,
  cors: boolean,
  label: string,
): Promise<void> {
  assert.equal(result.status, 429, `${label}: status`);
  assert.equal(result.headers.get("content-type"), "application/json; charset=utf-8", `${label}: content-type`);
  const retryAfter = Number(result.headers.get("retry-after"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= windowSeconds, `${label}: Retry-After ${retryAfter}`);
  assert.equal(result.headers.get("ratelimit-policy"), `${limit};w=${windowSeconds}`, `${label}: RateLimit-Policy`);
  assert.equal(result.headers.get("ratelimit-limit"), String(limit), `${label}: RateLimit-Limit`);
  assert.equal(result.headers.get("ratelimit-remaining"), "0", `${label}: RateLimit-Remaining`);
  assert.equal(result.headers.get("access-control-allow-origin"), cors ? "*" : null, `${label}: CORS`);
  assert.deepEqual(await result.json(), { error: "too_many_requests", error_description: description }, `${label}: body`);
}

const { app } = createServer(config);
const httpServer = app.listen(0, config.host);

try {
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });

  const address = httpServer.address() as AddressInfo;
  const baseUrl = `http://${config.host}:${address.port}`;
  const authorize = (xff: string) =>
    fetch(`${baseUrl}/authorize`, { headers: { "x-forwarded-for": xff }, redirect: "manual" });

  for (let i = 0; i < 10; i++) {
    assert.notEqual((await authorize("203.0.113.1")).status, 429, `request ${i + 1} from client A must not be limited`);
  }
  const limited = await authorize("203.0.113.1");
  await assertLimited(limited, 10, 60, "You have exceeded the rate limit for authorization requests", false, "11th request to /authorize from client A");
  assert.notEqual((await authorize("203.0.113.2")).status, 429, "client B has its own bucket");
  assert.equal(
    (await authorize("198.51.100.9, 203.0.113.1")).status,
    429,
    "a spoofed leftmost hop does not escape client A's bucket",
  );
  assert.equal(
    (await authorize("203.0.113.1, 127.0.0.1")).status,
    429,
    "a trailing loopback hop is skipped: still client A's bucket (fails under trust proxy = 1)",
  );

  // Every OAuth endpoint has exactly one limiter, keyed on the client address. Wrong methods are
  // counted; CORS preflights are answered before the limiter and never counted.
  const send = (path: string, xff: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, { ...init, headers: { ...init.headers, "x-forwarded-for": xff }, redirect: "manual" });
  const preflight = (path: string, xff: string) =>
    send(path, xff, { method: "OPTIONS", headers: { origin: "https://client.example", "access-control-request-method": "POST" } });
  for (const endpoint of [
    { path: "/token", limit: 30, windowSeconds: 60, description: "You have exceeded the rate limit for token requests", xff: "203.0.113.11" },
    { path: "/register", limit: 20, windowSeconds: 3600, description: "You have exceeded the rate limit for client registration requests", xff: "203.0.113.12" },
    { path: "/revoke", limit: 50, windowSeconds: 900, description: "You have exceeded the rate limit for token revocation requests", xff: "203.0.113.13" },
  ]) {
    for (let i = 0; i < 3; i++) {
      const answered = await preflight(endpoint.path, endpoint.xff);
      assert.equal(answered.status, 204, `${endpoint.path} preflight ${i + 1}`);
      assert.equal(answered.headers.get("ratelimit-policy"), null, `${endpoint.path} preflight ${i + 1}: not counted`);
    }
    for (let i = 0; i < endpoint.limit; i++) {
      // Alternate a wrong method with an empty POST: both are counted.
      const result = await send(endpoint.path, endpoint.xff, i % 2 === 0 ? { method: "GET" } : { method: "POST" });
      assert.notEqual(result.status, 429, `${endpoint.path} request ${i + 1} must not be limited`);
      assert.equal(result.headers.get("ratelimit-remaining"), String(endpoint.limit - i - 1), `${endpoint.path} request ${i + 1}: RateLimit-Remaining`);
    }
    await assertLimited(await send(endpoint.path, endpoint.xff, { method: "POST" }), endpoint.limit, endpoint.windowSeconds, endpoint.description, true, `${endpoint.path} over the limit`);
    await assertLimited(await send(endpoint.path, endpoint.xff, { method: "GET" }), endpoint.limit, endpoint.windowSeconds, endpoint.description, true, `${endpoint.path} wrong method over the limit`);
    assert.equal((await preflight(endpoint.path, endpoint.xff)).status, 204, `${endpoint.path} preflight over the limit is still answered`);
    assert.notEqual((await send(endpoint.path, "203.0.113.99", { method: "POST" })).status, 429, `${endpoint.path}: another client has its own bucket`);
  }
  // /authorize has no CORS handling, so OPTIONS is a wrong method there and is counted.
  for (let i = 0; i < 10; i++) {
    assert.notEqual((await send("/authorize", "203.0.113.14", { method: i % 2 === 0 ? "OPTIONS" : "PUT" })).status, 429, `/authorize wrong method ${i + 1}`);
  }
  await assertLimited(await send("/authorize", "203.0.113.14", { method: "OPTIONS" }), 10, 60, "You have exceeded the rate limit for authorization requests", false, "/authorize wrong methods over the limit");

  // Failed owner approvals are capped process-wide, so rotating X-Forwarded-For
  // (a fresh per-IP bucket for every request) cannot extend password guessing.
  const registration = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.250" },
    body: JSON.stringify({ redirect_uris: ["http://localhost:9999/callback"], client_name: "rate-limit-test" }),
  });
  assert.equal(registration.status, 201);
  const { client_id: clientId } = (await registration.json()) as { client_id: string };
  const approve = (ownerToken: string, xff: string) => {
    const csrf = "a".repeat(64);
    return fetch(`${baseUrl}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // The public base URL is http, so the CSRF cookie has no `__Host-` prefix.
        cookie: `devspace-csrf=${csrf}`,
        "x-forwarded-for": xff,
      },
      body: new URLSearchParams({
        client_id: clientId,
        redirect_uri: "http://localhost:9999/callback",
        response_type: "code",
        code_challenge: "test-code-challenge",
        code_challenge_method: "S256",
        resource: `${publicBaseUrl}/mcp`,
        csrf_token: csrf,
        owner_token: ownerToken,
      }),
    });
  };

  assert.equal((await approve(config.oauth.ownerToken, "192.0.2.200")).status, 302, "correct token is approved");
  for (let i = 0; i < 20; i++) {
    assert.equal((await approve("wrong-owner-token", `192.0.2.${i + 1}`)).status, 401, `failure ${i + 1} is rejected normally`);
  }
  assert.equal((await approve("wrong-owner-token", "192.0.2.100")).status, 429, "21st failure from a fresh IP is capped");
  assert.equal((await approve(config.oauth.ownerToken, "192.0.2.101")).status, 429, "cap holds for every IP during the window");
} finally {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await rm(stateDir, { recursive: true, force: true });
}
