// Shared orchestrator scenarios (S1–S7) for the T3 Code bridge.
//
// Each scenario drives DevSpace's exposed T3 tools the way a ChatGPT-like
// orchestrator would, through an MCP SDK client connected to DevSpace /mcp.
// The same code runs against the fake T3 (end-to-end suite), the real T3 on
// this machine (live suite), and the deployed gateway (deployed suite), so it
// relies only on DevSpace's shaped tool results, never on T3 internals.

import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export type ScenarioTargetKind = "fake" | "live" | "deployed";

export interface ScenarioContext {
  kind: ScenarioTargetKind;
  client: Client;
  stamp: string;
  projectName: string;
  modelSelection?: { instanceId: string; model: string };
  timeoutMs: number;
}

export interface Scenario {
  id: string;
  title: string;
  targets: ScenarioTargetKind[];
  run(ctx: ScenarioContext): Promise<Record<string, unknown>>;
}

export interface ScenarioResult {
  id: string;
  ok: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

// The fake T3 parses these exact forms; keep them stable.
export const SCENARIO_PROMPTS: {
  reply(word: string): string;
  ask(question: string, first: string, second: string): string;
  sleep(seconds: number): string;
} = {
  reply: (word) => `Reply with exactly ${word}`,
  ask: (question, first, second) =>
    `Use your AskUserQuestion tool to ask me exactly one question, '${question}', with exactly two options: '${first}' and '${second}'. After I answer, reply with only the option I picked, in lowercase, and nothing else.`,
  sleep: (seconds) =>
    `Run exactly this shell command in the foreground and wait for it to exit: python3 -c 'import time; time.sleep(${seconds})'. Then reply with exactly DONE.`,
};

type T3ToolName =
  | "t3_project_list"
  | "t3_thread_search"
  | "t3_thread_list"
  | "t3_thread_read"
  | "t3_thread_wait"
  | "t3_inbox"
  | "t3_thread_launch"
  | "t3_thread_send"
  | "t3_thread_interrupt"
  | "t3_pending_request"
  | "t3_thread_organize"
  | "t3_queue";

// DevSpace's shaped results (plan 015, "Result shaping", "Reading", "t3_inbox").
interface ProjectRow { projectId: string; title: string; workspaceRoot: string }
interface ProjectListResult { projects: ProjectRow[]; nextCursor?: number | null }
interface ThreadRow { threadId: string; project?: string; title: string; status: string; settled: boolean; updatedAt: string; link: string }
interface ThreadListResult { threads: ThreadRow[]; nextCursor?: number | null; total?: number }
interface SearchMatch { threadId: string; project?: string; title: string; source?: string; link: string }
interface SearchResult { matches: SearchMatch[] }
interface ThreadSummary {
  threadId: string; project?: string; title: string; status: string; runtimeMode: string;
  pendingRequestCount: number; settled: boolean; archived: boolean; link: string;
}
interface ThreadItem { position: number; itemId: string; type: string; createdBy?: string; text?: string | null; updatedAt?: string }
interface ThreadReadResult { thread: ThreadSummary; items: ThreadItem[]; olderAvailable?: boolean }
interface LaunchResult { threadId: string; link: string; projectId?: string; runId?: string; status?: string }
interface WaitResult { threadId: string; runId?: string | null; status: string; timedOut: boolean }
interface SendResult { threadId: string; runId?: string; status?: string; delivery: string }
interface InterruptResult { threadId: string; runId?: string | null; status: string }
interface InboxNeedsYou {
  threadId: string; project?: string; title: string; link: string; kind: string;
  requestId?: string; questionId?: string; question?: string; options?: string[]; updatedAt: string;
}
interface InboxNew { threadId: string; project?: string; title: string; link: string; outcome: string; updatedAt: string; preview?: string }
interface InboxResult {
  needsYou: InboxNeedsYou[]; needsYouIncomplete: boolean; uninspected?: number; new: InboxNew[]; omitted: number;
  counts: { running: number; unsettledBacklog: number }; since: string; checkedAt: string;
}
interface PendingQuestion { id: string; header?: string; question: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }
interface PendingRequestRead { requestId: string; questions: PendingQuestion[] }
interface QueueItem { queuedRunId: string; text: string; truncated?: boolean }
interface QueueListResult { items: QueueItem[]; nextCursor?: number | null }

interface ScenarioRun {
  ctx: ScenarioContext;
  id: string;
  deadline: number;
  launched: string[];
  archived: Set<string>;
}

const ALL_TARGETS: readonly ScenarioTargetKind[] = ["fake", "live", "deployed"];
const NON_DEPLOYED_TARGETS: readonly ScenarioTargetKind[] = ["fake", "live"];
const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const COMPACT_ROW_KEYS = ["link", "project", "settled", "status", "threadId", "title", "updatedAt"];
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const REQUEST_TIMEOUT_MS = 90_000;
const WAIT_SLICE_MS = 20_000;
const CLEANUP_WAIT_MS = 10_000;
const FAKE_POLL_MS = 25;
const REAL_POLL_MS = 2_000;
// Inbox cursors are taken slightly before launch so clock granularity cannot hide the thread.
const SINCE_MARGIN_MS = 2_000;
const SLEEP_SECONDS = 60;
const STEER_MESSAGE = "No change; keep waiting for the command to finish.";
const INTERRUPT_REASON = "DevSpace bridge check";

function threadTitle(ctx: ScenarioContext, id: string): string {
  return `DevSpace bridge check ${ctx.stamp} ${id}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") return block.text;
  }
  return undefined;
}

async function callTool<T>(ctx: ScenarioContext, name: T3ToolName, args: Record<string, unknown>): Promise<T> {
  const result: Record<string, unknown> = await ctx.client.callTool({ name, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT_MS });
  const text = firstText(result.content);
  if (result.isError === true) throw new Error(`${name} failed: ${text ?? "(no error text)"}`);
  if (isRecord(result.structuredContent)) return result.structuredContent as T;
  if (text === undefined) throw new Error(`${name} returned neither structured content nor text`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${name} returned non-JSON text: ${text.slice(0, 200)}`);
  }
  if (!isRecord(parsed)) throw new Error(`${name} returned JSON that is not an object`);
  return parsed as T;
}

function assertIsoTimestamp(value: unknown, label: string): void {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.match(value as string, ISO_TIMESTAMP, `${label} must be an ISO-8601 timestamp`);
  assert.ok(!Number.isNaN(Date.parse(value as string)), `${label} must parse as a date`);
}

function assertCount(value: unknown, label: string): void {
  assert.equal(typeof value, "number", `${label} must be a number`);
  assert.ok(Number.isInteger(value) && (value as number) >= 0, `${label} must be a non-negative integer`);
}

function sinceJustBefore(): string {
  return new Date(Date.now() - SINCE_MARGIN_MS).toISOString();
}

async function pollUntil<T>(run: ScenarioRun, label: string | (() => string), probe: () => Promise<T | undefined>): Promise<T> {
  const interval = run.ctx.kind === "fake" ? FAKE_POLL_MS : REAL_POLL_MS;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() + interval > run.deadline) {
      throw new Error(`${run.id} timed out after ${run.ctx.timeoutMs} ms waiting for ${typeof label === "string" ? label : label()}`);
    }
    await delay(interval);
  }
}

async function readThread(ctx: ScenarioContext, threadId: string, limit?: number): Promise<ThreadReadResult> {
  const result = await callTool<ThreadReadResult>(ctx, "t3_thread_read", limit === undefined ? { threadId } : { threadId, limit });
  assert.ok(isRecord(result.thread), "t3_thread_read must return a thread summary");
  assert.ok(Array.isArray(result.items), "t3_thread_read must return an items array");
  return result;
}

async function readInbox(ctx: ScenarioContext, args: { since?: string; limit?: number } = {}): Promise<InboxResult> {
  const result = await callTool<InboxResult>(ctx, "t3_inbox", args);
  assert.ok(Array.isArray(result.needsYou), "t3_inbox must return a needsYou array");
  assert.ok(Array.isArray(result.new), "t3_inbox must return a new array");
  assert.ok(isRecord(result.counts), "t3_inbox must return counts");
  return result;
}

async function organize(ctx: ScenarioContext, threadId: string, action: "settle" | "archive"): Promise<void> {
  await callTool<Record<string, unknown>>(ctx, "t3_thread_organize", { threadId, action });
}

async function settleThenArchive(run: ScenarioRun, threadId: string): Promise<void> {
  await organize(run.ctx, threadId, "settle");
  await organize(run.ctx, threadId, "archive");
  run.archived.add(threadId);
}

async function launch(run: ScenarioRun, message: string, placement: { projectId: string } | { scratch: true } = { scratch: true }): Promise<LaunchResult> {
  const { ctx } = run;
  const result = await callTool<LaunchResult>(ctx, "t3_thread_launch", {
    ...placement,
    title: threadTitle(ctx, run.id),
    message,
    ...(ctx.modelSelection ? { modelSelection: ctx.modelSelection } : {}),
  });
  assert.equal(typeof result.threadId, "string", "t3_thread_launch must return a threadId");
  run.launched.push(result.threadId);
  assert.equal(typeof result.link, "string", "t3_thread_launch must return a link");
  return result;
}

// Loops bounded t3_thread_wait calls until the run stops or the scenario deadline passes.
async function waitForRun(run: ScenarioRun, threadId: string): Promise<WaitResult> {
  for (;;) {
    const remaining = run.deadline - Date.now();
    if (remaining <= 0) throw new Error(`${run.id} timed out after ${run.ctx.timeoutMs} ms waiting for thread ${threadId} to finish`);
    const timeoutMs = Math.min(WAIT_SLICE_MS, Math.max(1_000, remaining));
    const result = await callTool<WaitResult>(run.ctx, "t3_thread_wait", { threadId, timeoutMs });
    assert.equal(typeof result.timedOut, "boolean", "t3_thread_wait must return timedOut");
    if (!result.timedOut) return result;
  }
}

async function waitForStatus(run: ScenarioRun, threadId: string, wanted: string): Promise<ThreadSummary> {
  let last = "unknown";
  return pollUntil(run, () => `thread ${threadId} to reach status ${wanted} (last ${last})`, async () => {
    const { thread } = await readThread(run.ctx, threadId, 1);
    last = thread.status;
    if (thread.status === wanted) return thread;
    if (!ACTIVE_STATUSES.has(thread.status)) {
      throw new Error(`thread ${threadId} ended with status ${thread.status} before reaching ${wanted}`);
    }
    return undefined;
  });
}

async function waitForEnd(run: ScenarioRun, threadId: string): Promise<ThreadSummary> {
  let last = "unknown";
  return pollUntil(run, () => `thread ${threadId} to stop (last ${last})`, async () => {
    const { thread } = await readThread(run.ctx, threadId, 1);
    last = thread.status;
    return ACTIVE_STATUSES.has(thread.status) ? undefined : thread;
  });
}

function lastAssistantText(read: ThreadReadResult): string | undefined {
  const item = [...read.items].reverse().find((entry) => entry.type === "assistant_message");
  return item?.text?.trim();
}

async function findProject(ctx: ScenarioContext, name: string): Promise<ProjectRow> {
  const wanted = name.toLowerCase();
  let cursor: number | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await callTool<ProjectListResult>(ctx, "t3_project_list", cursor === undefined ? {} : { cursor });
    assert.ok(Array.isArray(result.projects), "t3_project_list must return a projects array");
    const found = result.projects.find((project) => typeof project.title === "string" && project.title.toLowerCase() === wanted);
    if (found) return found;
    if (typeof result.nextCursor !== "number") break;
    cursor = result.nextCursor;
  }
  assert.fail(`No T3 project titled "${name}"`);
}

// Settles and archives one thread, stopping it first when it is still active.
// Returns false when the thread was already archived.
async function settleAndArchive(ctx: ScenarioContext, threadId: string): Promise<boolean> {
  const { thread } = await readThread(ctx, threadId, 1);
  if (thread.archived === true) return false;
  if (ACTIVE_STATUSES.has(thread.status)) {
    try {
      await callTool<InterruptResult>(ctx, "t3_thread_interrupt", { threadId, reason: INTERRUPT_REASON });
      await callTool<WaitResult>(ctx, "t3_thread_wait", { threadId, timeoutMs: CLEANUP_WAIT_MS });
    } catch {
      // Archiving below is what matters; a failed stop must not block it.
    }
  }
  if (thread.settled !== true) await organize(ctx, threadId, "settle");
  await organize(ctx, threadId, "archive");
  return true;
}

async function cleanupLaunched(run: ScenarioRun): Promise<string[]> {
  const failures: string[] = [];
  for (const threadId of run.launched) {
    if (run.archived.has(threadId)) continue;
    try {
      await settleAndArchive(run.ctx, threadId);
      run.archived.add(threadId);
    } catch (error) {
      failures.push(`${threadId}: ${describeError(error)}`);
    }
  }
  return failures;
}

async function cleanupMatching(ctx: ScenarioContext, query: string, matchesTitle: (title: string) => boolean): Promise<number> {
  const result = await callTool<SearchResult>(ctx, "t3_thread_search", { query, limit: 50 });
  assert.ok(Array.isArray(result.matches), "t3_thread_search must return a matches array");
  const threadIds = [...new Set(result.matches.filter((match) => typeof match.title === "string" && matchesTitle(match.title)).map((match) => match.threadId))];
  const failures: string[] = [];
  let archived = 0;
  for (const threadId of threadIds) {
    try {
      if (await settleAndArchive(ctx, threadId)) archived += 1;
    } catch (error) {
      failures.push(`${threadId}: ${describeError(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`Could not settle and archive ${failures.length} thread(s): ${failures.join("; ")}`);
  return archived;
}

// Wraps a scenario body so every thread it launched is settled and archived
// afterwards, whether the body passed or failed.
function tracked(id: string, body: (run: ScenarioRun) => Promise<Record<string, unknown>>): (ctx: ScenarioContext) => Promise<Record<string, unknown>> {
  return async (ctx) => {
    const run: ScenarioRun = { ctx, id, deadline: Date.now() + ctx.timeoutMs, launched: [], archived: new Set() };
    let details: Record<string, unknown>;
    try {
      details = await body(run);
    } catch (error) {
      await cleanupLaunched(run);
      throw error;
    }
    const failures = await cleanupLaunched(run);
    if (failures.length > 0) throw new Error(`${id} could not settle and archive its threads: ${failures.join("; ")}`);
    return details;
  };
}

// S1: "What's going on?"
async function inboxOverview(run: ScenarioRun): Promise<Record<string, unknown>> {
  const inbox = await readInbox(run.ctx);
  assert.equal(typeof inbox.needsYouIncomplete, "boolean", "needsYouIncomplete must be a boolean");
  if (inbox.needsYouIncomplete) assertCount(inbox.uninspected, "uninspected");
  assertCount(inbox.omitted, "omitted");
  assertCount(inbox.counts.running, "counts.running");
  assertCount(inbox.counts.unsettledBacklog, "counts.unsettledBacklog");
  assertIsoTimestamp(inbox.checkedAt, "checkedAt");
  assertIsoTimestamp(inbox.since, "since");
  return {
    needsYou: inbox.needsYou.length, needsYouIncomplete: inbox.needsYouIncomplete, new: inbox.new.length, omitted: inbox.omitted,
    counts: inbox.counts, since: inbox.since, checkedAt: inbox.checkedAt,
  };
}

// S2: find a thread by title, read its latest messages, see it in the recent list.
async function findAndRead(run: ScenarioRun): Promise<Record<string, unknown>> {
  const { ctx } = run;
  const launched = await launch(run, SCENARIO_PROMPTS.reply("OK"));
  const threadId = launched.threadId;
  const wait = await waitForRun(run, threadId);

  const query = `${ctx.stamp} ${run.id}`;
  const match = await pollUntil(run, `t3_thread_search "${query}" to find ${threadId}`, async () => {
    const result = await callTool<SearchResult>(ctx, "t3_thread_search", { query });
    assert.ok(Array.isArray(result.matches), "t3_thread_search must return a matches array");
    return result.matches.find((entry) => entry.threadId === threadId);
  });
  assert.equal(match.title, threadTitle(ctx, run.id));
  assert.ok(typeof match.project === "string" && match.project.length > 0, "search match must carry the project title");
  assert.ok(typeof match.link === "string" && match.link.length > 0, "search match must carry a link");

  const read = await readThread(ctx, threadId);
  assert.equal(read.thread.threadId, threadId);
  assert.ok(read.items.length > 0, "t3_thread_read must return the latest items");
  const last = read.items[read.items.length - 1];
  assert.equal(last.type, "assistant_message", "the latest item must be the assistant reply");
  assert.equal(last.text?.trim(), "OK");

  const list = await callTool<ThreadListResult>(ctx, "t3_thread_list", {});
  assert.ok(Array.isArray(list.threads), "t3_thread_list must return a threads array");
  const row = list.threads.find((entry) => entry.threadId === threadId);
  assert.ok(row, `t3_thread_list must include ${threadId}`);
  assert.deepEqual(Object.keys(row).sort(), COMPACT_ROW_KEYS, "t3_thread_list rows must carry compact fields only");

  return {
    threadId, link: launched.link, waitStatus: wait.status, project: match.project, source: match.source,
    itemCount: read.items.length, olderAvailable: read.olderAvailable, listedStatus: row.status,
  };
}

// S3: start work in a project named by voice, then settle and archive it.
async function projectLifecycle(run: ScenarioRun): Promise<Record<string, unknown>> {
  const { ctx } = run;
  const project = await findProject(ctx, ctx.projectName);
  assert.equal(typeof project.projectId, "string", "project rows must carry projectId");

  const launched = await launch(run, SCENARIO_PROMPTS.reply("OK"), { projectId: project.projectId });
  const threadId = launched.threadId;
  assert.ok(launched.link.length > 0, "t3_thread_launch must return a non-empty link");
  const wait = await waitForRun(run, threadId);

  const read = await readThread(ctx, threadId);
  assert.equal(read.thread.runtimeMode, "full-access");
  assert.equal(read.thread.project?.toLowerCase(), ctx.projectName.toLowerCase(), "thread summary must name the resolved project");
  assert.equal(lastAssistantText(read), "OK");

  await settleThenArchive(run, threadId);
  const list = await callTool<ThreadListResult>(ctx, "t3_thread_list", {});
  assert.ok(Array.isArray(list.threads), "t3_thread_list must return a threads array");
  assert.ok(!list.threads.some((entry) => entry.threadId === threadId), "an archived thread must not be listed");

  return {
    projectId: project.projectId, project: project.title, threadId, link: launched.link,
    waitStatus: wait.status, finalStatus: read.thread.status, runtimeMode: read.thread.runtimeMode,
  };
}

// S4: steer a long-running turn, interrupt it, and see it stopped in the inbox.
async function steerAndInterrupt(run: ScenarioRun): Promise<Record<string, unknown>> {
  const { ctx } = run;
  const since = sinceJustBefore();
  const launched = await launch(run, SCENARIO_PROMPTS.sleep(SLEEP_SECONDS));
  const threadId = launched.threadId;
  await waitForStatus(run, threadId, "running");

  const steer = await callTool<SendResult>(ctx, "t3_thread_send", { threadId, message: STEER_MESSAGE, mode: "steer" });
  assert.equal(steer.delivery, "steered");
  const interrupt = await callTool<InterruptResult>(ctx, "t3_thread_interrupt", { threadId, reason: INTERRUPT_REASON });
  assert.equal(interrupt.status, "interrupt_requested");
  const wait = await waitForRun(run, threadId);
  const final = await waitForEnd(run, threadId);
  // Real T3 ends an interrupted turn as `interrupted` or `cancelled` depending on timing; both are "stopped".
  assert.ok(final.status === "interrupted" || final.status === "cancelled", `interrupted thread ends stopped, got ${String(final.status)}`);

  const inbox = await readInbox(ctx, { since, limit: 20 });
  const entry = inbox.new.find((item) => item.threadId === threadId);
  assert.ok(entry, `t3_inbox (since ${since}) must list ${threadId} in new`);
  assert.equal(entry.outcome, "stopped");

  return {
    threadId, link: launched.link, since, delivery: steer.delivery, interruptStatus: interrupt.status,
    waitStatus: wait.status, finalStatus: final.status, inboxOutcome: entry.outcome,
  };
}

// S5: the agent asks a question; the inbox surfaces it; the orchestrator answers it.
async function answerQuestion(run: ScenarioRun): Promise<Record<string, unknown>> {
  const { ctx } = run;
  const questionText = "Pick a color";
  const launched = await launch(run, SCENARIO_PROMPTS.ask(questionText, "red", "blue"));
  const threadId = launched.threadId;

  const pending = await pollUntil(run, `t3_inbox to list a question from ${threadId}`, async () => {
    const inbox = await readInbox(ctx);
    if (inbox.new.some((item) => item.threadId === threadId)) {
      throw new Error(`thread ${threadId} finished without asking a question`);
    }
    return inbox.needsYou.find((item) => item.threadId === threadId && item.kind === "question");
  });
  assert.equal(pending.question, questionText);
  assert.ok(Array.isArray(pending.options), "a question must carry its option labels");
  assert.ok(pending.options.includes("red") && pending.options.includes("blue"), `options must include red and blue, got ${JSON.stringify(pending.options)}`);
  assert.ok(typeof pending.requestId === "string" && pending.requestId.length > 0, "a question must carry its requestId");
  assert.ok(typeof pending.questionId === "string" && pending.questionId.length > 0, "a question must carry its questionId");
  const { requestId, questionId } = pending;

  const request = await callTool<PendingRequestRead>(ctx, "t3_pending_request", { action: "read", threadId, requestId });
  assert.ok(Array.isArray(request.questions), "t3_pending_request read must return questions");
  const question = request.questions.find((entry) => entry.id === questionId);
  assert.ok(question, `t3_pending_request read must include question ${questionId}`);
  assert.equal(question.question, questionText);
  const labels = question.options.map((option) => option.label);
  assert.ok(labels.includes("red") && labels.includes("blue"), `question options must include red and blue, got ${JSON.stringify(labels)}`);

  await callTool<Record<string, unknown>>(ctx, "t3_pending_request", { action: "respond", threadId, requestId, answers: { [questionId]: "red" } });
  const wait = await waitForRun(run, threadId);
  const read = await readThread(ctx, threadId);
  assert.equal(lastAssistantText(read), "red");

  return { threadId, link: launched.link, requestId, questionId, options: pending.options, waitStatus: wait.status, finalStatus: read.thread.status };
}

// S6: queue a message on a running turn, then list, read, edit, and cancel it.
async function editQueue(run: ScenarioRun): Promise<Record<string, unknown>> {
  const { ctx } = run;
  // Queued texts are harmless prompts in case one ever runs.
  const queuedText = SCENARIO_PROMPTS.reply("QUEUED");
  const editedText = SCENARIO_PROMPTS.reply("EDITED");
  const launched = await launch(run, SCENARIO_PROMPTS.sleep(SLEEP_SECONDS));
  const threadId = launched.threadId;
  await waitForStatus(run, threadId, "running");

  const send = await callTool<SendResult>(ctx, "t3_thread_send", { threadId, message: queuedText, mode: "queue" });
  const listed = await callTool<QueueListResult>(ctx, "t3_queue", { action: "list", threadId });
  assert.ok(Array.isArray(listed.items), "t3_queue list must return an items array");
  const queued = listed.items.find((item) => item.text === queuedText);
  assert.ok(queued, `t3_queue list must show the queued message (send delivery: ${send.delivery})`);
  const { queuedRunId } = queued;

  const readBack = await callTool<QueueItem>(ctx, "t3_queue", { action: "read", threadId, queuedRunId });
  assert.equal(readBack.text, queuedText);

  await callTool<Record<string, unknown>>(ctx, "t3_queue", { action: "edit", threadId, queuedRunId, text: editedText });
  const afterEdit = await callTool<QueueListResult>(ctx, "t3_queue", { action: "list", threadId });
  assert.ok(Array.isArray(afterEdit.items), "t3_queue list must return an items array");
  assert.equal(afterEdit.items.find((item) => item.queuedRunId === queuedRunId)?.text, editedText, "t3_queue list must show the edited text");

  await callTool<Record<string, unknown>>(ctx, "t3_queue", { action: "cancel", threadId, queuedRunId });
  const afterCancel = await callTool<QueueListResult>(ctx, "t3_queue", { action: "list", threadId });
  assert.ok(Array.isArray(afterCancel.items), "t3_queue list must return an items array");
  assert.equal(afterCancel.items.length, 0, "the queue must be empty after cancel");

  const interrupt = await callTool<InterruptResult>(ctx, "t3_thread_interrupt", { threadId, reason: INTERRUPT_REASON });
  const wait = await waitForRun(run, threadId);
  const final = await waitForEnd(run, threadId);

  return {
    threadId, link: launched.link, delivery: send.delivery, queuedRunId,
    interruptStatus: interrupt.status, waitStatus: wait.status, finalStatus: final.status,
  };
}

// S7: scratch thread lifecycle visible in the inbox, then acknowledged by settling.
async function inboxLifecycle(run: ScenarioRun): Promise<Record<string, unknown>> {
  const { ctx } = run;
  const since = sinceJustBefore();
  const launched = await launch(run, SCENARIO_PROMPTS.reply("OK"));
  const threadId = launched.threadId;
  const wait = await waitForRun(run, threadId);

  const before = await readInbox(ctx, { since, limit: 20 });
  const entry = before.new.find((item) => item.threadId === threadId);
  assert.ok(entry, `t3_inbox (since ${since}) must list ${threadId} in new`);
  assert.equal(entry.outcome, "finished");
  assert.ok(typeof entry.preview === "string" && entry.preview.includes("OK"), `the finished entry must carry a preview containing OK, got ${JSON.stringify(entry.preview)}`);

  await organize(ctx, threadId, "settle");
  const after = await readInbox(ctx, { since, limit: 20 });
  const stillListed = after.new.some((item) => item.threadId === threadId) || after.needsYou.some((item) => item.threadId === threadId);
  assert.ok(!stillListed, "a settled thread must leave the inbox");

  await organize(ctx, threadId, "archive");
  run.archived.add(threadId);

  return { threadId, link: launched.link, since, waitStatus: wait.status, outcome: entry.outcome, preview: entry.preview };
}

export const SCENARIOS: Scenario[] = [
  { id: "S1", title: "What's going on? Check the inbox", targets: [...ALL_TARGETS], run: tracked("S1", inboxOverview) },
  { id: "S2", title: "Find a thread by title and read its latest messages", targets: [...ALL_TARGETS], run: tracked("S2", findAndRead) },
  { id: "S3", title: "Start work in a named project, wait, read, settle, archive", targets: [...ALL_TARGETS], run: tracked("S3", projectLifecycle) },
  { id: "S4", title: "Steer a long-running turn, then interrupt it", targets: [...NON_DEPLOYED_TARGETS], run: tracked("S4", steerAndInterrupt) },
  { id: "S5", title: "Answer an agent question surfaced by the inbox", targets: [...NON_DEPLOYED_TARGETS], run: tracked("S5", answerQuestion) },
  { id: "S6", title: "Queue a message on a running turn, then edit and cancel it", targets: [...NON_DEPLOYED_TARGETS], run: tracked("S6", editQueue) },
  { id: "S7", title: "Scratch thread lifecycle with inbox preview and settling", targets: [...ALL_TARGETS], run: tracked("S7", inboxLifecycle) },
];

function selectScenarios(kind: ScenarioTargetKind, ids?: string[]): Scenario[] {
  if (ids === undefined) return SCENARIOS.filter((scenario) => scenario.targets.includes(kind));
  return ids.map((id) => {
    const scenario = SCENARIOS.find((entry) => entry.id === id);
    if (!scenario) throw new Error(`Unknown scenario ${id}`);
    if (!scenario.targets.includes(kind)) throw new Error(`Scenario ${id} does not run against the ${kind} target`);
    return scenario;
  });
}

/**
 * Runs the selected scenarios (default: every scenario for ctx.kind) one after
 * another. A failing scenario is reported, not thrown, and any thread titled
 * for it is swept up so the next scenario starts clean.
 */
export async function runScenarios(ctx: ScenarioContext, ids?: string[]): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of selectScenarios(ctx.kind, ids)) {
    try {
      const details = await scenario.run(ctx);
      results.push({ id: scenario.id, ok: true, details });
    } catch (error) {
      let message = describeError(error);
      try {
        const title = threadTitle(ctx, scenario.id);
        await cleanupMatching(ctx, `${ctx.stamp} ${scenario.id}`, (candidate) => candidate === title);
      } catch (cleanupError) {
        message += ` (cleanup: ${describeError(cleanupError)})`;
      }
      results.push({ id: scenario.id, ok: false, error: message });
    }
  }
  return results;
}

/** Settles and archives every unarchived thread whose title carries ctx.stamp; returns how many it archived. */
export async function cleanupScenarioThreads(ctx: ScenarioContext): Promise<number> {
  return cleanupMatching(ctx, ctx.stamp, (title) => title.includes(ctx.stamp));
}
