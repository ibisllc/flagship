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
 */

const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_CIPHERTEXT_BYTES = 64 * 1024;
const B64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

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

interface SessionState {
  sessionId: string;
  createdAt: number;
  browserSocket: WebSocket | null;
  phoneSocket: WebSocket | null;
  /** Set when the phone successfully delivered an encrypted recipe.
   *  Any subsequent browser upgrade attempt for this sid is rebound. */
  consumed: boolean;
}

export interface BuildRelayDurableObjectState {
  id: { toString(): string };
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

export class BuildRelaySession implements DurableObject {
  private session: SessionState;
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(state: BuildRelayDurableObjectState, _env: unknown) {
    this.session = {
      sessionId: state.id.toString(),
      createdAt: Date.now(),
      browserSocket: null,
      phoneSocket: null,
      consumed: false,
    };
    this.scheduleTtl();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.handleUpgrade(url);
    }
    return new Response(JSON.stringify({ error: "websocket only" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  private handleUpgrade(url: URL): Response {
    const role = url.searchParams.get("role");
    if (role !== "browser" && role !== "phone") {
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
    (server as unknown as { accept(): void }).accept();
    if (role === "browser") this.attachBrowser(server);
    else this.attachPhone(server);
    return makeUpgradeResponse(client);
  }

  private attachBrowser(ws: WebSocket): void {
    // Arbitration: a browser may only occupy a session that has neither
    // been consumed nor is currently held by another browser.
    if (this.session.consumed) {
      this.send(ws, { kind: "rebind" });
      queueMicrotask(() => this.closeQuiet(ws));
      return;
    }
    if (this.session.browserSocket) {
      this.send(ws, { kind: "rebind" });
      queueMicrotask(() => this.closeQuiet(ws));
      return;
    }
    this.session.browserSocket = ws;
    ws.addEventListener("close", () => this.detachBrowser());
    ws.addEventListener("error", () => this.detachBrowser());
    // No incoming messages expected from the browser — it's a listener.
    // We could ignore them, but reject loudly to keep the protocol tight.
    ws.addEventListener("message", () => {
      this.send(ws, { kind: "error", reason: "browser sends nothing" });
    });
    this.send(ws, { kind: "accepted" });
  }

  private attachPhone(ws: WebSocket): void {
    if (this.session.consumed) {
      this.send(ws, { kind: "error", reason: "session already consumed" });
      queueMicrotask(() => this.closeQuiet(ws));
      return;
    }
    if (this.session.phoneSocket) {
      this.send(ws, { kind: "error", reason: "phone slot taken" });
      queueMicrotask(() => this.closeQuiet(ws));
      return;
    }
    this.session.phoneSocket = ws;
    ws.addEventListener("message", (e: MessageEvent) => {
      void this.onPhoneMessage(e.data);
    });
    ws.addEventListener("close", () => this.detachPhone());
    ws.addEventListener("error", () => this.detachPhone());
  }

  private async onPhoneMessage(data: string | ArrayBuffer): Promise<void> {
    const msg = this.parsePhone(data);
    if (!msg) return this.failPhone("malformed");

    if (msg.kind === "hello") {
      if (!isB64Url(msg.phonePk)) return this.failPhone("phonePk must be base64url");
      if (!this.session.browserSocket) {
        // The browser hasn't connected yet (or has dropped). Tell the
        // phone explicitly so it can wait/retry rather than guess.
        this.send(this.session.phoneSocket!, { kind: "peer-missing" });
        return;
      }
      this.send(this.session.browserSocket, {
        kind: "peer-hello",
        phonePk: msg.phonePk,
      });
      this.send(this.session.phoneSocket!, { kind: "ack" });
      return;
    }

    if (msg.kind === "deliver") {
      if (!isB64Url(msg.ciphertext)) return this.failPhone("ciphertext must be base64url");
      if (!isB64Url(msg.nonce)) return this.failPhone("nonce must be base64url");
      if (msg.ciphertext.length > MAX_CIPHERTEXT_BYTES) {
        return this.failPhone("ciphertext too large");
      }
      if (!this.session.browserSocket) return this.failPhone("browser not connected");
      if (this.session.consumed) return this.failPhone("already delivered");

      // Forward the opaque ciphertext untouched. We do not log it — it
      // is end-to-end-encrypted user content and .com must not see it.
      this.send(this.session.browserSocket, {
        kind: "peer-deliver",
        ciphertext: msg.ciphertext,
        nonce: msg.nonce,
      });
      this.send(this.session.phoneSocket!, { kind: "delivered" });
      this.session.consumed = true;
      queueMicrotask(() => this.tearDown("delivered"));
      return;
    }

    return this.failPhone("unknown kind");
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

  private failPhone(reason: string): void {
    const ws = this.session.phoneSocket;
    if (ws) this.send(ws, { kind: "error", reason });
    queueMicrotask(() => this.tearDown(`phone:${reason}`));
  }

  private detachBrowser(): void {
    this.session.browserSocket = null;
    // If the phone is mid-handshake and the browser drops, surface that
    // so the phone can show a helpful "open the homepage again" prompt.
    if (this.session.phoneSocket && !this.session.consumed) {
      this.send(this.session.phoneSocket, { kind: "peer-missing" });
    }
  }
  private detachPhone(): void {
    this.session.phoneSocket = null;
  }

  private closeQuiet(s: WebSocket | null): void {
    if (!s) return;
    try { s.close(1000, "session over"); } catch { /* already closed */ }
  }

  private tearDown(_why: string): void {
    if (this.ttlTimer) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }
    this.closeQuiet(this.session.browserSocket);
    this.closeQuiet(this.session.phoneSocket);
    this.session.browserSocket = null;
    this.session.phoneSocket = null;
  }

  private isExpired(): boolean {
    return Date.now() - this.session.createdAt >= SESSION_TTL_MS;
  }

  private scheduleTtl(): void {
    this.ttlTimer = setTimeout(() => {
      // Notify any listener before tearing down.
      const b = this.session.browserSocket;
      const p = this.session.phoneSocket;
      if (b) this.send(b, { kind: "expired" });
      if (p) this.send(p, { kind: "expired" });
      this.tearDown("ttl");
    }, SESSION_TTL_MS);
  }
}

function isB64Url(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && B64URL_RE.test(s);
}

export const _internal = {
  SESSION_TTL_MS,
  MAX_CIPHERTEXT_BYTES,
};
