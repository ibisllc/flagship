/**
 * The call room (docs/voici-calls.md §6): one Durable Object per call, named by the callId. It holds the caller's and
 * the ringing devices' WebSockets (hibernation API), feeds their messages and its alarm to VoiciCallRoomCore
 * (packages/control-plane/src/voiciCalls.ts), and performs what the core answers: relay, close, the missed-call row,
 * the account's live-call slot. It never sees audio or frame keys, and keeps nothing once the call ends.
 *
 * Requests from the Worker (voiciCallRoutes.ts), all internal:
 *   POST /init        the VoiciCallRoomInit; 409 if this callId was used
 *   GET  /caller?t=   the caller's WebSocket (token checked against its hash)
 *   GET  /device      a ringing admin device's WebSocket; `x-voici-device-ref` (and, for a locked device that joined with
 *                     its bound call key, `x-voici-call-key-pub`) set by the Worker after its checks
 */
import { D1Storage, RequestD1, type D1Database } from "@flagship/storage";
import { recordVoiciMissedCall, VoiciCallRoomCore, type VoiciCallRoomAction, type VoiciCallRoomInit, type VoiciCallRoomPeer, type VoiciCallRoomState } from "@flagship/control-plane";

export interface VoiciCallRoomEnv {
  DB?: D1Database;
  FLAGSHIP_CA_PRIV_HEX?: string;
}

interface RoomStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(at: number): Promise<void>;
}

interface RoomState {
  storage: RoomStorage;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

type Attachable = WebSocket & { serializeAttachment?(v: unknown): void; deserializeAttachment?(): unknown };
const MAX_MESSAGE = 32 * 1024;
const DEVICES = "devices";
const CALLER = "caller";
/** A closed room keeps its state this long (a replayed request is stale after 10 minutes), then deletes it all. */
const TOMBSTONE_MS = 15 * 60_000;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

function caSeed(env: VoiciCallRoomEnv): Uint8Array | null {
  const h = env.FLAGSHIP_CA_PRIV_HEX;
  if (!h || !/^[0-9a-f]{64}$/i.test(h)) return null;
  return Uint8Array.from(h.toLowerCase().match(/../g)!.map((x) => parseInt(x, 16)));
}

export class VoiciCallRoom implements DurableObject {
  constructor(
    private readonly state: RoomState,
    private readonly env: VoiciCallRoomEnv,
  ) {}

  private async load(): Promise<VoiciCallRoomState | null> {
    return (await this.state.storage.get<VoiciCallRoomState>("room")) ?? null;
  }

  private core(s: VoiciCallRoomState): VoiciCallRoomCore | null {
    const seed = caSeed(this.env);
    return seed ? new VoiciCallRoomCore(s, { seed }) : null;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/init" && request.method === "POST") {
      if (await this.state.storage.get("room")) return json(409, { code: "exists" });
      const init = (await request.json()) as VoiciCallRoomInit;
      const { state, actions } = VoiciCallRoomCore.start(init);
      await this.state.storage.put("room", state);
      await this.perform(state, actions);
      return json(200, { ok: true });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json(400, { code: "websocket-only" });
    const s = await this.load();
    const core = s && this.core(s);
    if (!s || !core) return json(404, { code: "not-found" });
    let peer: VoiciCallRoomPeer;
    if (url.pathname === "/caller") {
      const t = url.searchParams.get("t") ?? "";
      if (!/^[0-9a-f]{64}$/.test(t) || (await sha256Hex(t)) !== s.init.callerTokenHash) return json(403, { code: "forbidden" });
      peer = { role: "caller" };
    } else if (url.pathname === "/device") {
      const ref = request.headers.get("x-voici-device-ref") ?? "";
      if (!/^[0-9a-f]{64}$/.test(ref)) return json(403, { code: "forbidden" });
      const callKeyPub = request.headers.get("x-voici-call-key-pub");
      peer = { role: "device", deviceRef: ref, ...(callKeyPub && /^04[0-9a-f]{128}$/.test(callKeyPub) ? { callKeyPub } : {}) };
    } else return json(404, { code: "not-found" });
    const pair = new WebSocketPair();
    const server = pair[1] as Attachable;
    this.state.acceptWebSocket(server, [peer.role === "caller" ? CALLER : DEVICES]);
    server.serializeAttachment?.(peer);
    if (peer.role === "caller") for (const old of this.state.getWebSockets(CALLER)) if (old !== server) old.close(4000, "replaced");
    await this.perform(s, core.joined(peer));
    return new Response(null, { status: 101, webSocket: pair[0] } as unknown as ResponseInit);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > MAX_MESSAGE) return;
    const peer = (ws as Attachable).deserializeAttachment?.() as VoiciCallRoomPeer | undefined;
    const s = await this.load();
    const core = s && this.core(s);
    if (!peer || !s || !core) return;
    let msg: unknown;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    await this.perform(s, core.message(peer, msg, Date.now()));
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const peer = (ws as Attachable).deserializeAttachment?.() as VoiciCallRoomPeer | undefined;
    if (peer?.role !== "caller") return;
    const s = await this.load();
    const core = s && this.core(s);
    if (s && core) await this.perform(s, core.callerLeft(Date.now()));
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    const s = await this.load();
    if (!s) return;
    if (s.phase === "ended") {
      await this.state.storage.deleteAll();
      return;
    }
    const core = this.core(s);
    if (core) await this.perform(s, core.alarm(Date.now()));
  }

  private send(ws: WebSocket, msg: unknown) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* gone */
    }
  }

  private async perform(s: VoiciCallRoomState, actions: VoiciCallRoomAction[]): Promise<void> {
    const db = this.env.DB ? new D1Storage(new RequestD1(this.env.DB)) : null;
    for (const a of actions) {
      if (a.kind === "send") {
        const targets =
          a.to === "caller"
            ? this.state.getWebSockets(CALLER)
            : this.state.getWebSockets(DEVICES).filter((ws) => {
                if (a.to === "devices") return true;
                const ref = ((ws as Attachable).deserializeAttachment?.() as { deviceRef?: string } | undefined)?.deviceRef;
                return typeof a.to === "object" && "deviceRef" in a.to ? ref === a.to.deviceRef : ref !== (a.to as { notDeviceRef: string }).notDeviceRef;
              });
        for (const ws of targets) this.send(ws, a.msg);
      } else if (a.kind === "alarm") {
        await this.state.storage.setAlarm(a.at);
      } else if (a.kind === "missed" && db) {
        await recordVoiciMissedCall(db.voiciCalls, { pageId: s.init.pageId, inboxPub: s.init.inboxPub, request: s.init.request, ringingAt: s.init.ringingAt, endedAt: a.endedAt, reason: a.reason });
      } else if (a.kind === "release" && db) {
        await db.voiciCalls.releaseLiveCall(s.init.username, s.init.callId);
      } else if (a.kind === "extend" && db) {
        await db.voiciCalls.extendLiveCall(s.init.username, s.init.callId, a.until);
      } else if (a.kind === "close-all") {
        for (const ws of [...this.state.getWebSockets(CALLER), ...this.state.getWebSockets(DEVICES)]) {
          try {
            ws.close(1000, "ended");
          } catch {
            /* already closed */
          }
        }
        await this.state.storage.setAlarm(Date.now() + TOMBSTONE_MS);
      }
    }
    await this.state.storage.put("room", s);
  }
}
