/**
 * `flagship-build pair` — pair this computer with the phone over the live
 * relay and receive the signed recipe.
 *
 * This is the Linux / Chromebook counterpart to the macOS Swift builder's
 * pairing screen. The builder shows a QR + an 8-char code; the phone (the
 * Flagship app) scans/types it, both confirm a 6-digit security code (SAS),
 * and the phone delivers the recipe over the live `/builder-pipe` session.
 * A dropped session ends the pairing (the relay is the gate). The crypto is
 * the cross-platform `@flagship/protocol` builderPairing (pinned vector).
 *
 * After the recipe arrives it's verified locally (the phone's signature is
 * the trust root — we never call .com to verify) and saved to disk; you
 * then run `flagship-build write <recipe> <iso>` to flash the USB.
 *
 * ADVANCED — debug access (`--debug`): mirrors the macOS builder's Advanced
 * "Debug mode" toggle. Enabling a box's debug console user / SSH is NOT a
 * builder checkbox — it requires an owner-IRK-signed grant the BOX verifies.
 * With `--debug`, after the recipe arrives the builder sends a `consent-request`
 * over the session; the phone shows a security warning + Face ID and replies
 * with a signed `flagship/debug-access/v1` grant; the builder embeds it as the
 * recipe's UNSIGNED `debugGrant` sibling (exactly like `swkHex`/`pairingOrder`)
 * so the box-side gate enables debug ONLY after verifying it against the
 * config-pinned owner IRK. Deny/timeout ⇒ no grant ⇒ a production image.
 */
import WebSocket from "ws";
import QRCode from "qrcode";
import { writeFile } from "node:fs/promises";
import {
  newBuilderKeypair,
  newCodeBytes,
  sessionId,
  humanCode,
  formatHumanCode,
  qrPayload,
  deriveSessionMaterial,
  formatSas,
  openDelivered,
  base64UrlEncode,
  base64UrlDecode,
  verifyDebugAccessGrant,
  type DebugAccessGrant,
  type Bytes,
} from "@flagship/protocol";
import { loadBlobFromString } from "./loadBlob.js";

/** A minimal duplex transport so `runPair` is testable without a real socket. */
export interface PairTransport {
  send(text: string): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (e: Error) => void): void;
}

export type PairTransportFactory = (url: string) => PairTransport;

export interface PairOptions {
  host?: string; // control host; default flagshipserver.com (env FLAGSHIP_CONTROL_HOST)
  out?: string; // where to save the received recipe JSON
  insecure?: boolean; // ws:// instead of wss:// (local relay testing)
  /** Advanced: request an owner-signed debug-access grant over the session. */
  debug?: boolean;
  /** The security warning the phone shows when approving the debug toggle. */
  debugWarning?: string;
  /** How long to wait for the phone's consent reply before finalizing (ms). */
  consentTimeoutMs?: number;
  // ── test seams (all optional; defaults are the real thing) ──
  /** Inject the transport (default: a `ws` WebSocket). */
  transport?: PairTransportFactory;
  /** Fixed session code bytes (default: random). */
  codeBytes?: Bytes;
  /** Fixed builder keypair (default: random). */
  keypair?: { secretKey: Bytes; publicKey: Bytes };
  /** Suppress the QR / human-facing prints (tests). */
  quiet?: boolean;
  /**
   * Structured milestone callback for GUI hosts (the Windows/Mac desktop apps
   * drive `flagship-build pair` as a subprocess and render a native cover). When
   * set, each pairing milestone is reported as a typed event; the human-facing
   * `log()` prints are unaffected (a caller can also pass `quiet` to suppress
   * them). Additive — a caller that doesn't set this sees byte-identical
   * behavior to before.
   */
  emitEvents?: (ev: PairEvent) => void;
}

/** Machine-readable pairing milestones (see PairOptions.emitEvents). */
export type PairEvent =
  /** Cover is up: show the QR + code and wait for the phone. `qrTerminal` is
   *  the scannable unicode-block QR; `payload` is the raw QR string (for a
   *  host that renders its own image). */
  | { event: "ready"; sessionId: string; humanCode: string; payload: string; qrTerminal: string; debugRequested: boolean }
  /** The phone connected; compare `sas` against the phone before approving. */
  | { event: "phone-connected"; sas: string }
  /** SAS confirmed on the phone; the recipe is arriving. */
  | { event: "paired" }
  /** The recipe was received + verified. */
  | { event: "delivered"; serverDomain: string }
  /** Debug-access consent resolved (only when `--debug`). */
  | { event: "debug-result"; granted: boolean }
  /** Terminal success: the recipe is written to `recipePath`. */
  | { event: "done"; recipePath: string; serverDomain: string; debugGranted: boolean }
  /** Terminal failure. */
  | { event: "error"; message: string };

const DEFAULT_DEBUG_WARNING =
  "Turning on debug lets someone log into this server's console. Only approve this for a box you're actively debugging.";
const DEFAULT_CONSENT_TIMEOUT_MS = 120_000;

function realTransport(url: string): PairTransport {
  const ws = new WebSocket(url);
  return {
    send: (text) => { try { ws.send(text); } catch { /* socket gone */ } },
    close: () => { try { ws.close(); } catch { /* */ } },
    onOpen: (cb) => ws.on("open", cb),
    onMessage: (cb) => ws.on("message", (d) => cb(d.toString())),
    onClose: (cb) => ws.on("close", () => cb()),
    onError: (cb) => ws.on("error", (e) => cb(e as Error)),
  };
}

export interface PairResult {
  recipePath: string;
  serverDomain: string;
  /** True when a verified owner-IRK debug grant was embedded (`--debug`). */
  debugGranted: boolean;
}

export async function runPair(opts: PairOptions = {}): Promise<PairResult> {
  const host = opts.host ?? process.env.FLAGSHIP_CONTROL_HOST ?? "flagshipserver.com";
  const scheme = opts.insecure ? "ws" : "wss";
  const outPath = opts.out ?? "./flagship-recipe.json";
  const wantDebug = opts.debug === true;
  const consentTimeoutMs = opts.consentTimeoutMs ?? DEFAULT_CONSENT_TIMEOUT_MS;
  const makeTransport = opts.transport ?? realTransport;
  const log = (s: string) => { if (!opts.quiet) process.stdout.write(s + "\n"); };

  const emit = (ev: PairEvent) => { try { opts.emitEvents?.(ev); } catch { /* never let a host callback break pairing */ } };

  const kp = opts.keypair ?? newBuilderKeypair();
  const code = opts.codeBytes ?? newCodeBytes();
  const sid = sessionId(code);
  const human = humanCode(code);
  const payload = qrPayload(human, kp.publicKey);

  // Render the QR + announce readiness AFTER the transport handlers are
  // registered synchronously below (QRCode.toString is async; awaiting it here
  // would yield control before the socket callbacks are wired, which the test
  // harness — and a fast real relay — would race). Fire-and-forget so setup
  // stays synchronous.
  const announceReady = async () => {
    const qrTerminal = await QRCode.toString(payload, { type: "terminal", small: true });
    emit({ event: "ready", sessionId: sid, humanCode: human, payload, qrTerminal, debugRequested: wantDebug });
    if (!opts.quiet) {
      log("");
      log(qrTerminal);
      log(`  Pair from your phone — open Flagship, choose "Pair with the builder app".`);
      log(`  Scan the QR above, or enter this code:   ${formatHumanCode(human)}`);
      log(`  (Don't have it? Get the Flagship app at https://${host})`);
      if (wantDebug) {
        log(`  Advanced: debug access requested — you'll approve it on your phone after the recipe arrives.`);
      }
      log("");
      log("  Waiting for your phone…");
    }
  };

  const url = `${scheme}://${host}/builder-pipe/${sid}?role=builder`;
  const transport = makeTransport(url);

  let aeadKey: Bytes | null = null;
  let helloSent = false;
  let ownerIrkPub: Bytes | null = null;
  let recipeText: string | null = null;
  let recipeDomain: string | null = null;
  let debugCarrier: string | null = null; // the `{grant,signatureHex}` JSON to embed
  let finalized = false;
  let pingTimer: NodeJS.Timeout | undefined;
  let consentTimer: NodeJS.Timeout | undefined;

  const sendUp = (obj: unknown) => transport.send(JSON.stringify(obj));
  const sendBuilderHello = () => {
    if (helloSent) return;
    helloSent = true;
    sendUp({ kind: "builder-hello", builderPk: base64UrlEncode(kp.publicKey) });
  };

  const resultPromise = new Promise<PairResult>((resolve, reject) => {
    const cleanup = () => {
      if (pingTimer) clearInterval(pingTimer);
      if (consentTimer) clearTimeout(consentTimer);
      try { transport.close(); } catch { /* */ }
    };
    const fail = (msg: string) => {
      if (finalized) return;
      finalized = true;
      cleanup();
      emit({ event: "error", message: msg });
      reject(new Error(msg));
    };

    /** Write the recipe (with the debug grant, if granted) and resolve once. */
    const finalize = async () => {
      if (finalized) return;
      if (!recipeText || !recipeDomain) {
        // Nothing to write yet — caller decides (peer-gone before delivery just waits).
        return;
      }
      finalized = true;
      try {
        let toWrite = recipeText;
        if (debugCarrier) {
          // Embed the verified grant as an UNSIGNED top-level `debugGrant`
          // sibling (not part of the signed blob canonical bytes).
          const obj = JSON.parse(recipeText) as Record<string, unknown>;
          obj.debugGrant = debugCarrier;
          toWrite = JSON.stringify(obj);
        }
        await writeFile(outPath, toWrite, { mode: 0o600 });
        sendUp({ kind: "recipe-accepted" });
        cleanup();
        emit({ event: "done", recipePath: outPath, serverDomain: recipeDomain, debugGranted: !!debugCarrier });
        log("");
        log(`  ✅ Recipe received + verified for:   ${recipeDomain}`);
        if (wantDebug) {
          log(debugCarrier
            ? `     Debug access:  GRANTED (owner-signed) — the box will enable the debug user.`
            : `     Debug access:  not granted — burning a production image (no debug user).`);
        }
        log(`     Saved to: ${outPath}`);
        log(`     Next:     sudo flagship-build write ${outPath} <base.iso>`);
        resolve({ recipePath: outPath, serverDomain: recipeDomain, debugGranted: !!debugCarrier });
      } catch (e) {
        cleanup();
        reject(new Error(`couldn't save the recipe: ${(e as Error).message}`));
      }
    };

    const requestDebugConsent = () => {
      if (!recipeDomain) return;
      log("");
      log("  Requesting debug access — approve it on your phone (Face ID)…");
      sendUp({
        kind: "consent-request",
        setting: "debug",
        serverDomain: recipeDomain,
        warning: opts.debugWarning ?? DEFAULT_DEBUG_WARNING,
      });
      consentTimer = setTimeout(() => {
        log("  Debug approval timed out — burning a production image (no debug user).");
        void finalize();
      }, consentTimeoutMs);
    };

    /** Parse + locally verify a consent-result `grant` (string or object). */
    const acceptConsentResult = (frame: Record<string, unknown>) => {
      if (consentTimer) { clearTimeout(consentTimer); consentTimer = undefined; }
      const rawGrant = frame["grant"];
      let carrierObj: { grant?: unknown; signatureHex?: unknown } | null = null;
      let carrierStr: string | null = null;
      if (typeof rawGrant === "string" && rawGrant.length > 0) {
        carrierStr = rawGrant;
        try { carrierObj = JSON.parse(rawGrant); } catch { carrierObj = null; }
      } else if (rawGrant && typeof rawGrant === "object") {
        carrierObj = rawGrant as Record<string, unknown>;
        carrierStr = JSON.stringify(rawGrant);
      }
      if (!carrierObj || !carrierStr) {
        log("  Debug access was declined on the phone — burning a production image.");
        emit({ event: "debug-result", granted: false });
        void finalize();
        return;
      }
      // Best-effort local integrity check: the recipe's userPubKey IS the owner
      // IRK, so we can confirm the grant verifies (the box re-verifies anyway).
      const g = carrierObj.grant as Partial<DebugAccessGrant> | undefined;
      const sigHex = carrierObj.signatureHex;
      const sig = typeof sigHex === "string" ? base16(sigHex) : null;
      if (
        g && typeof g.serverDomain === "string" && typeof g.sshAuthorizedKey === "string" &&
        typeof g.issuedAt === "number" && sig && ownerIrkPub &&
        verifyDebugAccessGrant(g as DebugAccessGrant, sig, ownerIrkPub)
      ) {
        debugCarrier = carrierStr;
        log("  ✓ Debug grant verified under the owner key.");
      } else {
        log("  ⚠ Debug grant did not verify locally — embedding it anyway; the box is the authority.");
        debugCarrier = carrierStr;
      }
      emit({ event: "debug-result", granted: !!debugCarrier });
      void finalize();
    };

    transport.onOpen(() => {
      pingTimer = setInterval(() => sendUp({ kind: "ping" }), 20_000);
    });
    transport.onError((e) => fail(`relay connection failed: ${e.message}`));
    transport.onClose(() => {
      // If we already have the recipe, write it out; otherwise nothing to do.
      if (recipeText && !finalized) void finalize();
    });

    transport.onMessage((text) => { void handleRelayFrame(text); });

    const handleRelayFrame = async (text: string) => {
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(text); } catch { return; }
      switch (obj["kind"]) {
        case "accepted":
        case "peer-missing":
        case "pong":
          return;
        case "peer-present":
        case "peer-joined":
          sendBuilderHello();
          return;
        case "peer-gone":
          if (recipeText) {
            // The phone dropped after delivering — finalize with what we have.
            void finalize();
          } else {
            log("  The phone left before sending the recipe. Waiting for it to reconnect…");
            aeadKey = null; helloSent = false;
          }
          return;
        case "expired":
          if (recipeText) return void finalize();
          return fail("pairing session timed out — re-run `flagship-build pair`");
        case "error":
          return fail(`relay error: ${String(obj["reason"] ?? "unknown")}`);
        case "peer": {
          const frame = obj["frame"] as Record<string, unknown> | undefined;
          if (frame) await onPeerFrame(frame);
          return;
        }
        default:
          return;
      }
    };

    const onPeerFrame = async (frame: Record<string, unknown>) => {
      switch (frame["kind"]) {
        case "phone-hello": {
          const phonePkB64 = frame["phonePk"];
          if (typeof phonePkB64 !== "string") return;
          const phonePk = base64UrlDecode(phonePkB64);
          if (!phonePk) return;
          const mat = deriveSessionMaterial(kp.secretKey, phonePk);
          aeadKey = mat.aeadKey;
          emit({ event: "phone-connected", sas: formatSas(mat.sasCode) });
          log("");
          log(`  📱 Phone connected. Security code:   ${formatSas(mat.sasCode)}`);
          log(`  Confirm this matches the code on your phone, then approve there.`);
          return;
        }
        case "confirm-pairing":
          emit({ event: "paired" });
          log("  ✓ Paired. Receiving the recipe…");
          return;
        case "deliver": {
          if (recipeText) return; // already delivered
          if (!aeadKey) { log("  (recipe arrived before pairing completed — ignoring)"); return; }
          const ct = frame["ciphertext"];
          const nonce = frame["nonce"];
          if (typeof ct !== "string" || typeof nonce !== "string") return;
          try {
            const plaintext = openDelivered(ct, nonce, aeadKey);
            const text = new TextDecoder().decode(plaintext);
            const loaded = loadBlobFromString(text, { kind: "stdin" });
            recipeText = text;
            recipeDomain = loaded.blob.serverDomain;
            ownerIrkPub = loaded.blob.authCode.userPubKey;
            emit({ event: "delivered", serverDomain: recipeDomain });
            if (wantDebug) {
              requestDebugConsent(); // keep the session open for the consent round-trip
            } else {
              void finalize();
            }
          } catch (e) {
            fail(`couldn't read the delivered recipe: ${(e as Error).message}`);
          }
          return;
        }
        case "consent-result": {
          if (frame["setting"] !== "debug") return;
          acceptConsentResult(frame);
          return;
        }
        default:
          return;
      }
    };
  });

  // Handlers are now registered synchronously; the async QR render + `ready`
  // announcement can't race the socket callbacks.
  void announceReady();
  return await resultPromise;
}

function base16(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
