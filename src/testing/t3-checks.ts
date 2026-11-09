/**
 * Behavior checks for the T3 Code bridge (plan 015, "Behavior matrix"), shared by the unit suite
 * (calls go straight to `T3Bridge.call`) and the end-to-end suite (calls go through an MCP client
 * connected to DevSpace `/mcp`). Each check seeds the fake T3, calls DevSpace's shaped tools, and
 * asserts on the shaped results and on the arguments the fake actually received.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createT3CliRunner, T3_TOOL_NAMES, T3_UNREACHABLE_MESSAGE } from "../t3-bridge.js";
import type { FakeT3 } from "./fake-t3.js";

type Json = Record<string, unknown>;

/** Calls one DevSpace T3 tool and returns its MCP result. */
export type T3Call = (name: string, args?: Json) => Promise<CallToolResult>;

export const T3_GUIDANCE =
  "Find threads with t3_thread_search or t3_thread_list; never ask the user for IDs. Refer to threads by title and project, and give the thread link when the user may want to open it in the T3 app. Threads always run in full-access mode.";
export const CREDENTIAL_REJECTED = "T3 Code rejected DevSpace's credential.";
export const READ_ONLY_T3_TOOLS: ReadonlySet<string> = new Set([
  "t3_project_list",
  "t3_thread_search",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_wait",
  "t3_inbox",
]);
export const THREAD_REQUIRED_T3_TOOLS = ["t3_pending_request", "t3_thread_organize", "t3_queue"] as const;
export const FULL_ACCESS_SCOPES = ["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"];

const DAY_MS = 24 * 60 * 60 * 1000;
const THREAD_ROW_KEYS = ["link", "project", "settled", "status", "threadId", "title", "updatedAt"];
const SEARCH_MATCH_KEYS = ["link", "project", "source", "threadId", "title"];
const PROJECT_ROW_KEYS = ["projectId", "title", "workspaceRoot"];
const READ_THREAD_KEYS = ["archived", "link", "pendingRequestCount", "project", "runtimeMode", "settled", "status", "threadId", "title"];
const READ_ITEM_KEYS = ["createdBy", "itemId", "nextTextOffset", "position", "text", "textTruncated", "type", "updatedAt"];

const SNAPSHOT_TOOL_NAMES: string[] = (
  JSON.parse(readFileSync(new URL("./t3-tools.snapshot.json", import.meta.url), "utf8")) as { allToolNames: string[] }
).allToolNames;

// ---------------------------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------------------------

export function resultText(result: CallToolResult): string {
  const block = result.content.find((entry) => entry.type === "text");
  return block && block.type === "text" ? block.text : "";
}

export function resultData(result: CallToolResult): Json {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const parsed: unknown = JSON.parse(resultText(result));
  assert.ok(isRecord(parsed), "tool result must carry a JSON object");
  return parsed;
}

/** Calls a tool that must succeed and returns its structured result. */
export async function ok(call: T3Call, name: string, args: Json = {}): Promise<Json> {
  const result = await call(name, args);
  assert.notEqual(result.isError, true, `${name} failed: ${resultText(result)}`);
  const data = resultData(result);
  assert.deepEqual(JSON.parse(resultText(result)), data, `${name} text must carry the same JSON as structuredContent`);
  return data;
}

/** Calls a tool that must fail and returns its error text. */
export async function fails(call: T3Call, name: string, args: Json = {}): Promise<string> {
  const result = await call(name, args);
  assert.equal(result.isError, true, `${name} must fail, got ${resultText(result).slice(0, 300)}`);
  return resultText(result);
}

/** Wraps a caller so every result (and thrown error) is kept for the secret scan (B23). */
export function recordingCall(call: T3Call): { call: T3Call; outputs: string[] } {
  const outputs: string[] = [];
  return {
    outputs,
    call: async (name, args) => {
      try {
        const result = await call(name, args);
        outputs.push(JSON.stringify(result));
        return result;
      } catch (error) {
        outputs.push(error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
        throw error;
      }
    },
  };
}

/** Arguments of every fake T3 call to `tool` made after `mark` (a `fake.calls.length`). */
export function forwarded(fake: FakeT3, tool: string, mark: number): Json[] {
  return fake.calls.slice(mark).filter((entry) => entry.tool === tool).map((entry) => entry.args);
}

export function pairingCount(fake: FakeT3, label?: string): number {
  return fake.cliInvocations.filter(
    (entry) => entry.args.slice(0, 3).join(" ") === "auth pairing create" && (label === undefined || entry.args.includes(label)),
  ).length;
}

export async function waitFor(label: string, probe: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await delay(20);
  }
}

function records(value: unknown): Json[] {
  assert.ok(Array.isArray(value), "expected an array");
  return value.filter(isRecord);
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortedKeys(value: Json): string[] {
  return Object.keys(value).sort();
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------------------------
// Catalog: B2, B3, B12 (schema), B15 (schema), B17
// ---------------------------------------------------------------------------------------------

export interface CatalogTool {
  name: string;
  description?: string;
  inputSchema: Json;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
  readOnly?: boolean;
}

/**
 * B2: exactly the twelve tools (in order) beyond `baseline`, and no other snapshot tool.
 * B3: read-only per the plan's table, never destructive or open-world (when annotations are given).
 * B12/B15: launch hides `runtimeMode` and `delegatedFrom`; no `environmentId`; `threadId` required.
 * B17: descriptions end with the shared guidance and carry no in-thread phrasing.
 */
export function checkCatalog(tools: CatalogTool[], options: { baseline?: ReadonlySet<string>; live?: boolean } = {}): void {
  const baseline = options.baseline ?? new Set<string>();
  const added = tools.filter((tool) => !baseline.has(tool.name));
  assert.deepEqual(
    added.map((tool) => tool.name),
    [...T3_TOOL_NAMES],
    "exactly the twelve Phase 1 tools are exposed, in order",
  );
  const listed = new Set(tools.map((tool) => tool.name));
  for (const name of SNAPSHOT_TOOL_NAMES) {
    if (!T3_TOOL_NAMES.includes(name) && !baseline.has(name)) assert.ok(!listed.has(name), `${name} must not be exposed`);
  }

  for (const tool of added) {
    const readOnly = READ_ONLY_T3_TOOLS.has(tool.name);
    if (tool.readOnly !== undefined) assert.equal(tool.readOnly, readOnly, `${tool.name} readOnly`);
    if (tool.annotations) {
      assert.equal(tool.annotations.readOnlyHint, readOnly, `${tool.name} readOnlyHint`);
      assert.equal(tool.annotations.destructiveHint, false, `${tool.name} destructiveHint`);
      assert.equal(tool.annotations.openWorldHint, false, `${tool.name} openWorldHint`);
    }

    const description = tool.description ?? "";
    assert.ok(description.endsWith(T3_GUIDANCE), `${tool.name} description must end with the shared guidance`);
    assert.doesNotMatch(description, /this thread|\binherit|\byours\b/i, `${tool.name} description must not use in-thread phrasing`);

    if (options.live === false) continue;
    const properties = isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
    const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [];
    assert.ok(!("environmentId" in properties), `${tool.name} must not expose environmentId`);
    if ((THREAD_REQUIRED_T3_TOOLS as readonly string[]).includes(tool.name)) {
      assert.ok("threadId" in properties && required.includes("threadId"), `${tool.name} must require threadId`);
    }
    if (tool.name === "t3_thread_launch") {
      assert.ok(!("runtimeMode" in properties), "t3_thread_launch must not expose runtimeMode");
      assert.ok(!("delegatedFrom" in properties), "t3_thread_launch must not expose delegatedFrom");
      assert.ok("message" in properties && "scratch" in properties && "projectId" in properties);
    }
    if (tool.name === "t3_pending_request") {
      assert.match(description, /keyed by each question's `id` whose value is the chosen option's `label`/);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Inbox: B18, B19, B20, B21, B22
// ---------------------------------------------------------------------------------------------

/**
 * Must run on a fake with no unsettled threads, through a bridge that has not served `t3_inbox`
 * yet (the 24-hour fallback is only observable on the first call).
 */
export async function checkInbox(call: T3Call, fake: FakeT3): Promise<void> {
  // B20: 24-hour fallback on the first call.
  const first = await ok(call, "t3_inbox");
  assert.equal(Date.parse(String(first.checkedAt)) - Date.parse(String(first.since)), DAY_MS, "first cursor is 24 hours back");
  assert.ok(Math.abs(Date.parse(String(first.checkedAt)) - Date.now()) < 10_000);
  assert.deepEqual(first.needsYou, []);
  assert.equal(first.needsYouIncomplete, false);
  assert.ok(!("uninspected" in first), "uninspected appears only when needsYou is incomplete");
  assert.deepEqual(first.new, []);
  assert.equal(first.omitted, 0);
  assert.deepEqual(first.counts, { running: 0, unsettledBacklog: 0 });

  const now = Date.now();
  const { projectId } = fake.addProject({ title: "inbox-fixture" });
  const reply = (text: string) => [
    { role: "user" as const, text: "Do the thing" },
    { role: "assistant" as const, text },
  ];
  const long = (index: number) => `Result ${index}: ${"x".repeat(600)}`;

  const question = fake.addThread({ projectId, title: "Inbox question", status: "running" });
  const { requestId } = fake.addQuestion(question.threadId, { question: "Ship the release?", options: ["Ship", "Hold"] });
  const approval = fake.addThread({ projectId, title: "Inbox approval", status: "running" });
  fake.addApproval(approval.threadId);
  const running = fake.addThread({ projectId, title: "Inbox running", status: "running" });

  const finished = Array.from({ length: 6 }, (_, index) =>
    fake.addThread({ projectId, title: `Inbox finished ${index}`, messages: reply(long(index)), updatedAt: iso(now - 60_000 + index * 1_000) }),
  );
  const outcomes: Array<{ threadId: string; outcome: string }> = [
    { threadId: fake.addThread({ projectId, title: "Inbox failed", status: "failed", messages: reply("boom"), updatedAt: iso(now - 50_000) }).threadId, outcome: "failed" },
    { threadId: fake.addThread({ projectId, title: "Inbox rolled back", status: "rolled_back", updatedAt: iso(now - 49_000) }).threadId, outcome: "failed" },
    { threadId: fake.addThread({ projectId, title: "Inbox cancelled", status: "cancelled", updatedAt: iso(now - 48_000) }).threadId, outcome: "stopped" },
    { threadId: fake.addThread({ projectId, title: "Inbox interrupted", status: "interrupted", updatedAt: iso(now - 47_000) }).threadId, outcome: "stopped" },
  ];
  const backlog = fake.addThread({ projectId, title: "Inbox backlog", messages: reply("old news"), updatedAt: iso(now - 2 * DAY_MS) });
  const excluded = [
    fake.addThread({ projectId, title: "Inbox settled", messages: reply("done"), settled: true, updatedAt: iso(now - 40_000) }),
    fake.addThread({ projectId, title: "Inbox snoozed", messages: reply("later"), snoozed: true, updatedAt: iso(now - 40_000) }),
    fake.addThread({ projectId, title: "Inbox subagent", messages: reply("child"), subagent: true, updatedAt: iso(now - 40_000) }),
    fake.addThread({ projectId, title: "Inbox idle", updatedAt: iso(now - 40_000) }),
  ].map((entry) => entry.threadId);
  const archived = fake.addThread({ projectId, title: "Inbox archived", messages: reply("gone"), updatedAt: iso(now - 40_000) });
  await ok(call, "t3_thread_organize", { threadId: archived.threadId, action: "archive" });
  excluded.push(archived.threadId);

  // B18, B19, B21 with an explicit cursor.
  const since = iso(now - 10 * 60_000);
  const inbox = await ok(call, "t3_inbox", { since, limit: 20 });
  assert.equal(inbox.since, since);
  assert.equal(inbox.needsYouIncomplete, false, "every active thread was inspected");
  assert.equal(inbox.omitted, 0);
  const needsYou = records(inbox.needsYou);
  assert.equal(needsYou.length, 2, "needsYou lists the question and the approval");
  const asked = needsYou.find((entry) => entry.threadId === question.threadId);
  assert.ok(asked, "the question is listed");
  assert.deepEqual(
    { ...asked, updatedAt: undefined },
    {
      threadId: question.threadId,
      project: "inbox-fixture",
      title: "Inbox question",
      link: asked.link,
      kind: "question",
      requestId,
      questionId: "Ship the release?",
      question: "Ship the release?",
      options: ["Ship", "Hold"],
      updatedAt: undefined,
    },
  );
  assert.match(String(asked.link), /^https:\/\/app\.t3\.codes\/threads\/.+\//);
  const approved = needsYou.find((entry) => entry.threadId === approval.threadId);
  assert.ok(approved, "the approval is listed");
  assert.equal(approved.kind, "approval");
  assert.ok(!("requestId" in approved) && !("question" in approved), "an approval carries no question");

  const fresh = records(inbox.new);
  const expected = [...finished.map((entry) => ({ threadId: entry.threadId, outcome: "finished" })), ...outcomes];
  assert.deepEqual(
    fresh.map((entry) => entry.threadId).sort(),
    expected.map((entry) => entry.threadId).sort(),
    "new lists finished, failed, and stopped threads after the cursor",
  );
  for (const entry of fresh) {
    assert.equal(entry.outcome, expected.find((candidate) => candidate.threadId === entry.threadId)?.outcome);
    assert.equal(entry.project, "inbox-fixture");
  }
  const updated = fresh.map((entry) => Date.parse(String(entry.updatedAt)));
  assert.deepEqual(updated, [...updated].sort((a, b) => b - a), "new is newest first");
  const previewed = fresh.filter((entry) => "preview" in entry);
  assert.equal(previewed.length, 5, "the five newest finished items carry a preview");
  for (const entry of previewed) {
    assert.equal(entry.outcome, "finished");
    const index = finished.findIndex((candidate) => candidate.threadId === entry.threadId);
    assert.ok(index >= 1, "previews go to the newest finished items");
    assert.equal(entry.preview, long(index).slice(0, 300));
  }
  assert.equal(String(previewed[0]?.preview).length, 300);
  assert.deepEqual(inbox.counts, { running: 1, unsettledBacklog: 1 }, "counts the running thread and the backlog");
  for (const threadId of [...excluded, backlog.threadId, running.threadId]) {
    assert.ok(!fresh.some((entry) => entry.threadId === threadId), `${threadId} must not be in new`);
    assert.ok(!needsYou.some((entry) => entry.threadId === threadId), `${threadId} must not be in needsYou`);
  }

  // `limit` caps `new` and `omitted` counts the rest; invalid arguments are errors.
  const limited = await ok(call, "t3_inbox", { since, limit: 3 });
  assert.equal(records(limited.new).length, 3);
  assert.equal(limited.omitted, expected.length - 3, "omitted counts the fresh outcomes left out by limit");
  assert.match(await fails(call, "t3_inbox", { since: "yesterday afternoon" }), /ISO-8601/);
  assert.match(await fails(call, "t3_inbox", { limit: 21 }), /limit/);
  assert.match(await fails(call, "t3_inbox", { limit: 0 }), /limit/);

  // B20: the previous successful check is the cursor (its `since` is before the implicit cursor);
  // needsYou ignores the cursor (B18).
  const previous = await ok(call, "t3_inbox", { since, limit: 20 });
  const afterPrevious = await ok(call, "t3_inbox");
  assert.equal(afterPrevious.since, previous.checkedAt);
  assert.deepEqual(afterPrevious.new, []);
  assert.equal(records(afterPrevious.needsYou).length, 2);
  assert.deepEqual(afterPrevious.counts, { running: 1, unsettledBacklog: expected.length + 1 });
  const later = fake.addThread({
    projectId,
    title: "Inbox later",
    messages: reply("Fresh result"),
    updatedAt: iso(Date.parse(String(afterPrevious.checkedAt)) + 5),
  });
  const next = await ok(call, "t3_inbox");
  assert.equal(next.since, afterPrevious.checkedAt);
  assert.deepEqual(
    records(next.new).map((entry) => ({ threadId: entry.threadId, outcome: entry.outcome, preview: entry.preview })),
    [{ threadId: later.threadId, outcome: "finished", preview: "Fresh result" }],
  );

  // B22: settling removes a thread from the inbox.
  await ok(call, "t3_thread_organize", { threadId: finished[5]!.threadId, action: "settle" });
  await ok(call, "t3_thread_organize", { threadId: question.threadId, action: "settle" });
  const settled = await ok(call, "t3_inbox", { since, limit: 20 });
  assert.ok(!records(settled.new).some((entry) => entry.threadId === finished[5]!.threadId), "a settled outcome leaves new");
  assert.ok(!records(settled.needsYou).some((entry) => entry.threadId === question.threadId), "a settled question leaves needsYou");
  assert.equal(records(settled.new).length, expected.length, "only the settled outcome left (and the later one joined)");
}

/**
 * B19/B20: with the implicit cursor, outcomes left out by `limit` are counted in `omitted` and
 * listed by the next check, each exactly once; an explicit `since` neither skips outcomes already
 * listed nor moves the implicit cursor past outcomes it did not list. Archives the threads it seeds.
 */
export async function checkInboxOmitted(call: T3Call, fake: FakeT3): Promise<void> {
  // Settle the implicit cursor: a check that omits nothing moves it to its checkedAt.
  let drained = await ok(call, "t3_inbox", { limit: 20 });
  for (let attempt = 0; drained.omitted !== 0 && attempt < 10; attempt += 1) drained = await ok(call, "t3_inbox", { limit: 20 });
  assert.equal(drained.omitted, 0, "the implicit cursor settled");
  const cursor = Date.parse(String(drained.checkedAt));
  // Every later check runs after the seeded outcomes' times.
  await delay(30);
  const { projectId } = fake.addProject({ title: "omitted-fixture" });
  const seeded = Array.from({ length: 12 }, (_, index) =>
    fake.addThread({
      projectId,
      title: `Omitted outcome ${index}`,
      messages: [{ role: "user", text: "Do it" }, { role: "assistant", text: `done ${index}` }],
      updatedAt: iso(cursor + 1 + index),
    }).threadId,
  );
  const newestFirst = [...seeded].reverse();
  const ids = (data: Json) => records(data.new).map((entry) => entry.threadId);

  const first = await ok(call, "t3_inbox");
  assert.equal(first.since, drained.checkedAt);
  assert.deepEqual(ids(first), newestFirst.slice(0, 8), "the eight newest outcomes are listed (default limit 8)");
  assert.equal(first.omitted, 4, "four outcomes are omitted");

  // Explicit checks while the cursor is held: one later than the cursor that omits nothing leaves
  // the held-back outcomes for the next implicit check, and none skips outcomes already listed.
  const later = await ok(call, "t3_inbox", { since: String(first.checkedAt) });
  assert.deepEqual(later.new, []);
  assert.equal(later.omitted, 0);
  const relisted = await ok(call, "t3_inbox", { since: String(drained.checkedAt), limit: 8 });
  assert.deepEqual(ids(relisted), newestFirst.slice(0, 8), "an explicit since does not skip outcomes already listed");
  assert.equal(relisted.omitted, 4);

  const second = await ok(call, "t3_inbox");
  assert.equal(second.since, drained.checkedAt, "the cursor is held while outcomes were omitted");
  assert.deepEqual(ids(second), newestFirst.slice(8), "the next check lists the remaining four");
  assert.equal(second.omitted, 0);

  const third = await ok(call, "t3_inbox");
  assert.equal(third.since, second.checkedAt, "the cursor moves once nothing was omitted");
  assert.deepEqual(third.new, []);
  assert.equal(third.omitted, 0);

  const explicit = await ok(call, "t3_inbox", { since: String(drained.checkedAt), limit: 8 });
  assert.equal(explicit.omitted, 4);
  const fourth = await ok(call, "t3_inbox");
  assert.equal(fourth.since, third.checkedAt, "an explicit check that omitted outcomes leaves the implicit cursor alone");
  assert.deepEqual(fourth.new, []);

  for (const threadId of seeded) await ok(call, "t3_thread_organize", { threadId, action: "archive" });
}

/**
 * B18: needsYou inspects every active thread across all pages of unsettled threads, up to the 60
 * most recent; beyond that, or when the 1000-row listing cap cut the listing, it reports
 * `needsYouIncomplete`. Needs a fake with no other active threads.
 */
export async function checkInboxCompleteness(call: T3Call, fake: FakeT3): Promise<void> {
  const { projectId } = fake.addProject({ title: "completeness-fixture" });
  const now = Date.now();
  // Outcomes are excluded with a future cursor, so only needsYou and counts matter here.
  const args = { since: iso(now + DAY_MS), limit: 1 };

  // 25 active threads; the one waiting on a question is the 22nd most recent.
  for (let index = 0; index < 3; index += 1) {
    fake.addThread({ projectId, title: `Active older ${index}`, status: "running", updatedAt: iso(now - 60_000 + index) });
  }
  const waiting = fake.addThread({ projectId, title: "Active waiting", status: "running" });
  fake.addQuestion(waiting.threadId, { question: "Proceed?", options: ["Yes", "No"] });
  for (let index = 0; index < 21; index += 1) {
    fake.addThread({ projectId, title: `Active newer ${index}`, status: "running", updatedAt: iso(now + 60_000 + index) });
  }
  const waitingOnly = (data: Json) => records(data.needsYou).map((entry) => [entry.threadId, entry.kind]);
  let inbox = await ok(call, "t3_inbox", args);
  assert.deepEqual(waitingOnly(inbox), [[waiting.threadId, "question"]], "the 22nd most recent active thread is inspected");
  assert.equal(inbox.needsYouIncomplete, false);
  assert.ok(!("uninspected" in inbox));
  assert.deepEqual(inbox.counts, { running: 24, unsettledBacklog: 0 });

  // 100 newer unsettled outcomes push every active thread to the second page of the listing.
  for (let index = 0; index < 100; index += 1) {
    fake.addThread({ projectId, title: `Finished newer ${index}`, status: "completed", updatedAt: iso(now + 120_000 + index) });
  }
  inbox = await ok(call, "t3_inbox", args);
  assert.deepEqual(waitingOnly(inbox), [[waiting.threadId, "question"]], "active threads on later pages are inspected");
  assert.equal(inbox.needsYouIncomplete, false);
  assert.deepEqual(inbox.counts, { running: 24, unsettledBacklog: 100 });

  // 66 active threads: the 60 most recent are inspected and the rest are reported, not assumed.
  for (let index = 0; index < 41; index += 1) {
    fake.addThread({ projectId, title: `Active oldest ${index}`, status: "running", updatedAt: iso(now - 120_000 + index) });
  }
  inbox = await ok(call, "t3_inbox", args);
  assert.deepEqual(waitingOnly(inbox), [[waiting.threadId, "question"]]);
  assert.equal(inbox.needsYouIncomplete, true, "needsYou never claims completeness past the inspection cap");
  assert.equal(inbox.uninspected, 6);
  assert.deepEqual(inbox.counts, { running: 59, unsettledBacklog: 100 });

  // 1000 newer outcomes fill the 1000-row listing cap, so no active thread is even listed; the cut
  // listing alone makes needsYou incomplete.
  for (let index = 0; index < 1_000; index += 1) {
    fake.addThread({ projectId, title: `Finished newest ${index}`, status: "completed", updatedAt: iso(now + 240_000 + index) });
  }
  inbox = await ok(call, "t3_inbox", args);
  assert.deepEqual(inbox.needsYou, []);
  assert.equal(inbox.needsYouIncomplete, true, "needsYou never claims completeness when the listing was cut");
  assert.deepEqual(inbox.counts, { running: 0, unsettledBacklog: 1_000 });
}

// ---------------------------------------------------------------------------------------------
// Listing: B13, B16
// ---------------------------------------------------------------------------------------------

export async function checkListing(call: T3Call, fake: FakeT3): Promise<void> {
  const { projectId } = fake.addProject({ title: "listing-fixture", workspaceRoot: "/tmp/listing-fixture" });
  const top = fake.addThread({ projectId, title: "Listing top thread", messages: [{ role: "user", text: "Listing marker alpha" }] });
  const child = fake.addThread({ projectId, title: "Listing child thread", subagent: true, messages: [{ role: "user", text: "child" }] });

  // B13: defaults across projects.
  let mark = fake.calls.length;
  const all = await ok(call, "t3_thread_list");
  assert.deepEqual(forwarded(fake, "t3_thread_list", mark), [{ allProjects: true, includeSubagents: false, limit: 10 }]);
  const rows = records(all.threads);
  assert.ok(rows.length > 0 && rows.length <= 10);
  for (const row of rows) assert.deepEqual(sortedKeys(row), THREAD_ROW_KEYS, "compact list rows");
  assert.ok(!rows.some((row) => row.threadId === child.threadId), "subagent threads are left out by default");
  const topRow = rows.find((row) => row.threadId === top.threadId);
  assert.ok(topRow, "the new thread is listed");
  assert.equal(topRow.project, "listing-fixture");
  assert.match(String(topRow.link), new RegExp(`^https://app\\.t3\\.codes/threads/[^/]+/${top.threadId}$`));
  assert.equal(typeof all.total, "number");
  assert.ok("nextCursor" in all);

  // B13: an explicit project is respected; explicit options pass through.
  mark = fake.calls.length;
  const scoped = await ok(call, "t3_thread_list", { projectId });
  assert.deepEqual(forwarded(fake, "t3_thread_list", mark), [{ projectId, includeSubagents: false, limit: 10 }]);
  assert.deepEqual(records(scoped.threads).map((row) => row.threadId), [top.threadId]);
  mark = fake.calls.length;
  const withChildren = await ok(call, "t3_thread_list", { projectId, includeSubagents: true, limit: 5 });
  assert.deepEqual(forwarded(fake, "t3_thread_list", mark), [{ projectId, includeSubagents: true, limit: 5 }]);
  assert.deepEqual(records(withChildren.threads).map((row) => row.threadId).sort(), [top.threadId, child.threadId].sort());

  // B16: project titles come from a cached list that is refreshed on a miss.
  const late = fake.addProject({ title: "late-fixture" });
  const lateThread = fake.addThread({ projectId: late.projectId, title: "Late project thread", messages: [{ role: "user", text: "late" }] });
  const lateRows = records((await ok(call, "t3_thread_list", { projectId: late.projectId })).threads);
  assert.deepEqual(lateRows.map((row) => [row.threadId, row.project]), [[lateThread.threadId, "late-fixture"]]);

  // B16: compact search matches with the default limit.
  mark = fake.calls.length;
  const search = await ok(call, "t3_thread_search", { query: "Listing top" });
  assert.deepEqual(forwarded(fake, "t3_thread_search", mark), [{ query: "Listing top", limit: 8 }]);
  assert.deepEqual(sortedKeys(search), ["matches"]);
  const matches = records(search.matches);
  assert.equal(matches.length, 1);
  assert.deepEqual(sortedKeys(matches[0]!), SEARCH_MATCH_KEYS);
  assert.deepEqual(
    { ...matches[0], link: undefined },
    { threadId: top.threadId, project: "listing-fixture", title: "Listing top thread", source: "title", link: undefined },
  );
  assert.equal(matches[0]!.link, topRow.link);
  const content = records((await ok(call, "t3_thread_search", { query: "marker alpha" })).matches);
  assert.deepEqual(content.map((match) => [match.threadId, match.source]), [[top.threadId, "user"]]);

  // B16: compact project rows with the default limit; `environmentId` is never forwarded.
  mark = fake.calls.length;
  const projects = await ok(call, "t3_project_list", { environmentId: "environment-from-caller" });
  assert.deepEqual(forwarded(fake, "t3_project_list", mark), [{ limit: 50 }]);
  assert.deepEqual(sortedKeys(projects), ["nextCursor", "projects"]);
  const projectRows = records(projects.projects);
  for (const row of projectRows) assert.deepEqual(sortedKeys(row), PROJECT_ROW_KEYS);
  assert.deepEqual(
    projectRows.find((row) => row.projectId === projectId),
    { projectId, title: "listing-fixture", workspaceRoot: "/tmp/listing-fixture" },
  );
  assert.deepEqual(projectRows.find((row) => row.title === "No project")?.title, "No project");
  mark = fake.calls.length;
  const paged = await ok(call, "t3_project_list", { limit: 1, cursor: 1 });
  assert.deepEqual(forwarded(fake, "t3_project_list", mark), [{ limit: 1, cursor: 1 }]);
  assert.equal(records(paged.projects).length, 1);
  assert.equal(paged.nextCursor, 2);
}

// ---------------------------------------------------------------------------------------------
// Reading and waiting: B14
// ---------------------------------------------------------------------------------------------

export async function checkReading(call: T3Call, fake: FakeT3): Promise<void> {
  const messages = Array.from({ length: 7 }, (_, index) => [
    { role: "user" as const, text: `question ${index}` },
    { role: "assistant" as const, text: `answer ${index}` },
  ]).flat();
  const { threadId } = fake.addThread({ title: "Reading long thread", messages });

  let mark = fake.calls.length;
  const latest = await ok(call, "t3_thread_read", { threadId });
  assert.deepEqual(sortedKeys(latest), ["items", "olderAvailable", "thread"]);
  assert.deepEqual(sortedKeys(latest.thread as Json), READ_THREAD_KEYS);
  assert.deepEqual(
    { ...(latest.thread as Json), link: undefined },
    {
      threadId,
      project: "No project",
      title: "Reading long thread",
      status: "completed",
      runtimeMode: "full-access",
      pendingRequestCount: 0,
      settled: false,
      archived: false,
      link: undefined,
    },
  );
  const items = records(latest.items);
  for (const item of items) assert.deepEqual(sortedKeys(item), READ_ITEM_KEYS);
  assert.deepEqual(
    items.map((item) => item.text),
    ["question 4", "answer 4", "question 5", "answer 5", "question 6", "answer 6"],
    "the latest six messages, oldest first",
  );
  assert.deepEqual(items.map((item) => item.type), ["user_message", "assistant_message", "user_message", "assistant_message", "user_message", "assistant_message"]);
  assert.equal(latest.olderAvailable, true);
  const reads = forwarded(fake, "t3_thread_read", mark);
  assert.deepEqual(reads[0], { threadId, limit: 1, maxCharsPerItem: 1 }, "the detail read comes first");
  for (const read of reads.slice(1)) assert.equal(read.maxCharsPerItem, 1500);

  assert.deepEqual(records((await ok(call, "t3_thread_read", { threadId, limit: 2 })).items).map((item) => item.text), ["question 6", "answer 6"]);
  const everything = await ok(call, "t3_thread_read", { threadId, limit: 14 });
  assert.equal(records(everything.items).length, 14);
  assert.equal(records(everything.items)[0]!.position, 0);
  assert.equal(everything.olderAvailable, false);

  // A short thread starts at position 0; long items are cut at 1500 characters by default.
  const short = fake.addThread({ title: "Reading short thread", messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "y".repeat(2_000) }] });
  const shortRead = await ok(call, "t3_thread_read", { threadId: short.threadId });
  const shortItems = records(shortRead.items);
  assert.deepEqual(shortItems.map((item) => item.position), [0, 2]);
  assert.equal(shortRead.olderAvailable, false);
  assert.equal(String(shortItems[1]!.text).length, 1500);
  assert.equal(shortItems[1]!.textTruncated, true);
  assert.equal(shortItems[1]!.nextTextOffset, 1500);

  // The tail window widens when the latest items are mostly activity.
  const sparse = fake.addThread({
    title: "Reading sparse thread",
    messages: Array.from({ length: 30 }, (_, index) => ({ role: "assistant" as const, text: `note ${index}` })),
  });
  const sparseRead = await ok(call, "t3_thread_read", { threadId: sparse.threadId, limit: 30 });
  assert.deepEqual(records(sparseRead.items).map((item) => item.text), Array.from({ length: 30 }, (_, index) => `note ${index}`));
  assert.equal(sparseRead.olderAvailable, false);

  // Forward paging is forwarded with the same defaults.
  mark = fake.calls.length;
  const page = await ok(call, "t3_thread_read", { threadId, afterPosition: 0, limit: 2 });
  assert.deepEqual(forwarded(fake, "t3_thread_read", mark), [{ threadId, afterPosition: 0, limit: 2, maxCharsPerItem: 1500 }]);
  assert.deepEqual(records(page.items).map((item) => item.text), ["answer 0", "question 1"]);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextPosition, records(page.items)[1]!.position);
  assert.equal(page.olderAvailable, true);

  assert.match(await fails(call, "t3_thread_read", {}), /threadId/);

  // B14: waits default to 20 s and are clamped to 25 s.
  for (const [requested, expected] of [[60_000, 25_000], [undefined, 20_000], [1_500, 1_500]] as const) {
    mark = fake.calls.length;
    const waited = await ok(call, "t3_thread_wait", requested === undefined ? { threadId } : { threadId, timeoutMs: requested });
    assert.deepEqual(forwarded(fake, "t3_thread_wait", mark), [{ threadId, timeoutMs: expected }]);
    assert.equal(waited.timedOut, false);
    assert.equal(waited.status, "completed");
  }
}

// ---------------------------------------------------------------------------------------------
// Argument shaping: B12 (calls), B15
// ---------------------------------------------------------------------------------------------

export async function checkShaping(call: T3Call, fake: FakeT3): Promise<void> {
  // B12: launch always runs full-access with a clientRequestId; delegation and environment are dropped.
  const modelSelection = { instanceId: "claudeAgent", model: "claude-haiku-5-5" };
  let mark = fake.calls.length;
  const launched = await ok(call, "t3_thread_launch", {
    scratch: true,
    title: "Shaping full access",
    message: "Reply with exactly OK",
    modelSelection,
    runtimeMode: "approval-required",
    delegatedFrom: { threadId: "caller-thread" },
    environmentId: "environment-from-caller",
  });
  const [launchArgs] = forwarded(fake, "t3_thread_launch", mark);
  assert.ok(launchArgs);
  assert.equal(launchArgs.runtimeMode, "full-access");
  assert.ok(typeof launchArgs.clientRequestId === "string" && launchArgs.clientRequestId.length > 0, "clientRequestId added");
  assert.ok(!("delegatedFrom" in launchArgs) && !("environmentId" in launchArgs));
  assert.deepEqual(launchArgs.modelSelection, modelSelection);
  const threadId = String(launched.threadId);
  await ok(call, "t3_thread_wait", { threadId });
  const read = await ok(call, "t3_thread_read", { threadId });
  assert.equal((read.thread as Json).runtimeMode, "full-access");
  assert.equal(records(read.items).at(-1)?.text, "OK");

  // A caller's clientRequestId is kept; send and interrupt get one when absent.
  mark = fake.calls.length;
  await ok(call, "t3_thread_launch", { scratch: true, title: "Shaping caller id", clientRequestId: "caller-request-1" });
  assert.equal(forwarded(fake, "t3_thread_launch", mark)[0]?.clientRequestId, "caller-request-1");
  mark = fake.calls.length;
  await ok(call, "t3_thread_send", { threadId, message: "Reply with exactly AGAIN" });
  await ok(call, "t3_thread_wait", { threadId });
  await ok(call, "t3_thread_interrupt", { threadId });
  for (const tool of ["t3_thread_send", "t3_thread_interrupt"]) {
    const [args] = forwarded(fake, tool, mark);
    assert.ok(args && typeof args.clientRequestId === "string" && args.clientRequestId.length > 0, `${tool} gets a clientRequestId`);
  }

  // B15: threadId is required before anything is sent to T3.
  mark = fake.calls.length;
  for (const tool of THREAD_REQUIRED_T3_TOOLS) {
    const action = tool === "t3_thread_organize" ? "settle" : "list";
    assert.match(await fails(call, tool, { action }), /threadId/, `${tool} without threadId`);
    assert.match(await fails(call, tool, { action, threadId: "" }), /threadId/, `${tool} with an empty threadId`);
  }
  assert.equal(fake.calls.length, mark, "nothing reached T3");

  // T3's own failures pass through unchanged.
  const failure = JSON.parse(await fails(call, "t3_thread_send", { threadId, message: "steer", mode: "steer" })) as Json;
  assert.equal(failure._tag, "OrchestratorMcpFailure");
  assert.equal(failure.code, "thread_not_sendable");

  await ok(call, "t3_thread_organize", { threadId, action: "archive" });
}

// ---------------------------------------------------------------------------------------------
// Connection and credential resilience: B6, B8, B9, B10, B11
// ---------------------------------------------------------------------------------------------

/** B6: a 401 re-mints once and the call succeeds; a second 401 returns the credential error. */
export async function checkCredentialRecovery(call: T3Call, fake: FakeT3, label: string): Promise<void> {
  await ok(call, "t3_project_list");
  const before = pairingCount(fake, label);
  fake.revokeAllSessions();
  await ok(call, "t3_project_list");
  assert.equal(pairingCount(fake, label), before + 1, "one re-mint after a 401");
  assert.equal(fake.liveSessions(label), 1);

  fake.rejectCredentials(true);
  try {
    assert.equal(await fails(call, "t3_project_list"), CREDENTIAL_REJECTED);
    assert.equal(pairingCount(fake, label), before + 2, "a second 401 does not loop");
  } finally {
    fake.rejectCredentials(false);
  }
  await ok(call, "t3_project_list");
  assert.equal(pairingCount(fake, label), before + 2, "the credential minted for the retry is reused");
  assert.equal(fake.liveSessions(label), 1);
}

/** B8: T3 down keeps the tools listed and returns the unreachable error; T3 back works again. */
export async function checkUnavailable(call: T3Call, fake: FakeT3, listToolNames: () => Promise<string[]>): Promise<void> {
  await ok(call, "t3_project_list");
  await fake.setAvailable(false);
  try {
    for (const name of ["t3_project_list", "t3_thread_list", "t3_inbox"]) {
      assert.equal(await fails(call, name), T3_UNREACHABLE_MESSAGE, `${name} while T3 is down`);
    }
    assert.equal(
      await fails(call, "t3_thread_launch", { scratch: true, title: "Launched while down", message: "Reply with exactly OK" }),
      T3_UNREACHABLE_MESSAGE,
    );
    const names = await listToolNames();
    for (const name of T3_TOOL_NAMES) assert.ok(names.includes(name), `${name} stays listed while T3 is down`);
  } finally {
    await fake.setAvailable(true);
  }
  await ok(call, "t3_project_list");
  const launched = records((await ok(call, "t3_thread_search", { query: "Launched while down" })).matches);
  assert.equal(launched.length, 0, "nothing was launched while T3 was down");
}

/** B9: a T3 restart (stale MCP session, 404) reconnects transparently. */
export async function checkRestart(call: T3Call, fake: FakeT3): Promise<void> {
  await ok(call, "t3_project_list");
  await fake.restart();
  const mark = fake.calls.length;
  await ok(call, "t3_project_list");
  assert.equal(forwarded(fake, "t3_project_list", mark).length, 1, "the call ran exactly once after the restart");
}

/** B10: a dropped launch response is retried once with the same clientRequestId; one thread exists. */
export async function checkDroppedLaunch(call: T3Call, fake: FakeT3): Promise<void> {
  const title = `Dropped launch ${Date.now()}`;
  const mark = fake.calls.length;
  fake.dropNextResponse("t3_thread_launch");
  const launched = await ok(call, "t3_thread_launch", { scratch: true, title, message: "Reply with exactly OK" });
  const launches = forwarded(fake, "t3_thread_launch", mark);
  assert.equal(launches.length, 2, "the launch was retried once");
  assert.equal(launches[0]!.clientRequestId, launches[1]!.clientRequestId);
  const listed = records((await ok(call, "t3_thread_list", { titleContains: title, limit: 100 })).threads);
  assert.deepEqual(listed.map((row) => row.threadId), [launched.threadId], "exactly one thread was created");
  await ok(call, "t3_thread_wait", { threadId: launched.threadId });

  // B10: reads are idempotent, so a dropped read is retried once and succeeds.
  const reads: Array<[string, Json]> = [
    ["t3_project_list", {}],
    ["t3_thread_search", { query: title }],
    ["t3_thread_list", {}],
    ["t3_thread_read", { threadId: launched.threadId }],
    ["t3_thread_wait", { threadId: launched.threadId }],
  ];
  for (const [tool, args] of reads) {
    let readMark = fake.calls.length;
    await ok(call, tool, args);
    const sent = forwarded(fake, tool, readMark).length;
    readMark = fake.calls.length;
    fake.dropNextResponse(tool);
    await ok(call, tool, args);
    assert.equal(forwarded(fake, tool, readMark).length, sent + 1, `${tool} was retried once`);
  }
  await ok(call, "t3_thread_organize", { threadId: launched.threadId, action: "archive" });

  // B10: so are the inbox's own reads (listing, thread detail, pending-request lookups).
  const asking = fake.addThread({ title: `Dropped inbox read ${Date.now()}`, status: "running" });
  fake.addQuestion(asking.threadId, { question: "Retry the read?", options: ["Yes", "No"] });
  const inboxArgs = { since: iso(Date.now() + DAY_MS), limit: 1 };
  const inboxReads = ["t3_thread_list", "t3_thread_read", "t3_pending_request"];
  const countReads = (mark: number) => inboxReads.map((tool) => forwarded(fake, tool, mark).length);
  let inboxMark = fake.calls.length;
  await ok(call, "t3_inbox", inboxArgs);
  const baseline = countReads(inboxMark);
  for (const [index, tool] of inboxReads.entries()) {
    inboxMark = fake.calls.length;
    fake.dropNextResponse(tool);
    const inbox = await ok(call, "t3_inbox", inboxArgs);
    assert.ok(
      records(inbox.needsYou).some((entry) => entry.threadId === asking.threadId && entry.kind === "question"),
      `the inbox survives a dropped ${tool} response`,
    );
    const expected = baseline.map((count, other) => (other === index ? count + 1 : count));
    assert.deepEqual(countReads(inboxMark), expected, `the inbox retried its dropped ${tool} read once`);
  }
  await ok(call, "t3_thread_organize", { threadId: asking.threadId, action: "archive" });
}

/** B11: a non-idempotent call without clientRequestId whose response was lost is reported, never retried. */
export async function checkNoBlindRetry(call: T3Call, fake: FakeT3): Promise<void> {
  const { threadId } = fake.addThread({ title: "No blind retry", messages: [{ role: "user", text: "hello" }] });
  for (const [tool, args] of [
    ["t3_thread_organize", { threadId, action: "pin" }],
    ["t3_pending_request", { threadId, action: "list" }],
    ["t3_queue", { threadId, action: "list" }],
  ] as const) {
    const mark = fake.calls.length;
    fake.dropNextResponse(tool);
    assert.equal(await fails(call, tool, args), `T3 Code connection failed during ${tool}; it may or may not have run.`);
    assert.equal(forwarded(fake, tool, mark).length, 1, `${tool} was sent exactly once`);
  }
  await ok(call, "t3_project_list");
}

// ---------------------------------------------------------------------------------------------
// Credential and environment: B4, B23, B24
// ---------------------------------------------------------------------------------------------

/** B4: the credential came from the CLI pairing flow at full access with all four scopes. */
export async function checkFullAccessMint(fake: FakeT3, label: string, secretNames: string[]): Promise<void> {
  const pairing = fake.cliInvocations.find(
    (entry) => entry.args.slice(0, 3).join(" ") === "auth pairing create" && entry.args.includes(label),
  );
  assert.ok(pairing, "the bridge created a pairing code through the CLI");
  assert.deepEqual(pairing.args, [
    "auth", "pairing", "create", "--json", "--ttl", "2m", "--label", label,
    ...FULL_ACCESS_SCOPES.flatMap((scope) => ["--scope", scope]),
  ]);
  const sessions = JSON.parse(await createT3CliRunner(fake.cliPath, secretNames).run(["auth", "session", "list", "--json"])) as Json[];
  const own = sessions.filter((session) => isRecord(session.client) && session.client.label === label);
  assert.equal(own.length, 1, "exactly one live session carries the label");
  assert.deepEqual([...(own[0]!.scopes as string[])].sort(), [...FULL_ACCESS_SCOPES].sort());
}

/** B23: no token, pairing code, or authorization code appears in any log line or tool output. */
export function checkNoSecrets(fake: FakeT3, texts: string[]): void {
  const secrets = fake.issuedSecrets();
  assert.ok(secrets.length >= 3, "the fake issued at least a pairing code, an authorization code, and a token");
  assert.ok(texts.length > 0, "there is output to scan");
  for (const text of texts) {
    for (const secret of secrets) {
      // Never print the secret itself.
      assert.ok(!text.includes(secret), `an issued secret leaked into: ${text.slice(0, 120).replaceAll(secret, "<secret>")}`);
    }
  }
}

/** B24: CLI children never see the configured secret names (or GitHub tokens) and run as Node. */
export function checkCliEnvironment(fake: FakeT3, secretName: string): void {
  assert.ok(fake.cliInvocations.length > 0, "the CLI ran");
  for (const invocation of fake.cliInvocations) {
    assert.ok(!invocation.envNames.includes(secretName), `${secretName} must not reach the CLI`);
    assert.ok(!invocation.envNames.includes("GH_TOKEN"), "GH_TOKEN must not reach the CLI");
    assert.ok(invocation.envNames.includes("ELECTRON_RUN_AS_NODE"), "the CLI runs with ELECTRON_RUN_AS_NODE");
  }
}

/** Captures everything written through `console` (DevSpace's logger writes there). */
export function captureConsole(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = (...values: unknown[]) => {
      lines.push(values.map((value) => (typeof value === "string" ? value : JSON.stringify(value) ?? String(value))).join(" "));
    };
  }
  return {
    lines,
    restore() {
      methods.forEach((method, index) => {
        console[method] = originals[index]!;
      });
    },
  };
}
