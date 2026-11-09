# T3 Code orchestration

The T3 bridge lets an MCP host, typically ChatGPT in voice mode on a phone, orchestrate T3 Code on the DevSpace machine through the existing DevSpace connector. The host finds projects and threads by name, starts threads in full-access mode, steers, interrupts, and reads them, answers agent questions, checks an inbox of threads that need you or have finished, and settles threads it has handled. It can also rename threads, create or clone projects and set their default model, and schedule tasks that start new threads later. T3 Code's agents do the coding in their own threads; the host stays the orchestrator.

```text
ChatGPT (voice) → devspace-saga.heliasar.com/mcp → Svartal DevSpace gateway
               → T3 bridge → http://127.0.0.1:3773/mcp (T3 Code on Svartal)
```

The bridge is off by default. Design record: [Plan 015](../plans/015-t3-voice-orchestrator-bridge.md).

## How it works

### Credential

The bridge mints its own T3 credential through the local T3 CLI, with no browser step:

1. `t3 auth pairing create` issues a single-use pairing code with a two-minute lifetime and the scopes `orchestration:read`, `orchestration:operate`, `settings:write`, and `source-control:write`.
2. The bridge registers an OAuth client with T3 (`/oauth/mcp/register`, loopback redirect URI, no listener), redeems the pairing code for a `full-access` authorization code (`/oauth/mcp/decision`), and exchanges that code with PKCE for an access token (`/oauth/mcp/token`).

The token is valid for 30 days and has no refresh token. It is kept in memory only, so a restarted DevSpace mints a new one on first use. The bridge also mints again after an HTTP 401 and when fewer than three days remain (or 10% of the token's lifetime, if that is shorter). Minting is single-flight.

Each DevSpace instance labels its T3 sessions `devspace-t3-bridge:<first 10 hex characters of sha256(state directory)>`. Before minting, the bridge revokes every T3 session carrying its label, so restarts leave at most one live session per instance. Pairing codes, authorization codes, and tokens are never logged or returned in tool results.

### Connection and retries

One bridge per DevSpace process serves every MCP session. It connects lazily over Streamable HTTP with a bearer token. T3's origin comes from `t3.url` when set, otherwise from the `origin` field of T3's runtime file, which is re-read on every reconnect.

| Condition | Behavior |
| --- | --- |
| HTTP 401 | Mint a new credential, reconnect, and retry once. A second 401 returns `T3 Code rejected DevSpace's credential.` |
| HTTP 404 on the MCP session (T3 restarted) | Reconnect and retry once. |
| Connection refused, or runtime file missing | Return `T3 Code is not reachable on this machine.` The next call tries again; DevSpace does not need a restart. |
| Any other failure after the request was sent | Reconnect and retry once when the call is a read (`t3_project_list`, `t3_thread_search`, `t3_thread_list`, `t3_thread_read`, `t3_thread_wait`, `list_scheduled_tasks`, `orchestrator_capabilities`, and the inbox's own reads), carries `clientRequestId` (launch, send, interrupt, `t3_thread_update`, and scheduled-task creation always do), or only sets fields (`t3_project_update`, and `schedule_task` with `scheduledTaskId`). `t3_pending_request`, `t3_thread_organize`, `t3_queue`, `t3_project_create`, `t3_project_clone`, `run_scheduled_task_now`, and `delete_scheduled_task` are never retried; they return `T3 Code connection failed during <tool>; it may or may not have run.`, or the unreachable error when an unauthenticated probe of T3's protected-resource metadata (two-second timeout) gets no connection. |

Tool names are fixed. Input schemas come from T3's live `tools/list`, trimmed as described in the tool reference, and the catalog is cached per process and refreshed on every new connection to T3; the first fetch has a three-second budget. When T3 is unreachable, the same 21 names register with loose schemas, so ChatGPT's cached tool list stays stable. After a failed or timed-out fetch, MCP sessions opened during the next 60 seconds get those loose schemas at once, without waiting, while the catalog keeps loading in the background. Once T3 is back, the catalog reloads, and MCP sessions opened after that get the live schemas without a DevSpace restart.

### Full access

Every thread the bridge launches runs in T3's `full-access` runtime mode, the most permissive of `approval-required`, `auto-accept-edits`, `auto`, and `full-access`. The bridge forces `runtimeMode: "full-access"` on every launch and removes `runtimeMode` and `delegatedFrom` from the exposed launch schema, so a caller cannot choose another mode. Tool descriptions state that threads always run in full-access mode. Scheduled-task runs are started by T3, also in `full-access` mode (see [Scheduled tasks](#scheduled-tasks)).

### Inbox

T3 has no inbox or event API on `/mcp`, so `t3_inbox` is a DevSpace tool. It pages through the unsettled, unarchived top-level threads, newest first (at most 1,000), drops snoozed ones, and sorts the rest:

- **Needs you.** Active threads (`preparing`, `queued`, `starting`, `running`, `waiting`) with a pending request (`pendingRequestCount > 0`). T3 keeps a waiting thread `running`, so the inbox reads the detail of every active thread, four at a time. A `question` carries its text and option labels and is answered with `t3_pending_request`. An `approval` can only be granted in the T3 app. Every item is listed on every call, regardless of the cursor. Past 60 active threads, only the 60 most recent are inspected; `needsYouIncomplete` is then `true` and `uninspected` counts the active threads that were not checked. It is also `true` when a detail read failed or more than 1,000 unsettled threads exist.
- **New.** Outcomes updated after the cursor, newest first, up to `limit`: `finished` (`completed`), `failed` (`failed`, `rolled_back`), and `stopped` (`interrupted`, `cancelled`). `omitted` counts the outcomes left out by `limit`. The five newest `finished` items carry `preview`, the last assistant message cut to 300 characters. `idle` threads are ignored.
- **Counts.** `running` threads (inspected, nothing pending), and `unsettledBacklog`: unsettled outcomes at or before the cursor, or already listed while the cursor is held back.

The cursor is `since` when given, otherwise this process's implicit cursor, otherwise 24 hours ago. A check without `since` moves the implicit cursor to its `checkedAt` once nothing was omitted. When `limit` left outcomes out, the cursor stays where it was and the bridge remembers the outcomes it listed (thread and `updatedAt`, at most 1,000), so the next check without `since` lists the rest instead of losing them. A check with `since` lists every outcome after it, including ones already listed. It moves the implicit cursor only when it omitted nothing and its `since` is no later than the implicit cursor, so it listed everything the next check without `since` would have; otherwise it leaves the implicit cursor and the remembered outcomes alone. The cursor lives in memory, so a restart falls back to 24 hours. To acknowledge a thread, settle it with `t3_thread_organize`; settling is T3's own inbox-zero state, so it also shows in the T3 app. Archiving also settles.

```text
{ "needsYou": [{ "threadId", "project", "title", "link", "kind", "requestId?", "questionId?", "question?", "options?", "updatedAt" }],
  "needsYouIncomplete", "uninspected?",
  "new": [{ "threadId", "project", "title", "link", "outcome", "updatedAt", "preview?" }], "omitted",
  "counts": { "running", "unsettledBacklog" }, "since", "checkedAt" }
```

### Thread links

Thread list rows, search matches, read results, inbox items, and launch and send results carry `link`, of the form `https://app.t3.codes/threads/<environmentId>/<threadId>`. Every tool description tells the model to find threads with `t3_thread_search` or `t3_thread_list` instead of asking for IDs, to refer to threads by title and project, and to give the link when you may want to open the thread in the T3 app.

### Scheduled tasks

T3 runs scheduled tasks itself; the bridge creates, updates, lists, runs, and deletes them. Creating a task needs:

- **`projectId`.** Without it T3 returns `target_required`.
- **A project default model.** T3 records it when the task is created and starts every run with that model; changing the project default later does not change existing tasks. Pick a model with `orchestrator_capabilities` and set it with `t3_project_update`; T3 ignores a default model given at project creation.
- **A git repository.** Each run gets its own git worktree, so the project folder must be a repository. A project created without `workspaceRoot` is one.

Each run of a task created through DevSpace starts a new thread (unless the task sets `freshSession`, when runs share the thread the first run made) in `full-access` mode with the model recorded at creation, in a worktree under `~/.t3/worktrees/<folder>/`. Tasks created through DevSpace are never bound to a calling thread, and their creation carries a `clientRequestId`, so a retried creation returns the same `scheduledTaskId`. An update (`scheduledTaskId` given) changes only the fields it names. `run_scheduled_task_now` also runs a disabled task. A task created in the T3 app keeps its own thread binding, runtime mode, and model when DevSpace updates it.

## Setup

### Requirements

- T3 Code running on the same machine as the DevSpace process that serves the tools. In gateway mode that is the gateway host; remote nodes are not involved.
- The T3 CLI at `~/.t3/bin/t3`. The defaults assume DevSpace runs as the OS user that runs T3 Code.
- Verified against T3 Code `v0.1.8-nightly.20261109.4392`. T3 Code ships nightly; run the live suite after T3 updates that touch MCP or auth.

### Settings

Add a `t3` block to `config.json` in the DevSpace configuration directory (`~/.devspace/config.json` by default):

```json
{
  "t3": {
    "enabled": true,
    "cliPath": "~/.t3/bin/t3",
    "runtimeFile": "~/.t3/userdata/server-runtime.json"
  }
}
```

`enabled` defaults to `false`. `cliPath` and `runtimeFile` are shown at their defaults and can be omitted. `url` has no default; set it (for example `"http://127.0.0.1:3773"`) to pin T3's origin, in which case `runtimeFile` is ignored. Settings are read at startup, and invalid values stop DevSpace from starting; see the [Configuration Reference](configuration.md#t3-code-bridge).

### Enable on Svartal

The gateway reads `config.json` from `<stateDir>/role-config-source/`, which on Svartal links to `~/.devspace/config.json`. Add the block there and restart the gateway:

```bash
launchctl kickstart -k gui/$(id -u)/com.rclair.devspace-gateway
```

Deployment, verification, and rollback steps are in [Svartal gateway](svartal-gateway.md#t3-code-bridge). For a standalone `devspace serve`, edit its `config.json` and restart the server.

### Refresh the connector in ChatGPT

DevSpace registers the T3 tools when an MCP session starts, and ChatGPT caches the tool list. After enabling or disabling the bridge, or updating DevSpace to a version that changes the T3 tools, refresh the DevSpace connector in ChatGPT's settings. Refreshing opens a new MCP session without re-authorizing, and the 21 T3 tools appear.

### Disable

- Set `t3.enabled` to `false` and restart DevSpace. The tools disappear and DevSpace no longer contacts T3.
- Or keep the setting and hide the tools with the `t3` capability: `DISABLED_CAPABILITIES=t3` for the instance, `X-Disabled-Capabilities: t3` for one MCP session, or `t3` in the gateway's local machine `disabledCapabilities`. See [Configuration Reference](configuration.md#t3-code-bridge).

After disabling, the bridge's last T3 session may stay listed in T3 until it expires. Find it with `~/.t3/bin/t3 auth session list --json` (label `devspace-t3-bridge:…`) and revoke it with `~/.t3/bin/t3 auth session revoke <sessionId>` if it should go immediately.

## Usage

Talk about threads by project and title. The orchestrator resolves names to IDs itself.

| You say | The orchestrator uses |
| --- | --- |
| "What's going on?" / "Anything new?" | `t3_inbox` |
| "Start a thread in devspace to fix the CI flake" | `t3_project_list` to find the project, then `t3_thread_launch` |
| "Start a scratch thread to try the new parser" | `t3_thread_launch` with `scratch` |
| "Find the thread about the OAuth refactor" | `t3_thread_search`, then `t3_thread_read` |
| "What's running in devspace?" | `t3_thread_list` |
| "How's it going?" | `t3_thread_read`, or `t3_thread_wait` for a short wait |
| "Tell it to also update the changelog" | `t3_thread_send` |
| "What's queued on it?" | `t3_queue` |
| "Stop it" | `t3_thread_interrupt` |
| "Answer red" | `t3_pending_request` (`read`, then `respond`) |
| "Mark it done" | `t3_thread_organize` with `settle` |
| "Snooze it until tomorrow" | `t3_thread_organize` with `snooze` |
| "Rename it to parser spike" / "Give it a better title" | `t3_thread_update` with `rename` / `regenerate_title` |
| "Which models can I use?" | `orchestrator_capabilities` |
| "Start the same fix in devspace and in t3-bridge" | `t3_thread_launch` once per thread, each with its own project and model |
| "Make a new project called notes" | `t3_project_create` without `workspaceRoot` (T3 creates a git repository) |
| "Add ~/code/website as a project" | `t3_project_create` with `workspaceRoot` |
| "Clone this repository and make it a project" | `t3_project_clone`, then `t3_project_create` with the clone's folder |
| "Use Haiku by default in notes" | `orchestrator_capabilities`, then `t3_project_update` with `defaultModelSelection` |
| "Every weekday at nine, have devspace check for dependency updates" | `schedule_task` |
| "What's scheduled?" | `list_scheduled_tasks` |
| "Run the dependency check now" | `list_scheduled_tasks`, then `run_scheduled_task_now` |
| "Pause it" / "Delete it" | `schedule_task` with `enabled: false` / `delete_scheduled_task` |

### Taking over in the T3 app

Open a returned thread link to continue in the T3 Code mobile app. Thread state lives in T3, so replies, approvals, and settling done in the app are what the orchestrator sees on its next read or inbox check. Approvals can only be granted there.

### Notifications

Nothing can start a turn in a ChatGPT conversation from outside, so DevSpace cannot alert you. T3 Code's push notifications and Live Activities in its mobile app remain the alert path. When one arrives, or whenever you want an update, ask ChatGPT to check back; it calls `t3_inbox`. Within a turn, `t3_thread_wait` waits at most 25 seconds.

## Tool reference

`readOnlyHint` is as listed. Under the `trusted-owner` annotation profile (Svartal's) every tool advertises `destructiveHint: false` and `openWorldHint: false`, so ChatGPT asks for no confirmations; under `standard`, write tools advertise `destructiveHint: true` and `openWorldHint: true`, as T3 itself does. No other T3 tool is reachable through DevSpace. Forwarded tools drop `environmentId` from their schema and pass T3's result through unchanged unless noted. Results carry `structuredContent` and the same JSON as text; no tool declares an output schema. T3 failures are `isError` results whose text is `{"_tag":"OrchestratorMcpFailure","code":…,"message":…}`.

| Tool | Read-only | Purpose, defaults, and shaping |
| --- | --- | --- |
| `t3_project_list` | yes | Projects by name and path. `limit` 50. Returns `{ projects: [{ projectId, title, workspaceRoot }], nextCursor }`. |
| `t3_thread_search` | yes | Find threads by title, branch, pull request, project, then message text; skips subagent threads. `limit` 8. Returns `{ matches: [{ threadId, project, title, source, link }] }`. |
| `t3_thread_list` | yes | Recent threads, newest first. All projects unless `projectId` is given; no subagent threads; `limit` 10. Returns `{ threads: [{ threadId, project, title, status, settled, updatedAt, link }], nextCursor, total }`. |
| `t3_thread_read` | yes | Without `afterPosition` or `itemId`, the latest `limit` (6) messages, `maxCharsPerItem` 1500. Returns `{ thread, items, olderAvailable }`; `thread` includes `status`, `runtimeMode`, `pendingRequestCount`, `settled`, `archived`, and `link`. With `afterPosition` or `itemId`, pages forward through T3 with the same defaults and also returns `nextPosition` and `hasMore`. |
| `t3_thread_wait` | yes | Wait for a run to finish. `timeoutMs` 20000, at most 25000. Returns `{ threadId, runId, status, timedOut }`. |
| `t3_inbox` | yes | DevSpace-native inbox (see [Inbox](#inbox)). `since` (ISO-8601), `limit` 1 to 20 (default 8); `omitted` counts outcomes left out by `limit`. |
| `t3_thread_launch` | no | Start a thread in a project (`projectId`) or a scratch folder (`scratch`). Always `full-access`; `clientRequestId` added when absent, so the bridge's own retry cannot create a second thread. |
| `t3_thread_send` | no | Message a thread. `mode`: `auto` (start, steer, or queue as fits), `queue`, `steer`, `restart`. `clientRequestId` added when absent. |
| `t3_thread_interrupt` | no | Stop the running turn; the thread ends `cancelled`. Returns `status: "interrupt_requested"` or `"no_active_run"`. `clientRequestId` added when absent. |
| `t3_pending_request` | no | `list`, `read`, and `respond` to an agent's questions. `threadId` required. `answers` is keyed by question `id` with the chosen option label. Cannot grant approvals. |
| `t3_thread_organize` | no | `settle`, `unsettle`, `snooze` (with `snoozedUntil`), `unsnooze`, `pin`, `unpin`, `archive`, `unarchive`, `mark_unread`. `threadId` required. |
| `t3_queue` | no | A thread's queued messages: `list`, `read`, `edit`, `cancel`, `reorder`, `promote_to_steer`. `threadId` required. |
| `t3_thread_update` | no | Rename a thread (`action: "rename"` with `title`) or regenerate its title (`regenerate_title`). `threadId` required; `clientRequestId` added when absent. |
| `orchestrator_capabilities` | yes | Providers and models T3 can run; the list is short, and `search` finds other models. DevSpace's own description. Returns `{ providers: [{ providerInstanceId, displayName, models: [{ id, label?, options? }], constraints? }] }`; each option has `id`, `values`, and `default`, and `constraints` (kept only when present) says why a provider cannot run now, such as a disabled provider. |
| `t3_project_create` | no | Register a folder as a project, or, without `workspaceRoot`, have T3 create a git repository at `~/.t3/projects/<title>`. `workspaceRoot` must be absolute or start with `~/` (expanded to the DevSpace user's home folder); `createWorkspaceRootIfMissing` defaults to `true` when it is given. Only `title`, `workspaceRoot`, and `createWorkspaceRootIfMissing` are exposed and forwarded: T3 ignores a default model given at creation, and project scripts stay out. |
| `t3_project_clone` | no | Clone a repository into a new or empty folder. `destinationPath` is required, with the same path rule. Register the clone with `t3_project_create`, passing the returned `cwd` as `workspaceRoot`. |
| `t3_project_update` | no | Rename a project or set its default model (`defaultModelSelection`: `{ instanceId, model }` from `orchestrator_capabilities`). Only `projectId`, `title`, and `defaultModelSelection` are exposed and forwarded. |
| `list_scheduled_tasks` | yes | Scheduled tasks in one project (`projectId`) or in every project. `webhookUrl` and `webhookSignature` are removed from results. |
| `schedule_task` | no | Create a task (no `scheduledTaskId`; see [Scheduled tasks](#scheduled-tasks)) or update one. `schedule.type`: `interval` (`everyMs`, at least 60000), `fixed_time` (`timeOfDay`, optional `weekdays`), or `once` (`runAt`). Creation forces `bindToCurrentThread: false` and adds `clientRequestId` when absent. Webhook triggers are removed from the schema and rejected; `webhookUrl` and `webhookSignature` are removed from results. |
| `run_scheduled_task_now` | no | Start one run now; `taskId` is the task's `scheduledTaskId`. Follow the returned thread with `t3_thread_wait` and `t3_thread_read`. |
| `delete_scheduled_task` | no | Delete a task by `scheduledTaskId`. A missing task returns `task_not_found`. |

### Not exposed

- **Batch launch (`create_threads`).** T3 accepts it only from inside a thread (`thread_credential_required`). Start several threads with repeated `t3_thread_launch` calls.
- **Project deletion (`t3_project_delete`).** Kept out of the voice surface; delete projects in the T3 Code app.
- **Webhook triggers for scheduled tasks.** A webhook URL accepts requests from anyone who holds it and starts full-access agents with each request's content. DevSpace callers can already start threads directly, so a webhook would add only a persistent outside trigger. Set webhooks up in the T3 Code app.
- **Other project settings** (scripts, workspace root, icon, archiving, and the like). `t3_project_create` takes only a title and a folder, and `t3_project_update` only the title and the default model; change the rest in the T3 Code app.

## Verification

| Suite | Command | Chain under test |
| --- | --- | --- |
| Unit | `bunx tsx src/t3-bridge.test.ts` | Bridge module against the fake T3: credential, retries, shaping, inbox, secret hygiene |
| End-to-end | `bunx tsx src/t3-e2e.test.ts` | MCP SDK client → DevSpace `/mcp` in serve and gateway modes → bridge → fake T3 over HTTP with its OAuth and a fake CLI process |
| Live | `bun run test:t3-live` | MCP SDK client → in-process DevSpace → bridge → real T3 Code and real CLI on this machine |
| Deployed | `bun run test:t3-deployed` | MCP SDK client → public DevSpace URL → Svartal gateway → real T3 Code |

`bun run test` includes the unit and end-to-end suites. The fake T3 serves the captured `tools/list` and result shapes in `src/testing/`. The live suite also asserts that real T3 still matches the fake's contract (tool names and properties, error codes, HTTP failure modes, list and read fields, CLI output) and fails on any mismatch; run it before merging bridge changes and after T3 updates. Run the deployed suite after each deployment; it reads `publicBaseUrl` from `config.json` and the owner token from `auth.json` in the DevSpace configuration directory (`DEVSPACE_CONFIG_DIR`, default `~/.devspace`; `DEVSPACE_PUBLIC_BASE_URL` and `DEVSPACE_OAUTH_OWNER_TOKEN` override them). DevSpace keeps at most 500 registered OAuth clients and refuses registration beyond that, so the suite reuses one client: it caches the client, its refresh token, and the OAuth metadata in `~/.local/state/devspace/t3-deployed-check.json` (directory `0700`, file `0600`, never printed), obtains each run's access token with the refresh-token grant (storing the rotated refresh token), and registers a new client through DevSpace's public OAuth flow with the owner token only when the cache is missing, belongs to another `publicBaseUrl`, or its refresh fails. At the end it revokes the access token and keeps the refresh token. It prints whether the client was reused or newly minted, and the refresh token's expiry when DevSpace reports it.

The live and deployed suites start real agent turns, which use provider credits. Their threads are titled `DevSpace bridge check <stamp> …` and are settled and archived at the end. They also clone a small public repository into a temporary folder, register it as a project, and schedule and run a task in it; at the end they delete the task, remove the project through their own T3 client (project deletion is not exposed through DevSpace), and delete its folder and the run worktrees. The deployed suite can do this because it runs on the gateway's machine. The suites revoke every T3 session they created, fail if any remain, and fail loudly when T3 is unreachable.

## Troubleshooting

**`T3 Code is not reachable on this machine.`** T3 Code is not running, or its runtime file is missing or names a stale origin. Start T3 Code, check `origin` in `~/.t3/userdata/server-runtime.json`, or set `t3.url`. The next call retries without a DevSpace restart.

**`T3 Code rejected DevSpace's credential.`** T3 refused a freshly minted credential. As the DevSpace user, check that the CLI works and lists the bridge's session (label `devspace-t3-bridge:…`):

```bash
~/.t3/bin/t3 --version
~/.t3/bin/t3 auth session list --json
```

An Electron `CompileAndCall` warning on stderr is harmless. If the launcher reports that T3 Code has moved, open the T3 Code app once to rewrite it. Restarting DevSpace forces a fresh mint on the next call. If T3 changed its auth model, the live suite fails at the credential step.

**`T3 Code credential setup failed: …`** Minting a credential failed before anything was sent to T3. The rest of the message names the step, for example `T3 CLI not found at <path>.`, `T3 CLI auth pairing create exited with 1.`, `T3 CLI auth session list timed out after 30 seconds.`, or `T3 Code token exchange failed with HTTP 400.` Check `t3.cliPath` and run the CLI commands above as the DevSpace user. The next call tries again.

**`T3 Code connection failed during <tool>; it may or may not have run.`** The connection failed after the request was sent, and the call is not one the bridge retries (see [Connection and retries](#connection-and-retries)), or its one retry failed too. Check the result with `t3_thread_read`, `t3_project_list`, or `list_scheduled_tasks` before repeating the call.

**`Project … has no default model, so this caller cannot pick one for it.`** `schedule_task` needs a project default model. Pick a model with `orchestrator_capabilities`, set it with `t3_project_update` (`defaultModelSelection`), and create the task again.

**A scheduled run fails at once with `Workspace preparation failed during provision worktree …`.** The project folder is not a git repository, and each run needs a git worktree. Make the folder a repository, or use a project T3 created without `workspaceRoot`.

**`workspaceRoot must be an absolute path (or start with ~/), not "…".`** T3 resolves a relative path against its own working directory, the home folder, so DevSpace rejects relative `workspaceRoot` and `destinationPath` values. Pass an absolute path or one starting with `~/`.

**ChatGPT does not show the T3 tools, or shows an old list.** Refresh the DevSpace connector in ChatGPT. If they are still missing, check that `t3.enabled` is `true` in the `config.json` DevSpace actually reads, that DevSpace was restarted after the change, and that `t3` is not a disabled capability for the instance, the session, or the gateway's local machine.

**A bridge-launched thread is not `full-access`.** This should not happen: the bridge forces the mode on every launch. Disable the bridge, report it with the thread link, and run `bun run test:t3-live`.

**Logs.** DevSpace's request log records the tool name of every call. On Svartal the logs are `~/.local/state/devspace-svartal/gateway.log` and `gateway.err.log`; a standalone server writes to its standard output and error streams as configured by `DEVSPACE_LOG_*`. T3 credential values never appear in them.

## Security

Enabling the bridge lets any authenticated DevSpace client start full-access coding agents on this machine, at once or on a schedule, which is equivalent to DevSpace's shell authority. See [Security Model](security.md#t3-code-bridge).
