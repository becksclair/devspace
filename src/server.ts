import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "./pi-tools.js";
import { countDiffStats, ResultStore } from "./result-store.js";
import { formatAgentsNotice, WorkspaceRegistry } from "./workspaces.js";

type Transport = StreamableHTTPServerTransport;
const WORKSPACE_APP_URI = "ui://pi-on-mcp/workspace-app.html";

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function isAuthorized(req: Request, config: ServerConfig): boolean {
  if (!config.authToken) return true;

  const authorization = req.header("authorization");
  return authorization === `Bearer ${config.authToken}`;
}

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function contentText(content: ToolContent[]): string {
  return content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function textSummary(content: ToolContent[]): { lines: number; characters: number } {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function compactToolResultText(
  verb: string,
  label: string,
  summary: Record<string, unknown>,
): string {
  const details = Object.entries(summary)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(", ");
  return details ? `${verb} ${label} (${details}).` : `${verb} ${label}.`;
}

async function loadWorkspaceAppHtml(): Promise<string> {
  const candidates = [
    new URL("../dist/ui/workspace-app.html", import.meta.url),
    new URL("./ui/workspace-app.html", import.meta.url),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return await readFile(candidate, "utf-8");
    } catch {
      // Try the next path. The first works from dist, the second from tsx dev.
    }
  }

  throw new Error("Built workspace app resource not found. Run npm run build:app.");
}

function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  results: ResultStore,
): McpServer {
  const server = new McpServer(
    {
      name: "local-coding-workspace",
      title: "Local Coding Workspace",
      version: "0.1.0",
      description:
        "Local development harness that exposes workspace-scoped file, search, edit, and shell tools.",
    },
    {
      instructions:
        "Use this server as a local coding workspace harness. First call open_workspace with a project directory inside an allowed root. Then use the returned workspaceId for all file, search, edit, write, and shell tools. Follow any AGENTS.md context returned by open_workspace or subsequent tool calls. Prefer read_file and search tools for inspection, edit_file for targeted modifications, write_file only for new files or complete rewrites, and run_shell for tests/builds/git commands.",
    },
  );

  registerAppResource(
    server,
    "Pi Edit Diff Card",
    WORKSPACE_APP_URI,
    {
      description: "Interactive card for viewing edit_file diffs.",
      _meta: {
        ui: {
          csp: {
            resourceDomains: ["https://esm.sh"],
            connectDomains: ["https://esm.sh"],
          },
        },
      },
    },
    async () => {
      const html = await loadWorkspaceAppHtml();
      return {
        contents: [
          {
            uri: WORKSPACE_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: {
                csp: {
                  resourceDomains: ["https://esm.sh"],
                  connectDomains: ["https://esm.sh"],
                },
              },
            },
          },
        ],
      };
    },
  );

  registerAppTool(
    server,
    "get_tool_result_payload",
    {
      title: "Get tool result payload",
      description:
        "Fetch the full payload for a tool result. This is app-only and hidden from the model.",
      inputSchema: {
        workspaceId: z
          .string()
          .optional()
          .describe("Workspace identifier returned by open_workspace."),
        resultId: z.string().describe("Result identifier returned by a tool."),
      },
      _meta: {
        ui: {
          resourceUri: WORKSPACE_APP_URI,
          visibility: ["app"],
        },
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, resultId }) => {
      if (workspaceId) workspaces.getWorkspace(workspaceId);
      const result = results.get(resultId, workspaceId);

      return {
        content: [
          {
            type: "text" as const,
            text: `Loaded payload for ${result.label ?? result.path ?? result.tool}.`,
          },
        ],
        structuredContent: {
          tool: "get_tool_result_payload",
          resultId,
          workspaceId,
          sourceTool: result.tool,
          label: result.label,
          path: result.path,
          summary: result.summary,
          payload: result.payload,
        },
      };
    },
  );

  registerAppTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Open a local project directory as a coding workspace. This must be the first tool call before reading, editing, searching, writing, or running commands in a project. Returns a workspaceId and any AGENTS.md instructions discovered at the workspace root.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path to a local project directory inside an allowed root.",
          ),
      },
      _meta: {
        ui: {
          resourceUri: WORKSPACE_APP_URI,
          visibility: ["model"],
        },
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path }) => {
      const { workspace, agentsFiles } = await workspaces.openWorkspace(path);
      const summary = {
        agentsFiles: agentsFiles.length,
      };
      const storedResult = results.put({
        tool: "open_workspace",
        workspaceId: workspace.id,
        label: workspace.root,
        path: workspace.root,
        summary,
        payload: {
          content: [
            {
              type: "text",
              text: formatAgentsNotice(agentsFiles) ?? "",
            },
          ],
        },
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                workspaceId: workspace.id,
                root: workspace.root,
                loadedAgentsFiles: agentsFiles.map((file) => ({
                  path: file.path,
                  alreadyLoaded: file.alreadyLoaded,
                })),
                instruction:
                  "Use this workspaceId in all subsequent tool calls for this project. Follow the AGENTS.md context returned below.",
              },
              null,
              2,
            ),
          },
          ...(formatAgentsNotice(agentsFiles)
            ? [
                {
                  type: "text" as const,
                  text: formatAgentsNotice(agentsFiles)!,
                },
              ]
            : []),
        ],
        structuredContent: {
          tool: "open_workspace",
          resultId: storedResult.id,
          workspaceId: workspace.id,
          root: workspace.root,
          label: workspace.root,
          summary,
          ui: {
            card: "workspace",
            expandable: agentsFiles.length > 0,
          },
        },
      };
    },
  );

  registerAppTool(
    server,
    "read_file",
    {
      title: "Read file",
      description:
        "Read a file inside an open workspace. Use this for file inspection instead of shell commands like cat or sed. Call open_workspace first and pass workspaceId. If the file path enters a directory with an AGENTS.md, that AGENTS.md context is returned as newly loaded or already loaded.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to read, relative to the workspace root."),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      _meta: {
        ui: {
          resourceUri: WORKSPACE_APP_URI,
          visibility: ["model"],
        },
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = workspaces.resolvePath(workspace, input.path);
      const agentsNotice = formatAgentsNotice(
        await workspaces.loadAgentsForPath(workspace, targetPath),
      );
      const response = await readFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
        agentsNotice,
      });

      if (response.isError) return response;

      const summary = {
        ...textSummary(response.content),
        offset: input.offset ?? 1,
        limited: input.limit !== undefined,
      };
      const storedResult = results.put({
        workspaceId,
        tool: "read_file",
        path: input.path,
        label: input.path,
        summary,
        payload: { content: response.content },
      });

      return {
        ...response,
        structuredContent: {
          tool: "read_file",
          resultId: storedResult.id,
          workspaceId,
          path: input.path,
          label: input.path,
          summary,
          ui: {
            card: "text",
            expandable: true,
          },
        },
      };
    },
  );

  registerAppTool(
    server,
    "write_file",
    {
      title: "Write file",
      description:
        "Create or completely overwrite a file inside an open workspace. Prefer edit_file for targeted changes to existing files. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      _meta: {
        ui: {
          resourceUri: WORKSPACE_APP_URI,
          visibility: ["model"],
        },
      },
      annotations: { destructiveHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = workspaces.resolvePath(workspace, input.path);
      const agentsNotice = formatAgentsNotice(
        await workspaces.loadAgentsForPath(workspace, targetPath),
      );
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
        agentsNotice,
      });

      if (response.isError) return response;

      const summary = {
        lines: input.content.length === 0 ? 0 : input.content.split("\n").length,
        characters: input.content.length,
      };
      const storedResult = results.put({
        workspaceId,
        tool: "write_file",
        path: input.path,
        label: input.path,
        summary,
        payload: { content: response.content },
      });

      return {
        ...response,
        structuredContent: {
          tool: "write_file",
          resultId: storedResult.id,
          workspaceId,
          path: input.path,
          label: input.path,
          summary,
          ui: {
            card: "write",
            expandable: true,
          },
        },
      };
    },
  );

  registerAppTool(
    server,
    "edit_file",
    {
      title: "Edit file",
      description:
        "Edit one file inside an open workspace by replacing exact text blocks. Prefer this over write_file for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      _meta: {
        ui: {
          resourceUri: WORKSPACE_APP_URI,
          visibility: ["model"],
        },
      },
      annotations: { destructiveHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = workspaces.resolvePath(workspace, input.path);
      const agentsNotice = formatAgentsNotice(
        await workspaces.loadAgentsForPath(workspace, targetPath),
      );
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
        agentsNotice,
      });

      if (response.isError) return response;

      const stats = countDiffStats(response.details?.patch ?? response.details?.diff);
      const storedResult = results.put({
        workspaceId,
        tool: "edit_file",
        path: input.path,
        label: input.path,
        summary: {
          ...stats,
          editCount: input.edits.length,
        },
        payload: {
          diff: response.details?.diff,
          patch: response.details?.patch,
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Edited ${input.path} (+${stats.additions} -${stats.removals}). Diff available in the UI as ${storedResult.id}.`,
          },
          ...(agentsNotice
            ? [{ type: "text" as const, text: agentsNotice }]
            : []),
        ],
        structuredContent: {
          tool: "edit_file",
          resultId: storedResult.id,
          workspaceId,
          status: "applied",
          path: input.path,
          label: input.path,
          summary: storedResult.summary,
          ui: {
            card: "file-diff",
            expandable: true,
          },
        },
      };
    },
  );

  registerAppTool(
    server,
    "grep_files",
    {
      title: "Grep files",
      description:
        "Search file contents inside an open workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects the underlying Pi grep behavior, including project ignore rules. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        pattern: z.string().describe("Search pattern."),
        path: z
          .string()
          .optional()
          .describe(
            "Optional path or glob scope relative to the workspace root.",
          ),
        include: z.string().optional().describe("Optional include glob."),
      },
      _meta: {
        ui: {
          resourceUri: WORKSPACE_APP_URI,
          visibility: ["model"],
        },
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = input.path
        ? workspaces.resolvePath(workspace, input.path)
        : workspace.root;
      const agentsNotice = formatAgentsNotice(
        await workspaces.loadAgentsForPath(workspace, targetPath),
      );
      const response = await grepFilesTool(input, {
        cwd: workspace.root,
        root: workspace.root,
        agentsNotice,
      });

      if (response.isError) return response;

      const summary = {
        pattern: input.pattern,
        scope: input.path ?? ".",
        ...textSummary(response.content),
      };
      const storedResult = results.put({
        workspaceId,
        tool: "grep_files",
        path: input.path,
        label: input.pattern,
        summary,
        payload: { content: response.content },
      });

      return {
        ...response,
        structuredContent: {
          tool: "grep_files",
          resultId: storedResult.id,
          workspaceId,
          path: input.path,
          label: input.pattern,
          summary,
          ui: {
            card: "search",
            expandable: true,
          },
        },
      };
    },
  );

  registerAppTool(
    server,
    "find_files",
    {
      title: "Find files",
      description:
        "Find files by glob pattern inside an open workspace. Use this to discover filenames or narrow file sets before reading. Respects the underlying Pi find behavior, including project ignore rules. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        pattern: z.string().describe("File glob pattern."),
        path: z
          .string()
          .optional()
          .describe("Optional path scope relative to the workspace root."),
      },
      _meta: {
        ui: {
          resourceUri: WORKSPACE_APP_URI,
          visibility: ["model"],
        },
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = input.path
        ? workspaces.resolvePath(workspace, input.path)
        : workspace.root;
      const agentsNotice = formatAgentsNotice(
        await workspaces.loadAgentsForPath(workspace, targetPath),
      );
      const response = await findFilesTool(input, {
        cwd: workspace.root,
        root: workspace.root,
        agentsNotice,
      });

      if (response.isError) return response;

      const summary = {
        pattern: input.pattern,
        scope: input.path ?? ".",
        ...textSummary(response.content),
      };
      const storedResult = results.put({
        workspaceId,
        tool: "find_files",
        path: input.path,
        label: input.pattern,
        summary,
        payload: { content: response.content },
      });

      return {
        ...response,
        structuredContent: {
          tool: "find_files",
          resultId: storedResult.id,
          workspaceId,
          path: input.path,
          label: input.pattern,
          summary,
          ui: {
            card: "search",
            expandable: true,
          },
        },
      };
    },
  );

  registerAppTool(
    server,
    "list_directory",
    {
      title: "List directory",
      description:
        "List a directory inside an open workspace. Use this for directory inspection before reading files. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("Directory path to list, relative to the workspace root."),
      },
      _meta: {
        ui: {
          resourceUri: WORKSPACE_APP_URI,
          visibility: ["model"],
        },
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = workspaces.resolvePath(workspace, input.path);
      const agentsNotice = formatAgentsNotice(
        await workspaces.loadAgentsForPath(workspace, targetPath),
      );
      const response = await listDirectoryTool(input, {
        cwd: workspace.root,
        root: workspace.root,
        agentsNotice,
      });

      if (response.isError) return response;

      const summary = textSummary(response.content);
      const storedResult = results.put({
        workspaceId,
        tool: "list_directory",
        path: input.path,
        label: input.path,
        summary,
        payload: { content: response.content },
      });

      return {
        ...response,
        structuredContent: {
          tool: "list_directory",
          resultId: storedResult.id,
          workspaceId,
          path: input.path,
          label: input.path,
          summary,
          ui: {
            card: "directory",
            expandable: true,
          },
        },
      };
    },
  );

  registerAppTool(
    server,
    "run_shell",
    {
      title: "Run shell",
      description:
        "Run a shell command inside an open workspace. Use for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Prefer read_file, grep_files, find_files, and list_directory for file inspection. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        command: z.string().describe("Shell command to run."),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      _meta: {
        ui: {
          resourceUri: WORKSPACE_APP_URI,
          visibility: ["model"],
        },
      },
      annotations: { destructiveHint: true },
    },
    async ({ workspaceId, workingDirectory, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const agentsNotice = formatAgentsNotice(
        await workspaces.loadAgentsForDirectory(workspace, cwd),
      );
      const response = await runShellTool(input, { cwd, root: workspace.root, agentsNotice });

      if (response.isError) return response;

      const summary = {
        command: input.command,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(response.content),
      };
      const storedResult = results.put({
        workspaceId,
        tool: "run_shell",
        path: workingDirectory,
        label: input.command,
        summary,
        payload: { content: response.content },
      });

      return {
        ...response,
        structuredContent: {
          tool: "run_shell",
          resultId: storedResult.id,
          workspaceId,
          path: workingDirectory,
          label: input.command,
          summary,
          ui: {
            card: "shell",
            expandable: true,
          },
        },
      };
    },
  );

  return server;
}

export function createServer(config = loadConfig()): RunningServer {
  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: Array.from(new Set([config.host, ...config.allowedHosts])),
  });
  const transports = new Map<string, Transport>();
  const workspaces = new WorkspaceRegistry(config);
  const results = new ResultStore();

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "pi-on-mcp" });
  });

  app.all("/mcp", async (req, res) => {
    if (!isAuthorized(req, config)) {
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    try {
      const sessionId = req.header("mcp-session-id");
      let transport: Transport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (req.method === "POST" && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.set(newSessionId, transport);
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) transports.delete(closedSessionId);
        };

        const server = createMcpServer(config, workspaces, results);
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request", error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  return { app, config };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { app, config } = createServer();
  app.listen(config.port, config.host, () => {
    console.log(
      `pi-on-mcp listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(
      config.authToken ? "auth: bearer token required" : "auth: disabled",
    );
  });
}
