import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "yaml";

export interface OAuthTokens {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope?: string;
}

export interface OAuthClient {
  client_id: string;
  [key: string]: unknown;
}

export interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  scopes_supported?: string[];
  [key: string]: unknown;
}

export interface HeadlessOAuthBundle {
  resource: string;
  metadata: OAuthMetadata;
  client: OAuthClient;
  tokens: OAuthTokens;
  minted_at: string;
}

interface MintOptions {
  baseUrl: string;
  ownerToken: string;
  clientName?: string;
  redirectUri?: string;
  fetchImpl?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export async function assertHermesOAuthConfigCompatible(hermesHome: string, serverName: string): Promise<void> {
  const configPath = join(hermesHome, "config.yaml");
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let config: unknown;
  try {
    config = parse(source);
  } catch (error) {
    throw new Error(`Cannot parse Hermes configuration at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const server = record(record(config)?.mcp_servers)?.[serverName];
  const clientId = record(record(server)?.oauth)?.client_id;
  if (typeof clientId === "string" && clientId.trim()) {
    throw new Error(
      `Hermes MCP server '${serverName}' configures oauth.client_id; remove that setting before headless minting so Hermes does not replace the dynamically registered client`,
    );
  }
}

function requireString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) throw new Error(`${context} missing ${key}`);
  return value;
}

async function fetchJson(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, init);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return await response.json() as Record<string, unknown>;
}

function pkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(64).toString("base64url").slice(0, 128);
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(24).toString("base64url"),
  };
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function trustedUrl(value: string, label: string, expectedOrigin?: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials`);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
    throw new Error(`${label} must use HTTPS unless it is loopback`);
  }
  if (expectedOrigin && parsed.origin !== expectedOrigin) throw new Error(`${label} must use OAuth server origin ${expectedOrigin}`);
  return parsed;
}

function normalizedBaseUrl(value: string): URL {
  const parsed = trustedUrl(value.trim(), "OAuth server URL");
  if (parsed.search || parsed.hash) throw new Error("OAuth server URL must not contain a query string or fragment");
  parsed.pathname = "/";
  return parsed;
}

function loopbackRedirect(value: string): URL {
  const parsed = trustedUrl(value, "OAuth redirect URI");
  if (!isLoopback(parsed.hostname)) throw new Error("OAuth redirect URI must be loopback");
  return parsed;
}

export async function mintHeadlessOAuth(options: MintOptions): Promise<HeadlessOAuthBundle> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = normalizedBaseUrl(options.baseUrl);
  const baseUrl = base.href.replace(/\/$/, "");
  const redirect = loopbackRedirect(options.redirectUri ?? "http://127.0.0.1:19877/callback");
  const redirectUri = redirect.href;
  const metadata = await fetchJson(fetchImpl, `${baseUrl}/.well-known/oauth-authorization-server`) as OAuthMetadata;
  const protectedResource = await fetchJson(fetchImpl, `${baseUrl}/.well-known/oauth-protected-resource/mcp`);
  const authorizationEndpoint = trustedUrl(requireString(metadata, "authorization_endpoint", "OAuth metadata"), "OAuth authorization endpoint", base.origin).href;
  const tokenEndpoint = trustedUrl(requireString(metadata, "token_endpoint", "OAuth metadata"), "OAuth token endpoint", base.origin).href;
  const registrationEndpoint = trustedUrl(requireString(metadata, "registration_endpoint", "OAuth metadata"), "OAuth registration endpoint", base.origin).href;
  if (typeof metadata.issuer === "string") trustedUrl(metadata.issuer, "OAuth issuer", base.origin);
  const resourceUrl = trustedUrl(requireString(protectedResource, "resource", "protected-resource metadata"), "OAuth protected resource", base.origin);
  const expectedResource = new URL(`${baseUrl}/mcp`).href;
  if (resourceUrl.href !== expectedResource) throw new Error(`OAuth protected resource must be ${expectedResource}`);
  const resource = resourceUrl.href;
  const scopes = Array.isArray(metadata.scopes_supported)
    ? metadata.scopes_supported.filter((scope): scope is string => typeof scope === "string")
    : [];

  const client = await fetchJson(fetchImpl, registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: options.clientName ?? "Headless MCP client",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(scopes.length ? { scope: scopes.join(" ") } : {}),
    }),
  }) as OAuthClient;
  const clientId = requireString(client, "client_id", "registration response");
  const pair = pkce();
  const authorization = await fetchImpl(authorizationEndpoint, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pair.challenge,
      code_challenge_method: "S256",
      scope: scopes.join(" "),
      state: pair.state,
      resource,
      owner_token: options.ownerToken,
    }),
  });
  if (authorization.status !== 302) {
    throw new Error(`OAuth authorization returned HTTP ${authorization.status}; owner password may be invalid`);
  }
  const location = authorization.headers.get("location");
  if (!location) throw new Error("OAuth authorization redirect had no Location header");
  const callback = new URL(location);
  if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname) {
    throw new Error("OAuth authorization redirect did not target the registered loopback URI");
  }
  if (callback.searchParams.get("state") !== pair.state) throw new Error("OAuth authorization state mismatch");
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("OAuth authorization redirect had no code");

  const tokens = await fetchJson(fetchImpl, tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pair.verifier,
      resource,
    }),
  }) as unknown as OAuthTokens;
  requireString(tokens as unknown as Record<string, unknown>, "access_token", "token response");
  requireString(tokens as unknown as Record<string, unknown>, "refresh_token", "token response");
  if (!Number.isFinite(tokens.expires_in)) throw new Error("token response missing expires_in");

  return { resource, metadata, client, tokens, minted_at: new Date().toISOString() };
}

async function stageSecretJson(path: string, value: unknown): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const payload = `${JSON.stringify(value, null, 2)}\n`;
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    return temporary;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function atomicSecretJson(path: string, value: unknown): Promise<void> {
  const temporary = await stageSecretJson(path, value);
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

interface SecretEntry { path: string; value: unknown }

async function atomicSecretSet(entries: SecretEntry[]): Promise<void> {
  const existing = new Set<string>();
  for (const entry of entries) {
    try {
      const info = await lstat(entry.path);
      if (!info.isFile()) throw new Error(`Credential destination is not a regular file: ${entry.path}`);
      existing.add(entry.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const staged: Array<{ path: string; temporary: string }> = [];
  try {
    for (const entry of entries) staged.push({ path: entry.path, temporary: await stageSecretJson(entry.path, entry.value) });
  } catch (error) {
    await Promise.allSettled(staged.map(({ temporary }) => rm(temporary, { force: true })));
    throw error;
  }

  const backups: Array<{ path: string; backup: string }> = [];
  const published: string[] = [];
  try {
    for (const { path } of staged) {
      if (!existing.has(path)) continue;
      const backup = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.bak`;
      await rename(path, backup);
      backups.push({ path, backup });
    }
    for (const { path, temporary } of staged) {
      await rename(temporary, path);
      published.push(path);
    }
  } catch (error) {
    await Promise.allSettled([...published].reverse().map((path) => rm(path, { force: true })));
    for (const { path, backup } of [...backups].reverse()) await rename(backup, path).catch(() => undefined);
    await Promise.allSettled(staged.map(({ temporary }) => rm(temporary, { force: true })));
    throw error;
  }
  await Promise.all(backups.map(({ backup }) => rm(backup, { force: true })));
}

export async function writeOAuthBundle(path: string, bundle: HeadlessOAuthBundle): Promise<void> {
  await atomicSecretJson(path, bundle);
}

export function safeServerName(serverName: string): string {
  const normalized = serverName.replace(/[^\p{L}\p{N}_-]/gu, "_").replace(/^_+|_+$/g, "");
  return Array.from(normalized).slice(0, 128).join("") || "default";
}

export async function writeHermesOAuthFiles(
  hermesHome: string,
  serverName: string,
  bundle: HeadlessOAuthBundle,
  nowMs = Date.now(),
): Promise<string[]> {
  const safe = safeServerName(serverName);
  const tokenDir = join(hermesHome, "mcp-tokens");
  const tokenPath = join(tokenDir, `${safe}.json`);
  const clientPath = join(tokenDir, `${safe}.client.json`);
  const metadataPath = join(tokenDir, `${safe}.meta.json`);
  await atomicSecretSet([
    { path: tokenPath, value: { ...bundle.tokens, expires_at: Math.floor(nowMs / 1000) + bundle.tokens.expires_in } },
    { path: clientPath, value: bundle.client },
    { path: metadataPath, value: bundle.metadata },
  ]);
  return [tokenPath, clientPath, metadataPath];
}
