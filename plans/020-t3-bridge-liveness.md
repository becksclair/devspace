# Plan 020: Close three small liveness gaps in the T3 bridge

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 63d6d81..HEAD -- src/t3-bridge.ts src/server.ts src/t3-bridge.test.ts src/testing/t3-checks.ts docs/t3-code.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `63d6d81`, 2026-11-11

## Why this matters

The T3 bridge lets ChatGPT in voice mode orchestrate T3 Code threads through
DevSpace. Three small gaps make it less dependable than it should be:

1. **Cold start.** The bridge mints its T3 credential and loads T3's tool
   catalog only when the first MCP session arrives, with a three-second budget.
   After every restart or deploy the first sessions therefore register the 20
   forwarded tools with schema-less fallbacks (`{ type: "object",
   additionalProperties: true }`), and a host that caches that list keeps
   guessing argument names until the connector is refreshed.
2. **CLI timeout.** The 30-second timeout for the `t3` CLI kills the child but
   then waits for its output pipes to close. If any descendant keeps a pipe
   open, the credential mint never settles, and because minting is
   single-flight, every T3 tool call hangs until DevSpace restarts.
3. **Blank optional arguments.** Models often send `""` for an optional field.
   `t3_project_create` then answers "workspaceRoot is required…" although the
   field is optional, and `t3_inbox` rejects `since: ""` as an invalid
   timestamp.

## Current state

Files:

- `src/t3-bridge.ts` — the bridge (credential, connection, catalog, shaping,
  inbox).
- `src/server.ts` — `createServer` registers the T3 tools per MCP session.
- `src/t3-bridge.test.ts` — unit suite against the fake T3
  (`src/testing/fake-t3.ts`), already in the `"test"` script.
- `src/testing/t3-checks.ts` — behavior checks shared by the unit and
  end-to-end suites.
- `docs/t3-code.md` — user documentation; states the behavior this plan
  changes.

**Gap 1.** `src/t3-bridge.ts:717-728`:

```ts
  async toolDefinitions(): Promise<T3ToolDefinition[]> {
    if (!this.liveTools) {
      const failedAt = this.catalogFailedAt;
      if (failedAt !== undefined && this.now() - failedAt < CATALOG_FALLBACK_MS) {
        void this.loadCatalog().catch(() => undefined);
      } else {
        await withTimeout(this.loadCatalog().catch(() => undefined), this.catalogTimeoutMs);
        if (!this.liveTools) this.catalogFailedAt = this.now();
      }
    }
    return T3_TOOL_NAMES.map((name) => this.definition(name));
  }
```

`loadCatalog()` (`src/t3-bridge.ts:787-814`) is private, single-flight through
`this.catalogLoad`, sets `this.liveTools` on success, and does not touch
`catalogFailedAt`. The only caller path is per session
(`src/server.ts:1798-1801`):

```ts
  if (config.t3?.enabled && !isCapabilityDisabled(effectiveSet, T3_CAPABILITY)) {
    const bridge = t3Bridge ?? sharedT3Bridge(config);
    if (bridge) await registerT3Tools(server, bridge, config.annotationProfile);
  }
```

`createServer` starts at `src/server.ts:1837`:

```ts
export function createServer(config = loadConfig(), options: CreateServerOptions = {}): RunningServer {
  if (config.widgets === "workspace" && !options.gatewayRouter) {
    throw new Error("DEVSPACE_WIDGETS=workspace is only supported in gateway mode");
  }
```

`options.t3Bridge` (`src/server.ts:1810-1811`) is "T3 bridge to use instead of
the process-wide `sharedT3Bridge(config)`". `createGatewayServer` calls
`createServer`, so one change covers both modes. `isCapabilityDisabled(disabled:
Set<string>, capability: string)` is exported from `src/config.ts:310` and is
already imported in `src/server.ts`.

**Gap 2.** `src/t3-bridge.ts:378-424` (abridged):

```ts
export function createT3CliRunner(cliPath: string, secretNames: string[]): T3CliRunner {
  …
        let timedOut = false;
        let overflow = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, CLI_TIMEOUT_MS);
  …
        child.once("close", (code, closeSignal) => {
          if (timedOut) finish(new Error(`T3 CLI ${command} timed out after ${CLI_TIMEOUT_MS / 1000} seconds.`));
          else if (overflow) finish(new Error(`T3 CLI ${command} printed too much output.`));
```

`finish` is idempotent (it returns early when `settled` is true) and clears the
timer. `CLI_TIMEOUT_MS` is `30_000` (`src/t3-bridge.ts:41`).

**Gap 3.** `src/t3-bridge.ts:1684-1692`:

```ts
    case "t3_project_create": {
      const picked = pick(args, PROJECT_CREATE_FIELDS);
      if (picked.workspaceRoot === undefined) return picked;
      const root = absolutePath(picked.workspaceRoot, "workspaceRoot");
      if (root.error) return root.error;
```

`src/t3-bridge.ts:1746-1747`:

```ts
function absolutePath(value: unknown, field: string): { path: string; error?: undefined } | { path?: undefined; error: string } {
  if (!nonEmptyString(value)) return { error: `${field} is required and must be an absolute path.` };
```

`src/t3-bridge.ts:1279-1285` (inbox):

```ts
    const checkedAt = this.now();
    const explicit = args.since !== undefined && args.since !== null;
    let since: number;
    if (explicit) {
      const parsed = typeof args.since === "string" ? Date.parse(args.since) : Number.NaN;
      if (Number.isNaN(parsed)) return errorResult("since must be an ISO-8601 timestamp, for example 2026-11-09T17:00:00Z.");
```

Design decisions already made (from `plans/015-t3-voice-orchestrator-bridge.md`
and `docs/t3-code.md`; do not change them):

- The fallback behavior stays: "When T3 is unreachable, the same 21 names
  register with loose schemas… After a failed or timed-out fetch, MCP sessions
  opened during the next 60 seconds get those loose schemas at once."
- "Pairing codes, authorization codes, and tokens are never logged or returned
  in tool results."
- `t3_project_clone`'s `destinationPath` stays required.
- Without `workspaceRoot`, T3 creates a git repository at
  `~/.t3/projects/<title>`; the fake T3 does the same
  (`src/testing/fake-t3.ts:1434-1441`).

Test helpers that already exist in `src/t3-bridge.test.ts`: `startFake()`,
`newBridge(fake, label, overrides)`, `callerFor(bridge)`,
`countingProvider(provider, counter)`, `captureError(promise)`,
`waitFor(description, predicate)`, `t3Config(fake)`, and the `ok` / `fails`
call helpers. The unit suite's catalog section starts at the comment
`// Cold start while T3 is down` (line 415) and uses a fake named
`catalogFake`. The CLI runner section is at lines 283-290 and uses `tempDir`.

Commit style: conventional commits, for example
`test(t3): wait for the live catalog in the deployed suite`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install (in your worktree only) | `bun install --frozen-lockfile` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Unit suite | `bunx tsx src/t3-bridge.test.ts` | exit 0, ends with `t3-bridge.test: all checks passed` |
| End-to-end suite (fake T3) | `bunx tsx src/t3-e2e.test.ts` | exit 0, ends with `t3-e2e.test: all checks passed` |
| Full suite (about 65 s, needs `tmux`) | `bun run test` | exit 0 |

**Never** run `bun run test:t3-live` or `bun run test:t3-deployed`: they start
real agent turns that spend provider credits and touch the production gateway.
Do not run `bun test`, `bun run build`, or `bun run rebuild:local`. Work in a
separate git worktree or clone: on the host Svartal the checkout
`/Users/rclair/projects/devspace` serves the production gateway from its
`dist/`, so never run `bun run build:check` or `bun install` there.

## Scope

**In scope** (the only files you should modify):

- `src/t3-bridge.ts`
- `src/server.ts` (one block in `createServer`)
- `src/t3-bridge.test.ts`
- `src/testing/t3-checks.ts`
- `docs/t3-code.md`
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):

- The retry table, the forced `full-access` mode, schema trimming, webhook
  scrubbing, and the inbox cursor rules.
- `src/testing/fake-t3.ts`, `src/testing/fake-t3-cli.mjs`, and the JSON
  fixtures. If a step seems to need a change there, STOP.
- `src/t3-live.test.ts`.
- The revoke-before-mint order in `createT3TokenProvider` — a documented
  decision.
- Any handling of dropped SSE response streams — a separate, unverified
  finding recorded in `plans/README.md`.

## Git workflow

- Branch: `advisor/020-t3-bridge-liveness`
- One commit per step; message style `fix(t3): load the catalog at startup`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Load the catalog at startup

1. In `src/t3-bridge.ts`, add a public method to `T3Bridge` directly after
   `toolDefinitions`:

   ```ts
   /**
    * Starts minting the credential and loading the catalog in the background, so the first MCP
    * session after a restart registers live schemas. Never throws, and a failure here does not
    * open the fallback window: the first session still waits its normal budget.
    */
   warm(): void {
     if (!this.liveTools) void this.loadCatalog().catch(() => undefined);
   }
   ```

2. In `src/server.ts`, in `createServer`, directly after the
   `DEVSPACE_WIDGETS=workspace` check shown above, add:

   ```ts
   // Mint the T3 credential and load its catalog now, so the first MCP session after a restart
   // gets live schemas instead of the loose fallback.
   if (config.t3?.enabled && !isCapabilityDisabled(config.disabledCapabilities ?? new Set<string>(), T3_CAPABILITY)) {
     (options.t3Bridge ?? sharedT3Bridge(config))?.warm();
   }
   ```

3. In `src/t3-bridge.test.ts`, in the catalog section, directly before the
   comment `// The first fetch has a bounded budget`, add:

   ```ts
   // warm() loads the catalog without a session asking for it.
   const warmCounter = { getToken: 0 };
   const warmLabel = "devspace-t3-bridge:unit-warm";
   const warmBridge = newBridge(catalogFake, warmLabel, {
     tokenProvider: countingProvider(
       createT3TokenProvider({
         runner: createT3CliRunner(catalogFake.cliPath, [SECRET_NAME]),
         resolveOrigin: createT3OriginResolver(t3Config(catalogFake)),
         label: warmLabel,
       }),
       warmCounter,
     ),
   });
   warmBridge.warm();
   await waitFor("warm() to request a token", () => warmCounter.getToken >= 1);
   assert.ok((await warmBridge.toolDefinitions()).every((definition) => definition.live), "a warmed bridge serves live schemas");

   // A failed warm() does not open the fallback window: the next session waits and gets live schemas.
   await catalogFake.setAvailable(false);
   const coldWarmBridge = newBridge(catalogFake, "devspace-t3-bridge:unit-warm-down");
   coldWarmBridge.warm();
   await delay(200);
   await catalogFake.setAvailable(true);
   assert.ok((await coldWarmBridge.toolDefinitions()).every((definition) => definition.live), "a failed warm does not force the fallback");
   ```

   Check the signature of `countingProvider` at its definition (around line
   116) and match it; `SECRET_NAME`, `delay`, `createT3TokenProvider`, and
   `createT3OriginResolver` are already used in this section.

4. In `docs/t3-code.md`, section "Connection and retries":
   - Replace "It connects lazily over Streamable HTTP with a bearer token."
     with "It mints its credential and loads T3's tool catalog in the
     background when DevSpace starts, connects over Streamable HTTP with a
     bearer token, and reconnects lazily after a failure."
   - In the paragraph beginning "Tool names are fixed.", after "the first fetch
     has a three-second budget", add ", which normally only matters when T3
     Code is down or still starting when DevSpace starts".

**Verify**:

- `bun run typecheck` → exit 0
- `bunx tsx src/t3-bridge.test.ts` → exit 0
- `bunx tsx src/t3-e2e.test.ts` → exit 0

### Step 2: Make the CLI timeout settle on its own

1. In `src/t3-bridge.ts`, change the signature to
   `export function createT3CliRunner(cliPath: string, secretNames: string[], options: { timeoutMs?: number } = {}): T3CliRunner`
   and add `const timeoutMs = options.timeoutMs ?? CLI_TIMEOUT_MS;` as the
   first line of the function body.
2. Replace the timer with:

   ```ts
   const timer = setTimeout(() => {
     child.kill("SIGKILL");
     // A descendant can keep the pipes open after the launcher dies, so do not wait for `close`.
     child.stdout?.destroy();
     child.stderr?.destroy();
     finish(new Error(`T3 CLI ${command} timed out after ${timeoutMs / 1000} seconds.`));
   }, timeoutMs);
   ```

3. Remove the `timedOut` variable and the `if (timedOut) finish(...)` branch
   from the `close` handler, so the handler starts with
   `if (overflow) finish(...)`.
4. In `src/t3-bridge.test.ts`, directly after the "T3 CLI not found" assertion
   (line 287-290), add (import `writeFileSync` from `node:fs` if the file does
   not already import it):

   ```ts
   // A launcher whose descendant keeps stdout open must not delay the timeout.
   const hangingCli = join(tempDir, "hanging-t3");
   writeFileSync(hangingCli, "#!/bin/sh\n(sleep 5) &\nsleep 5\n", { mode: 0o755 });
   const hangStarted = Date.now();
   assert.equal(
     await captureError(createT3CliRunner(hangingCli, [], { timeoutMs: 200 }).run(["auth", "session", "list", "--json"])),
     "T3 CLI auth session list timed out after 0.2 seconds.",
   );
   assert.ok(Date.now() - hangStarted < 3_000, "the timeout does not wait for a descendant to release stdout");
   ```

   To confirm the test can fail, run it once **before** making changes 2 and 3
   (with only the signature change from 1): it must fail on the `< 3_000`
   assertion after about five seconds.

**Verify**:

- `grep -n "timedOut" src/t3-bridge.ts` → no matches
- `bunx tsx src/t3-bridge.test.ts` → exit 0

### Step 3: Treat blank optional arguments as absent

1. In `src/t3-bridge.ts`, in the `t3_project_create` case, replace
   `if (picked.workspaceRoot === undefined) return picked;` with:

   ```ts
   // Models often send "" or null for an optional field; both mean "let T3 create the folder".
   const blankRoot =
     picked.workspaceRoot === undefined ||
     picked.workspaceRoot === null ||
     (typeof picked.workspaceRoot === "string" && picked.workspaceRoot.trim() === "");
   if (blankRoot) {
     delete picked.workspaceRoot;
     return picked;
   }
   ```

2. In the inbox method, replace
   `const explicit = args.since !== undefined && args.since !== null;` with:

   ```ts
   const blankSince = args.since === undefined || args.since === null || (typeof args.since === "string" && args.since.trim() === "");
   const explicit = !blankSince;
   ```

3. In `src/testing/t3-checks.ts`, directly after the line
   `assert.equal(fake.calls.length, mark, "nothing reached T3 for relative paths");`
   (around line 771), add:

   ```ts
   // A blank optional workspaceRoot means "no folder given": it is not rejected and not forwarded.
   mark = fake.calls.length;
   await ok(call, "t3_project_create", { title: `Blank root ${Date.now()}`, workspaceRoot: "" });
   assert.equal("workspaceRoot" in (forwarded(fake, "t3_project_create", mark)[0] ?? {}), false, "a blank workspaceRoot is not forwarded");
   ```

4. In `src/t3-bridge.test.ts`, at the end of the catalog section (after the
   `warm()` checks from Step 1), add a check on a fresh bridge so no other
   inbox assertion is affected by the cursor:

   ```ts
   // A blank `since` means "no cursor given".
   const blankSinceBridge = newBridge(catalogFake, "devspace-t3-bridge:unit-blank-since");
   await ok(callerFor(blankSinceBridge), "t3_inbox", { since: "" });
   ```

5. In `docs/t3-code.md`, tool reference row for `t3_project_create`, add the
   sentence "A blank `workspaceRoot` is treated as absent."

**Verify**:

- `bunx tsx src/t3-bridge.test.ts` → exit 0
- `bunx tsx src/t3-e2e.test.ts` → exit 0
- `bun run test` → exit 0

## Test plan

- `warm()`: a warmed bridge requests a token without a session and then serves
  live schemas; a failed warm does not force the fallback.
- CLI timeout: a launcher with a descendant holding stdout rejects with the
  timeout message within three seconds.
- Blank optionals: `t3_project_create` with `workspaceRoot: ""` succeeds and
  forwards no root (shared check, so it also runs end to end); `t3_inbox` with
  `since: ""` succeeds.
- Pattern: the surrounding assertions in `src/t3-bridge.test.ts` and
  `src/testing/t3-checks.ts`.
- Verification: `bun run test` → exit 0.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bunx tsx src/t3-bridge.test.ts` and `bunx tsx src/t3-e2e.test.ts` exit 0
- [ ] `bun run test` exits 0
- [ ] `grep -n "warm()" src/server.ts` returns one match
- [ ] `grep -n "timedOut" src/t3-bridge.ts` returns no matches
- [ ] `grep -n "connects lazily" docs/t3-code.md` returns no matches
- [ ] `git status --short` lists only in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- After Step 1, an existing assertion in `src/t3-bridge.test.ts` or
  `src/t3-e2e.test.ts` fails because T3 was contacted earlier than the test
  expects (for example a count of credential mints, CLI runs, or T3 sessions).
  Report the assertion; do not rewrite it.
- Any pairing code, authorization code, or token value would appear in a log
  line, an error message, or a test's output.
- A step seems to need a change in `src/testing/fake-t3.ts` or the JSON
  fixtures.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- `docs/t3-code.md` says to run the live suite before merging bridge changes.
  That suite spends provider credits and needs the operator's explicit
  approval; the executor must not run it. The operator should run
  `bun run test:t3-live` before deploying this change.
- With `warm()`, a DevSpace that starts while T3 Code is down behaves exactly
  as before (first session waits up to three seconds, then the fallback).
- `warm()` is skipped when the `t3` capability is disabled for the whole
  instance, so a hidden bridge still makes no contact with T3.
- Deferred, recorded in `plans/README.md`: a response stream that ends without
  a result can hold a call for up to 120 seconds; early token renewal revokes
  the working token before the replacement exists; the inbox can announce an
  outcome twice when it finishes during a check.
