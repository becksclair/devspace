# Plan 019: Stop `multi_read` from breaking the workspace activity card

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 63d6d81..HEAD -- src/ui/card-types.ts src/ui/card-types.test.ts src/ui/workspace-app.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `63d6d81`, 2026-11-11

## Why this matters

The workspace widget keeps its own list of tool names, and `multi_read` (the
batched read tool) was never added to it. The gateway records a `multi_read`
activity event for every batched read. The widget's activity poller rejects a
whole page of events if any one event names an unknown tool, shows "Workspace
activity feed is unavailable.", and retries the same page every two seconds
through the tunnel until the event leaves the server's buffer. In the gateway's
default widget mode (`workspace`) the first `multi_read` therefore breaks the
live activity card. After this plan the widget knows `multi_read`, a test
keeps the two tool lists in step, and one unknown event can no longer poison a
page.

## Current state

Files:

- `src/ui/card-types.ts` — the widget's `ToolName` union and `isToolName`.
- `src/ui/workspace-app.tsx` — the widget. Contains the activity poller, the
  page validator `isWorkspaceActivityPage`, and `toolTitle`.
- `src/ui/card-types.test.ts` — `node:test` suite, run as
  `tsx src/ui/card-types.test.ts` in the `"test"` script (already wired).
- `src/tool-contract.ts` — server-side `CANONICAL_TOOL_NAMES`; read only.

`src/ui/card-types.ts:3-27` (no `multi_read`):

```ts
export type ToolName =
  | "open_workspace"
  | "workspace_status"
  | "close_workspace"
  | "read_file"
  | "write_file"
```

`src/ui/card-types.ts:92-100` (`isToolName` repeats the same list):

```ts
export function isToolName(value: unknown): value is ToolName {
  return (
    value === "open_workspace" ||
    value === "workspace_status" ||
    value === "close_workspace" ||
    value === "read_file" ||
    value === "write_file" ||
```

`src/tool-contract.ts:5-10` (the server's list has it):

```ts
export const CANONICAL_TOOL_NAMES = [
  "open_workspace",
  "workspace_status",
  "close_workspace",
  "read_file",
  "multi_read",
```

The gateway emits the event with the real tool name
(`src/gateway-router.ts:119-122`: `this.appendActivity({ workspaceId:
publicWorkspaceId, operationId, tool, …`), and labels it "batch read"
(`src/workspace-activity.ts:63-64`).

The page validator (`src/ui/workspace-app.tsx:423-431`):

```ts
  return page.events.every((event) => {
    if (!event || typeof event !== "object") return false;
    const candidate = event as Partial<WorkspaceActivityEvent>;
    return typeof candidate.seq === "number"
      && typeof candidate.operationId === "string"
      && isToolName(candidate.tool)
      && (candidate.status === "running" || candidate.status === "success" || candidate.status === "error")
      && typeof candidate.label === "string";
  });
```

The poller throws on an invalid page before advancing its cursor
(`src/ui/workspace-app.tsx:378-381`):

```ts
      const page = getStructuredContent<WorkspaceActivityPage>(result);
      if (result.isError || !isWorkspaceActivityPage(page)) {
        throw new Error("Workspace activity feed is unavailable.");
      }
```

It stores events and advances the cursor here (`src/ui/workspace-app.tsx:390-400`):

```ts
      for (const event of page.events) {
        const existing = activityEvents.get(event.operationId);
        if (!existing || event.seq >= existing.seq) activityEvents.set(event.operationId, event);
      }
      …
      activitySeq = page.events.at(-1)?.seq ?? page.latestSeq;
```

`toolTitle` (`src/ui/workspace-app.tsx:751-778`) is an exhaustive `switch` over
`ToolName` with no `default`, so adding a union member without a case is a
type error. That is useful: let the typecheck find every place that needs a
case.

`isReadTool` (`src/ui/card-types.ts:121-123`) drives the single-file viewer
(`src/ui/heavy-payload.tsx:69`, `src/ui/workspace-app.tsx:525`). A `multi_read`
result holds several files, so `multi_read` must **not** be added to
`isReadTool`.

Conventions: `src/ui/card-types.test.ts` uses `node:test` with
`node:assert/strict`; commit style is conventional commits, for example
`fix(executor): include result text in multi_read structured output`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install (in your worktree only) | `bun install --frozen-lockfile` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| This suite | `bunx tsx src/ui/card-types.test.ts` | exit 0, all tests pass |
| Full suite (about 65 s, needs `tmux`) | `bun run test` | exit 0 |
| UI build (only in a separate worktree or clone) | `bun run build:check` | exit 0 |

Do **not** run `bun test`, `bun run build`, `bun run rebuild:local`,
`bun run test:t3-live`, or `bun run test:t3-deployed`. On the host Svartal the
checkout `/Users/rclair/projects/devspace` serves the production gateway from
its `dist/`: never run `bun run build:check` or `bun install` in that
directory. If your working directory is that path, skip the UI build gate and
say so in your report.

## Scope

**In scope** (the only files you should modify):

- `src/ui/card-types.ts`
- `src/ui/card-types.test.ts`
- `src/ui/workspace-app.tsx`
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):

- `src/tool-contract.ts`, `src/gateway-router.ts`, `src/workspace-activity.ts`
  — the server side is correct.
- `isReadTool`, `src/ui/heavy-payload.tsx`, and any new rendering for
  `multi_read` results — the generic card is enough.
- Deriving the widget's `ToolName` from `CANONICAL_TOOL_NAMES` — the widget
  also knows legacy short names (`read`, `bash`, …) and is bundled separately;
  the new test keeps the lists in step instead.

## Git workflow

- Branch: `advisor/019-workspace-card-multi-read`
- Message style: `fix(ui): recognize multi_read in the workspace card`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the failing drift test

In `src/ui/card-types.test.ts` add the import
`import { CANONICAL_TOOL_NAMES } from "../tool-contract.js";` and this test:

```ts
test("every canonical tool name is a known card tool", () => {
  for (const name of CANONICAL_TOOL_NAMES) assert.equal(isToolName(name), true, name);
});
```

**Verify (must fail before the fix)**: `bunx tsx src/ui/card-types.test.ts` →
exits non-zero; the failing assertion message is `multi_read`.

### Step 2: Teach the widget the tool name

In `src/ui/card-types.ts`:

- Add `| "multi_read"` to the `ToolName` union, directly after `| "read_file"`.
- Add `value === "multi_read" ||` to `isToolName`, directly after the
  `value === "read_file" ||` line.
- Leave `isReadTool` unchanged.

Run `bun run typecheck`. It reports the places that must handle the new
member. In `toolTitle` (`src/ui/workspace-app.tsx`) add
`case "multi_read": return "Read Files";` after the `read` cases. If the
typecheck reports another exhaustive `switch` over `ToolName`, add a
`multi_read` case there that behaves like the generic/default tools in that
function.

**Verify**: `bun run typecheck` → exit 0.
`bunx tsx src/ui/card-types.test.ts` → exit 0.

### Step 3: Make one unknown event harmless

In `src/ui/workspace-app.tsx`:

- In `isWorkspaceActivityPage`, replace `&& isToolName(candidate.tool)` with
  `&& typeof candidate.tool === "string"`.
- In the poller loop, make the `for (const event of page.events)` body skip
  events the widget cannot render, as its first statement:
  `if (!isToolName(event.tool)) continue;`

Leave the cursor line (`activitySeq = page.events.at(-1)?.seq ?? page.latestSeq;`)
as it is, so a page containing only unknown events still advances.

**Verify**:

- `grep -n "isToolName(candidate.tool)" src/ui/workspace-app.tsx` → no matches
- `grep -n "if (!isToolName(event.tool)) continue;" src/ui/workspace-app.tsx` → one match
- `bun run typecheck` → exit 0
- `bun run build:check` (separate worktree or clone only) → exit 0

### Step 4: Full suite

**Verify**: `bun run test` → exit 0.

## Test plan

- New test in `src/ui/card-types.test.ts`: every `CANONICAL_TOOL_NAMES` entry
  passes `isToolName`. It fails today on `multi_read` and will fail again
  whenever a server tool is added without updating the widget.
- The validator change in Step 3 lives in a module with DOM side effects and
  has no unit test; it is covered by the typecheck, the two `grep` checks, and
  the UI build.
- Verification: `bun run test` → exit 0.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bunx tsx src/ui/card-types.test.ts` exits 0 and includes the new test
- [ ] `bun run test` exits 0
- [ ] `grep -n '"multi_read"' src/ui/card-types.ts` returns two matches (union and `isToolName`)
- [ ] `grep -n "isToolName(candidate.tool)" src/ui/workspace-app.tsx` returns no matches
- [ ] `git status --short` lists only in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- The Step 1 test passes before Step 2.
- The typecheck after Step 2 demands changes outside `src/ui/`.
- `bun run build:check` fails in a way unrelated to these edits.

## Maintenance notes

- Adding a server tool now fails `src/ui/card-types.test.ts` until the widget
  list is updated; that is the intended reminder.
- The widget ships inside `dist/ui`, so the fix reaches users only after a
  build and a deploy, and ChatGPT may keep a cached widget until the connector
  is refreshed.
- A reviewer should look once at a real `multi_read` card in ChatGPT under
  `DEVSPACE_WIDGETS=full`: it was previously dropped and now renders with the
  generic layout. A dedicated multi-file layout was deliberately left out.
