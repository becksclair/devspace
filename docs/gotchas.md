# Troubleshooting Gotchas

This page collects the setup issues users are most likely to hit.

## `devspace` Command Not Found

Use `npx`:

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
```

If you installed globally, confirm npm's global bin directory is on `PATH`.

## Unsupported Node Version

DevSpace requires Node `>=20.12 <27`.

Check:

```bash
node --version
```

Install Node 22 LTS with your preferred version manager such as `nvm`, `fnm`, or
`mise`.

## `better-sqlite3` Could Not Load

This usually means native dependencies were installed under a different Node
runtime.

Try:

```bash
npm rebuild better-sqlite3
```

Then run:

```bash
npx @waishnav/devspace doctor
```

Release starts run a native dependency check before launching.

## Public URL Includes `/mcp`

Use the origin for setup:

```text
https://your-tunnel-host.example.com
```

Use the MCP endpoint in the client:

```text
https://your-tunnel-host.example.com/mcp
```

If you saved the wrong value:

```bash
npx @waishnav/devspace config set publicBaseUrl https://your-tunnel-host.example.com
```

## Tunnel URL Changed

Temporary tunnels often change URLs between runs.

For a one-off run:

```bash
DEVSPACE_PUBLIC_BASE_URL="https://new-tunnel.example.com" npx @waishnav/devspace serve
```

For a stable URL:

```bash
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
```

## Host Header Or 403 Problems

DevSpace derives allowed hosts from the configured public URL.

Run:

```bash
npx @waishnav/devspace doctor
```

Confirm the public URL hostname appears in allowed hosts. If you changed tunnel
URLs, update `publicBaseUrl`.

Use this only for intentional local debugging:

```bash
DEVSPACE_ALLOWED_HOSTS="*" npx @waishnav/devspace serve
```

## OAuth Redirect Host Rejected

By default, DevSpace allows redirects for:

```text
chatgpt.com
localhost
127.0.0.1
```

If another MCP client uses a different redirect host, configure:

```bash
DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS="chatgpt.com,example.com" npx @waishnav/devspace serve
```

## Owner Password Not Accepted

Make sure you are entering the Owner password from:

```text
~/.devspace/auth.json
```

To regenerate setup:

```bash
npx @waishnav/devspace init --force
```

## Unknown Or Closed `workspaceId`

Workspace metadata survives executor restart. A workspace ID becomes unusable when it was explicitly closed, expired by maintenance, its gateway binding was removed, or current canonical root policy no longer authorizes the stored path.

Call `open_workspace` again when the returned error says the workspace is unknown or closed. Do not assume a removed managed checkout still exists.

## Workspace Path Rejected

The logical entry path must be under a configured root or alias, and its canonical target must be under a root policy that grants the requested access.

Run:

```bash
npx @waishnav/devspace config get
```

Then either open a project under an allowed root or rerun setup:

```bash
npx @waishnav/devspace init --force
```

For policy JSON, verify that every alias exists and resolves to the same canonical target as its declared root. A nested symlink into an undeclared target is rejected intentionally.

## Workspace Opens Read-Only

`open_workspace` reports both logical and canonical paths, mount state, file writability, and Git metadata writability. A logical path may be under a writable-looking home directory while its canonical target is mounted read-only inside the DevSpace service namespace.

Use `workspace_status` after changing host mounts or permissions. When writable work is required, reopen with:

```json
{
  "path": "~/projects/my-project",
  "mode": "isolated"
}
```

Isolated mode uses a Git worktree when source metadata is writable and an independent clone when it is not.

## Worktree Mode Fails

Explicit worktree mode requires:

- Git installed
- the path is inside a Git repository
- the repository has at least one commit
- the requested `baseRef` resolves to a commit
- the source Git common directory is writable

Use `mode: "isolated"` when the source `.git` is read-only. Uncommitted source changes are reported but are not copied into either managed strategy.

## Missing Workspace Directory

DevSpace no longer creates a missing checkout silently. A typo fails. To create a directory intentionally, pass `create: true`; the target must be inside a read-write root policy.

## Login Shell Does Not Find User Tools

Set:

```bash
DEVSPACE_SHELL_MODE=login
```

and, when needed, an explicit `DEVSPACE_SHELL_PATH=/bin/bash`. Run `devspace doctor` to verify Bun, OpenCode, tmux, user-systemd, and sudo capability through the configured child environment.

DevSpace control-plane secrets are removed from child processes. Add future infrastructure credential names to `DEVSPACE_INFRA_SECRET_NAMES`; do not add ordinary user development credentials there.

## Persistent Terminal Is Service-Lifetime Only

Terminal status reports whether the tmux owner is expected to survive DevSpace restart. Restart persistence requires:

- `DEVSPACE_TERMINAL_USER_SYSTEMD=1`
- a usable user systemd manager
- valid `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` in the service environment

Without those conditions, terminal sessions still survive individual MCP calls but may die with the DevSpace service.

Use the terminal tools' explicit IDs rather than the default tmux socket. DevSpace uses a private configured socket.

## Remote Node Connection Drops Mid-Command

When both gateway and node advertise resumable calls, DevSpace gives each remote execute call a gateway-generated operation UUID (separate from the session-scoped MCP JSON-RPC ID) and binds it to the node's current instance ID. A transient Saga-to-node tunnel failure may reconnect and replay that exact envelope without executing the operation twice. If the node itself restarted while the result was uncertain, the old instance ID fails closed instead of replaying the mutation into the new process. An upstream MCP caller cancellation is different and triggers best-effort remote cancellation so abandoned callers do not leave orphaned commands.

Completed results remain replayable for a bounded window, after which DevSpace retains a lightweight deduplication tombstone long enough to reject uncertain late replays rather than execute them again. This protects short and bounded remote operations from flaky links, but it is not process persistence across a node restart. For installers, substantial builds, upgrades, long test suites, and anything whose process must outlive the MCP request, use `terminal_start` and inspect the terminal afterward instead of relying on one long `bash` call.

Older gateway/node pairs intentionally keep the prior one-shot, disconnect-cancels behavior until both sides support the resumable capability.

## Dirty Isolated Workspace Was Not Deleted

This is intentional. `close_workspace` and maintenance remove only clean managed work. Dirty managed checkouts are retained and their exact path is reported. Inspect, commit, copy, or delete them deliberately.

## Windows Shell Commands Fail

DevSpace shell execution requires Bash. Native PowerShell and `cmd.exe` command
execution are not supported yet.

Install Git for Windows and use Git Bash, or use WSL, MSYS2, or Cygwin Bash.

Run:

```bash
npx @waishnav/devspace doctor
```

Confirm Bash is detected.

## Skills Do Not Appear

Skills are enabled by default. Check:

```bash
DEVSPACE_SKILLS=1 npx @waishnav/devspace serve
```

DevSpace looks in:

- `DEVSPACE_AGENT_DIR`, defaulting to `~/.codex`
- project `.pi/skills`
- `DEVSPACE_SKILL_PATHS`

If a skill appears in `open_workspace`, the model must read that skill's
`SKILL.md` before reading other files inside the skill directory.

## Review Card Does Not Appear

Standalone servers default to per-tool widget cards with `DEVSPACE_WIDGETS=full`.
Gateway mode uses `DEVSPACE_WIDGETS=workspace` semantics: `open_workspace` owns one
live activity card, while later tool calls remain model-visible without spawning
new custom widgets. `DEVSPACE_WIDGETS=changes` keeps the review-oriented aggregate
card behavior. Plain MCP clients may ignore ChatGPT Apps widget metadata and only
show text results.


### Reopening a checkout returns the existing session

This is deliberate workspace hygiene, not stale routing. Repeated `open_workspace` calls for the same active checkout reuse the session and public gateway ID. Use `fresh: true` when a distinct review baseline is actually required. `worktree` and `isolated` modes always create separate managed workspaces.
