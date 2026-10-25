/**
 * The AI tool broker (AI01, IMPLEMENTATION-PLAN §10): the one gate every model-driven tool call
 * passes, whoever drives it (the box's own build loop, or an IDE agent over MCP).
 *
 * Authority never comes from the model. A session's grant is fixed by the box when the session
 * starts, from what the owner did (a signed consent, an owner session, an owner-issued MCP key):
 * which tools exist for it and what each may touch. Text in a repo file, a tool result, a log line
 * or the model's own output is data; nothing in it can add a tool, widen an argument, reach a live
 * service, read a credential or open the network. Concretely:
 *
 *  - per-tool capabilities: each tool declares what it touches (`TOOL_POLICIES`); a session gets
 *    only the capabilities its grant names, and an unknown tool is refused, never guessed at;
 *  - arguments are checked against the tool's exact shape: unknown fields (a `target: "live"`, a
 *    `value` for an env var), wrong types, oversize values, path escapes, absolute URLs or header
 *    injection in a staging request are refused before any hook runs;
 *  - the staging fence: every effect is on the build's private staging copy and its sample data;
 *    no tool takes a host, a URL, a service id or a store outside the staging copy's own;
 *  - credentials: the exact values of secrets the box holds for this session (the provider key,
 *    owner env values) are cut from every result, and secret-shaped tokens from box-written text;
 *  - redaction: every box-written result passes `buildModelRedactor` (the repo's own bytes, from
 *    read_file and list_files, are passed unchanged: rewriting them would corrupt the code);
 *  - revocation: `revoke()` (the owner cancelled, the key was rotated, the build was sealed) refuses
 *    queued calls and abandons active ones; nothing a revoked session started reaches the model.
 */
import { redactSecrets } from "./buildJournal.js";
import type { ModelRedactor } from "../llm/modelPrivacy.js";

export type ToolCapability =
  | "contract.read"
  | "workspace.read"
  | "workspace.write"
  | "journal.read"
  | "env.names"
  | "env.request"
  | "staging.deploy"
  | "staging.http"
  | "staging.logs"
  | "staging.data"
  | "build.finish";

type ArgKind = "string" | "boolean";

export interface ToolPolicy {
  /** What the tool touches: the session's grant must hold every one. */
  needs: readonly ToolCapability[];
  /** Box-written text (redacted) or the repo's own bytes (passed as they are). */
  output: "box-written" | "repo-content";
  /** The exact argument shape: name → type and the most bytes it may carry. */
  args: Readonly<Record<string, { kind: ArgKind; max?: number; required?: boolean }>>;
  /** What the tool reaches beyond the workspace. */
  reach: "workspace" | "staging-copy" | "staging-data" | "box";
}

const PATH_MAX = 512;

/** Every build tool, what it needs and its argument shape. A tool missing here can't be called. */
export const TOOL_POLICIES = {
  get_contract: { needs: ["contract.read"], output: "box-written", args: {}, reach: "box" },
  list_files: { needs: ["workspace.read"], output: "repo-content", args: {}, reach: "workspace" },
  read_file: { needs: ["workspace.read"], output: "repo-content", args: { path: { kind: "string", max: PATH_MAX, required: true } }, reach: "workspace" },
  write_file: {
    needs: ["workspace.write"],
    output: "box-written",
    args: { path: { kind: "string", max: PATH_MAX, required: true }, content: { kind: "string", max: 2 * 1024 * 1024, required: true } },
    reach: "workspace",
  },
  delete_file: { needs: ["workspace.write"], output: "box-written", args: { path: { kind: "string", max: PATH_MAX, required: true } }, reach: "workspace" },
  validate: { needs: ["workspace.read"], output: "box-written", args: {}, reach: "workspace" },
  request_env_var: {
    needs: ["env.request", "env.names"],
    output: "box-written",
    args: { name: { kind: "string", max: 64, required: true }, why: { kind: "string", max: 300 }, secret: { kind: "boolean" } },
    reach: "box",
  },
  get_journal: { needs: ["journal.read"], output: "box-written", args: {}, reach: "box" },
  deploy: { needs: ["staging.deploy"], output: "box-written", args: {}, reach: "staging-copy" },
  check_app: {
    needs: ["staging.http"],
    output: "box-written",
    args: { path: { kind: "string", max: 2048, required: true }, method: { kind: "string", max: 8 }, body: { kind: "string", max: 64 * 1024 } },
    reach: "staging-copy",
  },
  get_logs: { needs: ["staging.logs"], output: "box-written", args: {}, reach: "staging-copy" },
  query_db: { needs: ["staging.data"], output: "box-written", args: { sql: { kind: "string", max: 16 * 1024, required: true }, store: { kind: "string", max: 64 } }, reach: "staging-data" },
  list_tables: { needs: ["staging.data"], output: "box-written", args: { store: { kind: "string", max: 64 } }, reach: "staging-data" },
  list_data_files: { needs: ["staging.data"], output: "box-written", args: { path: { kind: "string", max: PATH_MAX } }, reach: "staging-data" },
  read_data_file: { needs: ["staging.data"], output: "box-written", args: { path: { kind: "string", max: PATH_MAX, required: true } }, reach: "staging-data" },
  finish: { needs: ["build.finish"], output: "box-written", args: {}, reach: "box" },
} as const satisfies Record<string, ToolPolicy>;

export type BrokeredToolName = keyof typeof TOOL_POLICIES;

/** Who authorized the session, as the box recorded it. Never model text. */
export type GrantAuthority =
  | { kind: "owner-consent"; issuedAt: number }
  | { kind: "owner-session" }
  | { kind: "mcp-key" }
  | { kind: "test" };

export interface ToolGrant {
  readonly buildId: string;
  readonly authority: GrantAuthority;
  readonly capabilities: ReadonlySet<ToolCapability>;
}

const ALL_CAPS: readonly ToolCapability[] = [
  "contract.read", "workspace.read", "workspace.write", "journal.read", "env.names", "env.request",
  "staging.deploy", "staging.http", "staging.logs", "staging.data", "build.finish",
];

/** The box's own build loop: everything but its own journal (it doesn't need it). */
export function agentGrant(buildId: string, authority: GrantAuthority): ToolGrant {
  return Object.freeze({ buildId, authority, capabilities: new Set(ALL_CAPS.filter((c) => c !== "journal.read")) });
}

/** An IDE over MCP: the whole limited surface, its journal included. */
export function mcpGrant(buildId: string): ToolGrant {
  return Object.freeze({ buildId, authority: { kind: "mcp-key" } as const, capabilities: new Set(ALL_CAPS) });
}

export function grantAllows(grant: ToolGrant, name: string): name is BrokeredToolName {
  if (!Object.hasOwn(TOOL_POLICIES, name)) return false;
  return (TOOL_POLICIES as Record<string, ToolPolicy>)[name]!.needs.every((c) => grant.capabilities.has(c));
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** A path inside the workspace or /data: relative, forward slashes, no escape. */
export function safeRelativePath(p: string): boolean {
  if (p.length === 0 || p.includes("\u0000") || p.includes("\\") || /^[A-Za-z]:/.test(p)) return false;
  const parts = p.replace(/^\/+/, "").split("/");
  return !parts.some((x) => x === ".." || x === ".") && !p.startsWith("//");
}

/** A path on the staging copy: origin-relative, never a URL or another host, no header injection. */
export function stagingRequestPath(p: string): boolean {
  if (!p.startsWith("/") || p.startsWith("//") || /[\r\n\u0000\\]/.test(p) || /\s/.test(p)) return false;
  try {
    const u = new URL(p, "http://staging.invalid");
    return u.host === "staging.invalid";
  } catch {
    return false;
  }
}

/** Why the arguments are refused, or null when they fit the tool's exact shape. */
export function checkToolArgs(name: BrokeredToolName, args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "arguments must be an object";
  const policy = TOOL_POLICIES[name] as ToolPolicy;
  const a = args as Record<string, unknown>;
  for (const k of Object.keys(a)) {
    if (!Object.hasOwn(policy.args, k)) return `${name} takes no argument "${k.slice(0, 40)}"`;
  }
  for (const [k, spec] of Object.entries(policy.args)) {
    const v = a[k];
    if (v === undefined) {
      if (spec.required) return `${name} needs "${k}"`;
      continue;
    }
    if (spec.kind === "boolean" ? typeof v !== "boolean" : typeof v !== "string") return `"${k}" must be a ${spec.kind}`;
    if (typeof v === "string" && spec.max !== undefined && Buffer.byteLength(v, "utf8") > spec.max) return `"${k}" is too long`;
  }
  switch (name) {
    case "read_file":
    case "write_file":
    case "delete_file":
      if (!safeRelativePath(String(a.path)) || String(a.path).startsWith("/")) return "paths are relative to the workspace, with no '..'";
      break;
    case "read_data_file":
    case "list_data_files":
      if (a.path !== undefined && !safeRelativePath(String(a.path).replace(/^\/data\/?/, "") || "x")) return "paths are inside /data, with no '..'";
      break;
    case "check_app":
      if (!stagingRequestPath(String(a.path))) return "check_app takes a path on the test copy, starting with /; never a URL or another host";
      if (a.method !== undefined && !METHODS.has(String(a.method).toUpperCase())) return "unsupported method";
      break;
    case "request_env_var":
      if (!ENV_NAME.test(String(a.name))) return "env var names are letters, digits and _";
      break;
    case "query_db":
    case "list_tables":
      if (a.store !== undefined && !/^[a-z][a-z0-9_-]{0,63}$/.test(String(a.store))) return "store is one of the app's own store names";
      break;
  }
  return null;
}

export interface BrokerResult {
  text: string;
  isError?: boolean;
  journalSummary?: string;
  journalDetail?: string;
  environment?: import("./environmentFailure.js").EnvironmentFailure;
}

export interface AiToolBrokerOptions {
  grant: ToolGrant;
  /** The dispatch behind the gate (BuildToolHost's own). */
  dispatch: (name: BrokeredToolName, args: Record<string, unknown>) => Promise<BrokerResult>;
  redact?: ModelRedactor;
  /** Exact secret values the box holds for this session (provider key, owner env values). */
  secrets?: () => readonly string[] | Promise<readonly string[]>;
  /** True once the build is sealed: every call refuses. */
  sealed?: () => boolean;
  /** At most this many calls in a session (default 2,000). */
  maxCalls?: number;
  /** A refusal, for the journal (value-free). */
  onRefused?: (name: string, why: string) => void;
}

export class ToolRefused extends Error {}

/** One brokered session. */
export class AiToolBroker {
  private revoked: string | null = null;
  private readonly aborts = new Set<() => void>();
  private calls = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: AiToolBrokerOptions) {}

  get grant(): ToolGrant {
    return this.o.grant;
  }

  /** The tools this session may call, for the model's tool list. */
  allowedTools(): BrokeredToolName[] {
    return (Object.keys(TOOL_POLICIES) as BrokeredToolName[]).filter((n) => grantAllows(this.o.grant, n));
  }

  revoke(reason: string): void {
    if (this.revoked) return;
    this.revoked = reason;
    for (const a of [...this.aborts]) a();
  }

  isRevoked(): boolean {
    return this.revoked !== null;
  }

  private refuse(name: string, why: string, summary: string): BrokerResult {
    this.o.onRefused?.(name, why);
    return { text: JSON.stringify({ ok: false, error: why }), isError: true, journalSummary: summary };
  }

  /** What leaves the broker for the model: secrets cut, box-written text redacted. */
  async scrub(text: string, output: "box-written" | "repo-content"): Promise<string> {
    let out = text;
    const secrets = await Promise.resolve(this.o.secrets?.() ?? []).catch(() => [] as readonly string[]);
    for (const s of secrets) if (s.length >= 8) out = out.split(s).join("«redacted»");
    if (output === "box-written") out = (this.o.redact ?? ((t: string) => t))(redactSecrets(out));
    return out;
  }

  /** Calls run one at a time, in order; a revoked session refuses the queued ones. */
  async call(name: string, args: unknown): Promise<BrokerResult> {
    const run = this.chain.then(() => this.callNow(name, args));
    this.chain = run.catch(() => {});
    return await run;
  }

  private async callNow(name: string, args: unknown): Promise<BrokerResult> {
    const short = typeof name === "string" ? name.slice(0, 64) : "?";
    if (this.revoked) return this.scrubbed(this.refuse(short, "this build's AI session was stopped", `refused ${short}: revoked`));
    if (this.o.sealed?.()) return this.scrubbed(this.refuse(short, "this build is closed: the app was handed to the box, and its tools no longer answer", `refused ${short}: sealed`));
    if (typeof name !== "string" || !Object.hasOwn(TOOL_POLICIES, name)) return this.scrubbed(this.refuse(short, `unknown tool: ${short}`, `unknown tool: ${short}`));
    if (!grantAllows(this.o.grant, name)) return this.scrubbed(this.refuse(name, `${name} is not available in this session`, `refused ${name}: not granted`));
    if (++this.calls > (this.o.maxCalls ?? 2000)) return this.scrubbed(this.refuse(name, "this session has made too many tool calls", `refused ${name}: call cap`));
    const why = checkToolArgs(name, args);
    if (why) return this.scrubbed(this.refuse(name, why, `refused ${name}: arguments`));
    let cancel!: () => void;
    const cancelled = new Promise<BrokerResult>((resolve) => {
      cancel = () => resolve(this.refuse(name, "this build's AI session was stopped", `abandoned ${name}: revoked`));
    });
    this.aborts.add(cancel);
    try {
      const r = await Promise.race([
        this.o.dispatch(name, args as Record<string, unknown>).catch((e: unknown): BrokerResult => ({
          // A hook's own error is box-written: it goes out redacted like any result.
          text: JSON.stringify({ ok: false, error: `${name} failed: ${e instanceof Error ? e.message : "an error"}` }),
          isError: true,
          journalSummary: `${name}: failed`,
        })),
        cancelled,
      ]);
      if (this.revoked) return this.scrubbed(this.refuse(name, "this build's AI session was stopped", `abandoned ${name}: revoked`));
      return { ...r, text: await this.scrub(r.text, r.isError ? "box-written" : TOOL_POLICIES[name].output) };
    } finally {
      this.aborts.delete(cancel);
    }
  }

  private async scrubbed(r: BrokerResult): Promise<BrokerResult> {
    return { ...r, text: await this.scrub(r.text, "box-written") };
  }
}
