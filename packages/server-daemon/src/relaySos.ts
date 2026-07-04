/**
 * Relay-trust SOS sender (docs/maintainer-trust-enforcement.md § "Box =
 * fail-closed lockdown"). Replaces the log-only owner-notify hook with a real
 * STK-signed `flagship/push-relay/v1` fan-out.
 *
 * When a box enters relay-lockdown (ENFORCE only), it proactively wakes its
 * owner: it signs a push-relay request with its STK (the same identity key it
 * signs daemon-status + box-trust-status with) and POSTs it to
 * `.com/api/push/relay`, category "cert-alert". `.com` authenticates the sender
 * as one of the target user's own boxes (it verifies the STK signature against
 * the registered servers), then fans the opaque payload out to the owner's
 * push tokens; the plaintext CATEGORY ("cert-alert") is what the OS shows on
 * the lock screen, so the owner is woken even though the body is confidential.
 *
 * DIVISION OF LABOR: the push is only the WAKE. The AUTHORITATIVE, unforgeable
 * trust detail is the STK-signed box-trust-status the daemon already relays on
 * `/pods` (which the phone re-verifies against the locally-derived STK). So the
 * sealed body here is deliberately minimal — a rogue `.com` that drops the push
 * only delays the wake; the /pods verdict still surfaces on the next poll. A
 * caller that can seal a richer detail to the owner's push key passes it as
 * `sealedPayloadHex`; absent, a minimal opaque marker still lands the category.
 *
 * Best-effort + never throws: a `.com` outage just means the wake didn't fire.
 */

import { canonicalPushRelayRequest, type PushRelayRequest } from "@flagship/protocol";
import type { BoxSigner } from "./keyCustodian.js";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export interface SendRelayTrustAlertOptions {
  /** The owner account the alert fans out to. */
  targetUsername: string;
  /** Box-identity (STK) signer — the custodian slice; signs the request. */
  signer: BoxSigner;
  /** `.com` base URL. */
  controlPlaneBaseUrl: string;
  /**
   * Hex of the payload sealed to the owner's push X25519 pub. Optional — when
   * absent a minimal opaque marker is sent so the plaintext category still
   * wakes the phone (the authoritative detail rides /pods, not this body).
   */
  sealedPayloadHex?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/** A minimal, non-empty opaque payload so the category push still fires when
 *  the caller can't seal a richer body to the owner push key. */
const MARKER_PAYLOAD_HEX = "00".repeat(32);

/**
 * POST one STK-signed `flagship/push-relay/v1` trust alert. Returns whether
 * `.com` accepted it (best-effort; never throws).
 */
export async function sendRelayTrustAlert(
  opts: SendRelayTrustAlertOptions,
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});

  const request: PushRelayRequest = {
    targetUsername: opts.targetUsername,
    category: "cert-alert",
    sealedPayloadHex: opts.sealedPayloadHex ?? MARKER_PAYLOAD_HEX,
    issuedAt: now(),
  };
  // Sign the exact canonical bytes `.com` verifies with the box STK. The
  // custodian's private half never leaves the custodian.
  const sig = opts.signer.signAsBox(canonicalPushRelayRequest(request));

  try {
    const url = `${opts.controlPlaneBaseUrl.replace(/\/+$/, "")}/api/push/relay`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: {
          targetUsername: request.targetUsername,
          category: request.category,
          sealedPayloadHex: request.sealedPayloadHex,
          issuedAt: request.issuedAt,
        },
        signature: bytesToHex(sig),
      }),
    });
    if (!res.ok) {
      log(`[relay-trust] SOS push relay ${res.status}`);
      return false;
    }
    log("[relay-trust] SOS push relay accepted (category=cert-alert)");
    return true;
  } catch (e) {
    log(`[relay-trust] SOS push relay failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
