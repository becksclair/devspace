# ChatGPT Coding Workflow

DevSpace gives ChatGPT and other MCP hosts a direct engineering loop on approved machines: inspect the repository, follow local instructions, edit files, run verification, use persistent terminals for long interactive work, review the aggregate diff, and close the workspace cleanly.

## Open one workspace

Call `open_workspace` once for a project folder:

```json
{
  "path": "~/work/my-project"
}
```

The result includes a `workspaceId`, logical and canonical roots, real filesystem and Git capabilities, runtime/tool availability, warnings, and project instructions. Reuse the same `workspaceId` for later calls. Reopening the same active checkout returns that session again, including the same public workspace ID in gateway mode. Pass `fresh: true` only when a separate checkout session and review baseline are intentional. Managed `worktree` and `isolated` opens are always distinct.

Pay attention to warnings before editing. A checkout can be readable by logical path while its canonical mount or Git metadata is read-only.

Use `workspace_status` to refresh capabilities after mounts, permissions, Git state, or host policy change.

## Explicit directory creation

DevSpace does not create a missing checkout merely because its path was supplied. A missing path fails by default. Create it only when intended:

```json
{
  "path": "~/work/new-project",
  "create": true
}
```

Creation must be inside a configured read-write root.

## Workspace modes

### Checkout

Checkout mode is the default and opens the real directory:

```json
{
  "path": "~/work/my-project"
}
```

Use it when the source checkout is writable and the user wants edits there.

### Worktree

Worktree mode explicitly requires a managed Git worktree:

```json
{
  "path": "~/work/my-project",
  "mode": "worktree",
  "baseRef": "HEAD"
}
```

It fails when the source Git common directory cannot accept worktree metadata.

### Isolated

Isolated mode guarantees a writable independent checkout:

```json
{
  "path": "~/work/my-project",
  "mode": "isolated"
}
```

DevSpace uses a managed worktree when source Git metadata is writable. Otherwise it creates an independent `--no-local` clone under the managed workspace root. The result reports `strategy: "worktree"` or `strategy: "clone"` plus source provenance.

Uncommitted source changes are reported but not copied. DevSpace never stashes or absorbs them automatically.

## Logical paths, canonical paths, and symlinks

Root policy may declare aliases, for example:

```text
/home/ubuntu/projects -> /srv/pool/projects
```

DevSpace preserves the logical alias for display and shell `PWD`, while file operations authorize the canonical target immediately before execution.

A project symlink may enter another configured root if that root grants the requested access. A link into an undeclared target is rejected by file tools. Shell and terminal commands are not confined by file-root policy.

## Global, project, and nested instructions

When a workspace opens, DevSpace first loads the configured global instruction file, defaulting to `~/.devspace/AGENTS.md` when that file exists. It then loads the first matching root-level project instruction file:

- `AGENTS.md`
- `AGENTS.MD`
- `CLAUDE.md`
- `CLAUDE.MD`

The global file is DevSpace-owned context and is independent of `DEVSPACE_AGENT_DIR`. Project instructions therefore override or specialize the global operating guidance naturally through their later, more specific context. Nested instruction files are returned as `availableAgentsFiles`; read the relevant file before working under that directory.

Skills are enabled by default and discovered from:

- `DEVSPACE_AGENT_DIR`, defaulting to `~/.codex`, for skill discovery only
- project `.pi/skills`
- optional paths from `DEVSPACE_SKILL_PATHS`

Read an advertised `SKILL.md` before using the skill. Skill reads receive the same canonical symlink checks as workspace reads.

## File and shell tools

Use structured read/edit/write/search tools when they fit the job. Use the shell tool for bounded non-interactive commands such as quick tests/builds, package-manager operations, Git, environment checks, and system inspection. Prefer persistent terminals for installers, substantial builds, upgrades, long test suites, interactive programs, or anything that should survive an MCP/network interruption.

Shell mode can be `service` or `login`. Service mode is the normal predictable non-login executor: DevSpace augments the inherited `PATH` with conventional user-tool locations so Bun, mise, OpenCode, Cargo, uv, npm, and similar tools work without sourcing shell startup files. Use login mode only when a command genuinely depends on login-shell profile semantics.

DevSpace strips its own OAuth and configured node-bearer environment variables from child shells and terminals. Ordinary user development variables remain available.

The shell is not confined by workspace root policy and may be root-capable according to host sudo policy. The `open_workspace` and `workspace_status` responses report that capability explicitly.

## Persistent terminals

Use persistent terminal tools for interactive work and for any process whose lifetime should not be coupled to one MCP request. This is the preferred path for installers, substantial builds, upgrades, long test suites, and remote work over unreliable links:

1. `terminal_start`
2. `terminal_write`
3. `terminal_read`
4. `terminal_resize`
5. `terminal_status`
6. `terminal_close`

Example:

```json
{
  "workspaceId": "...",
  "command": "opencode --mini --no-replay",
  "cols": 160,
  "rows": 50
}
```

Terminal IDs are opaque and bound to one workspace and machine. DevSpace uses an explicit private tmux socket rather than the default `/tmp` socket. When the user systemd manager is usable and enabled, the tmux owner can survive a DevSpace restart; otherwise the terminal reports service-lifetime persistence.

Remote gateway/node calls also support transport-resumable execution when both sides advertise that capability. Each remote execute call gets a gateway-generated operation UUID because MCP JSON-RPC IDs are session-scoped and may repeat. The gateway may reattach after a transient Saga-to-node tunnel failure by replaying that exact operation UUID and node instance ID, while the node executes the operation UUID at most once. If the node itself restarted during uncertainty, the stale instance ID fails closed instead of replaying into the new process. Completed outcomes remain replayable for a bounded window and then degrade to lightweight deduplication tombstones so late uncertain retries are rejected rather than re-executed. Upstream MCP caller cancellation and the remote execution deadline both trigger best-effort cancellation. Older gateway/node pairs keep the legacy one-shot, disconnect-cancels semantics during rolling upgrades.

That request-ID replay is transport resilience, not process persistence across a node restart. Use `terminal_start` when the process itself must outlive the MCP request or unreliable connectivity.

Text is sent literally, control keys are separate, captures are bounded, and terminal escape sequences are rendered as text rather than trusted HTML.

## Review changes

Review checkpoints live under DevSpace state, not in `refs/devspace/*` or the user repository's object database. This allows `show_changes` to work with read-only source Git metadata and allows its baseline to survive an executor restart.

With `DEVSPACE_WIDGETS=changes`, call `show_changes` after a coherent group of edits. Use `since: "workspace_open"` for the full workspace-session delta or the default for changes since the last shown checkpoint.

## Close the workspace

Call `close_workspace` when the workstream is complete. It:

- closes non-retained terminals
- refuses final closure while `retainOnWorkspaceClose` terminals remain active, listing their IDs
- removes shadow review state once closure can complete
- closes workspace metadata
- removes a clean managed worktree or clone
- retains dirty managed work and reports its exact path
- expires the gateway binding

Dirty isolated work is never deleted silently.

## Tool names

Short names remain the default for core file and shell tools:

- `open_workspace`
- `workspace_status`
- `close_workspace`
- `read`
- `write`
- `edit`
- `bash`
- terminal tools
- `show_changes` when enabled

Legacy names remain available for the original file/search/shell tools with `DEVSPACE_TOOL_NAMING=legacy`. Lifecycle and terminal tools keep their canonical names.
