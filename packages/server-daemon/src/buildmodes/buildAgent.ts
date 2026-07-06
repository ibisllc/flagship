/**
 * The AGENTIC build loop — the box's own AI shaping a pulled repo into a
 * working Flagship app by DRIVING THE TOOL SURFACE, multi-turn, exactly the
 * way an external IDE agent would over MCP:
 *
 *     read_file → reason → write_file → validate → (fix) → deploy
 *
 * This is the realization of the product bar: "let the AI do the job" — the
 * model reads the repo + the platform contract and calls the provided
 * functions until the app validates and deploys. It is NOT a one-shot
 * text-to-files transform; it is a tool-calling conversation the model
 * controls.
 *
 * The model only ever touches the SAME `BuildToolHost` the MCP path uses,
 * so the two ways of building (box-AI vs. external IDE) are the identical
 * surface. The credential never reaches here — the caller supplies a
 * `ChatRunner` that has already bound the BYOK key (the harness opens it
 * just-in-time per call); flagshipserver.com is never in the path.
 *
 * Safety/cost bounds: a turn cap (the model can't loop forever), a tool-call
 * cap per turn, and tool-result truncation so a giant file read can't blow
 * the context. Tool errors are fed back (not thrown) so the model can
 * recover — e.g. fix an invalid manifest the `validate` tool rejected.
 */

import type { ChatMessage, ChatRequest, ChatResponse, ToolSpec } from "@flagship/llm-providers";
import type { BuildJournal } from "./buildJournal.js";
import type { BuildToolHost } from "./buildToolHost.js";
import { BUILD_TOOL_SPECS } from "./buildToolHost.js";

/**
 * The model call the agent makes each turn. Provider-agnostic: the caller
 * (the daemon wiring) binds the BYOK credential + model and forwards to
 * `LlmHarness.chatWithCredential`. Returns the full `ChatResponse` so the
 * agent can read `toolUses`. Throws on a provider/guard failure (the agent
 * journals a value-free reason and stops).
 */
export type ChatRunner = (req: ChatRequest) => Promise<ChatResponse>;

/**
 * The orchestrator-level agentic runner dep: like `ChatRunner` but given
 * the `buildId` so it can open THAT build's transient sealed BYOK
 * credential just-in-time. The orchestrator binds the buildId into a
 * `ChatRunner` closure before handing it to the loop.
 */
export type AgentRunner = (buildId: string, req: ChatRequest) => Promise<ChatResponse>;

export interface BuildAgentResult {
  /** A deploy tool call succeeded → the app is live. */
  deployed: boolean;
  deployedUrl?: string;
  serviceId?: string;
  /** The workspace ended with a top-level flagship.app.json. */
  manifestPresent: boolean;
  /** The last `validate` tool call reported ok (manifest + Dockerfile). */
  validated: boolean;
  /** How many model turns ran. */
  turns: number;
  /** Why the loop ended: the model stopped, deployed, or hit the turn cap. */
  stopReason: "deployed" | "model-stopped" | "turn-cap" | "error";
  /** Value-free: a human note when the loop ended without deploying. */
  note?: string;
}

export interface BuildAgentOptions {
  /** Hard cap on model turns (default 24). Bounds cost + runaway loops. */
  maxTurns?: number;
  /** Max tool calls honored in a single assistant turn (default 8). */
  maxToolCallsPerTurn?: number;
  /** Truncate a tool result fed back to the model to this many chars (default 24k). */
  maxToolResultChars?: number;
  /** Model id (the runner may also default it). */
  model?: string;
  /** maxTokens per model turn (default 4096 — enough for a file write). */
  maxTokens?: number;
}

const DEFAULTS = {
  maxTurns: 24,
  maxToolCallsPerTurn: 8,
  maxToolResultChars: 24_000,
  maxTokens: 4096,
} as const;

/**
 * System prompt for the AGENTIC adapt loop. Unlike the scratch
 * `SYSTEM_PROMPT_V1` (which locks a one-shot emit format), this prompt tells
 * the model it has TOOLS and must drive them: read the contract, inspect the
 * repo, write files, validate, then deploy. Kept small.
 */
export const BUILD_AGENT_SYSTEM_PROMPT = `You are Flagship's app-adapter agent. You have been given an existing code repository and a set of TOOLS. Your job is to shape that repository into a working Flagship app — a containerised service the Flagship daemon will build, run, and front with TLS on the user's own box — by CALLING THE TOOLS. You are not writing a single answer; you are doing the work step by step with the tools until the app validates and deploys.

How to work:
1. Call get_contract FIRST to learn the platform's hard rules, the flagship.app.json manifest schema, and the FLAGSHIP_* env vars the daemon injects. The repository's files are ALREADY in your build workspace — call list_files and read_file to inspect what you were given.
2. Decide the smallest set of changes that make this repo a valid Flagship app: add a correct flagship.app.json, add or fix the Dockerfile (its final stage must EXPOSE the manifest runtime.port and start the app), make the app LISTEN ON the port the daemon injects as the PORT environment variable — read process.env.PORT (or the $PORT equivalent for the app's language) and bind 0.0.0.0:$PORT; this value equals your manifest runtime.port, so do NOT hardcode a port number — remove the app's own authentication (the daemon injects identity headers), and rewrite any persistence to the FLAGSHIP_* data-layer env vars. Keep the app's actual behaviour — adapt it, don't rewrite it from scratch.
3. write_file each change. Then call validate. If validate reports problems, fix them and validate again. Do NOT deploy until validate returns ok.
4. When validate is ok, call deploy. deploy builds the container and installs the app; it returns the live URL. After a successful deploy you are DONE — stop.

Rules you must respect (the harness enforces them; breaking them fails the build):
- Do NOT write authentication, login forms, passwords, cookies, or JWTs. Read X-Flagship-User / X-Flagship-Role from request headers.
- Listen on the injected PORT env var (process.env.PORT / $PORT), which equals runtime.port. Bind 0.0.0.0:$PORT. No hardcoded port, no second port.
- Do NOT persist to the container filesystem (wiped each deploy). Use FLAGSHIP_PG_URL / FLAGSHIP_S3_* / FLAGSHIP_REDIS_URL when the app needs storage. A static or in-memory app needs no data stores — omit data.stores.
- Do NOT define env vars starting with FLAGSHIP_ (reserved). If the app genuinely needs an owner secret, call request_env_var (value-free — you never see the value) and read it from the process environment at runtime.
- Do NOT hardcode the username, hostname, or any flagship.services URL.

Be decisive. Prefer the simplest manifest that works (often no data stores, a single public route). Call deploy as soon as validate passes.`;

/**
 * Render the initial user message: a short instruction plus the repo file
 * list, so the model knows what it's starting from. (The files themselves
 * are read via the read_file tool — we don't dump them all here, the model
 * pulls what it needs. We DO list paths so it can plan.)
 */
function initialUserMessage(repoFiles: string[], extra?: string): string {
  const list = repoFiles.length > 0 ? repoFiles.map((p) => `  - ${p}`).join("\n") : "  (empty)";
  const base =
    `Adapt the repository now in your build workspace into a Flagship app, using the tools.\n\n` +
    `Files present (${repoFiles.length}):\n${list}\n\n` +
    `Start by calling get_contract, then inspect the files you need with read_file. ` +
    `When you have written a valid flagship.app.json + Dockerfile and validate passes, call deploy.`;
  const steer = (extra ?? "").trim();
  return steer.length > 0 ? `${base}\n\nExtra instructions from the owner: ${steer}` : base;
}

function toolSpecs(): ToolSpec[] {
  // The agent exposes the same surface as MCP, minus get_journal/get_logs
  // (the model doesn't need its own journal to build, and logs only exist
  // post-deploy). Keeping the set tight reduces token cost + mis-calls.
  const drop = new Set(["get_journal"]);
  return BUILD_TOOL_SPECS.filter((t) => !drop.has(t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/**
 * Run the agentic adapt loop. Returns when the model deploys, stops calling
 * tools, errors, or hits the turn cap. Never throws — a provider failure
 * mid-loop is captured as `stopReason: "error"`.
 */
export async function runBuildAgent(args: {
  buildId: string;
  runner: ChatRunner;
  tools: BuildToolHost;
  journal: BuildJournal;
  repoFiles: string[];
  instructions?: string;
  options?: BuildAgentOptions;
}): Promise<BuildAgentResult> {
  const opts = { ...DEFAULTS, ...(args.options ?? {}) };
  const specs = toolSpecs();
  const messages: ChatMessage[] = [
    { role: "system", content: BUILD_AGENT_SYSTEM_PROMPT },
    { role: "user", content: initialUserMessage(args.repoFiles, args.instructions) },
  ];

  let deployed = false;
  let deployedUrl: string | undefined;
  let serviceId: string | undefined;
  let validated = false;
  let turns = 0;

  for (let i = 0; i < opts.maxTurns; i++) {
    turns = i + 1;
    let resp: ChatResponse;
    try {
      const req: ChatRequest = {
        model: opts.model ?? "",
        messages,
        tools: specs,
        maxTokens: opts.maxTokens,
      };
      resp = await args.runner(req);
    } catch (e) {
      const note = `adapt model call failed: ${(e as Error).message}`;
      await args.journal.append(args.buildId, { mode: "git", kind: "error", actor: "ai", summary: note });
      return { deployed, manifestPresent: false, validated, turns, stopReason: "error", note };
    }

    const toolUses = (resp.toolUses ?? []).slice(0, opts.maxToolCallsPerTurn);

    // No tool calls this turn ⇒ the model is done talking. (It either
    // finished, or asked a question — either way the loop ends; the caller
    // inspects the workspace for a manifest.)
    if (toolUses.length === 0) {
      await args.journal.append(args.buildId, {
        mode: "git",
        kind: "adapt-step",
        actor: "ai",
        summary: "model returned no tool calls — stopping",
      });
      return {
        deployed,
        ...(deployedUrl != null ? { deployedUrl } : {}),
        ...(serviceId != null ? { serviceId } : {}),
        manifestPresent: false,
        validated,
        turns,
        stopReason: "model-stopped",
        note: resp.content.slice(0, 200),
      };
    }

    // Record the assistant turn (with its tool calls) so the model keeps
    // memory of what it invoked when we resume.
    messages.push({ role: "assistant", content: resp.content, toolUses });

    // Dispatch each call through the SHARED tool host and collect results.
    const results: { toolUseId: string; name: string; content: string; isError?: boolean }[] = [];
    for (const tu of toolUses) {
      const r = await args.tools.call(tu.name, tu.input ?? {});
      results.push({
        toolUseId: tu.id,
        name: tu.name,
        content: truncate(r.text, opts.maxToolResultChars),
        ...(r.isError ? { isError: true } : {}),
      });
      if (tu.name === "validate" && !r.isError) {
        try {
          validated = (JSON.parse(r.text) as { ok?: boolean }).ok === true;
        } catch {
          /* leave validated as-is */
        }
      }
      if (tu.name === "deploy" && !r.isError) {
        try {
          const parsed = JSON.parse(r.text) as { ok?: boolean; url?: string; serviceId?: string };
          if (parsed.ok) {
            deployed = true;
            deployedUrl = parsed.url;
            serviceId = parsed.serviceId;
          }
        } catch {
          /* a malformed deploy result is treated as not-deployed */
        }
      }
    }

    // Feed the results back as a tool turn.
    messages.push({ role: "tool", content: "", toolResults: results });

    // A successful deploy is the terminal success — stop.
    if (deployed) {
      return {
        deployed: true,
        ...(deployedUrl != null ? { deployedUrl } : {}),
        ...(serviceId != null ? { serviceId } : {}),
        manifestPresent: true,
        validated,
        turns,
        stopReason: "deployed",
      };
    }
  }

  await args.journal.append(args.buildId, {
    mode: "git",
    kind: "adapt-step",
    actor: "ai",
    summary: `hit the ${opts.maxTurns}-turn cap without deploying`,
  });
  return {
    deployed,
    ...(deployedUrl != null ? { deployedUrl } : {}),
    ...(serviceId != null ? { serviceId } : {}),
    manifestPresent: false,
    validated,
    turns,
    stopReason: "turn-cap",
    note: "the agent reached its turn limit",
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… [truncated ${s.length - max} chars]`;
}
