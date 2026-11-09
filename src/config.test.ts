import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseT3BridgeConfig } from "./config.js";
import { createT3OriginResolver } from "./t3-bridge.js";

const emptyConfigDir = mkdtempSync(join(tmpdir(), "devspace-empty-config-test-"));
const baseEnv = {
  DEVSPACE_CONFIG_DIR: emptyConfigDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

assert.equal(loadConfig(baseEnv).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "changes" }).widgets, "changes");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "workspace" }).widgets, "workspace");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "full" }).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "off" }).widgets, "off");
assert.equal(loadConfig(baseEnv).toolNaming, "short");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_NAMING: "short" }).toolNaming, "short");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_NAMING: "legacy" }).toolNaming, "legacy");
assert.equal(loadConfig(baseEnv).annotationProfile, "standard");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_ANNOTATION_PROFILE: "standard" }).annotationProfile, "standard");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_ANNOTATION_PROFILE: "trusted-owner" }).annotationProfile, "trusted-owner");
assert.equal(loadConfig(baseEnv).minimalTools, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "minimal" }).minimalTools, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "full" }).minimalTools, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "0" }).minimalTools, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "1" }).minimalTools, true);
assert.equal(loadConfig(baseEnv).skillsEnabled, true);
assert.deepEqual(loadConfig(baseEnv).autoLoadSkills, []);
assert.deepEqual(loadConfig({ ...baseEnv, DEVSPACE_AUTOLOAD_SKILLS: " agent-monitor , agent-monitor , helper " }).autoLoadSkills, ["agent-monitor", "helper"]);
assert.deepEqual(loadConfig({ ...baseEnv, DEVSPACE_AUTOLOAD_SKILLS: "" }).autoLoadSkills, []);
const skillConfigDir = mkdtempSync(join(tmpdir(), "devspace-autoload-config-test-"));
writeFileSync(join(skillConfigDir, "config.json"), JSON.stringify({
  skillPaths: ["~/custom-agent-skills"],
  autoLoadSkills: ["agent-monitor", "helper"],
}));
const skillFileEnv = { ...baseEnv, DEVSPACE_CONFIG_DIR: skillConfigDir };
assert.equal(loadConfig(skillFileEnv).skillPaths.includes(join(homedir(), "custom-agent-skills")), true);
assert.deepEqual(loadConfig(skillFileEnv).autoLoadSkills, ["agent-monitor", "helper"]);
assert.deepEqual(loadConfig({ ...skillFileEnv, DEVSPACE_AUTOLOAD_SKILLS: "override" }).autoLoadSkills, ["override"]);
assert.equal(loadConfig({ ...skillFileEnv, DEVSPACE_SKILL_PATHS: "~/other-skills" }).skillPaths.includes(join(homedir(), "custom-agent-skills")), false);
const badSkillConfigDir = mkdtempSync(join(tmpdir(), "devspace-autoload-bad-config-test-"));
writeFileSync(join(badSkillConfigDir, "config.json"), JSON.stringify({ autoLoadSkills: "agent-monitor" }));
assert.throws(() => loadConfig({ ...baseEnv, DEVSPACE_CONFIG_DIR: badSkillConfigDir }), /Invalid autoLoadSkills in config\.json/);
assert.equal(loadConfig(baseEnv).globalInstructionsFile, join(homedir(), ".devspace", "AGENTS.md"));
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_GLOBAL_INSTRUCTIONS_FILE: "~/custom-devspace-agents.md" }).globalInstructionsFile,
  join(homedir(), "custom-devspace-agents.md"),
);
assert.equal(loadConfig(baseEnv).rootPolicies[0]?.access, "read-write");
assert.equal(loadConfig(baseEnv).rootPolicies[0]?.canonicalPath, process.cwd());
assert.equal(loadConfig(baseEnv).shell.mode, "service");
assert.equal(loadConfig(baseEnv).terminals.backend, "tmux");
assert.equal(loadConfig(baseEnv).terminals.maxPerWorkspace, 4);
assert.equal(loadConfig(baseEnv).maintenance.intervalSeconds, 3600);
assert.deepEqual(loadConfig(baseEnv).secretNames, ["DEVSPACE_OAUTH_OWNER_TOKEN"]);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SHELL_MODE: "login" }).shell.mode, "login");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TERMINAL_MAX_TOTAL: "7" }).terminals.maxTotal, 7);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_ISOLATED_IDLE_TTL_SECONDS: "123" }).maintenance.isolatedIdleTtlSeconds, 123);
assert.equal(loadConfig(baseEnv).sessions.idleTtlSeconds, 1800);
assert.equal(loadConfig(baseEnv).sessions.sweepIntervalSeconds, 60);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SESSION_IDLE_TTL_SECONDS: "300" }).sessions.idleTtlSeconds, 300);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SESSION_SWEEP_INTERVAL_SECONDS: "15" }).sessions.sweepIntervalSeconds, 15);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_SESSION_IDLE_TTL_SECONDS: "0" }),
  /Invalid DEVSPACE_SESSION_IDLE_TTL_SECONDS: 0/,
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_INFRA_SECRET_NAMES: "DEVSPACE_NODE_A,DEVSPACE_NODE_B" }).secretNames,
  ["DEVSPACE_OAUTH_OWNER_TOKEN", "DEVSPACE_NODE_A", "DEVSPACE_NODE_B"],
);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "0" }).skillsEnabled, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "1" }).skillsEnabled, true);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "invalid" }),
  /Invalid DEVSPACE_WIDGETS: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "minimal" }),
  /Invalid DEVSPACE_WIDGETS: minimal/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "write-only" }),
  /Invalid DEVSPACE_WIDGETS: write-only/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "invalid" }),
  /Invalid DEVSPACE_TOOL_MODE: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TOOL_NAMING: "invalid" }),
  /Invalid DEVSPACE_TOOL_NAMING: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_ANNOTATION_PROFILE: "invalid" }),
  /Invalid DEVSPACE_ANNOTATION_PROFILE: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_SHELL_MODE: "interactive" }),
  /Invalid DEVSPACE_SHELL_MODE: interactive/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_ROOTS: JSON.stringify([{ path: process.cwd(), access: "read-write" }]) }),
  /cannot mix policy roots with legacy allowedRoots/,
);

assert.deepEqual(loadConfig(baseEnv).logging, {
  level: "info",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: "loopback",
});

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "silent" }).logging.level, "silent");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "error" }).logging.level, "error");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "warn" }).logging.level, "warn");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "info" }).logging.level, "info");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "debug" }).logging.level, "debug");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "json" }).logging.format, "json");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "pretty" }).logging.format, "pretty");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_REQUESTS: "0" }).logging.requests, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_ASSETS: "1" }).logging.assets, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_TOOL_CALLS: "0" }).logging.toolCalls, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_SHELL_COMMANDS: "1" }).logging.shellCommands, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "1" }).logging.trustProxy, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "0" }).logging.trustProxy, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "loopback" }).logging.trustProxy, "loopback");
assert.equal(loadConfig({ ...baseEnv, HOST: "0.0.0.0" }).logging.trustProxy, false);
assert.equal(loadConfig({ ...baseEnv, HOST: "localhost" }).logging.trustProxy, "loopback");
assert.equal(loadConfig({ ...baseEnv, HOST: "::1" }).logging.trustProxy, "loopback");
assert.equal(loadConfig({ ...baseEnv, HOST: "127.example.com" }).logging.trustProxy, false);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "trace" }),
  /Invalid DEVSPACE_LOG_LEVEL: trace/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "color" }),
  /Invalid DEVSPACE_LOG_FORMAT: color/,
);

assert.equal(loadConfig(baseEnv).oauth.ownerToken, "test-owner-token-that-is-long-enough");
assert.deepEqual(loadConfig(baseEnv).oauth.scopes, ["devspace"]);
assert.deepEqual(loadConfig(baseEnv).oauth.allowedRedirectHosts, [
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
]);
assert.equal(loadConfig(baseEnv).oauth.accessTokenTtlSeconds, 3600);
assert.equal(loadConfig(baseEnv).oauth.refreshTokenTtlSeconds, 2592000);

assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_SCOPES: "devspace,admin" }).oauth.scopes,
  ["devspace", "admin"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com" }).oauth
    .allowedRedirectHosts,
  ["chatgpt.com", "example.com"],
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120" }).oauth
    .accessTokenTtlSeconds,
  120,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "240" }).oauth
    .refreshTokenTtlSeconds,
  240,
);

assert.throws(
  () => loadConfig({ DEVSPACE_CONFIG_DIR: emptyConfigDir, DEVSPACE_ALLOWED_ROOTS: process.cwd() }),
  /DEVSPACE_OAUTH_OWNER_TOKEN is required/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_OWNER_TOKEN: "too-short" }),
  /DEVSPACE_OAUTH_OWNER_TOKEN must be at least 16 characters long/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }),
  /Invalid DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: 0/,
);

const { DEVSPACE_ALLOWED_ROOTS: _legacyRoots, ...rootPolicyEnv } = baseEnv;
const policyConfig = loadConfig({
  ...rootPolicyEnv,
  DEVSPACE_ROOTS: JSON.stringify([{ path: process.cwd(), access: "read-only" }]),
});
assert.equal(policyConfig.rootPolicies[0]?.access, "read-only");
assert.deepEqual(policyConfig.allowedRoots, [process.cwd()]);

assert.equal(loadConfig(baseEnv).publicBaseUrl, "http://127.0.0.1:7676");
assert.deepEqual(loadConfig(baseEnv).allowedHosts, ["localhost", "127.0.0.1", "::1"]);

assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).publicBaseUrl,
  "https://abc.trycloudflare.com",
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).allowedHosts,
  ["localhost", "127.0.0.1", "::1", "abc.trycloudflare.com"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_ALLOWED_HOSTS: "*" }).allowedHosts,
  ["*"],
);

const configDir = mkdtempSync(join(tmpdir(), "devspace-config-test-"));
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    port: 8787,
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://devspace.example.com",
    annotationProfile: "trusted-owner",
    globalInstructionsFile: "~/persisted-devspace-agents.md",
  }),
);
writeFileSync(
  join(configDir, "auth.json"),
  JSON.stringify({
    ownerToken: "persisted-owner-token-long-enough",
  }),
);

const fileConfig = loadConfig({ DEVSPACE_CONFIG_DIR: configDir });
assert.equal(fileConfig.port, 8787);
assert.equal(fileConfig.oauth.ownerToken, "persisted-owner-token-long-enough");
assert.equal(fileConfig.publicBaseUrl, "https://devspace.example.com");
assert.equal(fileConfig.annotationProfile, "trusted-owner");
assert.equal(fileConfig.globalInstructionsFile, join(homedir(), "persisted-devspace-agents.md"));
assert.deepEqual(fileConfig.allowedHosts, [
  "localhost",
  "127.0.0.1",
  "::1",
  "devspace.example.com",
]);

// B25: the `t3` settings block (plan 015).
const t3Default = {
  enabled: false,
  cliPath: join(homedir(), ".t3", "bin", "t3"),
  runtimeFile: join(homedir(), ".t3", "userdata", "server-runtime.json"),
};
assert.deepEqual(loadConfig(baseEnv).t3, t3Default);
assert.deepEqual(parseT3BridgeConfig(undefined), t3Default);
assert.deepEqual(parseT3BridgeConfig(null), t3Default);
assert.deepEqual(parseT3BridgeConfig({}), t3Default);
assert.deepEqual(parseT3BridgeConfig({ enabled: true }), { ...t3Default, enabled: true });
assert.deepEqual(parseT3BridgeConfig({ enabled: false, url: null }), t3Default);
assert.equal("url" in parseT3BridgeConfig({ url: null }), false);

function loadT3(t3: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "devspace-t3-config-test-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ t3 }));
  return loadConfig({ ...baseEnv, DEVSPACE_CONFIG_DIR: dir }).t3;
}

assert.deepEqual(loadT3({ enabled: true, cliPath: "~/tools/t3", runtimeFile: " ~/t3-runtime/server-runtime.json " }), {
  enabled: true,
  cliPath: join(homedir(), "tools", "t3"),
  runtimeFile: join(homedir(), "t3-runtime", "server-runtime.json"),
});
assert.equal(loadT3({ cliPath: "relative/t3" })?.cliPath, join(process.cwd(), "relative", "t3"));
assert.deepEqual(loadT3({ enabled: true, url: "http://127.0.0.1:3773/mcp/?x=1" }), {
  ...t3Default,
  enabled: true,
  url: "http://127.0.0.1:3773",
});
assert.equal(loadT3({ url: " https://t3.example.com:8443/ " })?.url, "https://t3.example.com:8443");
assert.equal("url" in (loadT3({ enabled: true, url: null }) ?? {}), false);
assert.deepEqual(loadT3(null), t3Default);

// `url` takes precedence over the runtime file, which is not read at all when `url` is set.
const t3RuntimeDir = mkdtempSync(join(tmpdir(), "devspace-t3-runtime-test-"));
const t3RuntimeFile = join(t3RuntimeDir, "server-runtime.json");
writeFileSync(t3RuntimeFile, JSON.stringify({ origin: "http://127.0.0.1:4111/" }));
const t3WithUrl = loadT3({ enabled: true, runtimeFile: t3RuntimeFile, url: "http://127.0.0.1:3773/mcp" });
assert.ok(t3WithUrl);
assert.equal(await createT3OriginResolver(t3WithUrl)(), "http://127.0.0.1:3773");
assert.equal(
  await createT3OriginResolver({ ...t3WithUrl, runtimeFile: join(t3RuntimeDir, "missing.json") })(),
  "http://127.0.0.1:3773",
);
const t3WithRuntime = loadT3({ enabled: true, runtimeFile: t3RuntimeFile });
assert.ok(t3WithRuntime);
assert.equal(await createT3OriginResolver(t3WithRuntime)(), "http://127.0.0.1:4111");
await assert.rejects(
  createT3OriginResolver({ ...t3WithRuntime, runtimeFile: join(t3RuntimeDir, "missing.json") })(),
  /T3 Code is not reachable on this machine\./,
);

for (const [t3, pattern] of [
  [{ enabled: true, token: "x" }, /Invalid t3\.token in config\.json: unknown setting/],
  [{ Enabled: true }, /Invalid t3\.Enabled in config\.json: unknown setting/],
  [{ enabled: "true" }, /Invalid t3\.enabled in config\.json: expected a boolean/],
  [{ enabled: 1 }, /Invalid t3\.enabled in config\.json: expected a boolean/],
  [{ cliPath: 7 }, /Invalid t3\.cliPath in config\.json: expected a non-empty path/],
  [{ cliPath: "  " }, /Invalid t3\.cliPath in config\.json: expected a non-empty path/],
  [{ runtimeFile: false }, /Invalid t3\.runtimeFile in config\.json: expected a non-empty path/],
  [{ url: 3773 }, /Invalid t3\.url in config\.json: expected an http\(s\) URL/],
  [{ url: "127.0.0.1:3773" }, /Invalid t3\.url in config\.json: expected an http\(s\) URL/],
  [{ url: "ftp://127.0.0.1:3773" }, /Invalid t3\.url in config\.json: expected an http\(s\) URL/],
  [true, /Invalid t3 in config\.json: expected an object/],
  [[], /Invalid t3 in config\.json: expected an object/],
  ["enabled", /Invalid t3 in config\.json: expected an object/],
] as const) {
  assert.throws(() => parseT3BridgeConfig(t3), pattern);
  assert.throws(() => loadT3(t3), pattern);
}
