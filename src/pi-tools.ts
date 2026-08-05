import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashToolInput,
  type EditToolInput,
  type EditToolDetails,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  type WriteToolInput,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { createDevspaceShellSpawnHook, type ShellRuntime } from "./shell-environment.js";

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

interface ToolContext {
  cwd: string;
  root: string;
  readRoots?: string[];
  shellRuntime?: ShellRuntime;
}

function toMcpContent(result: AgentToolResult<unknown>): McpContent[] {
  return result.content.map((content) => {
    if (content.type === "text") {
      return { type: "text", text: content.text };
    }

    return {
      type: "image",
      data: content.data,
      mimeType: content.mimeType,
    };
  });
}

function formatToolError(error: unknown): McpContent[] {
  const message = error instanceof Error ? error.message : String(error);
  return [{ type: "text", text: message }];
}

async function runTool<TInput, TDetails = unknown>(
  execute: (input: TInput, requestId: string, signal?: AbortSignal) => Promise<AgentToolResult<TDetails>>,
  input: TInput,
  _context: ToolContext,
  signal?: AbortSignal,
  requestId = "devspace",
): Promise<ToolResponse<TDetails>> {
  try {
    const result = await execute(input, requestId, signal);
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

export async function readFileTool(input: ReadToolInput, context: ToolContext, signal?: AbortSignal, requestId = "devspace"): Promise<ToolResponse> {
  const path = input.path;
  const tool = createReadTool(context.cwd);

  return runTool((params, requestId, signal) => tool.execute(requestId, params, signal), {
    path,
    offset: input.offset,
    limit: input.limit,
  }, context, signal, requestId);
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext, signal?: AbortSignal, requestId = "devspace"): Promise<ToolResponse> {
  const path = input.path;
  const tool = createWriteTool(context.cwd);

  return runTool((params, requestId, signal) => tool.execute(requestId, params, signal), {
    path,
    content: input.content,
  }, context, signal, requestId);
}

export async function editFileTool(input: EditToolInput, context: ToolContext, signal?: AbortSignal, requestId = "devspace"): Promise<ToolResponse<EditToolDetails>> {
  const path = input.path;
  const tool = createEditTool(context.cwd);

  return runTool((params, requestId, signal) => tool.execute(requestId, params, signal), {
    path,
    edits: input.edits,
  }, context, signal, requestId);
}

export async function grepFilesTool(input: GrepToolInput, context: ToolContext, signal?: AbortSignal, requestId = "devspace"): Promise<ToolResponse> {
  const tool = createGrepTool(context.cwd);

  return runTool((params, requestId, signal) => tool.execute(requestId, params, signal), input, context, signal, requestId);
}

export async function findFilesTool(input: FindToolInput, context: ToolContext, signal?: AbortSignal, requestId = "devspace"): Promise<ToolResponse> {
  const tool = createFindTool(context.cwd);

  return runTool((params, requestId, signal) => tool.execute(requestId, params, signal), input, context, signal, requestId);
}

export async function listDirectoryTool(input: LsToolInput, context: ToolContext, signal?: AbortSignal, requestId = "devspace"): Promise<ToolResponse> {
  const tool = createLsTool(context.cwd);

  return runTool((params, requestId, signal) => tool.execute(requestId, params, signal), input, context, signal, requestId);
}

export async function runShellTool(input: BashToolInput, context: ToolContext, signal?: AbortSignal, requestId = "devspace"): Promise<ToolResponse> {
  const tool = createBashTool(context.cwd, context.shellRuntime ? {
    shellPath: context.shellRuntime.shellPath,
    spawnHook: createDevspaceShellSpawnHook(context.shellRuntime),
  } : undefined);
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);

  return runTool((params, requestId, signal) => tool.execute(requestId, params, signal), {
    command: input.command,
    timeout,
  }, context, signal, requestId);
}
