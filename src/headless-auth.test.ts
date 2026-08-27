import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import {
  assertHermesOAuthConfigCompatible,
  mintHeadlessOAuth,
  safeServerName,
  writeHermesOAuthFiles,
  writeOAuthBundle,
  type HeadlessOAuthBundle,
} from "./headless-auth.js";

const dirs: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function oauthFetch(): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return Response.json({
        issuer: "https://devspace.example.com",
        authorization_endpoint: "https://devspace.example.com/authorize",
        token_endpoint: "https://devspace.example.com/token",
        registration_endpoint: "https://devspace.example.com/register",
        scopes_supported: ["devspace:read", "devspace:write"],
      });
    }
    if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
      return Response.json({
        resource: "https://devspace.example.com/mcp",
        authorization_servers: ["https://devspace.example.com"],
        scopes_supported: ["devspace:read", "devspace:write"],
      });
    }
    if (url.endsWith("/register")) {
      const registration = JSON.parse(String(init?.body));
      assert.equal(registration.client_name, "Hermes Agent");
      assert.deepEqual(registration.redirect_uris, ["http://127.0.0.1:19877/callback"]);
      assert.equal(registration.token_endpoint_auth_method, "none");
      return Response.json({
        client_id: "devspace-client",
        client_id_issued_at: 123,
        client_name: "Hermes Agent",
        redirect_uris: ["http://127.0.0.1:19877/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    }
    if (url.includes("/authorize")) {
      const isGet = !init?.method || init.method === "GET";
      if (isGet) {
        const csrf = "test-csrf-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const html = `<!doctype html><html><body><form method="post"><input type="hidden" name="csrf_token" value="${csrf}" /></form></body></html>`;
        return new Response(html, {
          status: 200,
          headers: {
            "Content-Type": "text/html",
            "Set-Cookie": `__Host-devspace-csrf=${csrf}; Path=/; HttpOnly; SameSite=Lax`,
          },
        });
      }
      const authorization = new URLSearchParams(String(init?.body));
      assert.equal(authorization.get("owner_token"), "owner-secret");
      assert.equal(authorization.get("resource"), "https://devspace.example.com/mcp");
      assert.equal(authorization.get("code_challenge_method"), "S256");
      // csrf_token is now required; verify it's present and matches cookie if provided
      const csrfFromBody = authorization.get("csrf_token");
      if (csrfFromBody) {
        const cookieHeader = (init?.headers as Record<string, string> | undefined)?.Cookie ?? (init?.headers as Record<string, string> | undefined)?.cookie ?? "";
        if (cookieHeader) assert.ok(cookieHeader.includes(csrfFromBody));
      }
      return new Response(null, {
        status: 302,
        headers: { Location: `http://127.0.0.1:19877/callback?code=code-1&state=${authorization.get("state")}` },
      });
    }
    if (url.endsWith("/token")) {
      const token = new URLSearchParams(String(init?.body));
      assert.equal(token.get("grant_type"), "authorization_code");
      assert.equal(token.get("code"), "code-1");
      assert.equal(Boolean(token.get("code_verifier")), true);
      return Response.json({
        access_token: "access-secret",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "refresh-secret",
        scope: "devspace:read devspace:write",
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

async function bundle(): Promise<HeadlessOAuthBundle> {
  return mintHeadlessOAuth({
    baseUrl: "https://devspace.example.com",
    ownerToken: "owner-secret",
    clientName: "Hermes Agent",
    fetchImpl: oauthFetch(),
  });
}

describe("headless OAuth minting", () => {
  it("completes discovery, registration, owner approval, and PKCE exchange", async () => {
    const result = await bundle();
    assert.equal(result.tokens.access_token, "access-secret");
    assert.equal(result.tokens.refresh_token, "refresh-secret");
    assert.equal(result.client.client_id, "devspace-client");
    assert.equal(result.resource, "https://devspace.example.com/mcp");
  });

  it("rejects insecure and cross-origin OAuth endpoints before sending the owner password", async () => {
    let fetches = 0;
    await assert.rejects(
      () => mintHeadlessOAuth({ baseUrl: "http://devspace.example.com", ownerToken: "owner-secret", fetchImpl: async () => { fetches += 1; return Response.json({}); } }),
      /HTTPS unless it is loopback/,
    );
    assert.equal(fetches, 0);
    const calls: RequestInit[] = [];
    await assert.rejects(
      () => mintHeadlessOAuth({
        baseUrl: "https://devspace.example.com",
        ownerToken: "owner-secret",
        fetchImpl: async (_url, init) => {
          calls.push(init ?? {});
          if (calls.length === 1) return Response.json({ authorization_endpoint: "https://evil.example/authorize", token_endpoint: "https://devspace.example.com/token", registration_endpoint: "https://devspace.example.com/register" });
          return Response.json({ resource: "https://devspace.example.com/mcp" });
        },
      }),
      /must use OAuth server origin/,
    );
    assert.equal(calls.some((init) => String(init.body).includes("owner-secret")), false);
  });

  it("resolves path-prefixed base URLs to the server's root well-known routes", async () => {
    const result = await mintHeadlessOAuth({ baseUrl: "https://devspace.example.com/prefix///", ownerToken: "owner-secret", clientName: "Hermes Agent", fetchImpl: oauthFetch() });
    assert.equal(result.resource, "https://devspace.example.com/mcp");
  });

  it("writes a mode-0600 portable bundle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "devspace-auth-"));
    dirs.push(dir);
    const path = join(dir, "oauth.json");
    await writeOAuthBundle(path, await bundle());
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(path, "utf8")).tokens.access_token, "access-secret");
  });

  it("removes the protected temporary file when serialization fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "devspace-auth-failure-"));
    dirs.push(dir);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await assert.rejects(() => writeOAuthBundle(join(dir, "oauth.json"), circular as unknown as HeadlessOAuthBundle), /circular/i);
    assert.deepEqual(await readdir(dir), []);
  });

  it("preserves the destination and removes the temporary file when rename fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "devspace-auth-rename-failure-"));
    dirs.push(dir);
    const destination = join(dir, "oauth.json");
    await mkdir(destination);
    await writeFile(join(destination, "marker"), "unchanged");
    const value = await bundle();
    await assert.rejects(() => writeOAuthBundle(destination, value));
    assert.deepEqual(await readdir(dir), ["oauth.json"]);
    assert.equal(await readFile(join(destination, "marker"), "utf8"), "unchanged");
  });

  it("preserves the complete Hermes credential set when one destination is invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "devspace-hermes-transaction-"));
    dirs.push(dir);
    const tokenDir = join(dir, "mcp-tokens");
    await mkdir(tokenDir);
    await writeFile(join(tokenDir, "devspace.json"), "old-token");
    await mkdir(join(tokenDir, "devspace.client.json"));
    await writeFile(join(tokenDir, "devspace.client.json", "marker"), "old-client");
    await writeFile(join(tokenDir, "devspace.meta.json"), "old-metadata");
    const value = await bundle();
    await assert.rejects(() => writeHermesOAuthFiles(dir, "devspace", value));
    assert.equal(await readFile(join(tokenDir, "devspace.json"), "utf8"), "old-token");
    assert.equal(await readFile(join(tokenDir, "devspace.client.json", "marker"), "utf8"), "old-client");
    assert.equal(await readFile(join(tokenDir, "devspace.meta.json"), "utf8"), "old-metadata");
  });

  it("rejects a conflicting Hermes client_id before OAuth side effects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "devspace-hermes-config-"));
    dirs.push(dir);
    await writeFile(join(dir, "config.yaml"), "mcp_servers:\n  devspace:\n    oauth:\n      client_id: preregistered-client\n");
    await assert.rejects(() => assertHermesOAuthConfigCompatible(dir, "devspace"), /remove that setting before headless minting/);
    await assert.rejects(
      () => execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "auth", "mint", "--url", "http://127.0.0.1:1", "--owner-token", "owner-secret", "--hermes-home", dir], { cwd: process.cwd() }),
      (error: any) => {
        assert.match(error.stderr, /configures oauth\.client_id/);
        assert.doesNotMatch(error.stderr, /fetch failed|ECONNREFUSED/);
        return true;
      },
    );
  });

  it("writes Hermes token, client, and metadata files with absolute expiry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "devspace-hermes-"));
    dirs.push(dir);
    const paths = await writeHermesOAuthFiles(dir, "devspace", await bundle(), 1_000_000);
    assert.deepEqual(paths.map((path) => path.split("/").pop()), ["devspace.json", "devspace.client.json", "devspace.meta.json"]);
    const token = JSON.parse(await readFile(paths[0], "utf8"));
    assert.equal(token.expires_at, 4600);
    for (const path of paths) assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  for (const [serverName, expected] of [
    ["devspace", "devspace"],
    [".devspace.", "devspace"],
    ["...", "default"],
    ["café", "café"],
    ["a/b", "a_b"],
  ] as const) {
    it(`matches Hermes filename normalization for ${JSON.stringify(serverName)}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "devspace-hermes-name-"));
      dirs.push(dir);
      const paths = await writeHermesOAuthFiles(dir, serverName, await bundle());
      assert.deepEqual(paths.map((path) => path.split("/").pop()), [`${expected}.json`, `${expected}.client.json`, `${expected}.meta.json`]);
    });
  }

  it("truncates Hermes server names by Unicode code point", () => {
    assert.equal(safeServerName("é".repeat(129)), "é".repeat(128));
  });

  it("rejects invalid output destination combinations before OAuth side effects", async () => {
    for (const args of [
      [],
      ["--output", "/tmp/devspace-unused.json", "--hermes-home", "/tmp/devspace-unused-home"],
    ]) {
      await assert.rejects(
        () => execFileAsync(process.execPath, [
          "--import", "tsx", "src/cli.ts", "auth", "mint",
          "--owner-token", "owner-secret", "--url", "http://127.0.0.1:1",
          ...args,
        ], { cwd: process.cwd() }),
        (error: Error & { stderr?: string }) => {
          assert.match(error.stderr ?? "", /Specify exactly one of --output <file> or --hermes-home <directory>/);
          assert.doesNotMatch(error.stderr ?? "", /fetch failed|ECONNREFUSED/);
          return true;
        },
      );
    }
  });

  it("documents auth mint options in CLI help", async () => {
    const result = await execFileAsync(process.execPath, [
      "--import", "tsx", "src/cli.ts", "auth", "mint", "--help",
    ], { cwd: process.cwd() });
    assert.match(result.stdout, /--output <file>/);
    assert.match(result.stdout, /--hermes-home <directory>/);
    assert.match(result.stdout, /--owner-token <password>/);
  });

  it("rejects duplicate options and invalid auth help before OAuth side effects", async () => {
    for (const args of [
      ["mint", "--url", "http://127.0.0.1:1", "--owner-token", "owner-secret", "--output", "/tmp/devspace-a.json", "--output", "/tmp/devspace-b.json"],
      ["nope", "--help"],
    ]) {
      await assert.rejects(
        () => execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "auth", ...args], { cwd: process.cwd() }),
        (error: any) => {
          assert.equal(error.code, 1);
          assert.doesNotMatch(error.stderr, /fetch failed|ECONNREFUSED/);
          return true;
        },
      );
    }
  });
});
