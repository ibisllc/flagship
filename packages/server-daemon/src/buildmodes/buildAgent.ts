/**
 * The AGENTIC build loop — the box's own AI shaping a pulled repo into a
 * working Flagship app by DRIVING THE TOOL SURFACE, multi-turn, exactly the
 * way an external IDE agent would over MCP:
 *
 *     read_file → write_file → validate → deploy (staging) → check_app /
 *     get_logs / query_db … → (fix, deploy again) → finish
 *
 * This is the realization of the product bar: "let the AI do the job" — the
 * model reads the repo + the platform contract and calls the provided
 * functions until the app works on its private staging copy and the model
 * calls finish. It never sees the app live: the box seals the build and puts
 * it live after the loop (docs/ai-privacy-and-staging.md). It is NOT a one-shot
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
import type { BuildJournal, BuildMode } from "./buildJournal.js";
import type { BuildToolHost } from "./buildToolHost.js";
import { BUILD_TOOL_SPECS } from "./buildToolHost.js";
import type { EnvironmentFailure } from "./environmentFailure.js";

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
  /** The model called finish and the box accepted it. */
  finished: boolean;
  /** A deploy (to staging) succeeded at least once. */
  staged: boolean;
  /** The workspace ended with a top-level flagship.app.json. */
  manifestPresent: boolean;
  /** The last `validate` tool call reported ok (manifest + Dockerfile). */
  validated: boolean;
  /** How many model turns ran. */
  turns: number;
  /**
   * Why the loop ended: the model finished, stopped, hit the turn cap, or the
   * box itself failed (`environment`), which no change to the app can fix.
   */
  stopReason: "finished" | "model-stopped" | "turn-cap" | "error" | "environment";
  /** Value-free: a human note when the loop ended without finishing. */
  note?: string;
  /** The box's own failure that ended the loop (stopReason "environment"). */
  environment?: EnvironmentFailure;
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
  /** maxTokens per model turn. Unset: the provider's own default, which is its ceiling. */
  maxTokens?: number;
}

const DEFAULTS = {
  maxTurns: 24,
  maxToolCallsPerTurn: 8,
  maxToolResultChars: 24_000,
} as const;

/**
 * System prompt for the AGENTIC adapt loop. Unlike the scratch
 * `SYSTEM_PROMPT_V1` (which locks a one-shot emit format), this prompt tells
 * the model it has TOOLS and must drive them: read the contract, inspect the
 * repo, write files, validate, deploy a test copy, test it, then finish.
 * Kept small.
 */
export const BUILD_AGENT_SYSTEM_PROMPT = `You are Flagship's app-adapter agent. You have been given an existing code repository and a set of TOOLS. Your job is to shape that repository into a working Flagship app — a containerised service the Flagship daemon will build, run, and front with TLS on the user's own box — by CALLING THE TOOLS. You are not writing a single answer; you are doing the work step by step with the tools until a test copy of the app works and you call finish.

How to work:
1. Call get_contract FIRST to learn the platform's hard rules, the flagship.app.json manifest schema, and the FLAGSHIP_* env vars the daemon injects. The repository's files are ALREADY in your build workspace — call list_files and read_file to inspect what you were given.
2. Change as little as you can. The author keeps developing this repo for ordinary servers; your changes should sit beside their code, not rewrite it, so they can keep building the app the way they do now and a later re-import only has to revisit flagship.app.json. Prefer ADDING files (flagship.app.json) over editing theirs. Edit an existing file only where a rule below forces it, keep each such edit as small as possible (read config from environment variables rather than restructuring code), and never reformat, rename, move, or "improve" code that already works. Decide the smallest set of changes that make this repo a valid Flagship app: add a correct flagship.app.json whose runtime.base fits the repo (node-24, python-3.13 or static; the box builds the app on it and runs runtime.start; you can't write a Dockerfile, and a repo that fits none of them keeps its own Dockerfile unchanged), make the app LISTEN ON the port the daemon injects as the PORT environment variable — read process.env.PORT (or the $PORT equivalent for the app's language) and bind 0.0.0.0:$PORT; this value equals your manifest runtime.port, so do NOT hardcode a port number — switch the app's own sign-in to the identity headers the daemon injects (unless the owner asked to keep their own sign-in), and rewrite any persistence to the FLAGSHIP_* data-layer env vars. Keep the app's actual behaviour — adapt it, don't rewrite it from scratch.
3. write_file each change. Then call validate. If validate reports problems, fix them and validate again. Do NOT deploy until validate returns ok.
4. When validate is ok, call deploy. deploy builds the container and starts a PRIVATE TEST COPY of the app on the box, with sample data and no internet; nobody else can reach it. It tells you whether the app built and started, and why not.
5. Test the copy: call check_app with a path (start with "/", then the app's main pages or API routes) to see what it answers, and get_logs to read its output. To see what the app stored, use list_tables and query_db (its database) and list_data_files / read_data_file (its /data folder); the copy holds sample data only. If it doesn't build, doesn't start, or answers with errors, fix the files, validate, and deploy again.
6. When the test copy works, call finish. The box then puts the app live by itself; you won't see it again, and your tools stop working. finish only works after a successful deploy of the files as they are now, so deploy again after any change.

Rules you must respect (the harness enforces them; breaking them fails the build):
- Sign-in: prefer Flagship identity, and suggest it to the owner: read X-Flagship-User / X-Flagship-Role from the request headers, no login code or passwords. Keep or build the app's own sign-in only when the owner asks for it, and then follow the contract's sign-in rule (slow salted password hashes, social sign-in secrets via request_env_var, login/callback paths in public_routes, sessions in Postgres, Secure HttpOnly SameSite=Lax cookies, CSRF protection, rate-limited logins).
- WebSockets and Server-Sent Events pass through to the app. Machine clients use API keys the owner creates (the box checks them and injects X-Flagship-User: apikey:<keyId>); don't build another API-key system.
- Listen on the injected PORT env var (process.env.PORT / $PORT), which equals runtime.port. Bind 0.0.0.0:$PORT. No hardcoded port, no second port.
- Do NOT persist to the container filesystem (wiped each deploy). Store data in Postgres (FLAGSHIP_PG_URL) and files in FLAGSHIP_FILES_DIR (data.stores.files: true), with file metadata in Postgres and files served through the app's own routes. S3 and Redis are NOT available: move an app's S3, Redis or SQLite use onto these, as the contract's "Storing things" section says (cache = UNLOGGED table, pub/sub = LISTEN/NOTIFY, queue = SKIP LOCKED, search = tsvector or pg_trgm, embeddings = vector, schedules = an in-app timer). A static or in-memory app needs no data stores — omit data.stores.
- Do NOT define env vars starting with FLAGSHIP_ (reserved). If the app genuinely needs an owner secret, call request_env_var (value-free — you never see the value) and read it from the process environment at runtime.
- Do NOT hardcode the username, hostname, or any flagship.services URL.

Be decisive. Prefer the simplest manifest that works (often no data stores, a single public route). Deploy as soon as validate passes, test it, and call finish once it works.`;

/**
 * Render the initial user message: a short instruction plus the repo file
 * list, so the model knows what it's starting from. (The files themselves
 * are read via the read_file tool — we don't dump them all here, the model
 * pulls what it needs. We DO list paths so it can plan.)
 */
const LISTED_FILES = 400;

function listing(paths: string[]): string {
  if (paths.length === 0) return "  (none)";
  const shown = paths.slice(0, LISTED_FILES).map((p) => `  - ${p}`).join("\n");
  return paths.length > LISTED_FILES ? `${shown}\n  … and ${paths.length - LISTED_FILES} more (call list_files)` : shown;
}

function initialUserMessage(repoFiles: string[], extra?: string, binaryFiles: string[] = []): string {
  const binaries = binaryFiles.length
    ? `Also in the repo, carried into the build unchanged (images, fonts and other non-text files; you can't read or edit them) (${binaryFiles.length}):\n${listing(binaryFiles)}\n\n`
    : "";
  const base =
    `Adapt the repository now in your build workspace into a Flagship app, using the tools.\n\n` +
    `Files present (${repoFiles.length}):\n${listing(repoFiles)}\n\n` +
    binaries +
    `Start by calling get_contract, then inspect the files you need with read_file. ` +
    `When you have written a valid flagship.app.json and validate passes, call deploy, ` +
    `test the copy with check_app and get_logs (and query_db / list_tables for its sample data), fix what's wrong, and call finish when it works.`;
  const steer = (extra ?? "").trim();
  return steer.length > 0 ? `${base}\n\nExtra instructions from the owner: ${steer}` : base;
}

function toolSpecs(): ToolSpec[] {
  // The agent exposes the same surface as MCP, minus get_journal (the model
  // doesn't need its own journal to build). Keeping the set tight reduces
  // token cost + mis-calls.
  const drop = new Set(["get_journal"]);
  return BUILD_TOOL_SPECS.filter((t) => !drop.has(t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/**
 * Run the agentic adapt loop. Returns when the model finishes, stops calling
 * tools, errors, or hits the turn cap. Never throws — a provider failure
 * mid-loop is captured as `stopReason: "error"`.
 */
export async function runBuildAgent(args: {
  buildId: string;
  runner: ChatRunner;
  tools: BuildToolHost;
  journal: BuildJournal;
  repoFiles: string[];
  /** Non-text files the build carries; the model can't see them. */
  binaryFiles?: string[];
  instructions?: string;
  options?: BuildAgentOptions;
  /** The first user message, in place of the repo-adapt one. */
  initialMessage?: string;
  /** Journal mode for the loop's own entries (default "git"). */
  mode?: BuildMode;
}): Promise<BuildAgentResult> {
  const opts = { ...DEFAULTS, ...(args.options ?? {}) };
  const mode: BuildMode = args.mode ?? "git";
  const specs = toolSpecs();
  const messages: ChatMessage[] = [
    { role: "system", content: BUILD_AGENT_SYSTEM_PROMPT },
    {
      role: "user",
      content: args.initialMessage ?? initialUserMessage(args.repoFiles, args.instructions, args.binaryFiles),
    },
  ];

  let finished = false;
  let staged = false;
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
        ...(args.options?.maxTokens != null ? { maxTokens: args.options.maxTokens } : {}),
      };
      resp = await args.runner(req);
    } catch (e) {
      const note = `adapt model call failed: ${(e as Error).message}`;
      await args.journal.append(args.buildId, { mode, kind: "error", actor: "ai", summary: note });
      return { finished, staged, manifestPresent: false, validated, turns, stopReason: "error", note };
    }

    const toolUses = (resp.toolUses ?? []).slice(0, opts.maxToolCallsPerTurn);

    // No tool calls this turn ⇒ the model is done talking. (It either
    // finished, or asked a question — either way the loop ends; the caller
    // inspects the workspace for a manifest.)
    if (toolUses.length === 0) {
      await args.journal.append(args.buildId, {
        mode,
        kind: "adapt-step",
        actor: "ai",
        summary: "model returned no tool calls — stopping",
      });
      return {
        finished,
        staged,
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
    let environment: EnvironmentFailure | undefined;
    for (const tu of toolUses) {
      const r = await args.tools.call(tu.name, tu.input ?? {});
      if (r.environment) {
        // The box is broken, not the app: the model never sees it, so it
        // can't "fix" (rewrite, delete) the owner's files around it.
        environment = r.environment;
        break;
      }
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
      if (tu.name === "deploy" && !r.isError) staged = true;
      if (tu.name === "finish" && !r.isError) {
        // The build is sealed now; anything after finish in this turn
        // would be refused anyway.
        finished = true;
        break;
      }
    }

    if (environment) {
      await args.journal.append(args.buildId, {
        mode,
        kind: "error",
        actor: "system",
        summary: `stopped: ${environment.ownerReason}`,
      });
      return {
        finished,
        staged,
        manifestPresent: false,
        validated,
        turns,
        stopReason: "environment",
        note: environment.ownerReason,
        environment,
      };
    }

    // A successful finish is the terminal success — the box takes over.
    if (finished) {
      return { finished: true, staged, manifestPresent: true, validated, turns, stopReason: "finished" };
    }

    // Feed the results back as a tool turn.
    messages.push({ role: "tool", content: "", toolResults: results });
  }

  await args.journal.append(args.buildId, {
    mode,
    kind: "adapt-step",
    actor: "ai",
    summary: `hit the ${opts.maxTurns}-turn cap without finishing`,
  });
  return {
    finished,
    staged,
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
