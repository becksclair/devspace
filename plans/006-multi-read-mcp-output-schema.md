# Plan 006: Make multi_read succeed over MCP by satisfying its output schema

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 79ddffc..HEAD -- src/executor.ts src/server.ts package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `79ddffc`, 2026-11-04

## Why this matters

`multi_read` is the batch-read tool that the project's round-trip-efficiency
mandate (`AGENTS.md`) depends on. Over MCP, every call where **at least one**
file reads successfully is turned into an error by the MCP SDK:
`Output validation error: Invalid structured content for tool multi_read: Invalid input: expected string, received undefined at result`.
It only "works" when every file fails, because the SDK skips output validation
for `isError` results. This was reproduced end to end against `createServer`
at `79ddffc`. Unit tests miss it because they call `LocalExecutor` directly
and never go through the MCP server's output-schema validation.

## Current state

- `src/server.ts` — MCP tool registration and result shaping.
  - `src/server.ts:603-611` — `resultOutputSchema()` always requires a string `result`:
    ```ts
    function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
      return {
        result: z
          .string()
          .describe(
            "Model-readable result text for follow-up reasoning and plain MCP hosts.",
          ),
        ...extra,
      };
    }
    ```
  - `src/server.ts:1331` — multi_read's `outputSchema: resultOutputSchema({ results: z.array(...), totalBytes: z.number().int().optional() })`.
  - `src/server.ts:906-915` — `publicExecutorResult` passes the executor's `structuredContent` through **unchanged** for tools in `structuredTools`, which includes `"multi_read"`:
    ```ts
    const structuredTools = new Set<CanonicalToolName>([
      "open_workspace", "workspace_status", "close_workspace", "show_changes",
      "terminal_start", "terminal_read", "terminal_write", "terminal_resize", "terminal_status", "terminal_close",
      "multi_read",
    ]);
    const structuredContent = structuredTools.has(canonicalTool)
      ? executorStructured
      : canonicalTool === "edit_file"
        ? { status: "applied", result: resultText }
        : { result: resultText };
    ```
  - multi_read is the **only** tool that is both in `structuredTools` and uses `resultOutputSchema` (the others in that set declare their own schemas without `result`). Do not change the other tools.
- `src/executor.ts:535-545` — the end of `multiRead()`; `structuredContent` has no `result`:
    ```ts
    const summary = `multi_read: ${results.length} files, ${results.filter((r) => r.status === "ok").length} ok, ${results.filter((r) => r.status === "error").length} error, totalBytes=${totalBytes}`;
    const details = results.map((r) => { ... }).join("\n");
    void startedAt;
    return {
      content: [{ type: "text", text: `${summary}\n${details}` }],
      structuredContent: { results, totalBytes },
      isError: results.every((r) => r.status === "error"),
    };
    ```
- The SDK validator (`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`, `validateToolOutput`) returns early only for `isError` results; otherwise it parses `structuredContent` against the output schema.
- Gateway mode: remote nodes return the executor's result unchanged and the gateway shapes it with the same `publicExecutorResult` (via `gatewayPublicResult`), so fixing the executor fixes both standalone and gateway paths.
- Test conventions: tests are standalone `tsx` scripts using `node:assert/strict`, registered by hand in the `package.json` `"test"` script (a single `&&` chain). The HTTP/MCP test harness to copy is `src/server-mcp-routing.test.ts` (builds a full `ServerConfig` literal, seeds an OAuth access token through `SqliteOAuthStateStore`, calls `createServer(config)`, `app.listen(0)`, and posts JSON-RPC with `postMcp`/`parseSsePayload` helpers).

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `bun install --frozen-lockfile` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0, no output besides the tsc banner |
| One test  | `bunx tsx src/server-multi-read.test.ts` | exit 0 |
| All tests | `bun run test` | exit 0 (takes ~65s; needs `tmux` on PATH) |
| Build     | `bun run build:check` | exit 0 |

Do **not** run `bun run build` or `bun run rebuild:local`; they bump versions and restart services.

## Scope

**In scope** (the only files you should modify):
- `src/executor.ts` — `multiRead()` return value only
- `src/server-multi-read.test.ts` (create)
- `package.json` — append the new test file to the `"test"` script only

**Out of scope** (do NOT touch):
- `resultOutputSchema` and the output schemas of other tools — they are correct for their tools.
- multi_read truncation/budget behaviour — handled by plan 007; do not change byte limits here.
- `src/tool-contract.ts` — the input contract is unchanged; changing it alters `TOOL_CONTRACT_HASH` and breaks gateway↔node compatibility.

## Git workflow

- Branch: `advisor/006-multi-read-mcp-output-schema`
- Conventional commits matching history, e.g. `fix(executor): include result text in multi_read structured output`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing MCP-level test

Create `src/server-multi-read.test.ts` by copying the setup of `src/server-mcp-routing.test.ts`: its imports, the `config` literal with `widgets: "off"`, OAuth token seeding, `createServer`, `listen(0)`, the `postMcp`, `parseSsePayload` and `closeSession` helpers, and the `try/finally` teardown.

Create the temp tree **before** the `config` literal, because `normalizeRootPolicies` requires the directory to exist:
- `const root = await mkdtemp(join(tmpdir(), "devspace-server-multi-read-test-"));`
- `const project = join(root, "project");`, then `mkdir(project)`.

Set `allowedRoots: [root]` and `rootPolicies: normalizeRootPolicies([{ path: root, access: "read-write" }])`. Use the same `stateDir` approach as the routing test. Write two files into `project`: `a.txt` (`"alpha\n"`) and `b.txt` (`"beta\n"`). Remove `root` in the `finally`. Open the workspace with `{ path: project }`. This is the same layout as `src/executor-multi-read.test.ts`.

After initializing a session (copy the `initialize` + `notifications/initialized` sequence), add a small helper:

```ts
async function callTool(endpoint: string, sessionId: string, id: number, name: string, args: Record<string, unknown>) {
  const response = await postMcp(endpoint, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, sessionId);
  assert.equal(response.status, 200);
  return parseSsePayload(await response.text()) as { result?: { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> } };
}
```

Then assert:
1. `open_workspace` with `{ path: project }` returns a `structuredContent.workspaceId` string.
2. `multi_read` with `{ workspaceId, reads: [{ path: "a.txt" }, { path: "missing.txt" }] }`:
   - `assert.notEqual(result.isError, true, JSON.stringify(result.content))`. The message argument makes the SDK's validation text visible when this fails.
   - `structuredContent.result` is a string starting with `"multi_read: 2 files, 1 ok, 1 error"`
   - `structuredContent.results[0]` has `status: "ok"` and `content: "alpha\n"`
   - `structuredContent.results[1]` has `status: "error"`
3. `multi_read` with `{ workspaceId, reads: [{ path: "a.txt" }, { path: "b.txt" }] }` → not `isError`, two `ok` results.
4. `multi_read` with only missing files → `result.isError === true` (existing all-fail behaviour preserved).

**Verify**: `bunx tsx src/server-multi-read.test.ts` → exits non-zero at assertion 2 with an `AssertionError` whose message contains `Output validation error: Invalid structured content for tool multi_read` and `at result`. The SDK returns the validation failure as an `isError: true` tool result, not as a JSON-RPC error. Assertion 1 must pass first. If the script passes, STOP.

### Step 2: Add `result` to multi_read's structured content

In `src/executor.ts` `multiRead()`, build the text once and reuse it:

```ts
const text = `${summary}\n${details}`;
return {
  content: [{ type: "text", text }],
  structuredContent: { result: text, results, totalBytes },
  isError: results.every((r) => r.status === "error"),
};
```

**Verify**: `bunx tsx src/server-multi-read.test.ts` → exit 0.

### Step 3: Register the test and run the full gates

Append ` && tsx src/server-multi-read.test.ts` to the end of the `"test"` script in `package.json` (after `tsx src/executor-multi-read.test.ts`).

**Verify**:
- `bun run typecheck` → exit 0
- `bunx tsx src/executor-multi-read.test.ts` → exit 0 (existing unit test still passes)
- `bun run test` → exit 0
- `grep -c "server-multi-read.test.ts" package.json` → `1`

## Test plan

- New `src/server-multi-read.test.ts` (cases listed in Step 1) exercising the real MCP output-schema validation path — the gap that let this ship.
- Existing `src/executor-multi-read.test.ts` must still pass unchanged (it reads `results`/`totalBytes`, which are kept).

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0, including `src/server-multi-read.test.ts`
- [ ] `grep -n "structuredContent: { result: text, results, totalBytes }" src/executor.ts` returns one match
- [ ] `git status --porcelain -- src package.json` prints exactly three lines: ` M package.json`, ` M src/executor.ts`, `?? src/server-multi-read.test.ts` (or the committed equivalent: `git diff --name-only <base>..HEAD -- src package.json` lists those three)
- [ ] `plans/README.md` row for 006 updated

## STOP conditions

- The Step 1 test passes before the fix (the bug is already fixed or the harness is not reaching output validation).
- `publicExecutorResult` no longer passes multi_read's structured content through unchanged, or multi_read's `outputSchema` no longer uses `resultOutputSchema`.
- Any existing test fails after Step 2 and the failure is not obviously caused by the new field.
- The fix seems to require touching `src/tool-contract.ts`.

## Maintenance notes

- Any tool added to `structuredTools` in `src/server.ts` must return structured content that matches its declared `outputSchema`; the SDK enforces it only on non-error results, so an all-failure test will never catch a mismatch. Each such tool needs at least one MCP-level success-path test.
- Plan 007 changes multi_read's per-file semantics in the same function; it builds on this plan.
