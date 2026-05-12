/**
 * Build-relay Durable Object — task #59.
 *
 * Real-time E2E-encrypted relay between a browser at /build/ (the
 * "browser" peer) and a phone or webapp (the "sender" peer) that holds
 * the user's IRK. Replaces the deleted build_tickets system with a
 * push-style flow: the phone constructs the InstallBlob, encrypts it
 * with crypto_box_seal under the browser's ephemeral X25519 public
 * key, and ships the opaque ciphertext through the DO. The browser
 * decrypts in-process and assembles the personalized ISO.
 *
 * Wire shape:
 *
 *   POST /api/build-relay/sessions
 *     → 200 { sessionId, joinUrl, matchCode, expiresAt }
 *
 *   wss://<host>/build-relay/<sessionId>?role=browser
 *     ← { kind: "hello", role: "browser" }
 *     → { kind: "browser-hello", browserPk: <x25519-hex> }
 *     ← { kind: "matched", matchCode: <6-digit> }
 *     ← { kind: "blob", ciphertext: <base64> }    // delivered by sender
 *
 *   wss://<host>/build-relay/<sessionId>?role=sender
 *     ← { kind: "browser-key", browserPk: <hex>, matchCode: <6-digit> }
 *     → { kind: "blob", ciphertext: <base64> }
 *     ← { kind: "delivered" }
 *
 * The DO sees only:
 *   - the browser's ephemeral X25519 public key (used to derive the
 *     match-code)
 *   - opaque ciphertext on the way through
 *
 * It cannot read the InstallBlob — that is the entire point. We
 * explicitly never log the ciphertext field. State is in-memory only;
 * `state.storage` is intentionally never touched.
 *
 * Match-code derivation (load-bearing — the phone derives the same
 * digits independently from browserPk + sessionId and shows them, the
 * user visually compares both surfaces):
 *
 *   ikm = sessionId-bytes || browserPk-bytes
 *   prk = HKDF-Extract(SHA-256, salt = "flagship/build-relay/v1", ikm)
 *   okm = HKDF-Expand(prk, info = "match-code", L = 4) -> 32-bit uint
 *   code = (okm-uint32 mod 1_000_000).toString().padStart(6, "0")
 *
 * Encoded as base-10 digits because that's what the user visually
 * compares; 20 bits of search space (≈1e6) is the OWASP recommendation
 * for short MITM-resistant verification codes when the relay can be
 * walked away from instantly on mismatch.
 */

const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_CIPHERTEXT_BYTES = 64 * 1024;
const HKDF_SALT = "flagship/build-relay/v1";
const HKDF_INFO = "match-code";

export interface BuildRelayBrowserHello {
  kind: "browser-hello";
  browserPk: string;
}

export interface BuildRelayBlob {
  kind: "blob";
  ciphertext: string;
}

export type BuildRelayMessage = BuildRelayBrowserHello | BuildRelayBlob;

export interface CreateSessionResponse {
  sessionId: string;
  joinUrl: string;
  matchCode: string;
  expiresAt: number;
}

interface SessionState {
  sessionId: string;
  createdAt: number;
  browserSocket: WebSocket | null;
  senderSocket: WebSocket | null;
  browserPk: string | null;
  matchCode: string | null;
  delivered: boolean;
}

export interface BuildRelayDurableObjectState {
  id: { toString(): string };
  /**
   * Cloudflare's DurableObjectState provides storage, but we
   * intentionally never touch it — sessions are in-memory only.
   */
}

/**
 * Tiny shim around the Workers `WebSocketPair` global so the same
 * code path works under wrangler dev and in unit tests (where we
 * inject a polyfill). Production never hits the polyfill branch.
 */
function createWebSocketPair(): { client: WebSocket; server: WebSocket } {
  const pair = new WebSocketPair();
  return { client: pair[0], server: pair[1] };
}

/**
 * Build a 101-upgrade Response with the client WebSocket attached.
 * The Workers runtime supports this natively; Node's `Response`
 * rejects 101, so under tests we synthesize an object that quacks
 * like a Response (`status`, `webSocket`, `text`) and the test
 * harness reads `response.webSocket` directly.
 */
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
      async text() {
        return "";
      },
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
      senderSocket: null,
      browserPk: null,
      matchCode: null,
      delivered: false,
    };
    this.scheduleTtl();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/create")) {
      return this.handleCreate(url);
    }
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.handleUpgrade(url);
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  private handleCreate(url: URL): Response {
    const host = url.searchParams.get("host") ?? "flagshipserver.com";
    const proto = host.startsWith("localhost") ? "ws" : "wss";
    const body: CreateSessionResponse = {
      sessionId: this.session.sessionId,
      joinUrl: `${proto}://${host}/build-relay/${this.session.sessionId}?role=sender`,
      // matchCode is unknown until the browser presents its key; phone
      // derives the same digits client-side once it has browserPk.
      matchCode: "",
      expiresAt: this.session.createdAt + SESSION_TTL_MS,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  private handleUpgrade(url: URL): Response {
    const role = url.searchParams.get("role");
    if (role !== "browser" && role !== "sender") {
      return new Response(
        JSON.stringify({ error: "role must be browser or sender" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    if (this.isExpired()) {
      return new Response(
        JSON.stringify({ error: "session expired" }),
        { status: 410, headers: { "content-type": "application/json" } },
      );
    }
    if (role === "browser" && this.session.browserSocket) {
      return new Response(
        JSON.stringify({ error: "browser slot already taken" }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    if (role === "sender" && this.session.senderSocket) {
      return new Response(
        JSON.stringify({ error: "sender slot already taken" }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    const { client, server } = createWebSocketPair();
    (server as unknown as { accept(): void }).accept();
    if (role === "browser") this.attachBrowser(server);
    else this.attachSender(server);
    // Workers runtime accepts status 101 with a `webSocket` init field
    // and surfaces the client half via `response.webSocket`. Node's
    // baseline `Response` constructor rejects 101, so under tests we
    // return a shimmed Response-like object exposing the client.
    return makeUpgradeResponse(client);
  }

  private attachBrowser(ws: WebSocket): void {
    this.session.browserSocket = ws;
    ws.addEventListener("message", (e: MessageEvent) => {
      void this.onBrowserMessage(e.data);
    });
    ws.addEventListener("close", () => this.tearDown("browser-close"));
    ws.addEventListener("error", () => this.tearDown("browser-error"));
    this.send(ws, { kind: "hello", role: "browser" });
    if (this.session.senderSocket && this.session.browserPk && this.session.matchCode) {
      // Sender arrived first then browser sent its key — re-fire the
      // browser-key event to the sender now that we have both halves.
      this.send(this.session.senderSocket, {
        kind: "browser-key",
        browserPk: this.session.browserPk,
        matchCode: this.session.matchCode,
      });
    }
  }

  private attachSender(ws: WebSocket): void {
    this.session.senderSocket = ws;
    ws.addEventListener("message", (e: MessageEvent) => {
      void this.onSenderMessage(e.data);
    });
    ws.addEventListener("close", () => this.tearDown("sender-close"));
    ws.addEventListener("error", () => this.tearDown("sender-error"));
    this.send(ws, { kind: "hello", role: "sender" });
    if (this.session.browserPk && this.session.matchCode) {
      this.send(ws, {
        kind: "browser-key",
        browserPk: this.session.browserPk,
        matchCode: this.session.matchCode,
      });
    }
  }

  private async onBrowserMessage(data: string | ArrayBuffer): Promise<void> {
    const msg = this.parse(data);
    if (!msg) return this.fail("browser", "malformed");
    if (msg.kind !== "browser-hello") {
      return this.fail("browser", "expected browser-hello");
    }
    if (!/^[0-9a-f]{64}$/.test(msg.browserPk)) {
      return this.fail("browser", "browserPk must be 32 bytes hex");
    }
    if (this.session.browserPk) {
      return this.fail("browser", "browser-hello already received");
    }
    this.session.browserPk = msg.browserPk;
    this.session.matchCode = await deriveMatchCode(
      this.session.sessionId,
      msg.browserPk,
    );
    this.send(this.session.browserSocket!, {
      kind: "matched",
      matchCode: this.session.matchCode,
    });
    if (this.session.senderSocket) {
      this.send(this.session.senderSocket, {
        kind: "browser-key",
        browserPk: this.session.browserPk,
        matchCode: this.session.matchCode,
      });
    }
  }

  private async onSenderMessage(data: string | ArrayBuffer): Promise<void> {
    const msg = this.parse(data);
    if (!msg) return this.fail("sender", "malformed");
    if (msg.kind !== "blob") {
      return this.fail("sender", "expected blob");
    }
    if (!msg.ciphertext || typeof msg.ciphertext !== "string") {
      return this.fail("sender", "ciphertext required");
    }
    if (msg.ciphertext.length > MAX_CIPHERTEXT_BYTES) {
      return this.fail("sender", "ciphertext too large");
    }
    if (!this.session.browserSocket) {
      return this.fail("sender", "browser not connected");
    }
    if (this.session.delivered) {
      return this.fail("sender", "already delivered");
    }
    // Forward the opaque ciphertext untouched. We do not log it — it
    // is end-to-end-encrypted user content and .com must not see it.
    this.send(this.session.browserSocket, {
      kind: "blob",
      ciphertext: msg.ciphertext,
    });
    this.send(this.session.senderSocket!, { kind: "delivered" });
    this.session.delivered = true;
    // Close both peers cleanly so neither tries to send a second blob
    // (the DO never replays).
    queueMicrotask(() => this.tearDown("delivered"));
  }

  private parse(data: string | ArrayBuffer): BuildRelayMessage | null {
    let text: string;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else return null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") {
        return parsed as BuildRelayMessage;
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

  private fail(role: "browser" | "sender", reason: string): void {
    const target =
      role === "browser" ? this.session.browserSocket : this.session.senderSocket;
    if (target) {
      this.send(target, { kind: "error", reason });
    }
    // Defer teardown by a microtask so the error frame above lands on
    // the peer's listeners before the close event tears the pair
    // down. Workers' WebSocket implementation flushes in-flight sends
    // ahead of a close; the Node test polyfill doesn't.
    queueMicrotask(() => this.tearDown(`${role}:${reason}`));
  }

  private tearDown(_why: string): void {
    if (this.ttlTimer) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }
    const closeQuiet = (s: WebSocket | null): void => {
      if (!s) return;
      try {
        s.close(1000, "session over");
      } catch {
        // already closed
      }
    };
    closeQuiet(this.session.browserSocket);
    closeQuiet(this.session.senderSocket);
    this.session.browserSocket = null;
    this.session.senderSocket = null;
  }

  private isExpired(): boolean {
    return Date.now() - this.session.createdAt >= SESSION_TTL_MS;
  }

  private scheduleTtl(): void {
    this.ttlTimer = setTimeout(() => {
      // 5-minute hard cap. If no peer joined the session ends here
      // and any subsequent upgrade attempt sees 410.
      this.tearDown("ttl");
    }, SESSION_TTL_MS);
  }
}

/**
 * Derive a 6-digit base-10 match code from the session id and the
 * browser's X25519 public key. Pure function — exported so the phone
 * (and the unit tests) can derive the same digits client-side.
 */
export async function deriveMatchCode(
  sessionId: string,
  browserPkHex: string,
): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(browserPkHex)) {
    throw new Error("browserPk must be 32 bytes hex");
  }
  const sessionBytes = new TextEncoder().encode(sessionId);
  const pkBytes = hexToBytes(browserPkHex);
  const ikm = new Uint8Array(sessionBytes.length + pkBytes.length);
  ikm.set(sessionBytes, 0);
  ikm.set(pkBytes, sessionBytes.length);
  const salt = new TextEncoder().encode(HKDF_SALT);
  const info = new TextEncoder().encode(HKDF_INFO);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    ikm,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    baseKey,
    32,
  );
  const view = new DataView(bits);
  const u32 = view.getUint32(0, false);
  const digits = (u32 % 1_000_000).toString().padStart(6, "0");
  return digits;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export const _internal = {
  SESSION_TTL_MS,
  MAX_CIPHERTEXT_BYTES,
  HKDF_SALT,
  HKDF_INFO,
};
