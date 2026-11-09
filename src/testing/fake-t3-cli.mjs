#!/usr/bin/env node
// Fake `t3` CLI for tests (plan 015, "Fake T3"). The wrapper written by FakeT3
// runs `node fake-t3-cli.mjs --admin <adminUrl> "$@"`. It implements the
// `t3 auth` commands DevSpace uses with T3's real output shapes, and reports
// each invocation's arguments and environment variable names to the fake.

class CliError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

const TTL_UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseOptions(tokens, { flags = [], values = [], repeatable = [] }) {
  const options = { _: [] };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (flags.includes(name)) {
      options[name] = true;
      continue;
    }
    if (!values.includes(name) && !repeatable.includes(name)) throw new CliError(2, `Unknown option: --${name}`);
    const value = inline ?? tokens[++index];
    if (value === undefined) throw new CliError(2, `Missing value for --${name}`);
    if (repeatable.includes(name)) (options[name] ??= []).push(value);
    else options[name] = value;
  }
  return options;
}

function parseTtl(value) {
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(value.trim());
  if (!match) throw new CliError(2, `Invalid --ttl: ${value}`);
  return Number(match[1]) * TTL_UNITS[match[2] ?? "s"];
}

async function admin(base, method, path, body) {
  let response;
  try {
    response = await fetch(`${base}/${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CliError(1, "T3 Code server is not reachable.");
  }
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function write(text) {
  return new Promise((resolve) => process.stdout.write(text, () => resolve()));
}

async function main(argv) {
  if (argv[0] !== "--admin" || !argv[1]) throw new CliError(2, "fake-t3-cli: missing --admin <url>");
  const base = argv[1].replace(/\/+$/, "");
  const args = argv.slice(2);
  await admin(base, "POST", "cli/invocation", { args, envNames: Object.keys(process.env) });

  const [group, noun, verb, ...rest] = args;
  if (group === "auth" && noun === "pairing" && verb === "create") {
    const options = parseOptions(rest, { flags: ["json"], values: ["ttl", "label"], repeatable: ["scope"] });
    const pairing = await admin(base, "POST", "cli/pairing", {
      label: options.label ?? "",
      scopes: options.scope ?? ["orchestration:read", "orchestration:operate"],
      ttlMs: parseTtl(options.ttl ?? "5m"),
    });
    if (pairing.status !== 200) throw new CliError(1, "Failed to create a pairing credential.");
    if (options.json) await write(`${JSON.stringify(pairing.body, null, 2)}\n`);
    else await write(`Created pairing credential ${pairing.body.id}.\nCredential: ${pairing.body.credential}\n`);
    return;
  }
  if (group === "auth" && noun === "session" && verb === "list") {
    const options = parseOptions(rest, { flags: ["json"] });
    const sessions = await admin(base, "GET", "cli/sessions");
    if (options.json) await write(`${JSON.stringify(sessions.body, null, 2)}\n`);
    else await write(sessions.body.map((session) => `${session.sessionId}  ${session.client.label}\n`).join(""));
    return;
  }
  if (group === "auth" && noun === "session" && verb === "revoke") {
    const options = parseOptions(rest, {});
    const sessionId = options._[0];
    if (!sessionId || options._.length > 1) throw new CliError(2, "Usage: t3 auth session revoke <sessionId>");
    const revoked = await admin(base, "POST", "cli/sessions/revoke", { sessionId });
    if (revoked.status !== 200) throw new CliError(1, `Session ${sessionId} was not found.`);
    await write(`Revoked session ${sessionId}.\n\n`);
    return;
  }
  throw new CliError(2, `Unknown command: t3 ${args.join(" ")}`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const exitCode = error instanceof CliError ? error.exitCode : 1;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = exitCode;
}
