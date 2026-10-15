/**
 * A scripted stand-in for DeepInfra (`--mock`): no network, no key, no cost.
 * It answers the OpenAI-compatible requests the shim sends upstream the way
 * a well-behaved model would, so the whole loop (chat → owner answers →
 * build check → fix loop → edits) runs end to end:
 *
 *  - in a chat turn it may ask the owner a question (talkToUser) or for an
 *    env var (requestEnvVar), then writes a small app in the
 *    `=== path ===` format (with a syntax error on the first build when the
 *    scenario's mock hints say `break`);
 *  - in the fix loop it reads the broken file, writes the fixed one,
 *    validates, deploys, checks "/" and calls finish;
 *  - a summariser request gets a short summary.
 *
 * Token usage is estimated from the characters (4 per token), and cached
 * prompt tokens from the prefix shared with the run's previous request, so
 * the accounting has realistic shapes to work on. Its numbers measure the
 * harness, never a model.
 */

import type { MockHints } from "./scenarios.js";

interface OpenAiMessage {
  role: string;
  content?: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface UpstreamBody {
  model?: string;
  messages: OpenAiMessage[];
  tools?: Array<{ function?: { name?: string } }>;
  stream?: boolean;
  max_tokens?: number;
}

export interface MockTurn {
  content: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

const SUMMARISER_HEAD = "You condense the earlier part";
const EDIT_MARK = "# You are changing an app that is already running";

function text(m: OpenAiMessage | undefined): string {
  if (!m?.content) return "";
  if (typeof m.content === "string") return m.content;
  return m.content.map((p) => p.text ?? "").join("");
}

/** A small app of the hinted kind; `broken` puts a syntax error in its entry file. */
export function mockApp(
  hints: MockHints,
  opts: { name: string; version: string; broken?: boolean; feature?: string },
): { files: Record<string, string>; entry: string } {
  const feature = opts.feature ?? "first version";
  const manifest = (runtime: Record<string, unknown>, stores?: Record<string, unknown>) =>
    JSON.stringify(
      {
        schema_version: 1,
        name: opts.name,
        version: opts.version,
        description: "Built by the mock model",
        runtime,
        ...(stores ? { data: { stores } } : {}),
        network: { subdomain: opts.name },
        access: {
          enabled: true,
          default_role: "member",
          role_descriptions: {
            member: "Uses the app",
            manager: "Also edits everyone's entries",
            master: "Also changes the settings",
          },
          public_routes: ["/"],
        },
        migration: { verification: "standard" },
      },
      null,
      2,
    ) + "\n";
  const close = opts.broken ? "" : "}";
  switch (hints.kind) {
    case "static":
      return {
        entry: "public/index.html",
        files: {
          "flagship.app.json": manifest({ base: "static", root: "public", port: 8080 }),
          "public/index.html": `<!doctype html>\n<html><head><meta charset="utf-8"><title>${opts.name}</title><link rel="stylesheet" href="style.css"></head>\n<body><h1>${opts.name}</h1><p>${feature}</p></body></html>\n`,
          "public/style.css": "body { font-family: system-ui, sans-serif; margin: 2rem; }\n",
        },
      };
    case "python":
      return {
        entry: "app.py",
        files: {
          "flagship.app.json": manifest({ base: "python-3.13", start: ["python", "app.py"], port: 8000 }),
          "requirements.txt": "",
          "app.py":
            "import os\nfrom http.server import BaseHTTPRequestHandler, HTTPServer\n\n" +
            `class Handler(BaseHTTPRequestHandler)${opts.broken ? "" : ":"}\n` +
            "    def do_GET(self):\n" +
            "        body = b'" + feature.replace(/'/g, "") + "'\n" +
            "        self.send_response(200)\n        self.send_header('content-type', 'text/plain')\n        self.end_headers()\n        self.wfile.write(body)\n\n" +
            "HTTPServer(('0.0.0.0', int(os.environ.get('PORT', '8000'))), Handler).serve_forever()\n",
        },
      };
    default: {
      const pg = hints.kind === "node-pg";
      const filesDir = hints.kind === "node-files";
      const deps: Record<string, string> = pg ? { pg: "^8.13.0" } : {};
      const files: Record<string, string> = {
        "flagship.app.json": manifest(
          { base: "node-24", port: 3000 },
          pg ? { postgres: true } : filesDir ? { files: true } : undefined,
        ),
        "package.json":
          JSON.stringify(
            { name: opts.name, version: opts.version, type: "module", scripts: { start: "node src/server.js" }, dependencies: deps },
            null,
            2,
          ) + "\n",
        "src/server.js":
          `import { createServer } from "node:http";\n` +
          (pg ? `import pg from "pg";\nconst pool = new pg.Pool({ connectionString: process.env.FLAGSHIP_PG_URL });\n` : "") +
          (filesDir ? `import { readdir } from "node:fs/promises";\nconst dir = process.env.FLAGSHIP_FILES_DIR ?? "/data";\n` : "") +
          `const port = Number(process.env.PORT ?? 3000);\n` +
          `createServer(async (req, res) => {\n` +
          `  const who = req.headers["x-flagship-user"] ?? "anonymous";\n` +
          (pg ? `  const { rows } = await pool.query("SELECT count(*)::int AS n FROM items");\n` : `  const rows = [{ n: 0 }];\n`) +
          (filesDir ? `  const names = await readdir(dir).catch(() => []);\n` : `  const names = [];\n`) +
          `  res.writeHead(200, { "content-type": "application/json" });\n` +
          `  res.end(JSON.stringify({ app: ${JSON.stringify(opts.name)}, feature: ${JSON.stringify(feature)}, who, items: rows[0].n, files: names.length }));\n` +
          `}).listen(port, "0.0.0.0");\n` +
          (opts.broken ? `function unfinished() {\n  return 1;\n${close}` : ""),
      };
      if (pg) files["migrations/0001_init.sql"] = "CREATE TABLE items (id serial PRIMARY KEY, title text NOT NULL, created_at timestamptz DEFAULT now());\n";
      return { entry: "src/server.js", files };
    }
  }
}

function emit(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([p, c]) => `=== ${p} ===\n${c.endsWith("\n") ? c : c + "\n"}`)
    .join("") + "=== END ===\n";
}

/** The app's slug and version from the prompt (an edit's current files, else the owner's name). */
function appIdentity(system: string, firstUser: string): { name: string; version: string } {
  const manifest = /=== flagship\.app\.json ===\n([\s\S]*?)\n=== /.exec(system)?.[1];
  if (manifest) {
    try {
      const m = JSON.parse(manifest) as { name?: string; version?: string };
      if (m.name && m.version) return { name: m.name, version: m.version };
    } catch {
      /* fall through */
    }
  }
  const named = /The owner named this service "([a-z0-9-]+)"/.exec(system)?.[1];
  const words = firstUser.toLowerCase().match(/[a-z]+/g) ?? ["app"];
  return { name: named ?? words.slice(0, 2).join("-").slice(0, 30) ?? "app", version: "0.1.0" };
}

function bump(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : "0.1.1";
}

/** What the mock answers to one request. */
export function mockTurn(body: UpstreamBody, hints: MockHints): MockTurn {
  const msgs = body.messages;
  const system = text(msgs[0]);
  if (system.startsWith(SUMMARISER_HEAD)) {
    return { content: "Notes: the owner asked for a small app; files were written; the build check is the open item.", toolCalls: [] };
  }
  const tools = new Set((body.tools ?? []).map((t) => t.function?.name ?? ""));
  const users = msgs.filter((m) => m.role === "user");
  const firstUser = text(users[0]);

  if (tools.has("finish")) {
    // The staged fix loop: one step per turn.
    const done = msgs.filter((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0).length;
    const name = /"name":\s*"([a-z0-9-]+)"/.exec(msgs.map(text).join("\n"))?.[1] ?? "app";
    const fixed = mockApp(hints, { name, version: "0.1.0" });
    const steps: MockTurn["toolCalls"] = [
      { name: "read_file", args: { path: fixed.entry } },
      { name: "write_file", args: { path: fixed.entry, content: fixed.files[fixed.entry] } },
      { name: "validate", args: {} },
      { name: "deploy", args: {} },
      { name: "check_app", args: { path: "/" } },
      { name: "finish", args: {} },
    ];
    const step = steps[Math.min(done, steps.length - 1)]!;
    return { content: done === 0 ? "I'll look at the file the error points to." : "", toolCalls: [step] };
  }

  const edit = system.includes(EDIT_MARK);
  const { name, version } = appIdentity(system, firstUser);
  const asked = msgs.some((m) => m.role === "assistant");
  const envAcked = msgs.some((m) => text(m).startsWith("[tool_result:"));
  if (!edit && hints.ask && users.length < 2 && !asked) {
    return { content: "", toolCalls: [{ name: "talkToUser", args: { message: "Should anyone with the link be able to use it, or only people you invite?" } }] };
  }
  if (!edit && hints.envVar && !envAcked && tools.has("requestEnvVar")) {
    return {
      content: "",
      toolCalls: [
        { name: "requestEnvVar", args: { name: hints.envVar, description: "API key for the outside service", why: "The app calls it for its data.", secret: true } },
      ],
    };
  }
  if (edit) {
    const next = bump(version);
    const app = mockApp(hints, { name, version: next, feature: `change: ${text(users[users.length - 1]).slice(0, 60)}` });
    const changed = { "flagship.app.json": app.files["flagship.app.json"]!, [app.entry]: app.files[app.entry]! };
    return { content: `Here is the change.\n${emit(changed)}`, toolCalls: [] };
  }
  const app = mockApp(hints, { name, version, broken: hints.break === true });
  return { content: `Here is your app.\n${emit(app.files)}`, toolCalls: [] };
}

/** Rough tokens: 4 characters each. */
export function mockTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/**
 * The mock upstream: answers one shim request as DeepInfra would (an SSE
 * stream with a final usage chunk, or one JSON body). Keeps each run's last
 * prompt to estimate prefix-cache hits.
 */
export class MockUpstream {
  private readonly lastPrompt = new Map<string, string>();

  respond(rawBody: string, hints: MockHints, runId: string): Response {
    const body = JSON.parse(rawBody) as UpstreamBody;
    const turn = mockTurn(body, hints);
    const prompt = JSON.stringify({ messages: body.messages, tools: body.tools ?? [] });
    const prev = this.lastPrompt.get(runId) ?? "";
    this.lastPrompt.set(runId, prompt);
    const promptTokens = mockTokens(prompt.length);
    const cached = Math.min(promptTokens, Math.floor(mockTokens(commonPrefix(prev, prompt)) / 16) * 16);
    const calls = turn.toolCalls.map((c, i) => ({
      id: `call_${runId.slice(-6)}_${i}_${Math.random().toString(36).slice(2, 8)}`,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    }));
    const outChars = turn.content.length + calls.reduce((n, c) => n + c.function.name.length + c.function.arguments.length, 0);
    const completion = Math.min(mockTokens(outChars) + 8, body.max_tokens ?? Infinity);
    const usage = { prompt_tokens: promptTokens, completion_tokens: completion, total_tokens: promptTokens + completion, prompt_tokens_details: { cached_tokens: cached } };
    const finish = calls.length > 0 ? "tool_calls" : "stop";
    if (!body.stream) {
      return new Response(
        JSON.stringify({
          id: "mock",
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: turn.content, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finish }],
          usage,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const lines: string[] = [];
    const chunk = (delta: unknown, finishReason: string | null = null) =>
      lines.push(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    for (let i = 0; i < turn.content.length; i += 400) chunk({ content: turn.content.slice(i, i + 400) });
    calls.forEach((c, index) => chunk({ tool_calls: [{ index, ...c }] }));
    chunk({}, finish);
    lines.push(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [], usage })}\n\n`);
    lines.push("data: [DONE]\n\n");
    return new Response(lines.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  }
}
