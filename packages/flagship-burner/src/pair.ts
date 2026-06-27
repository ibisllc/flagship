/**
 * `flagship-burn pair` — pair this computer with the phone over the live
 * relay and receive the signed recipe.
 *
 * This is the Linux / Chromebook counterpart to the macOS Swift burner's
 * pairing screen. The burner shows a QR + an 8-char code; the phone (the
 * Flagship app) scans/types it, both confirm a 6-digit security code (SAS),
 * and the phone delivers the recipe over the live `/burner-pipe` session.
 * A dropped session ends the pairing (the relay is the gate). The crypto is
 * the cross-platform `@flagship/protocol` burnerPairing (pinned vector).
 *
 * After the recipe arrives it's verified locally (the phone's signature is
 * the trust root — we never call .com to verify) and saved to disk; you
 * then run `flagship-burn write <recipe> <iso>` to flash the USB.
 */
import WebSocket from "ws";
import QRCode from "qrcode";
import { writeFile } from "node:fs/promises";
import {
  newBurnerKeypair,
  newCodeBytes,
  sessionId,
  humanCode,
  formatHumanCode,
  qrPayload,
  deriveSessionMaterial,
  formatSas,
  openDelivered,
  base64UrlEncode,
  type Bytes,
} from "@flagship/protocol";
import { loadBlobFromString } from "./loadBlob.js";

export interface PairOptions {
  host?: string; // control host; default flagshipserver.com (env FLAGSHIP_CONTROL_HOST)
  out?: string; // where to save the received recipe JSON
  insecure?: boolean; // ws:// instead of wss:// (local relay testing)
}

const log = (s: string) => process.stdout.write(s + "\n");

export async function runPair(opts: PairOptions = {}): Promise<{ recipePath: string; serverDomain: string }> {
  const host = opts.host ?? process.env.FLAGSHIP_CONTROL_HOST ?? "flagshipserver.com";
  const scheme = opts.insecure ? "ws" : "wss";
  const outPath = opts.out ?? "./flagship-recipe.json";

  const kp = newBurnerKeypair();
  const code = newCodeBytes();
  const sid = sessionId(code);
  const human = humanCode(code);
  const payload = qrPayload(human, kp.publicKey);

  const qr = await QRCode.toString(payload, { type: "terminal", small: true });
  log("");
  log(qr);
  log(`  Pair from your phone — open Flagship, choose "Pair with the burner app".`);
  log(`  Scan the QR above, or enter this code:   ${formatHumanCode(human)}`);
  log(`  (Don't have it? Get the Flagship app at https://${host})`);
  log("");
  log("  Waiting for your phone…");

  const url = `${scheme}://${host}/burner-pipe/${sid}?role=burner`;
  const ws = new WebSocket(url);

  let aeadKey: Bytes | null = null;
  let helloSent = false;
  let pingTimer: NodeJS.Timeout | undefined;

  const sendUp = (obj: unknown) => {
    try { ws.send(JSON.stringify(obj)); } catch { /* socket gone */ }
  };
  const sendBurnerHello = () => {
    if (helloSent) return;
    helloSent = true;
    sendUp({ kind: "burner-hello", burnerPk: base64UrlEncode(kp.publicKey) });
  };

  return await new Promise((resolve, reject) => {
    const fail = (msg: string) => {
      if (pingTimer) clearInterval(pingTimer);
      try { ws.close(); } catch { /* */ }
      reject(new Error(msg));
    };

    ws.on("open", () => {
      pingTimer = setInterval(() => sendUp({ kind: "ping" }), 20_000);
    });

    ws.on("error", (e) => fail(`relay connection failed: ${(e as Error).message}`));
    ws.on("close", () => {
      if (!aeadKey || !helloSent) { /* closed before any progress */ }
    });

    ws.on("message", async (data) => {
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(data.toString()); } catch { return; }
      const kind = obj["kind"];
      switch (kind) {
        case "accepted":
          return;
        case "peer-present":
        case "peer-joined":
          sendBurnerHello();
          return;
        case "peer-missing":
          return; // phone not here yet; it'll join
        case "pong":
          return;
        case "peer-gone":
          log("  The phone disconnected. Waiting for it to reconnect…");
          aeadKey = null; helloSent = false;
          return;
        case "expired":
          return fail("pairing session timed out — re-run `flagship-burn pair`");
        case "error":
          return fail(`relay error: ${String(obj["reason"] ?? "unknown")}`);
        case "peer": {
          const frame = obj["frame"] as Record<string, unknown> | undefined;
          if (!frame) return;
          await onPeerFrame(frame);
          return;
        }
        default:
          return;
      }
    });

    const onPeerFrame = async (frame: Record<string, unknown>) => {
      switch (frame["kind"]) {
        case "phone-hello": {
          const phonePkB64 = frame["phonePk"];
          if (typeof phonePkB64 !== "string") return;
          const { base64UrlDecode } = await import("@flagship/protocol");
          const phonePk = base64UrlDecode(phonePkB64);
          if (!phonePk) return;
          const mat = deriveSessionMaterial(kp.secretKey, phonePk);
          aeadKey = mat.aeadKey;
          log("");
          log(`  📱 Phone connected. Security code:   ${formatSas(mat.sasCode)}`);
          log(`  Confirm this matches the code on your phone, then approve there.`);
          return;
        }
        case "confirm-pairing": {
          log("  ✓ Paired. Receiving the recipe…");
          return;
        }
        case "deliver": {
          if (!aeadKey) { log("  (recipe arrived before pairing completed — ignoring)"); return; }
          const ct = frame["ciphertext"];
          const nonce = frame["nonce"];
          if (typeof ct !== "string" || typeof nonce !== "string") return;
          try {
            const plaintext = openDelivered(ct, nonce, aeadKey);
            const text = new TextDecoder().decode(plaintext);
            const loaded = await loadBlobFromString(text, { kind: "stdin" });
            await writeFile(outPath, text, { mode: 0o600 });
            log("");
            log(`  ✅ Recipe received + verified for:   ${loaded.blob.serverDomain}`);
            log(`     Saved to: ${outPath}`);
            log(`     Next:     sudo flagship-burn write ${outPath} <base.iso>`);
            if (pingTimer) clearInterval(pingTimer);
            try { ws.close(); } catch { /* */ }
            resolve({ recipePath: outPath, serverDomain: loaded.blob.serverDomain });
          } catch (e) {
            fail(`couldn't read the delivered recipe: ${(e as Error).message}`);
          }
          return;
        }
        default:
          return; // consent-request etc. (not handled by the CLI burner yet)
      }
    };
  });
}
