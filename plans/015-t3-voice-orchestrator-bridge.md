# Plan 015: Bridge T3 Code thread orchestration into DevSpace for a voice orchestrator

> **Executor instructions**: Follow the steps in order, run every verification
> command, and stop on any STOP condition. Phase 2 starts only after Phase 1's
> exit criteria are met. The "Implementation contract" section is binding for
> file ownership, exported names, and behavior; where it is silent, follow the
> existing code's conventions.
>
> **Drift check (run first)**: `git diff --stat bdd940c..HEAD -- src/server.ts src/node-repl-bridge.ts src/sky-cua/bridge.ts src/mcp-bridge-utils.ts src/shell-environment.ts src/headless-auth.ts`
> and confirm the installed T3 Code version with `ELECTRON_RUN_AS_NODE=1 ~/.t3/bin/t3 --version`.
> The T3 facts below were verified against `v0.1.8-nightly.20261109.4392`; on a
> different version, re-run the live suite before relying on them.

## Status

- **State**: READY — Phase 1 in progress
- **Priority**: P1
- **Effort**: Phase 1 M, Phase 2 S
- **Risk**: MEDIUM — adds a remotely reachable capability that starts full-access coding agents on Svartal
- **Depends on**: none
- **Category**: feature
- **Planned at**: commit `bdd940c`, 2026-11-09
- **Branch / worktree**: `bex/t3-bridge` at `/Users/rclair/projects/devspace-t3-bridge`

## Goal

ChatGPT, used in voice mode on a phone, orchestrates T3 Code through the
existing DevSpace connector:

```text
ChatGPT (voice) → devspace-saga.heliasar.com/mcp → Svartal DevSpace gateway
               → T3 bridge → http://127.0.0.1:3773/mcp (T3 Code on Svartal)
```

The orchestrator finds projects and threads by name, project, and recency;
starts threads in full-access mode; steers, interrupts, and reads them; answers
agent questions; checks an inbox of threads that need the user, finished,
failed, or stopped; and settles threads it has handled. The user takes over in
the T3 Code mobile app through the thread links the bridge returns. T3 Code's
push notifications and Live Activities remain the out-of-band alert path.

## Resolved decisions

- **D1 — Enablement**: a `t3` block in the DevSpace settings file
  (`config.json` in the DevSpace configuration directory), not environment
  variables. Disabled unless `t3.enabled` is `true`. Enabled only on Svartal.
- **D2 — Inbox cursor**: in memory, with a `since` override and a 24-hour
  fallback after a restart. No persistence; settled state lives in T3.
- **D3 — Annotations**: `destructiveHint: false` and `openWorldHint: false` on
  every bridged tool, matching the sky-cua bridge.
- **D4 — Scope**: two phases. Phase 1 ships twelve tools and is validated end to
  end, including a voice pass. Phase 2 adds the remaining orchestration tools.
- **Live suite runs**: blanket approval from the user for this feature's work.

## Verified T3 behavior

Verified on 2026-11-09 with throwaway probes; scratch threads were archived and
probe sessions revoked. Raw shapes are committed as
`src/testing/t3-tools.snapshot.json` (real `tools/list` entries for 22 tools)
and `src/testing/t3-contract-samples.json` (real results, errors, HTTP failure
modes, and CLI output shapes).

1. **Endpoint.** Streamable HTTP MCP at `/mcp` (protocol `2025-06-18`, server
   name `T3 Code`). `~/.t3/userdata/server-runtime.json` records
   `origin: http://127.0.0.1:3773`. `/.well-known/oauth-protected-resource`
   names resource `http://127.0.0.1:3773/mcp`.
2. **HTTP failure modes.** Missing or invalid bearer: `401` with body
   `{"error":"invalid_mcp_credential",…}` and `WWW-Authenticate: Bearer …` that
   carries `resource_metadata="…"` unless the presented token is non-empty and
   has no `.` (T3 treats those as provider tokens), plus `error="invalid_token"`
   whenever a token was presented. Real MCP client tokens contain a `.`. A revoked token is rejected even on
   an existing MCP session. Unknown `mcp-session-id`: `404` with an empty body.
   T3 not running: connection refused.
3. **Headless full-access credential** (no browser step):
   1. `t3 auth pairing create --json --ttl <short> --label <label> --scope orchestration:read --scope orchestration:operate --scope settings:write --scope source-control:write`
      prints `{ id, credential, label, scopes, expiresAt }`.
   2. `POST /oauth/mcp/register` (JSON `{client_name, redirect_uris, token_endpoint_auth_method: "none"}`)
      returns `201` with `client_id`. Redirect URIs must be `https`, or `http`
      on `localhost`, `127.0.0.1`, or `[::1]`; no listener is needed.
   3. `POST /oauth/mcp/decision` (JSON)
      `{ authorization: {response_type: "code", client_id, redirect_uri, code_challenge, code_challenge_method: "S256", state, resource}, decision: { _tag: "pairing-code", access: "full-access", code } }`
      returns `{ redirectTo }` whose query carries `code` and `state`.
   4. `POST /oauth/mcp/token` (form-encoded `grant_type=authorization_code`,
      `code`, `redirect_uri`, `client_id`, `code_verifier`, `resource`) returns
      `{ access_token, token_type: "Bearer", expires_in: 2592000, scope }`.
      No refresh tokens.
   5. `t3 auth session list --json` prints a JSON **array** of
      `{ sessionId, method, scopes, subject: "mcp-client", client: { label, … }, connected, issuedAt, expiresAt, lastConnectedAt }`.
      `t3 auth session revoke <sessionId>` prints `Revoked session <id>.`.
      The decision consumes the pairing code. The launcher may print a
      harmless Electron `CompileAndCall` warning on stderr.
4. **Outside-client surface.** 71 tools are listed. Thread-bound tools refuse
   with `thread_credential_required`. Tools that take an optional `threadId`
   refuse without it with `target_required` (`t3_pending_request`,
   `t3_thread_organize`, and `t3_thread_list` without `projectId`/`allProjects`).
   Tool failures are `isError` results whose text is
   `{"_tag":"OrchestratorMcpFailure","code":…,"message":…}`.
5. **Threads.**
   - `t3_thread_list` orders by `updatedAt` descending. `includeSubagents: false`
     removes subagent rows (181 top-level of 266 total on the probe date).
     Archived threads are not listed. List rows carry `threadId`, `projectId`,
     `title`, `link` (`https://app.t3.codes/threads/<environmentId>/<threadId>`),
     `status`, `settled`, `settledAt`, `snoozed`, `snoozedUntil`,
     `relationshipToParent`, `runtimeMode`, `createdAt`, `updatedAt` — but not
     `pendingRequestCount`.
   - `t3_thread_read` returns `{ thread, recentRuns, items, nextPosition, hasMore }`.
     `thread` is the detail record including `pendingRequestCount`, `archived`,
     `itemCount`. Items page **forward from the start**; `afterPosition` is
     exclusive.
   - `settled` is T3's inbox-zero state, changed with `t3_thread_organize`
     actions `pin`, `unpin`, `snooze`, `unsnooze`, `settle`, `unsettle`,
     `archive`, `unarchive`, `mark_unread` (results `{ sequence }`). Archiving
     also settles.
   - `t3_thread_launch` with `runtimeMode: "full-access"` produces threads
     reporting `runtimeMode: "full-access"`. `clientRequestId` makes launch and
     `t3_thread_send` idempotent (same `threadId` / `runId` on repeat).
   - **A pending agent question does not change the thread status**: the thread
     stays `running` and `pendingRequestCount` becomes 1. T3's own awareness
     logic reports `waiting_for_input` for a pending user-input request,
     `waiting_for_approval` for any other pending request, and treats run
     status `waiting` as running. `t3_pending_request` lists questions only
     (approvals are not listed); `read` returns
     `{ requestId, questions: [{ id, header, question, options: [{label, description}], multiSelect }] }`;
     `respond` takes `answers` keyed by question `id` with the chosen label and
     returns `{ sequence }`.
   - Queue: `t3_queue` `list` returns `{ items: [{ queuedRunId, text, truncated }], nextCursor }`;
     `read`, `edit` (`text`), `cancel` work while the run is queued.
   - `t3_thread_send` `mode: "steer"` on a running turn returns
     `delivery: "steered"`; on a thread without a running turn it fails with
     `thread_not_sendable`.
   - `t3_thread_interrupt` returns `status: "interrupt_requested"` (repeat-safe)
     or `"no_active_run"`; the interrupted thread ends `cancelled` or
     `interrupted` depending on timing (both observed live).
   - `t3_thread_wait` returns `{ threadId, runId, status, timedOut }`.
   - Claude Code blocks a foreground `sleep`; a long-running test turn uses
     `python3 -c 'import time; time.sleep(N)'`.
6. **Notifications.** T3 publishes agent activity to its mobile app through
   T3 Connect. There is no local inbox or event API on `/mcp`, and nothing can
   start a turn in a ChatGPT conversation from outside.

## Current state (DevSpace)

- Stdio MCP bridges `src/node-repl-bridge.ts` and `src/sky-cua/bridge.ts` are
  registered per MCP session in `src/server.ts` (around lines 1680–1800) with
  `registerAppTool`; `jsonSchemaToZod` and `normalizeAnnotations` live in
  `src/mcp-bridge-utils.ts`.
- Capability gating: `parseEffectiveDisabledFromRequest` and the
  `isCapabilityDisabled` helpers (`src/server.ts:83-104`). `createGatewayServer`
  merges the local machine's `disabledCapabilities` into the public config
  (`src/server.ts:2235-2243`); bridges run in the gateway process for its local
  machine.
- Settings: `DevspaceUserConfig.t3` (`src/user-config.ts`) is parsed by
  `parseT3BridgeConfig` into `ServerConfig.t3: T3BridgeConfig` (`src/config.ts`)
  — **already implemented**. In gateway mode the configuration directory is
  `<stateDir>/role-config-source`; on Svartal its `config.json` links to
  `~/.devspace/config.json`.
- `tsconfig.build.json` excludes `src/testing/**/*`; `package.json` already has
  `src/t3-bridge.test.ts` and `src/t3-e2e.test.ts` appended to `test`, plus
  `test:t3-live` and `test:t3-deployed` — **already implemented**.
- Child environments: `bridgeChildEnvironment` (`src/shell-environment.ts`).
  DevSpace's headless OAuth helper: `mintHeadlessOAuth` (`src/headless-auth.ts`).
- Test harness pattern: `src/server-mcp-routing.test.ts` (createServer on an
  ephemeral port, seeded DevSpace OAuth access token). No test exercises
  `createGatewayServer` yet.
- Svartal's gateway runs `dist/` from `/Users/rclair/projects/devspace`
  (LaunchAgent `com.rclair.devspace-gateway`). **Building in that checkout
  changes what the live gateway runs on its next restart.**

## Design

### Settings (implemented)

```json
{ "t3": { "enabled": true, "cliPath": "~/.t3/bin/t3", "runtimeFile": "~/.t3/userdata/server-runtime.json", "url": "http://127.0.0.1:3773" } }
```

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `false` | Expose the T3 tools |
| `cliPath` | `~/.t3/bin/t3` | T3 CLI used to mint credentials |
| `runtimeFile` | `~/.t3/userdata/server-runtime.json` | Source of T3's origin, re-read on reconnect |
| `url` | none | Fixed T3 origin; when set, `runtimeFile` is ignored |

Unknown keys and wrong types fail `loadConfig`. The capability name is `t3`; it
can also be disabled per session (`X-Disabled-Capabilities`) or per gateway
machine (`disabledCapabilities`).

### Credential

- The provider runs the verified headless flow through the configured CLI
  with a two-minute pairing TTL and keeps the token in memory only.
- Session label: `devspace-t3-bridge:<first 10 hex chars of sha256(resolved stateDir)>`,
  so each DevSpace instance (and each test run) owns its own sessions.
- Before minting, the provider revokes every existing session carrying its
  label. Minting is single-flight. It re-mints on HTTP 401 and when fewer than
  min(three days, 10% of the token's lifetime from `expires_in`) remain before
  expiry.
- The CLI child gets `bridgeChildEnvironment(process.env, secretNames)` plus
  `ELECTRON_RUN_AS_NODE=1`, a 30-second timeout, and no stdin. Pairing codes,
  authorization codes, and tokens are never logged or returned.
- DevSpace already runs as the same OS user with unconfined shell tools, so the
  bridge does not widen what a DevSpace caller can do.

### Connection and retries

- One `T3Bridge` per DevSpace process, shared by all MCP sessions, connecting
  lazily with the MCP SDK `StreamableHTTPClientTransport` and an
  `authorization: Bearer` header.
- HTTP 401 → re-mint, reconnect, retry once (the request was not processed). A
  second 401 returns `T3 Code rejected DevSpace's credential.`
- HTTP 404 on the MCP session → reconnect, retry once.
- Connection refused or T3 runtime file missing → error result
  `T3 Code is not reachable on this machine.` The next call tries again.
- Any other failure after the request was sent → reconnect and retry once only
  when the call is idempotent: a read (`t3_project_list`, `t3_thread_search`,
  `t3_thread_list`, `t3_thread_read`, `t3_thread_wait`, and the inbox's own
  `t3_thread_list`, `t3_thread_read`, and `t3_pending_request` `list`/`read`
  calls) or forwarded arguments that carry `clientRequestId` (launch, send,
  interrupt always do after shaping). `t3_pending_request`,
  `t3_thread_organize`, and `t3_queue` without `clientRequestId` are never
  retried; they return
  `T3 Code connection failed during <tool>; it may or may not have run.`,
  or the unreachable error when an unauthenticated `GET
  <origin>/.well-known/oauth-protected-resource` (two-second timeout, no
  MCP session, no mint) gets no connection.

### Phase 1 tool surface

| Tool | Purpose | Read-only |
|------|---------|-----------|
| `t3_project_list` | Projects by name and path | yes |
| `t3_thread_search` | Find threads by title or content | yes |
| `t3_thread_list` | Recent threads, by project or across projects | yes |
| `t3_thread_read` | Latest messages of a thread | yes |
| `t3_thread_wait` | Short bounded wait for a run to finish | yes |
| `t3_inbox` | Threads that need you, finished, failed, or stopped (DevSpace-native) | yes |
| `t3_thread_launch` | Start a thread in a project or scratch folder | no |
| `t3_thread_send` | Message, steer, queue, or restart a thread | no |
| `t3_thread_interrupt` | Stop a running turn | no |
| `t3_pending_request` | Read and answer an agent's questions | no |
| `t3_thread_organize` | Settle, snooze, pin, archive, mark unread | no |
| `t3_queue` | Inspect and edit a thread's queued messages | no |

- Names are fixed. Input schemas come from T3's live `tools/list`, trimmed as
  below; when T3 is unreachable the same names register with loose
  passthrough schemas so ChatGPT's cached tool list stays stable. The catalog
  is cached per process; the first fetch has a 3-second budget. After a failed
  or timed-out fetch, sessions initialized during the next 60 seconds get the
  fallback definitions without waiting while a background refresh continues;
  once a live catalog is cached, sessions get live schemas.
- Registration converts the JSON Schemas to Zod with a converter local to
  `src/t3-bridge.ts` (`{}`, `type: "null"`, type arrays, `enum`, `const`,
  `anyOf`/`oneOf`/`allOf`, arrays, objects with `required` and
  `additionalProperties`); it never delegates to `jsonSchemaToZod`.
- Annotations: `readOnlyHint` per the table, `destructiveHint: false`,
  `openWorldHint: false`, passed through `toolAnnotationsForProfile`
  (`src/mcp-bridge-utils.ts`, shared with `src/server.ts`).
- No bridged tool declares an output schema; results carry `structuredContent`
  and the same JSON as text.

### Argument shaping and schema trimming

| Tool | Exposed schema | Forwarded arguments |
|------|----------------|---------------------|
| all forwarded | `environmentId` removed | — |
| `t3_thread_launch` | `runtimeMode` and `delegatedFrom` removed | `runtimeMode: "full-access"` always; `clientRequestId` added if absent |
| `t3_thread_send`, `t3_thread_interrupt` | — | `clientRequestId` added if absent |
| `t3_thread_list` | — | `allProjects: true` when `projectId` is absent; `includeSubagents: false` and `limit: 10` by default |
| `t3_thread_search` | — | `limit: 8` by default |
| `t3_project_list` | — | `limit: 50` by default |
| `t3_thread_read` | — | see "Reading" |
| `t3_thread_wait` | — | `timeoutMs` defaults to 20000, clamped to at most 25000 |
| `t3_pending_request`, `t3_thread_organize`, `t3_queue` | `threadId` required | — |

### Result shaping

- `t3_project_list` → `{ projects: [{ projectId, title, workspaceRoot }], nextCursor }`.
- `t3_thread_list` → `{ threads: [{ threadId, project, title, status, settled, updatedAt, link }], nextCursor, total }`,
  with `project` the project title from a cached project list (refreshed on a
  miss; a project id the refresh did not find is not looked up again for 60
  seconds and its `project` is `null` meanwhile).
- `t3_thread_search` → `{ matches: [{ threadId, project, title, source, link }] }`.
- `t3_thread_read` → see "Reading".
- Every other tool passes T3's result through unchanged.

### Reading

Without `afterPosition` or `itemId`, `t3_thread_read` returns the **latest**
`limit` (default 6) messages: read the thread detail (`limit: 1`) for
`itemCount`, then page `view: "messages"` from
`afterPosition = max(0, itemCount - window)` (window starts at 40 and widens
×4 up to three times while fewer than `limit` messages were found), keeping the
last `limit`. `maxCharsPerItem` defaults to 1500. With `afterPosition` or
`itemId` the call is forwarded (same defaults). Result:

```json
{ "thread": { "threadId", "project", "title", "status", "runtimeMode", "pendingRequestCount", "settled", "archived", "link" },
  "items": [{ "position", "itemId", "type", "createdBy", "text", "textTruncated", "nextTextOffset", "updatedAt" }],
  "olderAvailable": true }
```

### Descriptions

Each forwarded tool keeps T3's description with targeted overrides: remove
"Omit `threadId` for this thread" and "inherit yours" phrasing, and for
`t3_pending_request` state that `answers` is keyed by the question `id` with
the chosen option label. Every T3 tool description ends with one shared line:
"Find threads with t3_thread_search or t3_thread_list; never ask the user for
IDs. Refer to threads by title and project, and give the thread link when the
user may want to open it in the T3 app. Threads always run in full-access
mode."

### `t3_inbox`

- **Input**: `{ since?: ISO-8601 string, limit?: integer 1–20 (default 8) }`.
- **Source**: `t3_thread_list` with `allProjects: true`, `settled: false`,
  `includeSubagents: false`, `limit: 100`, paged through `nextCursor` up to
  10 pages (1000 rows); snoozed rows dropped.
- **Needs you**: for every row with status `preparing`, `queued`, `starting`,
  `running`, or `waiting` (concurrency 4), read the detail (`limit: 1`). Past
  60 active rows, only the 60 most recent are inspected. When
  `pendingRequestCount > 0`: if `t3_pending_request list` returns ids, it is a
  `question` (read the first: `requestId`, `questionId`, `question`, option
  labels); otherwise an `approval` (only the T3 app can grant it). Otherwise
  the row counts as running. `needsYouIncomplete` is `true`, with
  `uninspected` (active rows not inspected, including failed detail reads),
  whenever any active row was not inspected or the 1000-row cap cut the
  listing; it is `false` only when every active row was inspected.
- **Settled outcomes**: `finished` (`completed`), `failed` (`failed`,
  `rolled_back`), `stopped` (`interrupted`, `cancelled`). `idle` is ignored.
- **Output**:
  `{ needsYou: [{ threadId, project, title, link, kind, requestId?, questionId?, question?, options?, updatedAt }],
     needsYouIncomplete, uninspected?,
     new: [{ threadId, project, title, link, outcome, updatedAt, preview? }], omitted,
     counts: { running, unsettledBacklog }, since, checkedAt }`.
  `needsYou` lists every item found. `new` lists outcomes updated after the
  cursor, newest first, up to `limit`; `omitted` counts the fresh outcomes
  left out by `limit`. The five newest `finished` items carry `preview`, the
  last assistant message cut to 300 characters. `unsettledBacklog` counts
  outcomes at or before the cursor, plus outcomes already listed while the
  cursor is held back.
- **Cursor**: `since` if given, else this process's implicit cursor, else 24
  hours ago. Invalid `since` is an argument error. A check that omitted
  nothing moves the implicit cursor to its `checkedAt` and clears the reported
  set. A check without `since` that omitted outcomes keeps (pins) the cursor
  and adds the outcomes it listed (`threadId` + `updatedAt`) to an in-memory
  reported set (at most 1000, oldest dropped first), which later checks
  without `since` skip, so omitted outcomes are listed by the next check
  instead of being lost. A check with `since` does not filter by the reported
  set. It moves the implicit cursor to its `checkedAt` and clears the reported
  set only when it omitted nothing and its `since` is at or before the
  implicit cursor (or the 24-hour fallback), so it listed every outcome the
  next check without `since` would have; otherwise it leaves the implicit
  state alone.
- **Acknowledge**: settle the thread with `t3_thread_organize`.

### Phase 2 tool surface

Added after Phase 1 exits, with the same discipline:

| Tool | Shaping |
|------|---------|
| `schedule_task`, `list_scheduled_tasks`, `delete_scheduled_task`, `run_scheduled_task_now` | `bindToCurrentThread` removed and forced `false` |
| `t3_thread_update` | `threadId` required |
| `create_threads` | `runtimeMode: "full-access"` forced on every thread; `clientRequestId` added |
| `t3_project_create`, `t3_project_clone` | Pass through; descriptions state where folders are created |

Project deletion stays out of the model-facing surface.

## Implementation contract

### Files and ownership

| File | Owner | Notes |
|------|-------|-------|
| `src/config.ts`, `src/user-config.ts` | done | `T3BridgeConfig`, `parseT3BridgeConfig` |
| `src/t3-bridge.ts` | bridge builder | Runtime code only |
| `src/testing/fake-t3.ts`, `src/testing/fake-t3-cli.mjs` | fake builder | Excluded from the build |
| `src/testing/t3-scenarios.ts` | scenario builder | Shared S1–S7 |
| `src/server.ts` | integrator | Registration and injection only |
| `src/mcp-bridge-utils.ts` | integrator | Exports `toolAnnotationsForProfile` (moved from `src/server.ts`) |
| `src/t3-bridge.test.ts`, `src/t3-e2e.test.ts`, `src/t3-live.test.ts`, `src/config.test.ts` (t3 cases) | integrator | |
| `README.md`, `docs/t3-code.md`, `docs/configuration.md`, `docs/security.md`, `docs/svartal-gateway.md`, `AGENTS.md` | docs writer | |

### `src/t3-bridge.ts` exports

```ts
export const T3_CAPABILITY = "t3";
export const T3_FORWARDED_TOOLS: readonly string[]; // the 11 forwarded Phase 1 names
export const T3_INBOX_TOOL = "t3_inbox";
export const T3_TOOL_NAMES: readonly string[];      // forwarded + inbox, registration order as in the table
export const T3_UNREACHABLE_MESSAGE = "T3 Code is not reachable on this machine.";
export function t3SessionLabel(stateDir: string): string;
export interface T3CliRunner { run(args: string[], signal?: AbortSignal): Promise<string> } // resolves stdout
export function createT3CliRunner(cliPath: string, secretNames: string[]): T3CliRunner;
export function createT3OriginResolver(config: T3BridgeConfig): () => Promise<string>; // origin, no trailing slash
export interface T3TokenProvider {
  getToken(): Promise<string>;          // cached, single-flight mint
  refresh(): Promise<string>;           // force a new token (revokes own label first)
  revokeOwnSessions(): Promise<number>; // revoke every session with the label
}
export function createT3TokenProvider(options: {
  runner: T3CliRunner; resolveOrigin: () => Promise<string>; label: string;
  fetchImpl?: typeof fetch; now?: () => number;
}): T3TokenProvider;
export interface T3ToolDefinition {
  name: string; title: string; description: string;
  inputSchema: Record<string, unknown>; // JSON Schema object
  readOnly: boolean; live: boolean;
}
export interface T3BridgeOptions {
  config: T3BridgeConfig; label: string; secretNames: string[];
  tokenProvider?: T3TokenProvider; resolveOrigin?: () => Promise<string>;
  now?: () => number; catalogTimeoutMs?: number;
}
export class T3Bridge {
  constructor(options: T3BridgeOptions);
  toolDefinitions(): Promise<T3ToolDefinition[]>; // all 12, in T3_TOOL_NAMES order
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
  close(options?: { revoke?: boolean }): Promise<void>;
}
export function sharedT3Bridge(config: ServerConfig): T3Bridge | undefined; // process singleton; undefined unless config.t3?.enabled
export function registerT3Tools(server: McpServer, bridge: T3Bridge, annotationProfile: AnnotationProfile): Promise<void>;
```

`CallToolResult` errors are `{ isError: true, content: [{ type: "text", text }] }`;
T3's own `isError` results pass through unchanged. Argument validation errors
(missing `threadId`, bad `since`) are `isError` results, not thrown.

### `src/server.ts` integration

- `CreateServerOptions` gains `t3Bridge?: T3Bridge`; `createGatewayServer`
  gains an optional second parameter `{ t3Bridge?: T3Bridge }`.
- Per MCP session, beside the sky-cua block: when `config.t3?.enabled` and the
  `t3` capability is not disabled for the session, `await registerT3Tools(...)`
  with the injected bridge or `sharedT3Bridge(config)`.
- `toolAnnotationsForProfile` moves unchanged from `src/server.ts` to an export
  of `src/mcp-bridge-utils.ts`, imported by `src/server.ts` and
  `src/t3-bridge.ts`.
- Nothing else in `src/server.ts` changes.

### Fake T3 (`src/testing/fake-t3.ts`, `src/testing/fake-t3-cli.mjs`)

```ts
export interface FakeT3Options { sleepScaleMs?: number; completionDelayMs?: number; tokenTtlSeconds?: number }
export class FakeT3 {
  static start(options?: FakeT3Options): Promise<FakeT3>;
  readonly origin: string;      // http://127.0.0.1:<port>
  readonly runtimeFile: string; // temp file {"origin": …} like T3's
  readonly cliPath: string;     // executable wrapper that runs fake-t3-cli.mjs against this instance
  readonly calls: Array<{ tool: string; args: Record<string, unknown>; label: string }>;
  readonly cliInvocations: Array<{ args: string[]; envNames: string[] }>;
  issuedSecrets(): string[];    // every token, pairing code, authorization code issued
  liveSessions(label: string): number;
  addProject(input: { title: string; workspaceRoot?: string }): { projectId: string };
  removeProject(projectId: string): void; // its threads keep the now-unknown projectId
  addThread(input: { projectId?: string; title: string; status?: string; settled?: boolean; snoozed?: boolean;
    subagent?: boolean; updatedAt?: string; messages?: Array<{ role: "user" | "assistant"; text: string }> }): { threadId: string };
  addQuestion(threadId: string, question: { question: string; options: string[] }): { requestId: string };
  addApproval(threadId: string): void;
  revokeAllSessions(): void;
  expireSessions(): void;
  setAvailable(available: boolean): Promise<void>; // false closes the listener (connection refused)
  restart(): Promise<void>;                         // same port; MCP sessions dropped, sessions kept
  dropNextResponse(tool: string): void;             // process the call, then destroy the socket
  stop(): Promise<void>;
}
```

- Serves `tools/list` from `t3-tools.snapshot.json` exactly; implements the 11
  Phase 1 tools plus `task_status` (always `thread_credential_required`) with
  the result shapes in `t3-contract-samples.json`, including the error JSON,
  `target_required` cases, idempotent `clientRequestId`, subagent and archived
  filtering, `afterPosition` exclusivity, and `pendingRequestCount` on detail
  only. Other snapshot tools return an `isError` "not implemented in fake".
- OAuth and HTTP behavior mirror "Verified T3 behavior" items 2 and 3.
- Scripted agent behavior from the launch or send message (same prompts the
  live suite uses):
  - `Reply with exactly <word>` → completes after `completionDelayMs` (default
    30) with assistant message `<word>`.
  - `Use your AskUserQuestion tool to ask me exactly one question, '<q>', with exactly two options: '<a>' and '<b>'.`
    → stays `running` with a pending question (`id` = `<q>`); `respond`
    completes the run with the chosen label.
  - `python3 -c 'import time; time.sleep(<n>)'` → stays `running` for
    `<n> × sleepScaleMs` (default 20) unless interrupted (→ `cancelled`);
    accepts steer; queued sends become queued runs.
  - Anything else → completes with `OK`.
- The CLI implements `auth pairing create --json …`, `auth session list --json`,
  `auth session revoke <id>` with the real output shapes, and reports the
  environment variable names it received.

### Scenarios (`src/testing/t3-scenarios.ts`)

```ts
export type ScenarioTargetKind = "fake" | "live" | "deployed";
export interface ScenarioContext {
  kind: ScenarioTargetKind;
  client: Client;          // MCP SDK client connected to DevSpace /mcp
  stamp: string;           // unique per run; thread titles are `DevSpace bridge check <stamp> <id>`
  projectName: string;     // S3 target project: fake "devspace-fixture", live/deployed "No project"
  modelSelection?: { instanceId: string; model: string }; // live: { instanceId: "claudeAgent", model: "claude-haiku-5-5" }
  timeoutMs: number;       // per scenario
}
export interface Scenario { id: string; title: string; targets: ScenarioTargetKind[]; run(ctx: ScenarioContext): Promise<Record<string, unknown>> }
export const SCENARIO_PROMPTS: { reply(word: string): string; ask(q: string, a: string, b: string): string; sleep(seconds: number): string };
export const SCENARIOS: Scenario[];      // S1–S7 per "Orchestrator scenarios"
export function runScenarios(ctx: ScenarioContext, ids?: string[]): Promise<Array<{ id: string; ok: boolean; error?: string; details?: Record<string, unknown> }>>;
export function cleanupScenarioThreads(ctx: ScenarioContext): Promise<number>; // settle + archive every thread titled with ctx.stamp
```

Scenarios use only DevSpace-exposed tools through `ctx.client`, parse
`structuredContent` (falling back to JSON text), wait with bounded
`t3_thread_wait` calls, and assert with `node:assert/strict`.

## Verification design

### Suites

| Suite | Command | Chain under test | When |
|-------|---------|------------------|------|
| Unit | `bunx tsx src/t3-bridge.test.ts` | Bridge module against the fake T3 | `bun run test`, CI |
| End-to-end (fake) | `bunx tsx src/t3-e2e.test.ts` | MCP SDK client → DevSpace HTTP `/mcp` in serve mode **and** gateway mode → bridge → fake T3 over HTTP with its OAuth and a fake CLI process | `bun run test`, CI |
| Live | `bun run test:t3-live` | MCP SDK client → in-process DevSpace → bridge → **real T3** and **real CLI** | Before merge, after T3 updates |
| Deployed | `bun run test:t3-deployed` | MCP SDK client → **public** DevSpace URL → Svartal gateway → real T3 | After each deployment |

- The live suite also runs **contract assertions** that keep the fake honest:
  every forwarded tool exists in the real `tools/list` with the input
  properties the bridge sets or reads; real error codes (`target_required`,
  `thread_credential_required`); real list-row and read-result fields; real CLI
  JSON shapes. A mismatch fails the suite.
- Live and deployed runs title their threads `DevSpace bridge check <stamp> …`,
  settle and archive them, revoke every session they created, and fail if any
  remain. They fail loudly when T3 is unreachable. The deployed suite reads the
  public base URL from the DevSpace settings file. DevSpace retains at most 500
  registered OAuth clients and refuses registration beyond that, so the suite
  caches one headless OAuth bundle (client, refresh token, resource, metadata;
  never the access token) at `~/.local/state/devspace/t3-deployed-check.json`
  (directory `0700`, file `0600`, never printed). Each run obtains an access
  token with the refresh-token grant against the bundle's token endpoint and
  stores the rotated refresh token; when the cache is absent, belongs to
  another public URL, or the refresh fails, it mints with `mintHeadlessOAuth`
  and the owner credential from the DevSpace auth file and stores the result.
  At the end it revokes the access token at the advertised
  `revocation_endpoint` and keeps the refresh token. It prints only whether
  the client was reused or newly minted and the refresh token's expiry when
  DevSpace reports it.

### Behavior matrix (Phase 1)

| ID | Behavior | Unit | E2E | Live | Deployed |
|----|----------|:----:|:---:|:----:|:--------:|
| B1 | Tools present only with `t3.enabled: true`; absent when the `t3` capability is disabled per session or per gateway machine | | ✓ | | |
| B2 | Exactly the twelve Phase 1 tools are exposed; non-allowlisted T3 tools never appear | ✓ | ✓ | ✓ | ✓ |
| B3 | Annotations: read-only hints per table; `destructiveHint` and `openWorldHint` false | | ✓ | | ✓ |
| B4 | Credential minted through the CLI pairing flow at full-access with all four scopes | ✓ | ✓ | ✓ | |
| B5 | Revoke before mint: repeated restarts leave at most one live session per label | ✓ | ✓ | ✓ | |
| B6 | HTTP 401 → one re-mint and the call succeeds; a second 401 returns the credential error without looping | ✓ | ✓ | | |
| B7 | Re-mint when fewer than min(three days, 10% of the lifetime) remain; a short-lived token is not re-minted while more than 10% remains | ✓ | | | |
| B8 | T3 down: tools stay listed and calls return the unreachable error; T3 back: calls succeed without restarting DevSpace | ✓ | ✓ | | |
| B9 | T3 restart mid-session (stale MCP session, 404): the next call reconnects transparently | ✓ | ✓ | | |
| B10 | Dropped launch response with `clientRequestId`: one retry, exactly one thread created; dropped reads (forwarded and the inbox's own) are retried once and succeed | ✓ | ✓ | | |
| B11 | Non-idempotent calls without `clientRequestId` (`t3_thread_organize`, `t3_pending_request`, `t3_queue`) are never retried after the request was sent; classifying the failure opens no MCP session and mints nothing | ✓ | ✓ | | |
| B12 | Launch always runs `full-access`, even when the caller asks for another mode; `runtimeMode` is not in the exposed schema | ✓ | ✓ | ✓ | ✓ |
| B13 | List defaults (`allProjects`, no subagents, limit); explicit `projectId` respected | ✓ | ✓ | ✓ | |
| B14 | Tail read returns the latest messages; wait clamped to 25 s | ✓ | ✓ | ✓ | |
| B15 | `t3_pending_request`, `t3_thread_organize`, and `t3_queue` require `threadId` | ✓ | ✓ | | |
| B16 | Compact rows with project title and `link` for list, search, and projects | ✓ | ✓ | ✓ | ✓ |
| B17 | Descriptions carry the shared guidance and no "this thread" phrasing | ✓ | ✓ | | |
| B18 | Inbox `needsYou` lists questions (with text and options) and approvals regardless of the cursor; every active thread on every page is inspected up to 60, beyond which `needsYouIncomplete` and `uninspected` are reported | ✓ | ✓ | ✓ | |
| B19 | Inbox `new` lists finished, failed, and stopped threads after the cursor; previews capped at 300 characters for five items; `omitted` counts outcomes left out by `limit` | ✓ | ✓ | ✓ | |
| B20 | Inbox cursor: `since` override, previous-call cursor, 24-hour fallback; omitted outcomes are listed by the next implicit check, each once, even after an explicit `since` later than the cursor | ✓ | ✓ | | |
| B21 | Inbox excludes settled, snoozed, subagent, idle, and archived threads; counts running and backlog | ✓ | ✓ | ✓ | |
| B22 | Settling through `t3_thread_organize` removes the thread from the inbox | ✓ | ✓ | ✓ | ✓ |
| B23 | No token, pairing code, or authorization code in logs, errors, or tool results (logging captured at debug) | ✓ | ✓ | ✓ | |
| B24 | The CLI child environment excludes configured secret names | ✓ | ✓ | | |
| B25 | Settings validation: defaults, `~` expansion, `url` precedence, unknown keys and wrong types rejected | ✓ | | | |

### Orchestrator scenarios

| ID | Scenario | E2E | Live | Deployed |
|----|----------|:---:|:----:|:--------:|
| S1 | "What's going on?" → `t3_inbox` | ✓ | ✓ | ✓ |
| S2 | Find a thread by title → search → read latest | ✓ | ✓ | ✓ |
| S3 | Start work in a project named by voice → project list → launch → bounded wait → read → settle → archive | ✓ | ✓ | ✓ |
| S4 | Long-running turn: steer it, then interrupt it; it ends stopped | ✓ | ✓ | |
| S5 | Agent asks a question → inbox `needsYou` → read and answer → thread finishes with the answer | ✓ | ✓ | |
| S6 | Queue a message on a running turn → list, read, edit, cancel | ✓ | ✓ | |
| S7 | Scratch thread lifecycle (`Reply with exactly OK`) with the result visible in the inbox and a preview | ✓ | ✓ | ✓ |

### Outside the suites

ChatGPT itself: after deployment, ChatGPT is exercised through the user's
browser with the browse MCP (Step 10), then by the user in voice mode.

## Documentation

Tight and task-oriented; no duplicated reference material.

| File | Content |
|------|---------|
| `README.md` | Short "Orchestrate T3 Code" subsection under "What ChatGPT Can Do" with the settings block and a link to `docs/t3-code.md`; link in the "Documentation" list |
| `docs/t3-code.md` (new) | How it works (chain, credential, inbox model); setup (settings, Svartal enablement, connector refresh); usage (example voice requests mapped to tools, taking over in the T3 app, settling); tool reference; verification commands; troubleshooting |
| `docs/configuration.md` | `t3` settings block and the `t3` capability name |
| `docs/security.md` | Full-access orchestration authority, opt-in setting, credential handling |
| `docs/svartal-gateway.md` | Enablement, verification, rollback |
| `AGENTS.md` | `test:t3-live` and `test:t3-deployed` in the command table and under "Never run unless explicitly asked" |

## Git workflow

- Branch `bex/t3-bridge` in the worktree `/Users/rclair/projects/devspace-t3-bridge`.
- Never run `bun run build:check`, `bun run build`, or `bun run rebuild:local`
  in `/Users/rclair/projects/devspace` during development.

## Phase 1 steps

1. **Step 0** (done): live probes; fixtures committed.
2. **Settings** (done): `bunx tsx src/config.test.ts` gains the B25 cases.
3. **Build** in parallel: bridge, fake, scenarios, documentation.
4. **Integrate**: registration, unit, end-to-end, and live suites; gates
   `bun run typecheck`, `bun run test`, `bun run build:check` in the worktree.
5. **Review**: multi-lens review with adversarial verification; fix confirmed
   findings; re-run gates.
6. **Live**: `bun run test:t3-live` passes and leaves nothing behind.
7. **Ship**: commit, pull request, CI green, merge.
8. **Deploy**: in `/Users/rclair/projects/devspace` save `dist` for rollback,
   update to the merged `main`, `bun run build:check`, add
   `"t3": { "enabled": true }` to `~/.devspace/config.json`,
   `launchctl kickstart -k gui/$(id -u)/com.rclair.devspace-gateway`, check
   local and public `/healthz`. Rollback: set `t3.enabled` to `false` and
   restart, or restore the saved `dist`.
9. **Deployed**: `bun run test:t3-deployed`.
10. **ChatGPT**: refresh the DevSpace connector through the browser, run S1,
    S2, S3, and S7 in a text chat; the user repeats the flow by voice.

### Phase 1 exit criteria

- Unit, end-to-end (both modes), live, and deployed suites pass.
- ChatGPT text acceptance and the user's voice pass succeed.
- Documentation ships with the change.

## Phase 2 steps

1. Re-run the live contract assertions for the Phase 2 tools.
2. Extend the fake, allowlist, shaping, and descriptions.
3. Extend the matrix and scenarios: schedule a far-future task, list it, run
   it now, delete it; rename and regenerate a scratch thread title;
   batch-launch two scratch threads and confirm both run `full-access`; create
   a project in a temporary folder and clone a small public repository. The
   live harness removes test projects and folders through its own direct T3
   client; deletion is never exposed through DevSpace.
4. Update `docs/t3-code.md` and the README subsection.
5. Repeat steps 4–10 of Phase 1 for the Phase 2 tools.

## Done criteria

- Phase 1 and Phase 2 exit criteria met.
- Threads started through the bridge always run with `runtimeMode: full-access`.
- Restarts leave at most one live session per DevSpace instance label in T3.
- No secret value appears in DevSpace logs or tool results.

## STOP conditions

- The installed T3 rejects the headless pairing-code decision, changes the
  `/mcp` auth model, or no longer issues full-access client tokens.
- A bridge-launched thread does not report `runtimeMode: full-access`.
- A live contract assertion disagrees with the fake: fix the fake to match the
  real T3 before continuing.
- Any secret value appears in logs, errors, or tool output.

## Maintenance notes

- T3 Code is on a nightly channel. Run `bun run test:t3-live` after T3 updates
  that touch MCP or auth; keep tool names stable when T3's schemas change, and
  refresh the fixtures from a live capture when shapes change.
- If T3 adds a local event or inbox API, replace the `t3_inbox` derivation
  with it.
