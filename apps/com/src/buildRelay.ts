/**
 * QR relay Durable Object — v2 protocol.
 *
 * Phone-to-browser pipe for delivering an encrypted server-creation
 * recipe. Compared to v1, this is a *dumb pipe*:
 *
 *  - Sessions are addressed by a CLIENT-DERIVED 128-bit `sid`. The DO is
 *    looked up by name `=sid`; there's no `POST /sessions` to mint one.
 *  - The match code is NEVER computed or transmitted by the relay. Both
 *    peers derive it locally from an ECDH shared secret (X25519). The
 *    SAS comparison protects against a malicious or compromised relay.
 *  - The DO sees only opaque routing state: "is a browser registered?",
 *    "has a delivery happened?". No pubkeys, no ciphertext kept after
 *    forwarding, no recipe.
 *
 * Wire surface (registered in apps/com/src/route.ts):
 *
 *   wss://<host>/qr-pipe/<sid>?role=browser
 *     ← { kind: "accepted" }                              // sid is free
 *     ← { kind: "rebind" }                                // sid taken / consumed; client regenerates
 *     ← { kind: "peer-hello", phonePk: <base64url> }      // when phone sends hello
 *     ← { kind: "peer-deliver", ciphertext: <base64url>, nonce: <base64url> }
 *     ← { kind: "expired" }                               // TTL fired
 *     ← { kind: "error", reason: <string> }
 *
 *   wss://<host>/qr-pipe/<sid>?role=phone
 *     → { kind: "hello", phonePk: <base64url> }
 *     ← { kind: "ack" }
 *     ← { kind: "peer-missing" }                          // browser not connected
 *     → { kind: "deliver", ciphertext: <base64url>, nonce: <base64url> }
 *     ← { kind: "delivered" }
 *     ← { kind: "error", reason: <string> }
 *
 * After a successful delivery the DO marks itself consumed and tears
 * down both sockets. Any subsequent browser upgrade attempt sees
 * `rebind`; the client generates a fresh sid + ephemeral keypair and
 * tries again.
 *
 * Confidentiality of the recipe is unconditional against the relay
 * (kEnc = HKDF(X25519(sk_phone, pk_browser), …); the DO never sees a
 * private key). Authenticity / MitM resistance is provided by the SAS
 * pattern client-side. See:
 *   memory/project_qr_relay_protocol_v2.md
 *
 * Runtime shape (free-tier-friendly):
 *   - WebSockets are accepted via `state.acceptWebSocket(ws, [role])`,
 *     not `ws.accept()`. This opts into the Hibernation API: the DO
 *     can be evicted from memory while the WSes are idle, and Workerd
 *     wakes it on the next frame. Without this, the DO is billed for
 *     wallclock duration across the entire connection lifetime.
 *   - TTL is enforced by `state.storage.setAlarm` + `async alarm()`,
 *     not `setTimeout`. setTimeout pinned the DO to memory for the
 *     full 5-minute window even when it was otherwise idle.
 *   - The DO holds NO in-memory references to its WebSockets; every
 *     handler looks them up via `state.getWebSockets(role)` so it
 *     works after wake-from-hibernation.
 */

const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_CIPHERTEXT_BYTES = 64 * 1024;
const B64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

const ROLE_BROWSER = "browser";
const ROLE_PHONE = "phone";

export interface BuildRelayBrowserHello {
  kind: "hello";
  phonePk: string;
}
export interface BuildRelayDeliver {
  kind: "deliver";
  ciphertext: string;
  nonce: string;
}
export type BuildRelayPhoneMessage = BuildRelayBrowserHello | BuildRelayDeliver;

interface SessionMeta {
  sessionId: string;
  createdAt: number;
  /** Set when the phone successfully delivered an encrypted recipe.
   *  Any subsequent browser upgrade attempt for this sid is rebound.
   *  In-memory only — once the DO hibernates and is re-created, this
   *  is reset; the SAS check on the client side is the authoritative
   *  protection against replay. */
  consumed: boolean;
}

/**
 * Minimal slice of `DurableObjectStorage` we depend on. Real Workerd
 * provides the full surface; tests provide an in-memory stub.
 */
export interface BuildRelayStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

/**
 * Subset of `DurableObjectState` we depend on. The hibernation-aware
 * API is the critical part: acceptWebSocket lets the runtime evict
 * the DO between frames, and getWebSockets is how we recover the
 * still-open sockets after a wake.
 */
export interface BuildRelayDurableObjectState {
  id: { toString(): string };
  storage: BuildRelayStorage;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

/**
 * Per-socket attachment persisted by Workerd across hibernation.
 * Small JSON payload — keep it tight; the runtime caps it.
 */
interface SocketAttachment {
  role: typeof ROLE_BROWSER | typeof ROLE_PHONE;
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

export class BuildRelaySession implements DurableObject {
  private session: SessionMeta;
  private readonly state: BuildRelayDurableObjectState;
  /**
   * Resolves once createdAt has been loaded (or initialized) from
   * persistent storage. Every public entry point awaits this so a DO
   * that just woke up from hibernation sees the correct TTL window
   * before handling its first request.
   */
  private readonly loaded: Promise<void>;

  constructor(state: BuildRelayDurableObjectState, _env: unknown) {
    this.state = state;
    this.session = {
      sessionId: state.id.toString(),
      createdAt: 0,
      consumed: false,
    };
    this.loaded = this.loadOrInit();
  }

  /**
   * On first construction, write `createdAt` to storage and arm the
   * TTL alarm. On wake-from-hibernation, just hydrate from storage.
   *
   * Using `state.storage.setAlarm` instead of `setTimeout` is the
   * single biggest DO-duration fix: the alarm persists across
   * eviction, so the DO doesn't have to stay resident to honour it.
   */
  private async loadOrInit(): Promise<void> {
    const stored = await this.state.storage.get<number>("createdAt");
    if (typeof stored === "number") {
      this.session.createdAt = stored;
      return;
    }
    const now = Date.now();
    this.session.createdAt = now;
    await this.state.storage.put("createdAt", now);
    await this.state.storage.setAlarm(now + SESSION_TTL_MS);
  }

  async fetch(request: Request): Promise<Response> {
    await this.loaded;
    const url = new URL(request.url);
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.handleUpgrade(url);
    }
    return new Response(JSON.stringify({ error: "websocket only" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  /**
   * Fired by the Workerd runtime when the TTL alarm scheduled in
   * `loadOrInit` comes due. The DO may have been hibernated up to
   * this point; the alarm is what wakes it. We notify any listeners
   * and wipe storage so the DO can be fully evicted.
   */
  async alarm(): Promise<void> {
    await this.loaded;
    const browser = this.getBrowserSocket();
    const phone = this.getPhoneSocket();
    if (browser) this.send(browser, { kind: "expired" });
    if (phone) this.send(phone, { kind: "expired" });
    // Let the `expired` frames flush before closing. Same pattern as
    // tearDown("delivered"): a same-tick close races the send.
    queueMicrotask(() => {
      this.closeQuiet(browser);
      this.closeQuiet(phone);
    });
    await this.state.storage.deleteAll();
  }

  // ─────────────────────────────────────────────────────────────────
  // Hibernation-aware handlers. Workerd dispatches these for each
  // accepted WebSocket; the DO can be evicted between calls.
  // ─────────────────────────────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.loaded;
    const att = readAttachment(ws);
    if (att?.role === ROLE_PHONE) {
      await this.onPhoneMessage(ws, message);
      return;
    }
    if (att?.role === ROLE_BROWSER) {
      // Browsers are listeners; any inbound frame is a protocol violation.
      this.send(ws, { kind: "error", reason: "browser sends nothing" });
    }
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.loaded;
    const att = readAttachment(ws);
    if (att?.role === ROLE_BROWSER) this.detachBrowser();
    else if (att?.role === ROLE_PHONE) this.detachPhone();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.webSocketClose(ws, 1011, "error", false);
  }

  // ─────────────────────────────────────────────────────────────────
  // Internals.
  // ─────────────────────────────────────────────────────────────────

  private handleUpgrade(url: URL): Response {
    const role = url.searchParams.get("role");
    if (role !== ROLE_BROWSER && role !== ROLE_PHONE) {
      return new Response(
        JSON.stringify({ error: "role must be browser or phone" }),
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
    if (role === ROLE_BROWSER) this.attachBrowser(server);
    else this.attachPhone(server);
    return makeUpgradeResponse(client);
  }

  private attachBrowser(ws: WebSocket): void {
    // Arbitration: a browser may only occupy a session that has neither
    // been consumed nor is currently held by another browser.
    if (this.session.consumed) {
      this.acceptForRebind(ws);
      return;
    }
    if (this.getBrowserSocket()) {
      this.acceptForRebind(ws);
      return;
    }
    this.state.acceptWebSocket(ws, [ROLE_BROWSER]);
    writeAttachment(ws, { role: ROLE_BROWSER });
    this.send(ws, { kind: "accepted" });
  }

  private attachPhone(ws: WebSocket): void {
    if (this.session.consumed) {
      // Accept just long enough to deliver the error; the runtime
      // requires acceptance before send().
      this.state.acceptWebSocket(ws, [ROLE_PHONE]);
      writeAttachment(ws, { role: ROLE_PHONE });
      this.send(ws, { kind: "error", reason: "session already consumed" });
      queueMicrotask(() => this.closeQuiet(ws));
      return;
    }
    if (this.getPhoneSocket()) {
      this.state.acceptWebSocket(ws, [ROLE_PHONE]);
      writeAttachment(ws, { role: ROLE_PHONE });
      this.send(ws, { kind: "error", reason: "phone slot taken" });
      queueMicrotask(() => this.closeQuiet(ws));
      return;
    }
    this.state.acceptWebSocket(ws, [ROLE_PHONE]);
    writeAttachment(ws, { role: ROLE_PHONE });
  }

  /**
   * Accept a browser long enough to send `{kind:"rebind"}`, then close.
   * Equivalent to the legacy non-hibernation path's accept + send +
   * close — we just have to acceptWebSocket first so the runtime
   * allows the send.
   */
  private acceptForRebind(ws: WebSocket): void {
    this.state.acceptWebSocket(ws, [ROLE_BROWSER]);
    writeAttachment(ws, { role: ROLE_BROWSER });
    this.send(ws, { kind: "rebind" });
    queueMicrotask(() => this.closeQuiet(ws));
  }

  private async onPhoneMessage(
    phoneWs: WebSocket,
    data: string | ArrayBuffer,
  ): Promise<void> {
    const msg = this.parsePhone(data);
    if (!msg) return this.failPhone(phoneWs, "malformed");

    if (msg.kind === "hello") {
      if (!isB64Url(msg.phonePk)) return this.failPhone(phoneWs, "phonePk must be base64url");
      const browser = this.getBrowserSocket();
      if (!browser) {
        // The browser hasn't connected yet (or has dropped). Tell the
        // phone explicitly so it can wait/retry rather than guess.
        this.send(phoneWs, { kind: "peer-missing" });
        return;
      }
      this.send(browser, { kind: "peer-hello", phonePk: msg.phonePk });
      this.send(phoneWs, { kind: "ack" });
      return;
    }

    if (msg.kind === "deliver") {
      if (!isB64Url(msg.ciphertext)) return this.failPhone(phoneWs, "ciphertext must be base64url");
      if (!isB64Url(msg.nonce)) return this.failPhone(phoneWs, "nonce must be base64url");
      if (msg.ciphertext.length > MAX_CIPHERTEXT_BYTES) {
        return this.failPhone(phoneWs, "ciphertext too large");
      }
      const browser = this.getBrowserSocket();
      if (!browser) return this.failPhone(phoneWs, "browser not connected");
      if (this.session.consumed) return this.failPhone(phoneWs, "already delivered");

      // Forward the opaque ciphertext untouched. We do not log it — it
      // is end-to-end-encrypted user content and .com must not see it.
      this.send(browser, {
        kind: "peer-deliver",
        ciphertext: msg.ciphertext,
        nonce: msg.nonce,
      });
      this.send(phoneWs, { kind: "delivered" });
      this.session.consumed = true;
      queueMicrotask(() => this.tearDown("delivered"));
      return;
    }

    return this.failPhone(phoneWs, "unknown kind");
  }

  private parsePhone(data: string | ArrayBuffer): BuildRelayPhoneMessage | null {
    let text: string;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else return null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") {
        if (parsed.kind === "hello" || parsed.kind === "deliver") {
          return parsed as BuildRelayPhoneMessage;
        }
      }
    } catch {
      // fall through
    }
    return null;
  }

  private send(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Socket already closed — nothing useful we can do.
    }
  }

  private failPhone(phoneWs: WebSocket, reason: string): void {
    this.send(phoneWs, { kind: "error", reason });
    queueMicrotask(() => this.tearDown(`phone:${reason}`));
  }

  private detachBrowser(): void {
    // If the phone is mid-handshake and its peer drops, surface that so the
    // phone can offer a useful "reopen the pairing page" prompt.
    const phone = this.getPhoneSocket();
    if (phone && !this.session.consumed) {
      this.send(phone, { kind: "peer-missing" });
    }
    this.tearDownIfEmpty();
  }
  private detachPhone(): void {
    this.tearDownIfEmpty();
  }

  /**
   * When both peers have disconnected without delivering, release the
   * DO immediately instead of waiting 5 minutes for the alarm. The
   * unconsumed session has no chance of completing — the SAS code is
   * derived from per-connection ephemeral keys, so a returning peer
   * would have to start a fresh sid anyway.
   *
   * Skipped when consumed=true because the delivery path already
   * queued its own tearDown; calling deleteAll twice is harmless but
   * the second pass is wasted work.
   */
  private tearDownIfEmpty(): void {
    if (this.session.consumed) return;
    if (this.getBrowserSocket()) return;
    if (this.getPhoneSocket()) return;
    this.tearDown("empty");
  }

  private closeQuiet(s: WebSocket | null | undefined): void {
    if (!s) return;
    try { s.close(1000, "session over"); } catch { /* already closed */ }
  }

  private tearDown(_why: string): void {
    this.closeQuiet(this.getBrowserSocket());
    this.closeQuiet(this.getPhoneSocket());
    // Fire-and-forget: clear persisted state so the DO can be fully
    // evicted. The alarm is wiped by deleteAll() per Workerd contract.
    void this.state.storage.deleteAll().catch(() => { /* idempotent */ });
  }

  private isExpired(): boolean {
    if (this.session.createdAt === 0) return false; // not yet loaded
    return Date.now() - this.session.createdAt >= SESSION_TTL_MS;
  }

  /**
   * Find the currently-attached socket for a given role. Returns
   * undefined if none — runtime auto-removes closed sockets from the
   * `getWebSockets` list, so this is also our "is the peer still
   * here?" probe.
   */
  private getBrowserSocket(): WebSocket | undefined {
    return this.state.getWebSockets(ROLE_BROWSER)[0];
  }
  private getPhoneSocket(): WebSocket | undefined {
    return this.state.getWebSockets(ROLE_PHONE)[0];
  }
}

function isB64Url(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && B64URL_RE.test(s);
}

export const _internal = {
  SESSION_TTL_MS,
  MAX_CIPHERTEXT_BYTES,
  ROLE_BROWSER,
  ROLE_PHONE,
};
