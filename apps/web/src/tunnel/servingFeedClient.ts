/**
 * The relay's one connection to `.com`'s serving feed (docs/architecture-v2/serving-wiring.md §1 "Feed", §2):
 * revocations are applied with `applyRevocationEntries` under the revocation key pinned in this relay's config
 * (`FLAGSHIP_SERVING_REVOCATION_PUB`, never learnt from the feed) and acked; a gap is filled from
 * `/api/internal/serving-revocations?since=N`; `changed` re-reads a box; every frame (and pong) is contact, which
 * the gate's lost-contact rule counts on. Nothing is persisted: a fresh process reads from 0.
 */
import { WebSocket } from "ws";
import { applyRevocationEntries, type RevocationEntry } from "@flagship/protocol";
import type { ServingGate } from "./servingGate.js";

type SignedEntry = { entry: RevocationEntry; signature: string };

export type RevocationsSince = (since: number) => Promise<{ entries: SignedEntry[]; sequence: number } | null>;

export interface ServingFeedClientOptions {
  /** `.com`'s base URL (https); the feed is its `wss:` twin. */
  comBaseUrl: string;
  /** The services control secret, sent as a bearer token. */
  secret: string;
  relayId: string;
  /** The pinned revocation public key, 64 hex. */
  revocationKey: string;
  gate: ServingGate;
  /** Default: `GET <comBaseUrl>/api/internal/serving-revocations?since=N`. */
  revocationsSince?: RevocationsSince;
  fetchImpl?: typeof fetch;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** WebSocket ping cadence; a pong is contact too. Default 20 s. */
  pingMs?: number;
}

export interface ServingFeedStats {
  connected: boolean;
  reconnects: number;
  badEntries: number;
}

export class ServingFeedClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private catchingUp: Promise<void> | null = null;
  private catchUpAgain = false;
  private sawFrameThisConnection = false;
  private everConnected = false;
  private reconnects = 0;
  private badEntries = 0;
  private readonly revocationsSince: RevocationsSince;

  constructor(private readonly opts: ServingFeedClientOptions) {
    if (!/^[0-9a-f]{64}$/.test(opts.revocationKey)) throw new Error("serving revocation key must be 64 lowercase hex");
    this.backoff = opts.initialBackoffMs ?? 1_000;
    this.revocationsSince = opts.revocationsSince ?? defaultRevocationsSince(opts);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
    this.ws?.terminate();
    this.ws = null;
  }

  stats(): ServingFeedStats {
    return { connected: this.ws?.readyState === WebSocket.OPEN, reconnects: this.reconnects, badEntries: this.badEntries };
  }

  private feedUrl(): string {
    const u = new URL("/api/internal/serving-feed", this.opts.comBaseUrl);
    u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
    u.searchParams.set("relay", this.opts.relayId);
    return u.toString();
  }

  private connect(): void {
    if (this.stopped) return;
    this.sawFrameThisConnection = false;
    const ws = new WebSocket(this.feedUrl(), { headers: { authorization: `Bearer ${this.opts.secret}` } });
    this.ws = ws;
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", since: this.opts.gate.revocations.sequence }));
      this.stopPing();
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, this.opts.pingMs ?? 20_000);
      this.pingTimer.unref?.();
    });
    ws.on("pong", () => this.opts.gate.noteContact());
    ws.on("message", (raw) => {
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
      this.onFrame(frame as Record<string, unknown>);
    });
    ws.on("error", () => undefined);
    ws.on("close", () => {
      if (this.ws === ws) this.ws = null;
      this.stopPing();
      this.scheduleReconnect();
    });
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.round(this.backoff / 2 + Math.random() * (this.backoff / 2));
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnects += 1;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private onFrame(f: Record<string, unknown>): void {
    const gate = this.opts.gate;
    gate.noteContact();
    if (!this.sawFrameThisConnection) {
      this.sawFrameThisConnection = true;
      this.backoff = this.opts.initialBackoffMs ?? 1_000;
      // `changed` frames sent while the feed was down were missed.
      if (this.everConnected) void gate.refreshAll();
      this.everConnected = true;
    }
    if (f.type === "revocation") {
      if (typeof f.entry !== "object" || f.entry === null || typeof f.signature !== "string") return;
      this.apply([{ entry: f.entry as RevocationEntry, signature: f.signature }]);
      return;
    }
    if (f.type === "beat") {
      if (typeof f.sequence !== "number" || !Number.isSafeInteger(f.sequence)) return;
      gate.noteLatestSequence(f.sequence);
      if (f.sequence > gate.revocations.sequence) void this.catchUp();
      return;
    }
    if (f.type === "changed") {
      if (typeof f.username !== "string" || typeof f.boxPub !== "string") return;
      void gate.changed(f.username, f.boxPub);
    }
  }

  /** Apply in order; a gap reads the log since the last applied entry. */
  private apply(entries: SignedEntry[]): void {
    const gate = this.opts.gate;
    const r = applyRevocationEntries(gate.revocations, entries, this.opts.revocationKey);
    if (!r.ok) {
      if (r.reason === "gap") {
        void this.catchUp();
        return;
      }
      this.badEntries += 1;
      console.warn(`[serving-feed] refused revocation entry ${r.at}: ${r.reason}`);
      return;
    }
    for (const e of entries) gate.noteLatestSequence(e.entry.sequence);
    if (r.applied > 0) gate.adoptRevocations(r.state);
    this.ack(r.state.sequence);
  }

  private ack(sequence: number): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "ack", sequence }));
  }

  /** Single flight; a gap noticed while one runs reruns it once it ends. */
  catchUp(): Promise<void> {
    if (this.catchingUp) {
      this.catchUpAgain = true;
      return this.catchingUp;
    }
    this.catchingUp = (async () => {
      do {
        this.catchUpAgain = false;
        const gate = this.opts.gate;
        const got = await this.revocationsSince(gate.revocations.sequence);
        if (!got) break;
        gate.noteContact();
        gate.noteLatestSequence(got.sequence);
        const r = applyRevocationEntries(gate.revocations, got.entries, this.opts.revocationKey);
        if (!r.ok) {
          this.badEntries += 1;
          console.warn(`[serving-feed] catch-up stopped at entry ${r.at}: ${r.reason}`);
          break;
        }
        if (r.applied > 0) gate.adoptRevocations(r.state);
        this.ack(r.state.sequence);
        // A paged answer: keep reading while it moved us and more is known.
        if (r.applied > 0 && r.state.sequence < got.sequence) this.catchUpAgain = true;
      } while (this.catchUpAgain);
    })().finally(() => {
      this.catchingUp = null;
    });
    return this.catchingUp;
  }
}

function defaultRevocationsSince(opts: ServingFeedClientOptions): RevocationsSince {
  const base = opts.comBaseUrl.replace(/\/+$/, "");
  return async (since) => {
    try {
      const res = await (opts.fetchImpl ?? fetch)(`${base}/api/internal/serving-revocations?since=${since}`, {
        headers: { authorization: `Bearer ${opts.secret}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { entries?: unknown; sequence?: unknown };
      if (!Array.isArray(body.entries) || typeof body.sequence !== "number") return null;
      const entries: SignedEntry[] = [];
      for (const e of body.entries) {
        if (typeof e !== "object" || e === null) continue;
        const o = e as Record<string, unknown>;
        if (typeof o.entry === "object" && o.entry !== null && typeof o.signature === "string") {
          entries.push({ entry: o.entry as RevocationEntry, signature: o.signature });
        }
      }
      return { entries, sequence: body.sequence };
    } catch {
      return null;
    }
  };
}
