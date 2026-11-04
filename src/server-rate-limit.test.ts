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
  assert.equal((await authorize("203.0.113.1")).status, 429, "11th request from client A is limited");
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
} finally {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await rm(stateDir, { recursive: true, force: true });
}
