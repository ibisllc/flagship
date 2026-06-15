/**
 * MCP (Model Context Protocol) server for the `mcp` build mode.
 *
 * The box runs this — scoped to ONE build session — so an external
 * AI-capable IDE (Cursor, Cline, …) can build a service against the
 * user's own server using the IDE's own model subscription. No model and
 * no model key live on the box for this mode: the box exposes only a
 * limited, contract-bounded function surface (write files, validate,
 * request an owner secret value-free, deploy) and the IDE's agent drives
 * it. The auth key the user pastes into the IDE binds the connection to
 * this one build session (see `mcpKeyStore`).
 *
 * This module is the pure JSON-RPC 2.0 dispatcher (transport-agnostic).
 * The HTTP/Streamable-HTTP binding + per-session auth live in the daemon
 * wiring; tests drive `handle()` with plain objects.
 *
 * Every tool call is written to the build journal so the `mcp` mode is
 * exactly as observable as scratch/git.
 */

import { parseManifest } from "@flagship/protocol";
import type { BuildJournal } from "./buildJournal.js";
import type { BuildWorkspace } from "./buildWorkspace.js";
import { renderContractMarkdown, BUILD_CONTRACT_VERSION } from "./contract.js";

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "flagship-build";

export interface McpDeployResult {
  ok: boolean;
  serviceId?: string;
  url?: string;
  reason?: string;
}

export interface McpBuildContext {
  buildId: string;
  workspace: BuildWorkspace;
  journal: BuildJournal;
  serverFqdn: string;
  /** Owner-set env var NAMES (never values). */
  envNames: () => Promise<string[]>;
  /**
   * Record a value-free request that the owner set a named env var. The
   * actual value is supplied later from the phone via the signed
   * set-app-env path — NEVER through MCP. Optional; when absent the tool
   * still reports current state.
   */
  recordEnvRequest?: (req: { name: string; why?: string; secret?: boolean }) => Promise<void>;
  /** Build + install the current workspace. Absent ⇒ deploy tool 503s. */
  deploy?: () => Promise<McpDeployResult>;
  /** Recent logs for a deployed build. Absent ⇒ get_logs returns a hint. */
  logs?: () => Promise<string>;
  /** Server software version string for serverInfo. */
  version?: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "get_contract",
    description: "Read the Flagship app contract: hard rules, manifest schema, injected env vars, and the build workflow. Read this first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_files",
    description: "List the paths currently in the build workspace.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_file",
    description: "Read one file from the build workspace.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file in the build workspace. Paths are repo-relative (forward slashes, no '..').",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "delete_file",
    description: "Remove a file from the build workspace.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "validate",
    description: "Validate the workspace's flagship.app.json against the manifest schema. Returns problems, or ok.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "request_env_var",
    description: "Ask the owner to set a named secret env var. VALUE-FREE: you never see or send the value — the owner supplies it from their phone. Returns whether it is currently set.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        why: { type: "string" },
        secret: { type: "boolean" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_journal",
    description: "Read the build journal — the full history of this build across all modes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "deploy",
    description: "Build the container from the workspace and install it on the box. Returns the live URL.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_logs",
    description: "Read recent logs from the deployed app (after deploy).",
    inputSchema: { type: "object", properties: {} },
  },
];

const RESOURCES = [
  { uri: "flagship://contract", name: "Flagship app contract", mimeType: "text/markdown" },
  { uri: "flagship://journal", name: "Build journal", mimeType: "application/json" },
];

export class McpBuildServer {
  constructor(private readonly ctx: McpBuildContext) {}

  /** Dispatch one JSON-RPC message. Returns null for notifications. */
  async handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return err(null, -32600, "invalid request");
    }
    const req = message as unknown as JsonRpcRequest;
    const id = req.id ?? null;
    const isNotification = req.id === undefined;

    try {
      switch (req.method) {
        case "initialize":
          return ok(id, this.initialize(req.params));
        case "notifications/initialized":
        case "notifications/cancelled":
          return null; // notifications — no response
        case "ping":
          return ok(id, {});
        case "tools/list":
          return ok(id, { tools: TOOLS });
        case "resources/list":
          return ok(id, { resources: RESOURCES });
        case "resources/read":
          return ok(id, await this.readResource(req.params));
        case "tools/call":
          return ok(id, await this.callTool(req.params));
        default:
          if (isNotification) return null;
          return err(id, -32601, `method not found: ${req.method}`);
      }
    } catch (e) {
      return err(id, -32603, `internal error: ${(e as Error).message}`);
    }
  }

  private initialize(params: unknown): unknown {
    const requested = isObject(params) && typeof params.protocolVersion === "string"
      ? params.protocolVersion
      : DEFAULT_PROTOCOL_VERSION;
    return {
      protocolVersion: requested,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: SERVER_NAME, version: this.ctx.version ?? "0.1.0" },
      instructions:
        `This server builds ONE Flagship service (build id ${this.ctx.buildId}) on ${this.ctx.serverFqdn}. ` +
        `Call get_contract first, then write_file the app, validate, and deploy.`,
    };
  }

  private async readResource(params: unknown): Promise<unknown> {
    const uri = isObject(params) && typeof params.uri === "string" ? params.uri : "";
    if (uri === "flagship://contract") {
      return { contents: [{ uri, mimeType: "text/markdown", text: renderContractMarkdown() }] };
    }
    if (uri === "flagship://journal") {
      const entries = await this.ctx.journal.read(this.ctx.buildId);
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(entries, null, 2) }] };
    }
    if (uri.startsWith("flagship://files/")) {
      const path = uri.slice("flagship://files/".length);
      const content = this.ctx.workspace.read(path);
      if (content == null) throw new Error(`no such file: ${path}`);
      return { contents: [{ uri, mimeType: "text/plain", text: content }] };
    }
    throw new Error(`unknown resource: ${uri}`);
  }

  private async callTool(params: unknown): Promise<unknown> {
    const name = isObject(params) && typeof params.name === "string" ? params.name : "";
    const args = isObject(params) && isObject(params.arguments) ? params.arguments : {};
    const r = await this.dispatchTool(name, args);
    // Journal the call (value-free; the journal redacts as a backstop).
    await this.ctx.journal.append(this.ctx.buildId, {
      mode: "mcp",
      kind: "mcp-call",
      actor: "ide",
      summary: r.journalSummary ?? `${name}`,
      ...(r.journalDetail != null ? { detail: r.journalDetail } : {}),
      ...(r.serviceId != null ? { serviceId: r.serviceId } : {}),
    });
    return {
      content: [{ type: "text", text: r.text }],
      ...(r.isError ? { isError: true } : {}),
    };
  }

  private async dispatchTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError?: boolean; journalSummary?: string; journalDetail?: string; serviceId?: string }> {
    switch (name) {
      case "get_contract":
        return { text: renderContractMarkdown(), journalSummary: "read contract" };

      case "list_files": {
        const files = this.ctx.workspace.list();
        return { text: JSON.stringify({ files }), journalSummary: `list_files (${files.length})` };
      }

      case "read_file": {
        const path = str(args.path);
        const content = this.ctx.workspace.read(path);
        if (content == null) return toolErr(`no such file: ${path}`, `read_file miss: ${path}`);
        return { text: content, journalSummary: `read_file ${path}` };
      }

      case "write_file": {
        const path = str(args.path);
        const content = typeof args.content === "string" ? args.content : "";
        const w = this.ctx.workspace.write(path, content);
        if (!w.ok) return toolErr(w.reason, `write_file rejected: ${path}`);
        return {
          text: JSON.stringify({ ok: true, path, bytes: Buffer.byteLength(content, "utf8") }),
          journalSummary: `wrote ${path}`,
        };
      }

      case "delete_file": {
        const path = str(args.path);
        const existed = this.ctx.workspace.delete(path);
        return { text: JSON.stringify({ ok: true, existed }), journalSummary: `delete ${path}` };
      }

      case "validate": {
        const manifestJson = this.ctx.workspace.manifestJson();
        if (manifestJson == null) return toolErr("no flagship.app.json in the workspace yet", "validate: no manifest");
        let parsed: unknown;
        try {
          parsed = JSON.parse(manifestJson);
        } catch (e) {
          return toolErr(`flagship.app.json is not valid JSON: ${(e as Error).message}`, "validate: bad json");
        }
        const result = parseManifest(parsed);
        if (!result.ok) {
          return { text: JSON.stringify({ ok: false, problems: result.errors }), journalSummary: `validate: ${result.errors.length} problem(s)` };
        }
        const hasDockerfile = this.ctx.workspace.has("Dockerfile");
        const problems = hasDockerfile ? [] : ["missing Dockerfile"];
        return {
          text: JSON.stringify({ ok: problems.length === 0, manifestName: result.manifest.name, problems }),
          journalSummary: problems.length ? `validate: ${problems.join(", ")}` : "validate: ok",
        };
      }

      case "request_env_var": {
        const envName = str(args.name);
        if (!envName) return toolErr("name required", "request_env_var: no name");
        if (envName.startsWith("FLAGSHIP_")) return toolErr("FLAGSHIP_ prefix is reserved", "request_env_var: reserved");
        const why = typeof args.why === "string" ? args.why : undefined;
        const secret = typeof args.secret === "boolean" ? args.secret : undefined;
        if (this.ctx.recordEnvRequest) {
          await this.ctx.recordEnvRequest({ name: envName, why, secret });
        }
        const names = await this.ctx.envNames();
        const currentlySet = names.includes(envName);
        // VALUE-FREE: report only whether it is set, never the value.
        return {
          text: JSON.stringify({
            name: envName,
            status: currentlySet ? "set" : "pending-owner",
            currentlySet,
            note: "The owner sets the value from their phone. You will never receive it; read it from the process environment at runtime.",
          }),
          journalSummary: `requested env var ${envName}${currentlySet ? " (already set)" : ""}`,
        };
      }

      case "get_journal": {
        const entries = await this.ctx.journal.read(this.ctx.buildId);
        return { text: JSON.stringify(entries), journalSummary: "read journal" };
      }

      case "deploy": {
        if (!this.ctx.deploy) return toolErr("deploy is not available for this session", "deploy unavailable");
        if (!this.ctx.workspace.manifestJson()) return toolErr("nothing to deploy: write flagship.app.json first", "deploy: no manifest");
        const d = await this.ctx.deploy();
        if (!d.ok) return toolErr(d.reason ?? "deploy failed", `deploy failed: ${d.reason ?? ""}`);
        return {
          text: JSON.stringify({ ok: true, url: d.url, serviceId: d.serviceId }),
          journalSummary: `deployed → ${d.url ?? ""}`,
          ...(d.serviceId != null ? { serviceId: d.serviceId } : {}),
        };
      }

      case "get_logs": {
        if (!this.ctx.logs) return { text: "logs are available after the app is deployed", journalSummary: "get_logs (none)" };
        const text = await this.ctx.logs();
        return { text, journalSummary: "read logs" };
      }

      default:
        return toolErr(`unknown tool: ${name}`, `unknown tool: ${name}`);
    }
  }
}

function toolErr(message: string, journalSummary: string) {
  return { text: JSON.stringify({ ok: false, error: message }), isError: true, journalSummary };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export { TOOLS as MCP_BUILD_TOOLS, BUILD_CONTRACT_VERSION };
