# Turn DevSpace into a trusted-host engineering cockpit

**Status:** Application implementation complete; infrastructure companion pending  
**Date:** 5 August 2026  
**Completed:** 5 August 2026  
**Owning repository:** DevSpace  
**Infrastructure companion plan:** `saga-homelab/.opencode/plans/devspace-trusted-host-runtime.md`

## Outcome

DevSpace stops behaving like a stateless wrapper around short file and Bash calls and becomes a reliable remote engineering cockpit for long, stateful work on trusted hosts.

The completed system must provide all of the following:

- `open_workspace` reports the real capabilities of the opened checkout, including logical and canonical roots, file and Git writability, mount state, repository identity, shell/runtime availability, user-systemd availability, and whether privileged execution is possible.
- Friendly path aliases such as `/home/ubuntu/projects -> /srv/pool/projects` remain supported. Authorization is based on canonical targets and explicit root policy, not on lexical path prefixes and not on a blanket ban on symlinks.
- File reads and writes may cross a symlink only when the canonical target belongs to another explicitly configured root with sufficient access. A nested link to an unconfigured target such as `/etc` is rejected even when the lexical path begins inside the workspace.
- Root policies distinguish read-only and read-write targets and may declare aliases. Existing string roots remain accepted as read-write roots.
- Opening a misspelled path no longer silently creates a new directory. Directory creation requires an explicit `create: true` request.
- A new `isolated` workspace mode always produces a writable independent checkout. It uses a managed worktree when the source Git metadata is writable and a managed clone when it is not.
- Review checkpoints live under DevSpace state instead of writing `refs/devspace/*` and snapshot objects into the user's repository.
- Shell calls may use the user's login environment so Bun, OpenCode, mise, user-installed tools, and user-systemd work without command-specific `bash -lc` wrappers.
- DevSpace infrastructure credentials are stripped from child shell and terminal environments even on a trusted, root-capable host.
- Persistent interactive terminal sessions are first-class MCP tools. The initial backend is tmux with an explicit socket under DevSpace state and optional user-systemd ownership so sessions may outlive an MCP request and a DevSpace restart.
- Long remote shell calls honor the requested shell timeout plus bounded transport grace instead of being killed by the gateway's current fixed 30-second node timeout.
- Workspaces and terminals have explicit status and close operations, bounded retention, and safe cleanup. Dirty isolated checkouts are never deleted silently.
- Gateway and node mode use the same executor implementation and tool contract. The public MCP layer contains no second, unreachable copy of the tool implementations.
- Ultra Review and other local agent skills may be advertised through configured skill roots without adding OpenCode-specific behavior to DevSpace core.

The intended Saga interaction becomes:

    open_workspace(path="~/projects/watercooler", mode="isolated", machine="saga")
      -> reports that the source is a read-only alias, creates a writable clone,
         returns logical/canonical provenance and runtime capabilities

    implement with file tools and ordinary shell calls

    terminal_start(command="opencode --mini --no-replay")
    terminal_write(...)
    terminal_read(...)
    terminal_resize(...)
      -> review remains observable and interactive beyond MCP request limits

    show_changes(...)
    close_workspace(...)
      -> terminal/review state is cleaned; dirty isolated checkout is retained

## Accepted trust model

DevSpace supports more than one deployment profile. The generic/default profile remains suitable for users who want a constrained non-root development daemon. Saga intentionally uses a **trusted-host** profile.

For the trusted-host profile:

- The authenticated DevSpace shell and terminal tools may do anything the service account can do.
- On Saga, the service account may also obtain root through the host's existing sudo policy. DevSpace must report this capability plainly; it must not pretend the shell remains a meaningful sandbox once root is available.
- The public service remains loopback-bound behind the dedicated Cloudflare tunnel and DevSpace OAuth. The Asgard node remains protected by its independent node bearer.
- DevSpace's own OAuth owner token and every configured node bearer are control-plane secrets and must never be inherited by child shells, terminal sessions, language servers, OpenCode, or other development processes.
- The file tools still enforce canonical root policy because their scope, UI, provenance, and accidental-damage resistance are valuable. They are not claimed as a security boundary around an unrestricted or root-capable shell.
- Symlinks are useful topology, not inherently suspicious. A root alias is legitimate; a link to another configured root is legitimate when policy permits it; a link to an unconfigured target is rejected.
- No generic privileged RPC or embedded sudo broker is added in this work. Root-capable commands run through the explicitly annotated shell or terminal tools and remain visible in tool history.

## Work

### 1. Collapse the duplicated execution surface before adding new tools

`src/server.ts` currently registers routed tool calls and then retains hundreds of lines of unreachable direct implementations after immediate returns. Remove that dead path and make `LocalExecutor` the only implementation of workspace, file, shell, review, lifecycle, and terminal operations.

Split public MCP registration into focused modules, for example:

    src/tools/workspace-tools.ts
    src/tools/file-tools.ts
    src/tools/shell-tools.ts
    src/tools/terminal-tools.ts
    src/tools/review-tools.ts

Keep public naming, widget metadata, annotations, and result-card formatting in those registration modules. Keep all local behavior behind the shared canonical tool contract and `LocalExecutor`. Standalone mode, the Saga local executor, and the Asgard node must invoke the same code.

Do this refactor without changing the current public tool schemas first. Run the existing typecheck, Node tests, MCP/UI tests, and build before starting the contract additions below.

### 2. Replace lexical roots with canonical root policies

Introduce an explicit root-policy type used by standalone, gateway-local, and node roles:

```ts
interface RootPolicy {
  path: string;
  aliases?: string[];
  access: "read-only" | "read-write";
}
```

Continue accepting a string root as shorthand for:

```json
{ "path": "<string>", "access": "read-write" }
```

Normalize each configured root at startup:

- preserve the configured logical path for display;
- resolve the canonical existing target with `realpath`;
- resolve and record each alias independently;
- reject duplicate or overlapping aliases that would make one logical path map ambiguously to more than one policy;
- reject an alias whose canonical target is not the configured root or a descendant selected intentionally by configuration;
- fail configuration when a required root does not exist, unless the policy explicitly permits creation of that root during bootstrap.

Update workspace state to retain both logical and canonical identity:

```ts
interface Workspace {
  id: string;
  root: string;           // logical path shown to the user and used as PWD
  canonicalRoot: string;  // canonical target used for authorization
  rootPolicyId: string;
  // existing mode/source/worktree fields
}
```

For existing read targets, authorize the canonical target against the configured policies. For a write target that does not exist, canonicalize the nearest existing parent immediately before the operation, ensure the parent is inside a read-write policy, and then append only normalized non-`..` path components. Revalidate the resulting path after creation where the operation permits it.

A workspace-relative target is allowed when its canonical target is either:

1. inside the workspace's own canonical root with sufficient access; or
2. inside another explicitly configured canonical root reached through a symlink, with sufficient access for the requested operation.

This preserves:

    /home/ubuntu/projects -> /srv/pool/projects

and permits intentional project links to other configured roots, while rejecting an undeclared link such as:

    project/host-config -> /etc

unless `/etc` is separately configured, normally as read-only.

Apply the same canonical checks to:

- `read`, `write`, `edit`, `grep`, `glob`, and `ls`;
- `workingDirectory` resolution for shell and terminal start;
- project instruction discovery;
- skill file and activated skill-directory reads;
- restored workspace sessions after process restart;
- source and destination paths used by isolated workspace creation.

Add tests that prove:

- a root alias opens and displays the logical path while authorizing the canonical target;
- a nested symlink into the same root works;
- a nested symlink into another configured read-only root may be read but not written;
- a nested symlink into an unconfigured root is rejected;
- a nonexistent write target beneath a canonical read-write parent works;
- changing a parent into a symlink between workspace open and file access does not bypass the operation-time check;
- skill reads cannot escape through symlinks;
- a restored persisted workspace reruns current canonical authorization rather than trusting stale paths.

Update `docs/security.md` to state precisely that file-tool policy is canonical-target authorization and that the shell remains unrestricted by workspace roots.

### 3. Make workspace opening a capability probe, not a hopeful assertion

Stop calling `mkdir(root, { recursive: true })` for ordinary checkout opens. Extend the input with:

```ts
create?: boolean
```

A missing directory fails unless `create: true`; creation still requires a read-write root policy.

Return a capability object from `open_workspace` and persist the stable parts with the workspace session:

```ts
interface WorkspaceCapabilities {
  logicalRoot: string;
  canonicalRoot: string;
  fileAccess: "read-only" | "read-write";
  mountReadOnly: boolean;
  git?: {
    repositoryRoot: string;
    commonDirectory: string;
    head: string;
    branch?: string;
    dirty: boolean;
    worktreeAvailable: boolean;
    cloneAvailable: boolean;
    gitMetadataWritable: boolean;
  };
  runtime: {
    shellPath: string;
    shellMode: "service" | "login";
    tmux: boolean;
    opencode?: string;
    userSystemd: boolean;
    privilegeEscalation: "unavailable" | "available" | "unknown";
  };
  warnings: string[];
}
```

Use real probes, not only mode bits or `access(W_OK)`:

- inspect mount flags for the canonical target;
- create and remove a bounded temporary file when policy says read-write;
- resolve the Git common directory and perform a harmless temporary write probe there;
- record repository root, HEAD, branch, and dirty state;
- detect tmux and OpenCode through the configured shell environment;
- test whether the user systemd bus is usable;
- test privilege escalation non-interactively without printing or changing credentials.

Add `workspace_status` to refresh transient capabilities and show:

- current workspace state and last-used time;
- logical/canonical roots and access;
- current Git HEAD/branch/dirty state;
- isolated workspace strategy and provenance;
- active terminal IDs and their states;
- review-checkpoint status;
- close/cleanup eligibility.

The response text must lead with actionable warnings, for example:

    Checkout and Git metadata are read-only. Reopen with mode="isolated" to make changes.

The widget should display read-only/read-write, checkout/worktree/clone strategy, machine, and root-capable status without exposing environment values or secrets.

### 4. Add a trusted login-shell environment with control-plane secret filtering

Add explicit executor shell configuration:

```ts
interface ShellConfig {
  path?: string;
  mode: "service" | "login";
  environment?: Record<string, string>;
}
```

Expose it through standalone environment variables and role JSON. The trusted Saga profile uses login mode. A generic installation may keep service mode.

In login mode, launch commands through the configured shell as a login shell, preserving the workspace's logical path as `PWD`. Do not require callers to wrap every command in `bash -lc`.

Build the child environment once per executor startup from the intended user login environment, then overlay safe service variables and configured additions. Before every shell or terminal launch, remove DevSpace control-plane secrets by exact configured names:

- `DEVSPACE_OAUTH_OWNER_TOKEN`;
- the node role's configured `nodeTokenEnv`;
- every remote machine's configured `nodeTokenEnv`;
- any future secret explicitly registered as a DevSpace infrastructure credential.

Do not broadly remove every variable containing `TOKEN`, `KEY`, or `SECRET`; trusted development processes may intentionally need provider credentials from the user's login environment. The filter is based on DevSpace ownership and configuration, not substring paranoia.

Return only variable names, never values, in diagnostics. Add tests proving that:

- login mode resolves a binary installed through Bun or mise while service mode does not invent one;
- child `PATH`, `HOME`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, and logical `PWD` are correct;
- OAuth and node bearer names are absent from child processes;
- ordinary user development variables survive;
- the remote Asgard node applies its own local child-environment policy rather than receiving Saga's environment;
- shell command logging cannot emit environment values.

### 5. Add an `isolated` mode with managed clone fallback

Extend workspace mode to:

```ts
type WorkspaceMode = "checkout" | "worktree" | "isolated";
```

`worktree` keeps its current explicit semantics and fails when the source Git common directory is not writable.

`isolated` selects the smallest viable writable strategy:

1. use a managed worktree when the source repository and Git common directory are writable;
2. otherwise create a managed clone under `worktreeRoot` or a renamed `workspaceRoot` state directory.

A clone must not use shared local hard links to the readonly source. Use a genuinely independent object store, record source provenance, and ensure the clone's working tree and `.git` are writable. Preserve or reconstruct the source repository's network remotes when available; do not advertise a readonly local source path as a usable push remote.

Return:

```ts
interface IsolatedWorkspaceInfo {
  strategy: "worktree" | "clone";
  sourceRoot: string;
  sourceCanonicalRoot: string;
  baseRef: string;
  baseSha: string;
  sourceDirty: boolean;
  managed: true;
}
```

Uncommitted source changes are not copied automatically. Report them before creating the isolated checkout. Do not stash, copy, or absorb them without an explicit future feature.

Use deterministic bounded names containing the repository name plus a random opaque suffix. Persist enough metadata to restore the workspace after restart and to clean it safely later.

Tests must cover:

- writable source selects worktree;
- readonly Git metadata selects clone;
- clone creation from a readonly source succeeds;
- source dirty state is reported and not copied;
- the clone is independently writable;
- an invalid base ref fails without leaving a partial directory;
- a failed clone or worktree is removed;
- provenance survives executor restart;
- cleanup never removes an unmanaged or unexpectedly moved directory.

### 6. Move review checkpoints out of user repositories

Replace `refs/devspace/review/*` in the user's Git repository with a DevSpace-owned shadow repository under executor state, keyed by workspace ID.

The shadow review store may use the source repository's objects as alternates, but all temporary indexes, trees, commits, refs, and baselines are written under DevSpace state. It must work when both the checkout and source `.git` are read-only.

Persist review metadata so `workspace_open` and `last_shown` baselines may survive an executor restart when their shadow state remains valid. If source history has been rewritten or the workspace no longer matches its stored identity, fail explicitly and allow the caller to reset the baseline; do not compare unrelated repositories.

Remove all review refs created by previous DevSpace versions only through a deliberate maintenance command or documented manual step. The new runtime must not require mutating the source repository during normal operation.

Test binary files, untracked files, pure and changed renames, deleted files, readonly source repositories, executor restart, and cleanup on workspace close.

### 7. Add persistent terminal tools with a tmux backend

Add these canonical tools:

```text
terminal_start
terminal_read
terminal_write
terminal_resize
terminal_status
terminal_close
```

The tools are generic. DevSpace knows nothing about OpenCode, debuggers, REPLs, or review workflows beyond launching and interacting with terminal processes.

A starting contract:

```ts
terminal_start({
  workspaceId,
  command,
  workingDirectory?,
  cols?,
  rows?,
  shellMode?,
  retainOnWorkspaceClose?
})

terminal_read({
  workspaceId,
  terminalId,
  mode?: "screen" | "history",
  lines?,
  cursor?
})

terminal_write({
  workspaceId,
  terminalId,
  text?,
  keys?,
  submit?
})

terminal_resize({ workspaceId, terminalId, cols, rows })
terminal_status({ workspaceId, terminalId? })
terminal_close({ workspaceId, terminalId, force? })
```

Use tmux initially with an explicit socket beneath executor state or the configured user runtime directory. Do not use the default `/tmp` socket. Session names are internal opaque values; public terminal IDs are random and bound to one executor workspace.

Persist terminal records:

```text
terminal_id primary key
workspace_session_id
backend
backend_session_name
command_summary
working_directory
status
created_at
last_used_at
closed_at
retention_policy
```

Never store the full child environment. Do not return backend session names to the MCP client.

Use `capture-pane` for bounded screen/history output, `send-keys`/literal buffers for input, and tmux resize operations for geometry. Preserve Unicode and distinguish literal text from control keys. Cap returned history and provide a cursor or truncation metadata for incremental readers.

When user systemd is available, start the tmux server or terminal owner through a transient user unit so sessions survive a DevSpace service restart. Store the socket under `/run/user/<uid>/devspace` or another configured `0700` directory and keep durable metadata under executor state. If user systemd is unavailable, report that sessions are service-lifetime only.

Apply limits:

- maximum active terminals per workspace and executor;
- bounded initial geometry and history;
- idle TTL with an explicit pin/retention option;
- no terminal attachment across workspace or machine boundaries;
- close is graceful first, forced only when requested or after a bounded timeout;
- executor shutdown does not kill retained user-systemd terminals;
- closed/stale terminal metadata is pruned.

Gateway routing needs no special topology: terminal IDs are arguments on later tools and the existing public workspace binding selects the executor. The node and gateway tool contract hash must include all terminal tools. Remote node call deadlines remain short for terminal read/write/status operations because the long-lived process is detached from the request.

Add an MCP card that shows terminal status, command summary, workspace, machine, geometry, elapsed time, and bounded current screen. It must not render arbitrary terminal escape sequences as trusted HTML.

Test:

- start, write, submit, read, resize, and close;
- an interactive `opencode --mini --no-replay` smoke with a harmless prompt;
- terminal continuity across MCP calls;
- retained terminal continuity across DevSpace restart when user systemd is enabled;
- service-lifetime warning when it is not;
- wrong workspace and wrong terminal IDs fail;
- control keys and literal text cannot be confused;
- terminal output is bounded;
- close terminates the process tree and removes the tmux session;
- no tmux server or language-server residue remains after test cleanup.

### 8. Add workspace lifecycle and bounded maintenance

Add `close_workspace` and extend the workspace store beyond the current never-ending `active` state.

Closing a workspace must:

- mark the session closed;
- stop non-retained terminals and detach retained terminals according to policy;
- remove its shadow review state;
- remove a clean managed worktree or clone;
- retain a dirty managed checkout and report its exact path and reason;
- remove in-memory workspace state;
- expire or delete the public gateway binding;
- make later workspace calls fail with a clear closed-workspace error.

Add maintenance at executor startup and periodically at a low frequency:

- prune stale closed checkout metadata;
- prune clean abandoned isolated workspaces after configurable inactivity;
- retain and report dirty isolated workspaces;
- prune stale terminal metadata and dead tmux sessions;
- prune obsolete shadow review stores;
- checkpoint or control SQLite WAL growth.

Opening the same checkout may reuse an existing active workspace when machine, logical root, canonical root, and mode match. Add `fresh: true` to force a separate workspace and review baseline. Never merge two active isolated workspaces.

Expose maintenance findings in `devspace doctor` and `workspace_status`; do not silently delete dirty work.

### 9. Make remote deadlines match tool semantics

The remote client currently applies a fixed 30-second timeout to every call even though `run_shell` accepts up to 300 seconds. Compute the node deadline from the validated canonical tool arguments:

- `hello`: short fixed timeout;
- file, workspace, review, lifecycle, and terminal control calls: normal fixed timeout;
- `run_shell`: requested shell timeout plus bounded network/serialization grace;
- no operation is retried automatically after transport uncertainty.

Node request abort and response close continue to abort synchronous executor work. Persistent terminal processes are not tied to the request after `terminal_start` succeeds.

Add tests proving a remote 90-second shell is not killed at 30 seconds, a timed-out shell aborts its process tree, a disconnected mutation is invoked once, and terminal sessions remain usable after the request that started them has ended.

### 10. Update configuration, protocol, UI, and documentation as one contract change

This feature changes the canonical tool contract. Update:

- `src/tool-contract.ts` and its deterministic hash description;
- gateway and node tests;
- role configuration types and examples;
- workspace-store schema and migrations;
- widget card types and rendering;
- runtime artifact metadata and smoke tests;
- `devspace doctor`;
- `README.md`, `docs/configuration.md`, `docs/chatgpt-coding-workflow.md`, `docs/security.md`, and `docs/gotchas.md`.

Recommended configuration shape:

```json
{
  "roots": [
    {
      "path": "/srv/pool/projects",
      "aliases": ["/home/ubuntu/projects"],
      "access": "read-write"
    },
    { "path": "/etc", "access": "read-only" }
  ],
  "shell": {
    "path": "/bin/bash",
    "mode": "login"
  },
  "terminals": {
    "backend": "tmux",
    "runtimeDir": "/run/user/1000/devspace",
    "maxPerWorkspace": 4,
    "maxTotal": 12,
    "idleTtlSeconds": 28800
  }
}
```

Retain compatibility with existing `allowedRoots: string[]` and standalone environment variables, but return a configuration error when both old and new root forms are supplied ambiguously.

Make the trusted-host nature visible in the UI and documentation. The shell and terminal tools should clearly say that they run as the DevSpace service account and may be root-capable according to host policy. Do not add repetitive confirmation prompts inside DevSpace; authorization remains the MCP host's responsibility.

Add `/home/ubuntu/.agents/skills` to Saga through deployment configuration rather than hard-coding it in the application. DevSpace only discovers configured skill paths.

## Implementation sequence

Implement in this order so the homelab relaxation never precedes the application controls it depends on:

1. Remove dead server implementations and preserve the existing contract.
2. Add canonical root policy, operation-time path checks, and tests.
3. Add workspace capabilities, `workspace_status`, and explicit directory creation.
4. Add login-shell environment capture and DevSpace secret filtering.
5. Add `isolated` mode and external review storage.
6. Add terminal tools and terminal persistence.
7. Add `close_workspace`, cleanup, and remote timeout semantics.
8. Update UI, docs, protocol hash, artifact smoke tests, and doctor output.
9. Run a thorough adversarial review, using OpenCode Ultra Review when inference is available or an equivalent manual review when it is not; fix findings and rerun the complete gate.
10. Deploy this application build before applying the companion Saga unit relaxation.

## Validation

Run the complete repository gate:

    npm ci --include=dev
    npm test
    npm run typecheck
    npm run build:check
    npm run package:runtime-artifact  # includes the runtime-artifact smoke test
    git diff --check

Then exercise a real gateway/node matrix:

1. Open `~/projects/devspace` on Saga and verify that the logical path maps to `/srv/pool/projects/devspace`.
2. Verify a source checkout reports real file and Git writability instead of optimistic capability.
3. Verify a root alias symlink works.
4. Verify a nested symlink to an unconfigured target is rejected by file tools.
5. Configure `/etc` read-only and verify it may be read through an intentional link but not written.
6. Open a readonly repository with `mode: "isolated"`; verify clone fallback and independent Git metadata.
7. Modify files, call `show_changes`, restart DevSpace, and verify the external review baseline remains valid.
8. Run `command -v opencode`, `command -v bun`, and `systemctl --user is-system-running` through ordinary `bash` without wrappers.
9. Verify child shells do not contain the configured OAuth or node bearer variable names.
10. Start OpenCode in a persistent terminal, send two prompts, inspect output, resize it, restart DevSpace, reconnect, and close it cleanly.
11. Run a remote Asgard shell longer than 30 seconds with an explicit timeout and verify it completes.
12. Close a clean isolated workspace and verify cleanup; close a dirty one and verify it is retained with an explicit warning.
13. Confirm gateway OAuth, public workspace routing, Asgard node identity, widgets, and existing file operations remain correct.

## Completion criteria

The work is complete when:

- canonical path authorization supports configured aliases without permitting undeclared target escapes;
- Saga can report and use writable project checkouts after the companion unit change;
- `open_workspace` accurately reports access, Git, shell, terminal, user-systemd, and privilege capabilities;
- DevSpace child processes cannot see DevSpace's own OAuth or node credentials;
- `isolated` mode succeeds from a readonly source repository;
- review checkpoints no longer write into user repositories;
- persistent tmux-backed terminal sessions are observable, steerable, bounded, and cleanly managed;
- remote shell deadlines honor their requested timeout;
- stale workspace state is bounded and dirty isolated work is retained;
- one thorough adversarial review pass and the complete automated plus live validation matrix are green;
- the trusted-host infrastructure companion plan can be applied without requiring further application changes.


## Implementation outcome — 5 August 2026

The DevSpace application half is complete in the writable Saga checkout at `/home/ubuntu/devspace-trusted-host-plan`. The implementation is intentionally uncommitted and has not been deployed. The companion `saga-homelab` plan, systemd sandbox relaxation, live configuration update, artifact publication, and service restart remain outside this repository and are still pending.

Delivered behavior includes:

- canonical-target root policies with friendly aliases and read-only/read-write access;
- operation-time symlink authorization for file, instruction, skill, and working-directory paths;
- truthful workspace, mount, Git, shell, user-systemd, terminal, and privilege capabilities;
- explicit checkout creation, active checkout reuse, and `fresh: true` for a separate review baseline;
- writable `isolated` workspaces using worktrees or independent `--no-local` clones;
- DevSpace-owned shadow review repositories that survive restart without mutating user Git metadata;
- login-shell execution with exact DevSpace control-plane secret filtering before and after profile loading;
- persistent workspace-bound tmux terminal tools with user-systemd ownership, bounded capture, durable metadata, and transactional cleanup;
- explicit workspace closure, dirty/unsafe managed-work retention, active-operation exclusion, terminal pinning, orphan cleanup, and bounded maintenance;
- tool-aware remote deadlines, durable gateway binding reuse/deletion, one local executor implementation, and restored per-tool logging;
- updated MCP schemas, widgets, doctor output, examples, workflow/security documentation, and deterministic tool-contract metadata.

OpenCode Ultra Review was unavailable because no suitable free inference remained. The replacement was a manual adversarial review of every changed trust, persistence, process, and public-contract boundary. That review found and fixed material defects including post-profile secret leakage, unsafe managed-directory deletion, orphaned or falsely closed tmux sessions, uncertain `systemd-run` outcomes, misleading local clone origins, stale skill and instruction-path injection, review restart deadlock, active-workspace pruning, retained orphan terminals, gateway alias proliferation, close-versus-active-operation races, lost tool logging, secret-bearing failure logs, and dirty-tree artifact misidentification.

Final validation evidence:

- `npm ci --include=dev` completed from a cold dependency state. Saga's current npm configuration omits development dependencies unless `--include=dev` is explicit.
- `npm test` passed the complete repository suite, including the new failure-injection, migration, restart, concurrency, lifecycle, terminal, root-policy, and gateway tests.
- `npm run typecheck` passed.
- `npx tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters` passed.
- `npm run build:check` passed.
- `npm pack --dry-run` contained the expected compiled runtime, UI assets, documentation, and scripts; no tarball residue remained.
- `git diff --check` passed.
- A synthetic clean Git snapshot proved the immutable artifact path. Its manifest commit matched the snapshot commit `b55c29f1046bb3abcb3e566e61d63fe194a0291f`, its artifact SHA-256 was `f71ed19767d5584b97d364b92acd2d189b11d6267efd26be08cc0da2b3207ea2`, and its manifest tool-contract hash matched the built contract: `sha256:6f5a27b7431ac108e9ac647c1e0f98c9c9e472a75f6b8b10b034cebeac245849`. The synthetic checkout and artifact were deleted after verification.
- The artifact packer now refuses a dirty source tree instead of stamping uncommitted bytes with `HEAD`.
- A trusted-host `devspace doctor` probe verified the `/home/ubuntu/projects -> /srv/pool/projects` alias, read-only `/etc` and `/var/log`, login-shell OpenCode/tmux discovery, user-systemd access, root-capable sudo, and infrastructure-secret-name filtering without printing secret values.
- A final live Saga user-systemd/tmux canary started two sessions on one private socket, reconstructed the manager from SQLite, recovered both outputs, closed both sessions, and left no user unit, socket, environment handoff, process, or smoke-directory residue.

`npm audit --omit=dev` currently reports 10 production dependency advisories: 1 low, 3 moderate, 6 high, and 0 critical. No blind breaking `npm audit fix --force` was applied.
