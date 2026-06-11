import { X509Certificate } from "node:crypto";
import {
  signDaemonStatusReport,
  type DaemonStatusReport,
  type Keypair,
} from "@flagship/protocol";
import type { CertMaterial } from "./certManager.js";

/**
 * Signed daemon-status heartbeat (the proper long-term fix for the /pods
 * "never came online" regression).
 *
 * A genuinely-live, serving box does NOT populate the `daemon_status` table
 * unless it actively POSTs this report — the /pods read path has a
 * provision-status liveness bridge as a fallback, but that bridge sets only
 * liveness, never real cert details. This heartbeat closes the gap: once the
 * box is serving a real cert, it periodically POSTs an STK-signed report
 * carrying the live cert fingerprint/validity/issuer + served app FQDNs, so
 * `daemon_status.lastReported` reflects TRUE current liveness and the UI can
 * render real cert info.
 *
 * This report is ALSO the cert-fingerprint pinning primitive (A′ phase 4a):
 * .com stores the verbatim signed tuple + signature and relays them on
 * /pods, so a phone re-verifies the fingerprint under the locally-derived
 * STK. Canonical bytes + sign live in @flagship/protocol (daemonStatus.ts)
 * — the ONE implementation the control-plane verifier and the client
 * mirrors pin against.
 */

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Pull the SHA-256 fingerprint (lowercase hex, no colons) + issuer DN from
 *  a leaf cert PEM. Best-effort: any parse failure yields nulls so the
 *  heartbeat still reports liveness even if cert introspection trips. */
function certDetails(certPem: string): {
  certSha256: string | null;
  certIssuer: string | null;
} {
  try {
    const x = new X509Certificate(certPem);
    const certSha256 = x.fingerprint256.replace(/:/g, "").toLowerCase();
    return {
      certSha256: /^[0-9a-f]{64}$/.test(certSha256) ? certSha256 : null,
      certIssuer: x.issuer || null,
    };
  } catch {
    return { certSha256: null, certIssuer: null };
  }
}

/** POST one signed daemon-status report. Best-effort; never throws. */
export async function postDaemonStatus(args: {
  serverDomain: string;
  identity: Keypair;
  controlPlaneBaseUrl: string;
  cert: CertMaterial;
  certValidUntil: number;
  appsServed: string[];
  now?: () => number;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  try {
    const doFetch = args.fetchImpl ?? fetch;
    const issuedAt = (args.now ?? (() => Date.now()))();
    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const { certSha256, certIssuer } = certDetails(args.cert.certPem);
    const fields: DaemonStatusReport = {
      serverDomain: args.serverDomain,
      certSha256,
      certValidUntil: Number.isFinite(args.certValidUntil)
        ? args.certValidUntil
        : null,
      certIssuer,
      appsServed: args.appsServed,
      nonce,
      issuedAt,
    };
    const sig = signDaemonStatusReport(fields, args.identity);
    const url = `${args.controlPlaneBaseUrl.replace(/\/+$/, "")}/api/daemon-status`;
    await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: {
          serverDomain: fields.serverDomain,
          certSha256: fields.certSha256,
          certValidUntil: fields.certValidUntil,
          certIssuer: fields.certIssuer,
          appsServed: fields.appsServed,
          nonce: fields.nonce,
          issuedAt: fields.issuedAt,
        },
        signature: bytesToHex(sig),
      }),
    });
  } catch {
    // Heartbeat is best-effort; never let it break the daemon.
  }
}

export interface DaemonStatusHeartbeat {
  /** Update the cert snapshot the heartbeat reports (called on every cert
   *  issue/renewal) and fire one report immediately. */
  update(cert: CertMaterial, certValidUntil: number, appsServed: string[]): void;
  /** Stop the periodic timer. */
  stop(): void;
}

/**
 * Start a periodic signed daemon-status heartbeat. Returns a handle whose
 * `update` is wired into `onCertIssued` so the first report fires the moment
 * the cert lands, and subsequent ticks (default every 5 min) refresh
 * `lastReported` so the UI shows true current liveness. No-op until the first
 * `update` (no cert yet ⇒ nothing to report).
 */
export function startDaemonStatusHeartbeat(args: {
  serverDomain: string;
  identity: Keypair;
  controlPlaneBaseUrl: string;
  intervalMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}): DaemonStatusHeartbeat {
  const intervalMs = args.intervalMs ?? 5 * 60 * 1000;
  let snapshot:
    | { cert: CertMaterial; certValidUntil: number; appsServed: string[] }
    | null = null;

  const fire = () => {
    if (!snapshot) return;
    void postDaemonStatus({
      serverDomain: args.serverDomain,
      identity: args.identity,
      controlPlaneBaseUrl: args.controlPlaneBaseUrl,
      cert: snapshot.cert,
      certValidUntil: snapshot.certValidUntil,
      appsServed: snapshot.appsServed,
      ...(args.now ? { now: args.now } : {}),
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    });
  };

  const timer = setInterval(fire, intervalMs);
  // Don't keep the process alive solely for the heartbeat.
  if (typeof timer.unref === "function") timer.unref();

  return {
    update(cert, certValidUntil, appsServed) {
      snapshot = { cert, certValidUntil, appsServed };
      fire();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
