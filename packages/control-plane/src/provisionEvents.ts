/**
 * Provisioning observability — POST /api/server/<domain>/provision-event.
 *
 * Makes demo-server provisioning a glass box. The box pushes named
 * PHASE checkpoints as it provisions; this handler validates + stores
 * the latest phase on the demo_users row and (via the injected fan-out)
 * fires a native push to the user's registered devices on every change.
 *
 * Two authentication channels share one phase vocabulary
 * (`@flagship/protocol` `PROVISION_PHASES`):
 *
 *   - Pre-daemon (cloud-init bootstrap) phases — `boot`, `cloned`,
 *     `deps`, `built`, `identity` — carry the auth-code SERIAL the box
 *     already holds. We validate the serial maps to THIS domain and
 *     that the demo row is `provisioning`. This is a low-stakes DISPLAY
 *     signal, NOT a security boundary, so the check is deliberately
 *     simple + the route is rate-limited at the Worker edge.
 *
 *   - Daemon phases — `tunnel-online`, `cert-issued`, `ready`,
 *     `failed` — carry an Ed25519 `ProvisionEvent` signature over the
 *     `flagship/provision-event/v1` canonical bytes, verified against
 *     the server identity registered at /api/server/register. Same key
 *     + posture as the daemon-status channel.
 *
 * Either way the phase is only ever a HINT the phone renders; it never
 * gates routing, TLS, or identity. So an unverifiable event is a 403
 * (we don't store it) but is never fatal to the box (the daemon's
 * reporter fails open — a dropped checkpoint just leaves the phone on
 * the prior phase until the next one lands).
 */

import {
  isProvisionPhase,
  verifyProvisionEvent,
  type ProvisionEvent,
  type ProvisionPhase,
} from "@flagship/protocol";
import type {
  AuthCodeStorage,
  DemoUserRecord,
  DemoUsersStorage,
  PushTokenStorage,
  ServerStorage,
} from "@flagship/storage";
import { HEX128, hexToBytes } from "./hex.js";
import {
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";
import type { V12PushFanout } from "./totp.js";

export interface ProvisionEventDeps {
  demoUsers: DemoUsersStorage;
  servers: ServerStorage;
  authCodes: AuthCodeStorage;
  pushTokens: PushTokenStorage;
  /** Native push fan-out. Absent ⇒ phase is stored but no push fires
   *  (dev / pre-launch, or no provider secrets configured). */
  pushFanout?: V12PushFanout;
  now?: () => number;
}

interface ProvisionEventBody {
  phase?: unknown;
  error?: unknown;
  /** Pre-daemon channel — the auth-code serial the bootstrap holds. */
  authCodeSerial?: unknown;
  /** Daemon channel — hex Ed25519 signature over the canonical bytes. */
  signature?: unknown;
  /** Daemon channel — when the event was signed (part of the bytes). */
  issuedAt?: unknown;
}

const MAX_ERROR_LEN = 280;

/**
 * Resolve the demo_users row for a server domain. Demo FQDNs are
 * `home.<username>.flagship.services`; the username is the 2nd label.
 * Returns the row (so the caller can both validate state + fan out push
 * to the right user) or undefined.
 */
async function demoRowForDomain(
  deps: ProvisionEventDeps,
  serverDomain: string,
): Promise<DemoUserRecord | undefined> {
  const labels = serverDomain.toLowerCase().split(".");
  // home.<user>.flagship.services → labels[1] is the username.
  const username = labels.length >= 2 ? labels[1] : undefined;
  if (!username) return undefined;
  return deps.demoUsers.get(username);
}

export async function handlePostProvisionEvent(
  deps: ProvisionEventDeps,
  serverDomain: string,
  body: ProvisionEventBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (!body || typeof body.phase !== "string") {
    return malformed("malformed body");
  }
  if (!isProvisionPhase(body.phase)) {
    return malformed("unknown phase");
  }
  const phase: ProvisionPhase = body.phase;
  const errorRaw = typeof body.error === "string" ? body.error : "";
  const error = errorRaw.slice(0, MAX_ERROR_LEN);
  if (phase !== "failed" && error.length > 0) {
    // Non-failure phases carry no error string — keep the stored value
    // tidy so the phone never shows a stale error next to a live phase.
    return malformed("error is only valid with phase=failed");
  }
  const domain = serverDomain.toLowerCase();
  const now = (deps.now ?? Date.now)();

  // The demo row is the storage + push-fanout target for both channels.
  const row = await demoRowForDomain(deps, domain);
  if (!row) return notFound("no demo row for this server");

  // ---- Authenticate the event under whichever channel it claims. ----
  const hasSignature =
    typeof body.signature === "string" && HEX128.test(body.signature);
  const hasSerial =
    typeof body.authCodeSerial === "string" && body.authCodeSerial.length > 0;

  if (hasSignature) {
    // Daemon channel — Ed25519 over flagship/provision-event/v1.
    const server = await deps.servers.get(domain);
    if (!server) return forbidden("unknown serverDomain");
    if (server.revokedAt) return forbidden("server revoked");
    if (typeof body.issuedAt !== "number") {
      return malformed("issuedAt required for signed events");
    }
    const event: ProvisionEvent = {
      serverDomain: domain,
      phase,
      error,
      issuedAt: body.issuedAt,
    };
    const sig = hexToBytes(body.signature as string);
    const pub = hexToBytes(server.identityPubKeyHex);
    if (!verifyProvisionEvent(event, sig, pub)) {
      return forbidden("invalid signature");
    }
  } else if (hasSerial) {
    // Pre-daemon (bootstrap) channel — validate the serial maps to a
    // provisioning demo row for THIS domain. DISPLAY-only, so the bar
    // is "the box plausibly holds this auth-code", not a crypto proof.
    const ac = await deps.authCodes.get(body.authCodeSerial as string);
    if (!ac) return forbidden("unknown authCodeSerial");
    if (ac.serverDomain.toLowerCase() !== domain) {
      return forbidden("authCodeSerial does not match serverDomain");
    }
    if (ac.username.toLowerCase() !== row.username.toLowerCase()) {
      return forbidden("authCodeSerial does not match this server's user");
    }
    if (row.state !== "provisioning") {
      // A box that's already 'up' (or torn down) has no business
      // pushing bootstrap phases; reject so a replayed serial can't
      // rewind a live row's phase.
      return forbidden("demo row is not provisioning");
    }
  } else {
    return malformed("authCodeSerial or signature required");
  }

  // ---- Store the latest phase + fan out a push on the change. ----
  const updated = await deps.demoUsers.setProvisionPhase(
    row.username,
    phase,
    phase === "failed" ? error : null,
    now,
  );
  if (!updated) return notFound("no demo row for this server");

  await fanOutPhasePush(deps, updated, phase, error);

  return ok({ ok: true, phase, phaseAt: now });
}

const PHASE_TITLES: Record<ProvisionPhase, string> = {
  boot: "Server booting",
  cloned: "Code cloned",
  deps: "Installing dependencies",
  built: "Build complete",
  identity: "Identity generated",
  registered: "Registered with Flagship",
  "tunnel-online": "Tunnel online",
  "acme-order": "Requesting certificate",
  "dns01-publish-attempt": "Publishing DNS challenge",
  "dns01-publish-ok": "DNS challenge published",
  "dns01-propagation-wait": "Waiting for DNS",
  "tlsalpn-served": "Serving TLS challenge",
  "acme-validating": "Validating certificate",
  "cert-issued": "TLS certificate issued",
  ready: "Server is live",
  failed: "Provisioning failed",
};

const PHASE_BODIES: Record<ProvisionPhase, string> = {
  boot: "Your server has booted and started setting itself up.",
  cloned: "Server software downloaded.",
  deps: "Installing the server's dependencies.",
  built: "The server software built successfully.",
  identity: "Your server minted its identity key.",
  registered: "Your server checked in with Flagship.",
  "tunnel-online": "Your server connected its secure tunnel.",
  "acme-order": "Asking Let's Encrypt for your HTTPS certificate.",
  "dns01-publish-attempt": "Publishing the DNS-01 challenge record.",
  "dns01-publish-ok": "The DNS-01 challenge record is live.",
  "dns01-propagation-wait": "Waiting for the DNS challenge to propagate.",
  "tlsalpn-served": "Presenting the TLS-ALPN-01 challenge.",
  "acme-validating": "Let's Encrypt is validating your server.",
  "cert-issued": "Your server got its HTTPS certificate.",
  ready: "Your server is live and ready to use.",
  failed: "Provisioning hit a problem.",
};

/**
 * Fire a native push (APNs / FCM / Web Push) to every device the user
 * has registered. The payload carries the discrete fields the phone
 * routes into its install-progress Live Activity:
 *   { username, fqdn, phase, error? }.
 *
 * Best-effort: a push failure NEVER fails the event write (the phase is
 * already persisted + readable via /api/account/resolve).
 */
async function fanOutPhasePush(
  deps: ProvisionEventDeps,
  row: DemoUserRecord,
  phase: ProvisionPhase,
  error: string,
): Promise<void> {
  if (!deps.pushFanout) return;
  try {
    const tokens = await deps.pushTokens.listByUser(row.username);
    if (tokens.length === 0) return;
    await deps.pushFanout({
      username: row.username,
      targets: tokens.map((t) => ({
        tokenId: t.tokenId,
        platform: t.platform,
        providerToken: t.providerToken,
      })),
      payload: {
        category: "provision-phase",
        // The maps are exhaustive over ProvisionPhase; the `?? phase`
        // fallback only satisfies noUncheckedIndexedAccess.
        title: PHASE_TITLES[phase] ?? phase,
        body:
          phase === "failed" && error
            ? `Provisioning failed: ${error}`
            : (PHASE_BODIES[phase] ?? ""),
        deepLink: "flagship://install-progress",
        meta: {
          kind: "provision-phase",
          username: row.username,
          fqdn: row.activeServerFqdn ?? "",
          phase,
          ...(phase === "failed" && error ? { error } : {}),
        },
      },
    });
  } catch {
    // Push is a convenience; the phone also polls /api/account/resolve.
  }
}
