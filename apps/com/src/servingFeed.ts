/**
 * ServingFeed: the one Durable Object every relay keeps a WebSocket to (docs/architecture-v2/serving-wiring.md
 * §1). It pushes the signed revocation log, in order, and tells a relay which box's records changed.
 *
 *   relay → {type:"hello", since}                 replays every signed entry after `since`, then a beat
 *   .com  → {type:"revocation", entry, signature} in sequence order
 *   .com  → {type:"changed", username, boxPub}    a policy, lease or delegation changed: re-read that box
 *   .com  → {type:"beat", sequence}               every BEAT_MS while any relay is connected
 *   relay → {type:"ack", sequence}                kept in D1 `serving_relay_acks`
 *
 * Hibernatable: each socket's state lives in its attachment, the broadcast cursor in storage, and the beat
 * is an alarm that is only set while sockets are open. The Worker posts `{type:"flush"}` after a write that
 * can commit a revocation and `{type:"changed"}` after a policy, lease or delegation write.
 */
import type { D1Database } from "@flagship/storage";
import { revocationsSince, signPendingRevocations } from "./servingAuthority.js";

/** Relays treat 60 s without a frame as lost contact, so the beat comes well inside that. */
export const BEAT_MS = 30_000;
/** An unchanged ack is written again at most this often (it is also the relay's last-seen time). */
const ACK_REWRITE_MS = 5 * 60_000;
const MAX_FRAME_BYTES = 4096;
const CURSOR_KEY = "broadcast";
const RELAY_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export interface ServingFeedEnv {
  DB?: D1Database;
  SERVING_REVOCATION_SEED?: string;
}

export interface ServingFeedState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    setAlarm(time: number): Promise<void>;
    getAlarm(): Promise<number | null>;
  };
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

interface Attachment {
  relay: string;
  /** Replay done: live revocations go to this socket from now on. */
  ready: boolean;
  /** Highest sequence sent to it. */
  sent: number;
  acked: number;
  ackWrittenAt: number;
  superseded?: boolean;
}

type AttachableSocket = WebSocket & {
  serializeAttachment?(value: unknown): void;
  deserializeAttachment?(): unknown;
};

function readAttachment(ws: WebSocket): Attachment | null {
  const fn = (ws as AttachableSocket).deserializeAttachment;
  const v = typeof fn === "function" ? fn.call(ws) : null;
  return v && typeof v === "object" && typeof (v as Attachment).relay === "string" ? (v as Attachment) : null;
}

function writeAttachment(ws: WebSocket, a: Attachment): void {
  const fn = (ws as AttachableSocket).serializeAttachment;
  if (typeof fn === "function") fn.call(ws, a);
}

function send(ws: WebSocket, frame: unknown): boolean {
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

export class ServingFeed {
  constructor(
    private readonly state: ServingFeedState,
    private readonly env: ServingFeedEnv,
    private readonly now: () => number = Date.now,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const relay = url.searchParams.get("relay");
      if (!relay || !RELAY_ID.test(relay)) return Response.json({ error: "relay id required" }, { status: 400 });
      const pair = new WebSocketPair();
      await this.accept(pair[1], relay);
      return new Response(null, { status: 101, webSocket: pair[0] } as unknown as ResponseInit);
    }
    if (request.method === "POST" && url.pathname === "/notify") {
      let msg: unknown;
      try {
        msg = await request.json();
      } catch {
        msg = null;
      }
      const m = msg as { type?: unknown; username?: unknown; boxPub?: unknown } | null;
      if (m?.type === "flush") return Response.json({ sequence: await this.flush() });
      if (m?.type === "changed" && typeof m.username === "string" && typeof m.boxPub === "string") {
        this.broadcast({ type: "changed", username: m.username, boxPub: m.boxPub });
        return Response.json({ ok: true });
      }
      return Response.json({ error: "unknown message" }, { status: 400 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  /** A relay's socket joins; an older socket under the same relay id is closed (a reconnect). */
  async accept(ws: WebSocket, relay: string): Promise<void> {
    for (const old of this.state.getWebSockets(relay)) {
      const a = readAttachment(old);
      if (a) writeAttachment(old, { ...a, superseded: true });
      try {
        old.close(1000, "replaced");
      } catch {
        /* already closed */
      }
    }
    this.state.acceptWebSocket(ws, [relay]);
    writeAttachment(ws, { relay, ready: false, sent: 0, acked: 0, ackWrittenAt: 0 });
    if ((await this.state.storage.getAlarm()) == null) await this.state.storage.setAlarm(this.now() + BEAT_MS);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = readAttachment(ws);
    if (!a || a.superseded) return;
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (text.length > MAX_FRAME_BYTES) return;
    let frame: { type?: unknown; since?: unknown; sequence?: unknown };
    try {
      frame = JSON.parse(text) as typeof frame;
    } catch {
      return;
    }
    if (frame.type === "hello") {
      const since = typeof frame.since === "number" && Number.isSafeInteger(frame.since) && frame.since >= 0 ? frame.since : 0;
      await this.replay(ws, since);
      return;
    }
    if (frame.type === "ack" && typeof frame.sequence === "number" && Number.isSafeInteger(frame.sequence) && frame.sequence >= 0) {
      await this.recordAck(ws, frame.sequence);
    }
  }

  async webSocketClose(): Promise<void> {}

  async webSocketError(): Promise<void> {}

  /** The beat: sign and push anything pending, tell every relay the newest sequence, and come back. */
  async alarm(): Promise<void> {
    const sequence = await this.flush();
    for (const ws of this.sockets()) {
      const a = readAttachment(ws);
      if (a?.ready) send(ws, { type: "beat", sequence });
    }
    if (this.sockets().length > 0) await this.state.storage.setAlarm(this.now() + BEAT_MS);
  }

  /** Sign what the triggers left unsigned and send every ready relay what it hasn't had. Returns the newest sequence. */
  async flush(): Promise<number> {
    const db = this.env.DB;
    if (!db || !this.env.SERVING_REVOCATION_SEED) return (await this.state.storage.get<number>(CURSOR_KEY)) ?? 0;
    const top = await signPendingRevocations(db, this.env.SERVING_REVOCATION_SEED);
    const stored = await this.state.storage.get<number>(CURSOR_KEY);
    // A new feed starts from what its ready relays have; with none, each relay's hello replays the history it lacks.
    const readySent = this.sockets().flatMap((ws) => {
      const a = readAttachment(ws);
      return a?.ready ? [a.sent] : [];
    });
    const cursor = stored ?? (readySent.length > 0 ? Math.min(...readySent) : top);
    let from = cursor;
    while (from < top) {
      const entries = await revocationsSince(db, from);
      if (entries.length === 0) break;
      for (const ws of this.sockets()) {
        const a = readAttachment(ws);
        if (!a?.ready) continue;
        let sent = a.sent;
        for (const e of entries) {
          if (e.entry.sequence <= sent) continue;
          if (!send(ws, { type: "revocation", entry: e.entry, signature: e.signature })) break;
          sent = e.entry.sequence;
        }
        writeAttachment(ws, { ...a, sent });
      }
      from = entries[entries.length - 1]!.entry.sequence;
    }
    await this.state.storage.put(CURSOR_KEY, Math.max(cursor, from));
    return top;
  }

  private broadcast(frame: unknown): void {
    for (const ws of this.sockets()) {
      if (readAttachment(ws)?.ready) send(ws, frame);
    }
  }

  private sockets(): WebSocket[] {
    return this.state.getWebSockets().filter((ws) => !readAttachment(ws)?.superseded);
  }

  private async replay(ws: WebSocket, since: number): Promise<void> {
    const db = this.env.DB;
    let sent = since;
    let top = since;
    if (db && this.env.SERVING_REVOCATION_SEED) {
      top = await signPendingRevocations(db, this.env.SERVING_REVOCATION_SEED);
      // Pages until caught up; a flush running meanwhile skips this socket until it is ready, and the
      // second pass below sends whatever that flush committed.
      for (let pass = 0; pass < 2; pass++) {
        sent = Math.max(sent, readAttachment(ws)?.sent ?? 0);
        for (;;) {
          const entries = await revocationsSince(db, sent);
          if (entries.length === 0) break;
          for (const e of entries) {
            if (!send(ws, { type: "revocation", entry: e.entry, signature: e.signature })) return;
            sent = e.entry.sequence;
          }
        }
        const a = readAttachment(ws);
        if (!a || a.superseded) return;
        writeAttachment(ws, { ...a, ready: true, sent: Math.max(a.sent, sent) });
      }
      top = Math.max(top, sent);
    } else {
      const a = readAttachment(ws);
      if (!a || a.superseded) return;
      writeAttachment(ws, { ...a, ready: true });
    }
    send(ws, { type: "beat", sequence: top });
  }

  private async recordAck(ws: WebSocket, sequence: number): Promise<void> {
    const a = readAttachment(ws);
    if (!a) return;
    const now = this.now();
    const acked = Math.max(a.acked, sequence);
    if (acked === a.acked && now - a.ackWrittenAt < ACK_REWRITE_MS) return;
    writeAttachment(ws, { ...a, acked, ackWrittenAt: now });
    const db = this.env.DB;
    if (!db) return;
    await db
      .prepare(
        "INSERT INTO serving_relay_acks (relay_id, sequence, seen_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(relay_id) DO UPDATE SET sequence = MAX(serving_relay_acks.sequence, excluded.sequence), seen_at = excluded.seen_at",
      )
      .bind(a.relay, acked, now)
      .run();
  }
}
