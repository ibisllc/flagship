/**
 * The Flagship build TOOL SURFACE — one authoritative implementation of the
 * limited, contract-bounded functions a build agent drives:
 *   get_contract · list_files · read_file · write_file · delete_file ·
 *   validate · request_env_var · get_journal · deploy · get_logs
 *
 * BOTH callers route through here, so the surface can never drift between
 * them:
 *   - the box's OWN AI (the agentic git-adapt loop) — `buildAgent.ts`
 *     dispatches the model's tool calls through `call()`.
 *   - an EXTERNAL IDE/agent over MCP — `mcpServer.ts` wraps `call()` in the
 *     JSON-RPC 2.0 envelope.
 *
 * The host operates on a `BuildWorkspace` + the shared `BuildJournal` plus
 * the same hooks the MCP context took (owner env NAMES, value-free
 * `recordEnvRequest`, `deploy`, `logs`). It is transport-agnostic and
 * journals every call value-free (names/sizes/validation problems only —
 * never file contents, never a secret value).
 */

import { parseManifest } from "@flagship/protocol";
import type { BuildJournal, BuildMode } from "./buildJournal.js";
import type { BuildWorkspace } from "./buildWorkspace.js";
import { renderContractMarkdown } from "./contract.js";

export interface BuildToolDeployResult {
  ok: boolean;
  serviceId?: string;
  url?: string;
  reason?: string;
}

export interface BuildToolHostContext {
  buildId: string;
  workspace: BuildWorkspace;
  journal: BuildJournal;
  serverFqdn: string;
  /** Owner-set env var NAMES (never values). */
  envNames: () => Promise<string[]>;
  /**
   * Record a value-free request that the owner set a named env var. The
   * actual value is supplied later from the phone via the signed
   * set-app-env path — NEVER through a build tool. Optional.
   */
  recordEnvRequest?: (req: { name: string; why?: string; secret?: boolean }) => Promise<void>;
  /** Build + install the current workspace. Absent ⇒ the deploy tool 503s. */
  deploy?: () => Promise<BuildToolDeployResult>;
  /** Recent logs for a deployed build. Absent ⇒ get_logs returns a hint. */
  logs?: () => Promise<string>;
  /**
   * Which build mode owns the journal entries this host writes. `mcp` for
   * the external-IDE path, `git` for the box's own agentic adapt loop.
   */
  mode?: BuildMode;
}

/** The result of one tool call. `text` is what the model/IDE sees back. */
export interface BuildToolResult {
  text: string;
  isError?: boolean;
  /** Value-free journal summary (defaults to the tool name). */
  journalSummary?: string;
  journalDetail?: string;
  /** Set by `deploy` on success so the journal can carry the serviceId. */
  serviceId?: string;
}

/** Names of the tools the surface exposes, in the order they appear. */
export const BUILD_TOOL_NAMES = [
  "get_contract",
  "list_files",
  "read_file",
  "write_file",
  "delete_file",
  "validate",
  "request_env_var",
  "get_journal",
  "deploy",
  "get_logs",
] as const;

export type BuildToolName = (typeof BUILD_TOOL_NAMES)[number];

export interface BuildToolSpec {
  name: BuildToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The canonical tool specs. The MCP server publishes these verbatim under
 * `tools/list`; the agentic loop hands them to the model as the provider's
 * native tool shape. ONE definition so the two paths can never diverge.
 */
export const BUILD_TOOL_SPECS: BuildToolSpec[] = [
  {
    name: "get_contract",
    description:
      "Read the Flagship app contract: hard rules, manifest schema, injected env vars, and the build workflow. Read this first.",
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
    description:
      "Create or overwrite a file in the build workspace. Paths are repo-relative (forward slashes, no '..').",
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
    description:
      "Validate the workspace's flagship.app.json against the manifest schema (and check a Dockerfile is present). Returns problems, or ok.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "request_env_var",
    description:
      "Ask the owner to set a named secret env var. VALUE-FREE: you never see or send the value — the owner supplies it from their phone. Returns whether it is currently set.",
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

export class BuildToolHost {
  constructor(private readonly ctx: BuildToolHostContext) {}

  /** The names of all tools the host exposes. */
  toolNames(): readonly BuildToolName[] {
    return BUILD_TOOL_NAMES;
  }

  /**
   * Dispatch ONE tool call and journal it (value-free). `args` is the
   * model's / IDE's parsed argument object. Never throws for a tool-level
   * failure — it returns `{isError:true}` so the agent can recover.
   */
  async call(name: string, args: Record<string, unknown>): Promise<BuildToolResult> {
    const r = await this.dispatch(name, args);
    await this.ctx.journal.append(this.ctx.buildId, {
      mode: this.ctx.mode ?? "mcp",
      kind: "mcp-call",
      actor: this.ctx.mode === "git" ? "ai" : "ide",
      summary: r.journalSummary ?? name,
      ...(r.journalDetail != null ? { detail: r.journalDetail } : {}),
      ...(r.serviceId != null ? { serviceId: r.serviceId } : {}),
    });
    return r;
  }

  private async dispatch(name: string, args: Record<string, unknown>): Promise<BuildToolResult> {
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
          return {
            text: JSON.stringify({ ok: false, problems: result.errors }),
            journalSummary: `validate: ${result.errors.length} problem(s)`,
          };
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
        if (!this.ctx.workspace.manifestJson())
          return toolErr("nothing to deploy: write flagship.app.json first", "deploy: no manifest");
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

function toolErr(message: string, journalSummary: string): BuildToolResult {
  return { text: JSON.stringify({ ok: false, error: message }), isError: true, journalSummary };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
