/**
 * MCP (Model Context Protocol) server for the `mcp` build mode.
 *
 * The box runs this — scoped to ONE build session — so an external
 * AI-capable IDE (Cursor, Cline, …) can build a service against the
 * user's own server using the IDE's own model subscription. No model and
 * no model key live on the box for this mode: the box exposes only a
 * limited, contract-bounded function surface (write files, validate,
 * request an owner secret value-free, deploy a private staging copy, test
 * it, finish) and the IDE's agent drives it. Once it finishes, the box
 * seals the build (its key is revoked, every tool refuses) and puts the
 * app live by itself. The auth key the user pastes into the IDE binds the connection to
 * this one build session (see `mcpKeyStore`).
 *
 * This module is the pure JSON-RPC 2.0 dispatcher (transport-agnostic).
 * The HTTP/Streamable-HTTP binding + per-session auth live in the daemon
 * wiring; tests drive `handle()` with plain objects.
 *
 * Every tool call is written to the build journal so the `mcp` mode is
 * exactly as observable as scratch/git.
 */

import type { ModelRedactor } from "../llm/modelPrivacy.js";
import type { BuildJournal } from "./buildJournal.js";
import type { BuildWorkspace } from "./buildWorkspace.js";
import { renderContractMarkdown, BUILD_CONTRACT_VERSION } from "./contract.js";
import {
  BuildToolHost,
  BUILD_TOOL_SPECS,
  type BuildToolCheckResult,
  type BuildToolDataHooks,
  type BuildToolDeployResult,
} from "./buildToolHost.js";

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "flagship-build";

export type McpDeployResult = BuildToolDeployResult;

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
  /** Build the workspace and run it as the private staging copy. Absent ⇒ deploy refuses. */
  deploy?: () => Promise<McpDeployResult>;
  /** Request a path from the staging copy. */
  checkApp?: (req: { path: string; method?: string; body?: string }) => Promise<BuildToolCheckResult>;
  /** The staging copy's recent output; null when nothing is running. */
  logs?: () => Promise<string | null>;
  /** The staging copy's sample data (query_db, list_tables, list_data_files, read_data_file). */
  data?: BuildToolDataHooks;
  /** The IDE says the app works; the box seals the build and puts it live. */
  finish?: () => Promise<{ ok: boolean; reason?: string }>;
  /** True once sealed: tools and resources refuse. */
  sealed?: () => boolean;
  /** Server software version string for serverInfo. */
  version?: string;
  /** Strips the owner's identity from box-written texts the IDE reads. */
  redact?: ModelRedactor;
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

// The tool catalogue is OWNED by buildToolHost (one source of truth shared
// with the box's own agentic adapt loop); the MCP server publishes it
// verbatim.
const TOOLS = BUILD_TOOL_SPECS;

const RESOURCES = [
  { uri: "flagship://contract", name: "Flagship app contract", mimeType: "text/markdown" },
  { uri: "flagship://journal", name: "Build journal", mimeType: "application/json" },
];

export class McpBuildServer {
  private readonly tools: BuildToolHost;

  constructor(private readonly ctx: McpBuildContext) {
    this.tools = new BuildToolHost({
      buildId: ctx.buildId,
      workspace: ctx.workspace,
      journal: ctx.journal,
      serverFqdn: ctx.serverFqdn,
      envNames: ctx.envNames,
      mode: "mcp",
      ...(ctx.recordEnvRequest ? { recordEnvRequest: ctx.recordEnvRequest } : {}),
      ...(ctx.deploy ? { deploy: ctx.deploy } : {}),
      ...(ctx.checkApp ? { checkApp: ctx.checkApp } : {}),
      ...(ctx.logs ? { logs: ctx.logs } : {}),
      ...(ctx.data ? { data: ctx.data } : {}),
      ...(ctx.finish ? { finish: ctx.finish } : {}),
      ...(ctx.sealed ? { sealed: ctx.sealed } : {}),
      ...(ctx.redact ? { redact: ctx.redact } : {}),
    });
  }

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
        `This server builds ONE Flagship service (build id ${this.ctx.buildId}). ` +
        `Call get_contract first, then write_file the app, validate, deploy a private test copy, ` +
        `test it with check_app and get_logs, and call finish when it works.`,
    };
  }

  private async readResource(params: unknown): Promise<unknown> {
    const uri = isObject(params) && typeof params.uri === "string" ? params.uri : "";
    if (this.ctx.sealed?.()) throw new Error("this build is closed");
    if (uri === "flagship://contract") {
      return { contents: [{ uri, mimeType: "text/markdown", text: renderContractMarkdown() }] };
    }
    if (uri === "flagship://journal") {
      // The same history get_journal gives: no clock times, ids or URLs.
      const r = await this.tools.call("get_journal", {});
      return { contents: [{ uri, mimeType: "application/json", text: r.text }] };
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
    // Dispatch through the SHARED tool host (it journals the call value-free).
    const r = await this.tools.call(name, args);
    return {
      content: [{ type: "text", text: r.text }],
      ...(r.isError ? { isError: true } : {}),
    };
  }
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
