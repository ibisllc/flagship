/**
 * Builder relay Durable Object — phone ↔ desktop-builder live session.
 *
 * Sibling to the QR relay (`buildRelay.ts`). The QR relay is a one-shot,
 * 5-minute, deliver-once browser←phone pipe that tears itself down after
 * a single delivery. The builder pairing flow needs the opposite shape:
 *
 *  - A LONG-LIVED, BIDIRECTIONAL session. The builder shows a QR + short
 *    code; the phone joins; they confirm a SAS; then they exchange many
 *    frames over the life of a burn (recipe delivery, consent requests,
 *    consent results, secret injection).
 *  - RESILIENT, NOT presence-fragile. A peer that briefly drops (the
 *    phone's screen sleeps / its app backgrounds; a desktop network blip)
 *    can RECONNECT to the same `sid` and RESUME — the session survives for
 *    its full lifetime (ABSOLUTE_TTL_MS, ~1h). The survivor is told
 *    `{kind:"peer-gone"}` when a peer drops, but that is an advisory "the
 *    other side stepped away", NOT "wipe now": the builder holds its prepared
 *    burn and waits for the phone to return. A reconnect for a role whose
 *    slot is still draining EVICTS the stale socket (last-writer-wins) so
 *    the returning peer is never told "slot taken".
 *  - KEEPALIVE: clients send `{kind:"ping"}`; the relay replies
 *    `{kind:"pong"}` and re-arms an idle alarm. A session with no
 *    traffic for IDLE_TTL_MS expires on its own; the absolute cap is the
 *    ~1h auto-lock backstop, after which the relay sends `{kind:"expired"}`
 *    and both sides wipe.
 *
 * Like the QR relay, the DO is a DUMB PIPE: it never sees keys or
 * plaintext. App frames are forwarded VERBATIM (wrapped in
 * `{kind:"peer", frame}`); confidentiality + MitM resistance come from
 * the client-side X25519/SAS/AEAD layer (shared with the QR flow:
 * salt `flagship/qr/v1`, info `…/sas/v1` + `…/enc/v1`). The relay only
 * sees opaque routing state: which roles are connected.
 *
 * Wire surface (registered in apps/com/src/route.ts):
 *
 *   wss://<host>/builder-pipe/<sid>?role=builder
 *   wss://<host>/builder-pipe/<sid>?role=phone
 *     ← { kind: "accepted", role, expiresAt }        // joined; expiresAt = session deadline (ms epoch)
 *     ← { kind: "peer-present" }                     // the other side was already here
 *     ← { kind: "peer-joined" }                      // the other side just joined (incl. a reconnect/resume)
 *     ← { kind: "peer", frame: <object> }            // forwarded peer app frame
 *     ← { kind: "peer-missing" }                     // you sent a frame with no peer connected
 *     ← { kind: "peer-gone" }                        // the other side stepped away (advisory; hold + await resume)
 *     ← { kind: "pong" }                             // keepalive reply
 *     ← { kind: "expired" }                          // session lifetime / auto-lock reached → wipe
 *     ← { kind: "error", reason }
 *     → { kind: "ping" }                             // keepalive
 *     → <any other JSON object>                      // forwarded to the peer as {kind:"peer",frame}
 *
 * Runtime shape mirrors the QR relay's hibernation discipline
 * (acceptWebSocket + storage alarm, no in-memory socket cache) so the
 * DO can be evicted between frames. See buildRelay.ts for the rationale.
 */

/**
 * Session dies this long after the last frame (keepalive re-arms it). The
 * builder pings every ~20s, so a session stays alive as long as the builder
 * is connected even while the phone is briefly away; this only reaps a
 * session both peers have abandoned.
 */
const IDLE_TTL_MS = 2 * 60 * 1000;
/**
 * The session lifetime / auto-lock window. After this, even an actively
 * pinged session is expired: the relay sends `{kind:"expired"}` and both
 * the phone and the builder wipe + relock. Long enough to write a USB and
 * step away; short enough that an abandoned session self-destructs.
 */
const ABSOLUTE_TTL_MS = 60 * 60 * 1000;
/** Cap on a single inbound frame's raw size. Recipes + sealed secrets fit. */
const MAX_FRAME_BYTES = 64 * 1024;

const ROLE_BUILDER = "builder";
const ROLE_PHONE = "phone";

type BuilderRole = typeof ROLE_BUILDER | typeof ROLE_PHONE;

/** Minimal slice of DurableObjectStorage we depend on (see buildRelay.ts). */
export interface BuilderRelayStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

/** Subset of DurableObjectState we depend on (hibernation-aware). */
export interface BuilderRelayDurableObjectState {
  id: { toString(): string };
  storage: BuilderRelayStorage;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

interface SocketAttachment {
  role: BuilderRole;
  /**
   * Set on a socket we are about to evict because a fresh connection for
   * the same role arrived (a reconnect/resume). Its delayed close handler
   * checks this and stays silent — so evicting a stale socket never fires a
   * spurious `peer-gone` at the survivor.
   */
  superseded?: boolean;
}

interface AttachableSocket extends WebSocket {
  serializeAttachment?(value: unknown): void;
  deserializeAttachment?(): unknown;
}

function createWebSocketPair(): { client: WebSocket; server: WebSocket } {
  const pair = new WebSocketPair();
  return { client: pair[0], server: pair[1] };
}

function makeUpgradeResponse(client: WebSocket): Response {
  try {
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as unknown as ResponseInit);
  } catch {
    const fake = {
      status: 101,
      webSocket: client,
      ok: false,
      async text() { return ""; },
    };
    return fake as unknown as Response;
  }
}

function readAttachment(ws: WebSocket): SocketAttachment | undefined {
  const fn = (ws as AttachableSocket).deserializeAttachment;
  if (typeof fn !== "function") return undefined;
  const v = fn.call(ws);
  if (v && typeof v === "object" && "role" in (v as object)) {
    return v as SocketAttachment;
  }
  return undefined;
}

function writeAttachment(ws: WebSocket, attachment: SocketAttachment): void {
  const fn = (ws as AttachableSocket).serializeAttachment;
  if (typeof fn === "function") fn.call(ws, attachment);
}

export class BuilderRelaySession implements DurableObject {
  private readonly state: BuilderRelayDurableObjectState;
  private createdAt = 0;
  private readonly loaded: Promise<void>;

  constructor(state: BuilderRelayDurableObjectState, _env: unknown) {
    this.state = state;
    this.loaded = this.loadOrInit();
  }

  private async loadOrInit(): Promise<void> {
    const stored = await this.state.storage.get<number>("createdAt");
    if (typeof stored === "number") {
      this.createdAt = stored;
      return;
    }
    const now = Date.now();
    this.createdAt = now;
    await this.state.storage.put("createdAt", now);
    await this.state.storage.setAlarm(now + IDLE_TTL_MS);
  }

  async fetch(request: Request): Promise<Response> {
    await this.loaded;
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const url = new URL(request.url);
      return this.handleUpgrade(url);
    }
    return new Response(JSON.stringify({ error: "websocket only" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  async alarm(): Promise<void> {
    await this.loaded;
    const builder = this.getSocket(ROLE_BUILDER);
    const phone = this.getSocket(ROLE_PHONE);
    if (builder) this.send(builder, { kind: "expired" });
    if (phone) this.send(phone, { kind: "expired" });
    queueMicrotask(() => {
      this.closeQuiet(builder);
      this.closeQuiet(phone);
    });
    await this.state.storage.deleteAll();
  }

  // ── Hibernation-aware handlers ──────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.loaded;
    const att = readAttachment(ws);
    if (att?.role !== ROLE_BUILDER && att?.role !== ROLE_PHONE) return;

    const text = typeof message === "string"
      ? message
      : message instanceof ArrayBuffer
        ? new TextDecoder().decode(message)
        : null;
    if (text === null) return this.fail(ws, "malformed");
    if (text.length > MAX_FRAME_BYTES) return this.fail(ws, "frame too large");

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return this.fail(ws, "malformed");
    }
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { kind?: unknown }).kind !== "string") {
      return this.fail(ws, "malformed");
    }

    const kind = (parsed as { kind: string }).kind;

    if (kind === "ping") {
      await this.bumpAlarm();
      this.send(ws, { kind: "pong" });
      return;
    }

    // Any other frame is opaque app traffic → forward verbatim to the peer.
    const peer = this.getPeer(att.role);
    if (!peer) {
      this.send(ws, { kind: "peer-missing" });
      return;
    }
    await this.bumpAlarm();
    this.send(peer, { kind: "peer", frame: parsed });
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.loaded;
    const att = readAttachment(ws);
    if (att?.role !== ROLE_BUILDER && att?.role !== ROLE_PHONE) return;
    // This socket was evicted by a reconnect for the same role — the live
    // socket is already the new one. Stay silent: no peer-gone, no teardown.
    if (att.superseded) return;
    // Advise the survivor that this peer stepped away. It is NOT a wipe
    // signal: the builder holds its prepared burn and waits for the phone to
    // reconnect within the session lifetime.
    const peer = this.getPeer(att.role);
    if (peer) this.send(peer, { kind: "peer-gone" });
    this.tearDownIfEmpty();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.webSocketClose(ws, 1011, "error", false);
  }

  // ── Internals ───────────────────────────────────────────────────────

  private handleUpgrade(url: URL): Response {
    const role = url.searchParams.get("role");
    if (role !== ROLE_BUILDER && role !== ROLE_PHONE) {
      return new Response(
        JSON.stringify({ error: "role must be builder or phone" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    if (this.isExpired()) {
      return new Response(
        JSON.stringify({ error: "session expired" }),
        { status: 410, headers: { "content-type": "application/json" } },
      );
    }
    const { client, server } = createWebSocketPair();
    this.attach(server, role);
    return makeUpgradeResponse(client);
  }

  private attach(ws: WebSocket, role: BuilderRole): void {
    // Last-writer-wins per role. An existing socket for this role is almost
    // always STALE — the phone's screen slept / its app backgrounded and the
    // old socket is still draining. Evict it so the returning peer RESUMES
    // the same session instead of being told "slot taken". Mark it
    // `superseded` first so its delayed close stays silent (no peer-gone).
    const existing = this.getSocket(role);
    if (existing) {
      writeAttachment(existing, { role, superseded: true });
      this.closeQuiet(existing);
    }
    this.state.acceptWebSocket(ws, [role]);
    writeAttachment(ws, { role });
    this.send(ws, {
      kind: "accepted",
      role,
      expiresAt: this.createdAt + ABSOLUTE_TTL_MS,
    });

    // Presence handshake: tell each side about the other.
    const peer = this.getPeer(role);
    if (peer) {
      this.send(ws, { kind: "peer-present" });
      this.send(peer, { kind: "peer-joined" });
    }
    void this.bumpAlarm();
  }

  private send(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Socket already closed — nothing useful we can do.
    }
  }

  private fail(ws: WebSocket, reason: string): void {
    this.send(ws, { kind: "error", reason });
  }

  /**
   * Re-arm the idle alarm to now + IDLE_TTL_MS, clamped to the absolute
   * ceiling. An actively-pinged session keeps pushing this forward; an
   * abandoned one fires within IDLE_TTL_MS and `alarm()` wipes it.
   */
  private async bumpAlarm(): Promise<void> {
    if (this.createdAt === 0) return;
    const next = Math.min(Date.now() + IDLE_TTL_MS, this.createdAt + ABSOLUTE_TTL_MS);
    await this.state.storage.setAlarm(next);
  }

  private tearDownIfEmpty(): void {
    if (this.getSocket(ROLE_BUILDER)) return;
    if (this.getSocket(ROLE_PHONE)) return;
    this.tearDown();
  }

  private closeQuiet(s: WebSocket | null | undefined): void {
    if (!s) return;
    try { s.close(1000, "session over"); } catch { /* already closed */ }
  }

  private tearDown(): void {
    this.closeQuiet(this.getSocket(ROLE_BUILDER));
    this.closeQuiet(this.getSocket(ROLE_PHONE));
    void this.state.storage.deleteAll().catch(() => { /* idempotent */ });
  }

  private isExpired(): boolean {
    if (this.createdAt === 0) return false; // not yet loaded
    return Date.now() - this.createdAt >= ABSOLUTE_TTL_MS;
  }

  private getSocket(role: BuilderRole): WebSocket | undefined {
    return this.state.getWebSockets(role)[0];
  }
  private getPeer(role: BuilderRole): WebSocket | undefined {
    return this.getSocket(role === ROLE_BUILDER ? ROLE_PHONE : ROLE_BUILDER);
  }
}

export const _internal = {
  IDLE_TTL_MS,
  ABSOLUTE_TTL_MS,
  MAX_FRAME_BYTES,
  ROLE_BUILDER,
  ROLE_PHONE,
};
