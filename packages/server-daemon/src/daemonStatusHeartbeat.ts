import { X509Certificate } from "node:crypto";
import {
  signDaemonStatusReport,
  signBoxTrustStatusReport,
  type BoxTrustStatusReport,
  type DaemonStatusReport,
  type MsgSigner,
} from "@flagship/protocol";
import type { CertMaterial } from "./certManager.js";
import type { RelayTrustSnapshot } from "./relayLockdown.js";

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
    // node's `X509Certificate.issuer` is a NEWLINE-separated DN
    // (e.g. "C=US\nO=Let's Encrypt\nCN=R11"). The canonical-bytes field guard
    // (`legacyFieldGuard`) rejects control chars — newline is 0x0a — and the
    // '|' separator, so the RAW issuer makes `signDaemonStatusReport` THROW,
    // which `postDaemonStatus` used to swallow silently: the box never posted a
    // cert-bearing report and `daemon_status` stayed empty (no currentCert /
    // signedStatus on /pods, breaking phone-side cert pinning). Flatten the DN
    // to one safe line so the report signs + verifies + relays cleanly.
    const rawIssuer = x.issuer || "";
    const certIssuer =
      rawIssuer
        .replace(/[\r\n]+/g, ", ")
        .replace(/[\u0000-\u001f\u007f|]/g, "")
        .trim() || null;
    return {
      certSha256: /^[0-9a-f]{64}$/.test(certSha256) ? certSha256 : null,
      certIssuer,
    };
  } catch {
    return { certSha256: null, certIssuer: null };
  }
}

/** POST one signed daemon-status report. Best-effort; never throws. */
export async function postDaemonStatus(args: {
  serverDomain: string;
  /** Signs the report's canonical bytes. A `Keypair` OR a custodian-backed
   *  `sign(msg)` closure — the daemon passes the closure so it never holds the
   *  raw STK here. */
  sign: MsgSigner;
  controlPlaneBaseUrl: string;
  cert: CertMaterial;
  certValidUntil: number;
  appsServed: string[];
  /**
   * The service slugs THIS box currently LEADS (Phase 6 Part 3) — relayed on /pods
   * as a per-pod `leadsServices` so clients can badge "lead". UNSIGNED: it is NOT
   * part of the canonical daemon-status bytes (the signed report covers cert +
   * appsServed only, keeping the pinned vector + native mirrors byte-identical), so
   * it rides the POST body + reportJson purely as an advisory display field.
   */
  leadsServices?: string[];
  /**
   * The slugs of every app THIS box runs, led or not. UNSIGNED and advisory
   * like `leadsServices`: `.com` uses it to say where an app runs (its links'
   * instances, and which box an app's canonical URL and voi.ci link point at).
   */
  runsServices?: string[];
  /**
   * The box's PER-BOX relay-trust snapshot (relayLockdown.trustStatus()). When
   * present it is signed into a SIBLING `flagship/box-trust-status/v1` envelope
   * (STK-signed, distinct from the daemon-status signature) and ridden on the
   * POST body as `trustStatus: { report, signatureHex }`, so `.com` can relay
   * the box's own verdict verbatim on /pods for client re-verification. This is
   * how the "this server appears unauthorized" state crosses the untrusted
   * relay unforgeably. Emitted on EVERY beat regardless of enforce (detect +
   * propagate always run). Absent ⇒ no trustStatus is sent (additive).
   */
  trustStatus?: RelayTrustSnapshot;
  /** Receives the owner's server order from the reply (docs/server-order.md);
   *  the caller verifies it before using it. */
  onServerOrder?: (raw: unknown) => void;
  /** Receives the doorbell from each reply (`.com` says which polls would come
   *  back empty; doorbell.ts). Absent from an older `.com`. */
  onDoorbell?: (raw: unknown) => void;
  /**
   * `issuedAt` of the server order this box ranks by (0 = none). UNSIGNED
   * and advisory like `leadsServices`: `.com` relays it on /pods as the
   * box's acknowledgement, and the apps show the leader gray until it
   * matches the order on screen.
   */
  orderIssuedAt?: number;
  /** UNSIGNED advisory: this box waits for (or is restoring) one backup, so
   *  Home can say so (docs/server-backup-and-clone.md). */
  awaitingBackup?: AwaitingBackup;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /**
   * Bound each POST so a black-holed network (the exact failure that wedged a
   * real box: outbound TCP silently dead, no RST) can't leave the request
   * hanging forever and stalling/accumulating sockets across beats. Default
   * 30s; the heartbeat is best-effort so a timeout is just a skipped beat —
   * the next one fires on cadence regardless. 0/absent ⇒ no per-request bound.
   */
  requestTimeoutMs?: number;
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
    const sig = signDaemonStatusReport(fields, args.sign);

    // SIBLING envelope — the box's own STK-signed relay-trust verdict. Built +
    // signed independently of the daemon-status report (its own canonical
    // bytes), so the pinned daemon-status vector stays byte-identical. Rides
    // the POST body as `trustStatus`; `.com` relays it verbatim on /pods.
    let trustStatusBlock:
      | { report: BoxTrustStatusReport; signatureHex: string }
      | undefined;
    if (args.trustStatus) {
      const btsReport: BoxTrustStatusReport = {
        serverDomain: args.serverDomain,
        relayVerdict: args.trustStatus.relayVerdict,
        lockedDown: args.trustStatus.lockedDown,
        failingCertHash: args.trustStatus.failingCertHash,
        coveringExceptionCertHash: args.trustStatus.coveringExceptionCertHash,
        nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
        issuedAt,
      };
      trustStatusBlock = {
        report: btsReport,
        signatureHex: bytesToHex(signBoxTrustStatusReport(btsReport, args.sign)),
      };
    }

    const url = `${args.controlPlaneBaseUrl.replace(/\/+$/, "")}/api/daemon-status`;
    const timeoutMs = args.requestTimeoutMs ?? 30_000;
    const signal =
      timeoutMs > 0 && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
    const resp = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(signal ? { signal } : {}),
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
        // UNSIGNED advisory field (NOT in the canonical bytes) — `.com` relays it
        // on /pods so clients can show which services this box currently leads.
        ...(args.leadsServices ? { leadsServices: args.leadsServices } : {}),
        ...(args.runsServices ? { runsServices: args.runsServices } : {}),
        ...(args.orderIssuedAt !== undefined ? { orderIssuedAt: args.orderIssuedAt } : {}),
        ...(args.awaitingBackup ? { awaitingBackup: args.awaitingBackup } : {}),
        // Separately-signed SIBLING envelope: the box's per-box relay-trust
        // verdict. `.com` relays it verbatim on /pods for client re-verify.
        ...(trustStatusBlock ? { trustStatus: trustStatusBlock } : {}),
      }),
    });
    // Log a rejected report so a non-2xx (bad signature, schema drift) is
    // visible in the journal instead of silently leaving daemon_status empty.
    if (resp?.ok && (args.onServerOrder || args.onDoorbell)) {
      const reply = (await Promise.resolve()
        .then(() => resp.json())
        .catch(() => null)) as { serverOrder?: unknown; doorbell?: unknown } | null;
      if (reply?.serverOrder && args.onServerOrder) args.onServerOrder(reply.serverOrder);
      if (reply?.doorbell && args.onDoorbell) args.onDoorbell(reply.doorbell);
    } else if (resp && !resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error(
        `[daemon-status] ${url} → ${resp.status} ${body.slice(0, 200)}`,
      );
    }
  } catch (e) {
    // Heartbeat is best-effort; never let it break the daemon — but LOG so a
    // thrown failure (e.g. a canonical-bytes guard rejecting a malformed field,
    // the bug that left daemon_status empty) is diagnosable, not invisible.
    console.error(
      `[daemon-status] report failed: ${(e as Error)?.message ?? String(e)}`,
    );
  }
}

/** A box created to restore a backup, until the backup is in. */
export interface AwaitingBackup {
  archiveId: string;
  state: "waiting" | "restoring";
}

export interface DaemonStatusHeartbeat {
  /** Update the cert snapshot the heartbeat reports (called on every cert
   *  issue/renewal) and fire one report immediately. */
  update(cert: CertMaterial, certValidUntil: number, appsServed: string[]): void;
  /** Report now if the apps this box runs changed since the last beat. */
  appsChanged(): void;
  /** Report now: the box adopted a newer server order (its acknowledgement). */
  orderChanged(): void;
  /** Report now: the box started or stopped waiting for its backup. */
  backupWaitChanged(): void;
  /** Stop the periodic timer. */
  stop(): void;
}

/**
 * Start a periodic signed daemon-status heartbeat. Returns a handle whose
 * `update` is wired into `onCertIssued` so the first report fires the moment
 * the cert lands, and subsequent ticks (default every 5 min) refresh
 * `lastReported` so the UI shows true current liveness. No-op until the first
 * `update` (no cert yet ⇒ nothing to report).
 *
 * SELF-HEALING CONTRACT: the loop CANNOT die. A real box once sent exactly ONE
 * beat then went silent until a manual reboot — the cure is a heartbeat that
 * survives every failure mode and keeps beating on cadence regardless:
 *   - the loop is a self-rescheduling timer (NOT a bare `setInterval` whose
 *     callback throwing could surface as an uncaughtException — there is no
 *     uncaughtException handler in the daemon — and kill the process / the
 *     cadence). The next beat is scheduled in a `finally`, so nothing thrown in
 *     a tick can stop the next one;
 *   - every read+send is fire-and-forget and try/caught (`readLeads()` could
 *     throw; `postDaemonStatus` already never throws), so a tick is total;
 *   - the send is bounded (see `requestTimeoutMs`), so a black-holed network
 *     can't hang a beat;
 *   - it is INDEPENDENT of the tunnel — it POSTs straight to `.com`, so `.com`
 *     liveness recovers the moment the network returns even while the tunnel
 *     supervisor is still mid-reconnect.
 */
export function startDaemonStatusHeartbeat(args: {
  serverDomain: string;
  /** Report signer — a `Keypair` or a custodian-backed `sign(msg)` closure. */
  sign: MsgSigner;
  controlPlaneBaseUrl: string;
  intervalMs?: number;
  /** Bound for each POST (see postDaemonStatus.requestTimeoutMs). Default 30s. */
  requestTimeoutMs?: number;
  /**
   * Snapshot the services this box currently LEADS at each report (Phase 6 Part 3).
   * Re-read each fire so a re-election between cert renewals is reflected on the
   * next heartbeat. Absent ⇒ no `leadsServices` is sent (additive). The daemon
   * wires the gossip loop's `currentLeads()` here.
   */
  readLeads?: () => string[];
  /** Snapshot the slugs of every app this box runs, re-read each beat;
   *  undefined until the app platform is up (so `.com` never reads "none"). */
  readRuns?: () => string[] | undefined;
  /**
   * Snapshot the box's PER-BOX relay-trust verdict at each beat
   * (relayLockdown.trustStatus()). Re-read each fire so a verdict change
   * between cert renewals propagates on the next heartbeat. Absent / returns
   * null ⇒ no `trustStatus` is signed or sent (additive; an old box omits it).
   * The daemon back-patches this to the runtime's relayLockdown controller.
   */
  readTrustStatus?: () => RelayTrustSnapshot | null;
  /** Receives the owner's server order from each reply (see postDaemonStatus). */
  onServerOrder?: (raw: unknown) => void;
  /** Receives the doorbell from each reply (see postDaemonStatus). */
  onDoorbell?: (raw: unknown) => void;
  /** `issuedAt` of the held server order, re-read each beat (see postDaemonStatus). */
  readOrderIssuedAt?: () => number;
  /** Whether this box waits for its backup, re-read each beat. */
  readAwaitingBackup?: () => AwaitingBackup | null;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Test seam — replace setTimeout/clearTimeout (the self-rescheduling cadence). */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}): DaemonStatusHeartbeat {
  const intervalMs = args.intervalMs ?? 5 * 60 * 1000;
  const setTimeoutFn = args.setTimeoutImpl ?? setTimeout;
  const clearTimeoutFn = args.clearTimeoutImpl ?? clearTimeout;
  let snapshot:
    | { cert: CertMaterial; certValidUntil: number; appsServed: string[] }
    | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sentRuns: string | undefined;
  // One beat in flight at a time: a beat asked for meanwhile is sent when it
  // returns, read fresh then. Two concurrent POSTs can land out of order, and
  // `.com` keeps the last one it receives, so a stale beat could overwrite a
  // newer state (a restore that finished still read "restoring").
  let inFlight = false;
  let again = false;
  const runsKey = (r: string[] | undefined) => (r ? [...r].sort().join(",") : undefined);

  /**
   * Fire one best-effort beat. WHOLLY non-throwing: `readLeads()` is guarded
   * (it can throw) and the send is fire-and-forget (`postDaemonStatus` itself
   * never throws). The loop's survival does NOT depend on this returning
   * cleanly, but we keep it total anyway so a tick is never interrupted.
   */
  const fire = (): void => {
    if (!snapshot) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    const settle = (): void => {
      inFlight = false;
      if (again) {
        again = false;
        fire();
      }
    };
    try {
      let leadsServices: string[] | undefined;
      try {
        leadsServices = args.readLeads?.();
      } catch {
        // A gossip-loop read that throws must never kill the heartbeat — drop
        // the advisory leads for this beat and report cert/liveness anyway.
        leadsServices = undefined;
      }
      let runsServices: string[] | undefined;
      try {
        runsServices = args.readRuns?.();
      } catch {
        runsServices = undefined;
      }
      sentRuns = runsKey(runsServices);
      let trustStatus: RelayTrustSnapshot | undefined;
      try {
        trustStatus = args.readTrustStatus?.() ?? undefined;
      } catch {
        // A trust-snapshot read that throws must never kill the heartbeat —
        // drop the trust block for this beat and report liveness anyway.
        trustStatus = undefined;
      }
      let orderIssuedAt: number | undefined;
      try {
        orderIssuedAt = args.readOrderIssuedAt?.();
      } catch {
        orderIssuedAt = undefined;
      }
      let awaitingBackup: AwaitingBackup | null = null;
      try {
        awaitingBackup = args.readAwaitingBackup?.() ?? null;
      } catch {
        awaitingBackup = null;
      }
      void Promise.resolve(postDaemonStatus({
        serverDomain: args.serverDomain,
        sign: args.sign,
        controlPlaneBaseUrl: args.controlPlaneBaseUrl,
        cert: snapshot.cert,
        certValidUntil: snapshot.certValidUntil,
        appsServed: snapshot.appsServed,
        ...(leadsServices && leadsServices.length > 0 ? { leadsServices } : {}),
        ...(runsServices ? { runsServices } : {}),
        ...(orderIssuedAt !== undefined ? { orderIssuedAt } : {}),
        ...(awaitingBackup ? { awaitingBackup } : {}),
        ...(trustStatus ? { trustStatus } : {}),
        ...(args.onServerOrder ? { onServerOrder: args.onServerOrder } : {}),
        ...(args.onDoorbell ? { onDoorbell: args.onDoorbell } : {}),
        ...(args.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: args.requestTimeoutMs }
          : {}),
        ...(args.now ? { now: args.now } : {}),
        ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
      })).finally(settle);
    } catch (e) {
      inFlight = false;
      // Defensive: nothing above should throw synchronously, but a beat must
      // never propagate out of the timer callback (no uncaughtException handler).
      console.error(
        `[daemon-status] fire failed: ${(e as Error)?.message ?? String(e)}`,
      );
    }
  };

  // Self-rescheduling cadence. The next beat is ALWAYS armed in `finally`, so
  // no failure in a tick — even an unexpected synchronous throw — can stop the
  // heartbeat. This is the structural guarantee that the loop cannot die.
  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeoutFn(tick, intervalMs);
    if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
      // Don't keep the process alive solely for the heartbeat.
      (timer as { unref?: () => void }).unref!();
    }
  };
  function tick(): void {
    try {
      fire();
    } finally {
      scheduleNext();
    }
  }

  // Start the periodic loop. It ticks harmlessly (fire() no-ops) until the
  // first `update` lands a cert snapshot.
  scheduleNext();

  return {
    update(cert, certValidUntil, appsServed) {
      snapshot = { cert, certValidUntil, appsServed };
      // Fire immediately on a cert issue/renewal; the periodic loop keeps its
      // own cadence independently (we don't reset it here).
      fire();
    },
    appsChanged() {
      try {
        if (runsKey(args.readRuns?.()) !== sentRuns) fire();
      } catch {
        // The next beat reports it.
      }
    },
    orderChanged() {
      fire();
    },
    backupWaitChanged() {
      fire();
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }
    },
  };
}
