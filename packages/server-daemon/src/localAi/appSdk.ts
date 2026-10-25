/**
 * The app SDK for the box-local model (AI02): an app whose manifest declares `localAi.inference`
 * gets `FLAGSHIP_AI_URL` (an OpenAI-compatible base URL on its own apps-gateway port), and calls to
 * it reach the local model server only while the owner's signed `flagship/local-ai-app-grant/v1`
 * allows it, within that grant's daily quotas.
 *
 * - The endpoint is the app's own: one owned gateway port per app that only that app's containers
 *   can open (the egress gateway cuts every other source), forwarded to a loopback listener bound
 *   to that app. The app proves nothing in-band; where the connection comes from is the identity.
 * - It carries only what the app sends. Nothing is mounted, no tool runs on the box, no other app's
 *   data or the owner's prompts are reachable: the only routes are `/v1/models` and
 *   `/v1/chat/completions`, the body is rebuilt from an allowlist, and prompt caching is off so one
 *   caller's prompt never shapes another's answer time.
 * - No cloud fallback: when the model isn't running the app gets 503 with the reason.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readStateFile, writeFileDurable } from "../durableFile.js";
import { LOCAL_AI_LIMITS, type LocalAiAppGrant } from "@flagship/protocol";
import { LocalAiUnavailable, type LocalInferenceService } from "./service.js";

export const MAX_SDK_BODY = 4 * 1024 * 1024;

const ALLOWED_BODY_KEYS = new Set([
  "messages", "max_tokens", "max_completion_tokens", "temperature", "top_p", "top_k", "min_p", "stop", "stream", "seed",
  "tools", "tool_choice", "response_format", "presence_penalty", "frequency_penalty", "repeat_penalty",
]);

export interface HeldGrant {
  grant: LocalAiAppGrant;
  signature: string;
}

export interface Usage {
  day: string;
  requests: number;
  tokens: number;
}

export class AppGrantStore {
  private grants: Record<string, HeldGrant> = {};
  private usage: Record<string, Usage> = {};

  constructor(
    private readonly dir: string,
    /** Re-verifies a held grant (signature, this server): a grant that no longer verifies is dropped. */
    private readonly verify: (g: HeldGrant) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    const r = await readStateFile(`${this.dir}/app-grants.json`);
    if (r.kind !== "ok") return;
    try {
      const v = JSON.parse(r.text) as { grants?: Record<string, HeldGrant>; usage?: Record<string, Usage> };
      for (const [id, g] of Object.entries(v.grants ?? {})) if (g?.grant?.serviceId === id && this.verify(g)) this.grants[id] = g;
      this.usage = v.usage ?? {};
    } catch {
      this.grants = {};
    }
  }

  private async save(): Promise<void> {
    await writeFileDurable(`${this.dir}/app-grants.json`, JSON.stringify({ grants: this.grants, usage: this.usage }));
  }

  get(serviceId: string): LocalAiAppGrant | null {
    const g = this.grants[serviceId]?.grant;
    return g && g.requestsPerDay > 0 ? g : null;
  }

  heldIssuedAt(serviceId: string): number | null {
    return this.grants[serviceId]?.grant.issuedAt ?? null;
  }

  /** A verified grant (or withdrawal) replaces the one held; an older one is refused by the caller. */
  async apply(g: HeldGrant): Promise<void> {
    this.grants[g.grant.serviceId] = g;
    await this.save();
  }

  async forget(serviceId: string): Promise<void> {
    delete this.grants[serviceId];
    delete this.usage[serviceId];
    await this.save();
  }

  serviceIds(): string[] {
    return Object.keys(this.grants);
  }

  today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  usageOf(serviceId: string): Usage {
    const u = this.usage[serviceId];
    return u && u.day === this.today() ? { ...u } : { day: this.today(), requests: 0, tokens: 0 };
  }

  /** Count one request before it runs; false when the day's requests are spent. */
  async admit(serviceId: string, reservedTokens: number): Promise<"ok" | "requests" | "tokens"> {
    const g = this.get(serviceId);
    if (!g) return "requests";
    const u = this.usageOf(serviceId);
    if (u.requests + 1 > g.requestsPerDay) return "requests";
    if (u.tokens + reservedTokens > g.tokensPerDay) return "tokens";
    u.requests += 1;
    u.tokens += reservedTokens;
    this.usage[serviceId] = u;
    await this.save().catch(() => {});
    return "ok";
  }

  /** Replace a reservation with what the call really used. */
  async settle(serviceId: string, reserved: number, used: number): Promise<void> {
    const u = this.usageOf(serviceId);
    u.tokens = Math.max(0, u.tokens - reserved + used);
    this.usage[serviceId] = u;
    await this.save().catch(() => {});
  }
}

export interface AppSdkDeps {
  service: LocalInferenceService;
  grants: AppGrantStore;
  /** The app is installed and its manifest declares `localAi.inference`. */
  declares: (serviceId: string) => boolean;
  /** Owned gateway ports: one per app, opened to that app's containers only. */
  links: () => {
    gateway(): string | null;
    link(port: number, target: { host: string; port: number }, owner: string): Promise<boolean>;
    unlink(port: number): Promise<void>;
  } | null;
  portFor: (key: string) => Promise<number>;
  /** The alias apps reach the gateway by (`host.flagship.internal`). */
  hostAlias: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  log?: (m: string) => void;
}

function jsonError(res: ServerResponse, status: number, code: string, message: string): void {
  const body = JSON.stringify({ error: { message, type: "flagship_local_ai", code } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** The app's request, rebuilt from the allowlist; null when it isn't a chat request. */
export function sanitizeChatBody(raw: unknown, grant: LocalAiAppGrant, modelId: string): { body: Record<string, unknown>; reserved: number } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.messages) || r.messages.length === 0 || r.messages.length > 512) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) if (ALLOWED_BODY_KEYS.has(k)) out[k] = v;
  const asked = typeof r.max_tokens === "number" ? r.max_tokens : typeof r.max_completion_tokens === "number" ? r.max_completion_tokens : grant.maxTokensPerRequest;
  const maxTokens = Math.max(1, Math.min(Math.floor(asked), grant.maxTokensPerRequest, LOCAL_AI_LIMITS.maxTokensPerRequest));
  delete out.max_completion_tokens;
  out.max_tokens = maxTokens;
  out.model = modelId;
  out.cache_prompt = false;
  out.n = 1;
  if (out.stream === true) out.stream_options = { include_usage: true };
  const promptChars = JSON.stringify(out.messages).length;
  return { body: out, reserved: maxTokens + Math.ceil(promptChars / 4) };
}

/** One app's listener: what its gateway port forwards to. */
export function appSdkHandler(serviceId: string, d: AppSdkDeps) {
  const fetchImpl = d.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0];
    if (!d.declares(serviceId)) return jsonError(res, 403, "local-ai-not-declared", "This app doesn't ask to use the server's AI model.");
    const grant = d.grants.get(serviceId);
    if (!grant) return jsonError(res, 403, "local-ai-not-allowed", "The owner hasn't allowed this app to use the server's AI model.");
    if (req.method === "GET" && path === "/v1/models") {
      const models = d.service.menuModels();
      const body = JSON.stringify({ object: "list", data: models.map((m) => ({ id: m.id, object: "model", owned_by: "this-server" })) });
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(body);
    }
    if (req.method !== "POST" || path !== "/v1/chat/completions") return jsonError(res, 404, "not-found", "Only /v1/models and /v1/chat/completions are here.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_SDK_BODY) return jsonError(res, 413, "too-large", "The request is too large.");
      chunks.push(c as Buffer);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return jsonError(res, 400, "bad-json", "The body must be JSON.");
    }
    let lease;
    try {
      lease = await d.service.lease();
    } catch (e) {
      return jsonError(res, 503, "local-ai-unavailable", e instanceof LocalAiUnavailable ? e.message : "The server's AI model isn't available.");
    }
    try {
      const s = sanitizeChatBody(raw, grant, lease.modelId);
      if (!s) return jsonError(res, 400, "bad-request", "Send messages in the OpenAI chat format.");
      const admitted = await d.grants.admit(serviceId, s.reserved);
      if (admitted !== "ok") return jsonError(res, 429, "quota", admitted === "tokens" ? "This app has used its AI allowance for today." : "This app has made its AI requests for today.");
      const up = await fetchImpl(`${lease.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${lease.apiKey}` },
        body: JSON.stringify(s.body),
      });
      if (s.body.stream === true && up.body) {
        res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-store" });
        let used: number | null = null;
        const dec = new TextDecoder();
        for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) {
          const t = dec.decode(chunk, { stream: true });
          const m = /"total_tokens"\s*:\s*(\d+)/.exec(t);
          if (m) used = Number(m[1]);
          res.write(chunk);
        }
        res.end();
        await d.grants.settle(serviceId, s.reserved, used ?? s.reserved);
        return;
      }
      const text = await up.text();
      let used = s.reserved;
      try {
        const j = JSON.parse(text) as { usage?: { total_tokens?: number } };
        if (typeof j.usage?.total_tokens === "number") used = j.usage.total_tokens;
      } catch {
        // passed through as it came
      }
      await d.grants.settle(serviceId, s.reserved, used);
      res.writeHead(up.status, { "content-type": "application/json" });
      res.end(text);
    } catch {
      if (!res.headersSent) jsonError(res, 502, "local-ai-failed", "The server's AI model didn't answer.");
      else res.end();
    } finally {
      lease.release();
    }
  };
}

/** Every declaring app's endpoint: a loopback listener and its owned gateway port. */
export class AppSdkEndpoints {
  private readonly open = new Map<string, { server: Server; loopPort: number; ownedPort: number }>();

  constructor(private readonly d: AppSdkDeps) {}

  /** The app's environment: its endpoint, when the app declares the capability and the gateway can route it. */
  async envFor(serviceId: string, declares: boolean): Promise<Record<string, string>> {
    if (!declares) {
      await this.close(serviceId);
      return {};
    }
    const links = this.d.links();
    if (!links?.gateway()) return {};
    let e = this.open.get(serviceId);
    if (!e) {
      const server = createServer((req, res) => void appSdkHandler(serviceId, this.d)(req, res));
      const loopPort = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const a = server.address();
          resolve(typeof a === "object" && a ? a.port : 0);
        });
      });
      const ownedPort = await this.d.portFor(`ai:${serviceId}`);
      const ok = await links.link(ownedPort, { host: "127.0.0.1", port: loopPort }, serviceId);
      if (!ok) {
        server.close();
        return {};
      }
      e = { server, loopPort, ownedPort };
      this.open.set(serviceId, e);
    }
    return { FLAGSHIP_AI_URL: `http://${this.d.hostAlias}:${e.ownedPort}/v1` };
  }

  async close(serviceId: string): Promise<void> {
    const e = this.open.get(serviceId);
    if (!e) return;
    this.open.delete(serviceId);
    await this.d.links()?.unlink(e.ownedPort).catch(() => {});
    await new Promise<void>((r) => e.server.close(() => r()));
  }

  async sweep(installed: (serviceId: string) => boolean): Promise<void> {
    for (const id of [...this.open.keys()]) if (!installed(id)) await this.close(id);
  }

  openIds(): string[] {
    return [...this.open.keys()];
  }
}
