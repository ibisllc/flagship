import {
  signSecretRequest,
  verifyRootEntitlement,
  type AdminGrantView,
  type Keypair,
  type SecretRequest,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";
import type { EntitlementBundle } from "./tunnel/tunnelClient.js";
import {
  parseEntitlementBundle,
  writeEntitlementBundle,
} from "./entitlementBundleStore.js";

/**
 * Entitlement-via-relay (docs/security-phone-as-unlock-endpoint.md §4, §9).
 *
 * Instead of self-signing an admission credential, a freshly-burned box
 * asks the user's phone — through `.com`'s blind mailbox — to sign a
 * RootEntitlement binding (username, this box's STK, this box's
 * podCanonical) with the user's IRK. `.com` only stores + relays
 * signed-but-public blobs; it can withhold (a DoS) but never read or
 * forge (invariants I1–I3).
 *
 * Wire:
 *   POST /api/server/:domain/secret-request   { request, signature }
 *   GET  /api/server/:domain/secret-response?nonce=<64hex>
 *
 * The `secret-response.sealed` field for `purpose: "entitlement"` is NOT
 * an encrypted payload — the entitlement is public-signed, not secret.
 * The phone places the EntitlementBundle on-disk JSON (the exact shape
 * `entitlementBundleStore.ts` reads) into `sealed`, hex-encoded for
 * transport. The box hex-decodes it to UTF-8 JSON, parses + verifies the
 * RootEntitlement, then writes it to the entitlement path and loads it
 * normally.
 *
 * On ANY failure (no reply in the window, malformed carrier, signature
 * mismatch, wrong STK/podCanonical) this returns null so the caller can
 * fall back to whatever bundle already exists — never a brick.
 */

const HEX_NONCE = /^[0-9a-f]{64}$/;

export interface FetchEntitlementViaRelayOptions {
  /** This box's canonical FQDN (= the daemon's serverFqdn). */
  serverDomain: string;
  /** The daemon identity keypair — signs the SecretRequest with the STK. */
  identity: Keypair;
  /** The user's IRK pubkey (baked into the install config) — verifies the
   *  RootEntitlement signature. The relay reply is checked against THIS,
   *  not against anything `.com` asserts. */
  ownerIrkPub: Uint8Array;
  /** Slice D — the pinned admin master root (`ServerConfig.adminRootPub`);
   *  present ⇒ the RootEntitlement is gated by `requireMasterAdmin`, absent ⇒
   *  legacy owner-IRK verification (a strict no-op on pre-wipe boxes). */
  adminRootPub?: Uint8Array;
  /** This box's owner account (cfg.userId) — for the delegated-grant check. */
  username?: string;
  /** Slice D — box-local active admin grants (`[]` box-side today). */
  activeGrants?: readonly AdminGrantView[];
  /** `.com` base URL. */
  controlPlaneBaseUrl: string;
  /** Where to persist the fetched bundle once verified. */
  entitlementBundlePath: string;
  /** Total budget to wait for a phone reply (ms). Default 5 min. */
  windowMs?: number;
  /** Per-poll sleep cap (ms). Backoff is `min(attempt*pollBaseMs, pollMaxMs)`. */
  pollBaseMs?: number;
  pollMaxMs?: number;
  /** Injected for tests; default = global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; default = real sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; default = Date.now. */
  now?: () => number;
  /** Injected for tests; default = crypto random 32 bytes. */
  randomNonce?: () => Uint8Array;
  /** Optional progress hook (e.g. console.log / a phase reporter). */
  onLog?: (msg: string) => void;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex must have even length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function defaultRandomNonce(): Uint8Array {
  const n = new Uint8Array(32);
  globalThis.crypto.getRandomValues(n);
  return n;
}

/**
 * Build + sign the SecretRequest for an entitlement. Exported so the
 * unlock path / tests can reuse the exact canonical-bytes signing.
 */
export function buildEntitlementSecretRequest(args: {
  serverDomain: string;
  identity: Keypair;
  nonce: Uint8Array;
  issuedAt: number;
}): { request: SecretRequest; signatureHex: string } {
  const request: SecretRequest = {
    serverDomain: args.serverDomain,
    stkPub: args.identity.publicKey,
    purpose: "entitlement",
    nonce: args.nonce,
    issuedAt: args.issuedAt,
  };
  const sig = signSecretRequest(request, args.identity);
  return { request, signatureHex: bytesToHex(sig) };
}

/**
 * Decode the relay `secret-response.sealed` hex (for `purpose:
 * "entitlement"`) into a verified EntitlementBundle. Throws with a
 * specific reason on any defect — the caller maps that to "fall back".
 *
 * Verifies, in order:
 *   - the carrier hex decodes to UTF-8 JSON that parses as a bundle;
 *   - the RootEntitlement signature is valid under the OWNER IRK (not
 *     anything `.com` asserts);
 *   - the bundle binds THIS box: podPubKey == our STK, podCanonical ==
 *     our serverDomain.
 */
export function decodeAndVerifyEntitlementCarrier(args: {
  sealedHex: string;
  ownerIrkPub: Uint8Array;
  serverDomain: string;
  stkPub: Uint8Array;
  /** Slice D — pinned admin master root; present ⇒ authority gate, absent ⇒ legacy owner-IRK. */
  adminRootPub?: Uint8Array;
  /** Account name for the delegated-grant check (unused on the bare-root path). */
  username?: string;
  /** Slice D — box-local active admin grants (`[]` box-side today). */
  activeGrants?: readonly AdminGrantView[];
}): EntitlementBundle {
  const hex = args.sealedHex.toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("entitlement carrier is not valid hex");
  }
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(hex));
  } catch {
    throw new Error("entitlement carrier hex is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`entitlement carrier is not valid JSON: ${(e as Error).message}`);
  }
  // parseEntitlementBundle throws on any structural defect.
  const bundle = parseEntitlementBundle(parsed);

  // Slice D — the RootEntitlement is an administrative "authorize this box"
  // order, so it verifies under the pinned admin master root when present
  // (falling back to the owner IRK on a pre-wipe box). `.com` is not a trust
  // anchor, so re-verify everything the relay returns.
  if (
    !authorizeSensitiveOrder({
      order: bundle.rootEntitlement,
      signature: bundle.rootEntitlementSig,
      verify: verifyRootEntitlement,
      ownerIrkPub: args.ownerIrkPub,
      adminRootPub: args.adminRootPub,
      username: args.username ?? "",
      activeGrants: args.activeGrants,
    })
  ) {
    throw new Error("entitlement RootEntitlement signature is not authorized (admin root / owner IRK)");
  }

  // Bind to THIS box: a relay (or anyone) cannot hand us a bundle minted
  // for a different STK or canonical.
  const ourPub = bytesToHex(args.stkPub);
  const bundlePub = bytesToHex(bundle.rootEntitlement.podPubKey);
  if (ourPub !== bundlePub) {
    throw new Error(
      `entitlement podPubKey (${bundlePub.slice(0, 16)}…) does not match this box's STK (${ourPub.slice(0, 16)}…)`,
    );
  }
  if (
    bundle.rootEntitlement.podCanonical.toLowerCase() !==
    args.serverDomain.toLowerCase()
  ) {
    throw new Error(
      `entitlement podCanonical (${bundle.rootEntitlement.podCanonical}) does not match this box (${args.serverDomain})`,
    );
  }
  return bundle;
}

/**
 * Run the full relay handshake for an entitlement: POST the request, poll
 * for the phone's reply within the window, decode + verify the carrier,
 * persist it, and return the bundle.
 *
 * Returns null on ANY failure (timeout, network, malformed/forged reply)
 * — the caller falls back to the existing on-disk bundle so the daemon
 * still starts. Never throws.
 */
export async function fetchEntitlementViaRelay(
  opts: FetchEntitlementViaRelayOptions,
): Promise<EntitlementBundle | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const randomNonce = opts.randomNonce ?? defaultRandomNonce;
  const log = opts.onLog ?? (() => {});
  const windowMs = opts.windowMs ?? 5 * 60_000;
  const pollBaseMs = opts.pollBaseMs ?? 3_000;
  const pollMaxMs = opts.pollMaxMs ?? 15_000;
  const base = opts.controlPlaneBaseUrl.replace(/\/+$/, "");
  const domainPath = encodeURIComponent(opts.serverDomain);

  const nonce = randomNonce();
  const nonceHex = bytesToHex(nonce);
  if (!HEX_NONCE.test(nonceHex)) {
    log("[entitlement-relay] internal: produced a non-32-byte nonce; aborting relay");
    return null;
  }

  const { request, signatureHex } = buildEntitlementSecretRequest({
    serverDomain: opts.serverDomain,
    identity: opts.identity,
    nonce,
    issuedAt: now(),
  });

  // 1. POST the STK-signed request — this also wakes the phone via `.com`'s
  //    push fan-out. A non-2xx here means we never enqueued; fall back.
  try {
    const postUrl = `${base}/api/server/${domainPath}/secret-request`;
    const res = await fetchImpl(postUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: {
          serverDomain: request.serverDomain,
          stkPub: bytesToHex(request.stkPub),
          purpose: request.purpose,
          nonce: nonceHex,
          issuedAt: request.issuedAt,
        },
        signature: signatureHex,
      }),
    });
    if (!res.ok) {
      const text = await safeText(res);
      log(`[entitlement-relay] secret-request POST ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
  } catch (e) {
    log(`[entitlement-relay] secret-request POST failed: ${(e as Error).message}`);
    return null;
  }

  // 2. Poll for the phone's reply within the window. 404 = "no reply ready"
  //    (expected — keep polling); anything else terminal = fall back.
  const deadline = now() + windowMs;
  const pollUrl = `${base}/api/server/${domainPath}/secret-response?nonce=${nonceHex}`;
  let attempt = 0;
  while (now() < deadline) {
    attempt += 1;
    let sealedHex: string | null = null;
    try {
      const res = await fetchImpl(pollUrl, { method: "GET" });
      if (res.status === 200) {
        const body = (await res.json()) as {
          purpose?: string;
          requestNonceHex?: string;
          sealed?: string;
        };
        if (body.purpose !== "entitlement") {
          log(`[entitlement-relay] reply purpose mismatch: ${body.purpose}`);
          return null;
        }
        if ((body.requestNonceHex ?? "").toLowerCase() !== nonceHex) {
          log("[entitlement-relay] reply nonce mismatch");
          return null;
        }
        if (typeof body.sealed !== "string" || body.sealed.length === 0) {
          log("[entitlement-relay] reply missing sealed carrier");
          return null;
        }
        sealedHex = body.sealed;
      } else if (res.status === 404) {
        // No reply yet — expected; keep polling.
      } else {
        const text = await safeText(res);
        log(`[entitlement-relay] secret-response ${res.status}: ${text.slice(0, 200)}`);
        return null;
      }
    } catch (e) {
      log(`[entitlement-relay] secret-response poll error: ${(e as Error).message}`);
      // Transient network error — keep polling within the window.
    }

    if (sealedHex !== null) {
      let bundle: EntitlementBundle;
      try {
        bundle = decodeAndVerifyEntitlementCarrier({
          sealedHex,
          ownerIrkPub: opts.ownerIrkPub,
          serverDomain: opts.serverDomain,
          stkPub: opts.identity.publicKey,
          ...(opts.adminRootPub ? { adminRootPub: opts.adminRootPub } : {}),
          ...(opts.username ? { username: opts.username } : {}),
          ...(opts.activeGrants ? { activeGrants: opts.activeGrants } : {}),
        });
      } catch (e) {
        log(`[entitlement-relay] carrier rejected: ${(e as Error).message}`);
        return null;
      }
      try {
        await writeEntitlementBundle(opts.entitlementBundlePath, bundle);
      } catch (e) {
        log(`[entitlement-relay] failed to persist bundle: ${(e as Error).message}`);
        return null;
      }
      log(
        `[entitlement-relay] received + verified entitlement for ${bundle.rootEntitlement.podCanonical} (attempt ${attempt})`,
      );
      return bundle;
    }

    const backoff = Math.min(attempt * pollBaseMs, pollMaxMs);
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(backoff, remaining));
  }

  log(`[entitlement-relay] no phone reply within ${windowMs}ms; falling back`);
  return null;
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export interface ClaimEntitlementDepositOptions {
  /** This box's canonical FQDN. */
  serverDomain: string;
  /** The user's IRK pubkey (baked into the config) — the carrier is verified
   *  against THIS, never against anything `.com` asserts. */
  ownerIrkPub: Uint8Array;
  /** Slice D — the pinned admin master root (`ServerConfig.adminRootPub`);
   *  present ⇒ the RootEntitlement is gated by `requireMasterAdmin`, absent ⇒
   *  legacy owner-IRK verification (a strict no-op on pre-wipe boxes). */
  adminRootPub?: Uint8Array;
  /** This box's owner account (cfg.userId) — for the delegated-grant check. */
  username?: string;
  /** Slice D — box-local active admin grants (`[]` box-side today). */
  activeGrants?: readonly AdminGrantView[];
  /** This box's STK pubkey — the entitlement must bind to it. */
  stkPub: Uint8Array;
  /** `.com` base URL. */
  controlPlaneBaseUrl: string;
  /** Where to persist the claimed bundle. */
  entitlementBundlePath: string;
  /** GET attempts before giving up. The phone deposits at unlock-approval —
   *  the same gesture that hands the box its disk key — so the deposit is
   *  almost always already waiting by the time the daemon checks; a few
   *  retries only cover a slightly-late deposit. Default 4. */
  attempts?: number;
  /** Sleep between attempts (ms). Default 5000. */
  retryMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onLog?: (m: string) => void;
}

/**
 * Claim a phone-DEPOSITED entitlement before falling back to a relay request.
 *
 * The phone pre-deposits an IRK-signed RootEntitlement for this box's STK at
 * the moment it approves the first-boot unlock (it already holds the STK from
 * the unlock request), so an encrypted box comes online with a SINGLE owner
 * approval — no separate "authorize it to serve" tap. The daemon checks for
 * that deposit FIRST; only if there is none does it issue a relay request.
 *
 * `.com` is a blind store-and-forward: the deposited carrier is the same
 * public, IRK-signed entitlement the box presents at the hub HELLO (NOT a
 * secret), so a public consume-once GET reveals nothing usable without the STK
 * private key. We verify the carrier under the OWNER IRK + bind it to our STK
 * and podCanonical before trusting it. Returns null on no-deposit / any
 * mismatch so the caller falls back to the relay — never a brick.
 */
export async function claimEntitlementDeposit(
  opts: ClaimEntitlementDepositOptions,
): Promise<EntitlementBundle | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.onLog ?? (() => {});
  const attempts = opts.attempts ?? 4;
  const retryMs = opts.retryMs ?? 5000;
  const base = opts.controlPlaneBaseUrl.replace(/\/+$/, "");
  const url = `${base}/api/server/${encodeURIComponent(opts.serverDomain)}/entitlement-deposit`;

  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await sleep(retryMs);
    let sealedHex: string | undefined;
    try {
      const res = await fetchImpl(url, { method: "GET" });
      if (res.status === 404) continue; // not deposited (yet) — keep trying
      if (!res.ok) {
        log(`[entitlement-deposit] GET ${res.status}; falling back to relay`);
        return null;
      }
      const body = (await res.json()) as { sealed?: string };
      sealedHex = body?.sealed;
    } catch (e) {
      log(`[entitlement-deposit] GET failed: ${(e as Error).message}; retrying`);
      continue; // transient — keep trying within the bounded window
    }
    if (typeof sealedHex !== "string" || sealedHex.length === 0) {
      log("[entitlement-deposit] reply missing carrier; falling back to relay");
      return null;
    }
    let bundle: EntitlementBundle;
    try {
      bundle = decodeAndVerifyEntitlementCarrier({
        sealedHex,
        ownerIrkPub: opts.ownerIrkPub,
        serverDomain: opts.serverDomain,
        stkPub: opts.stkPub,
        ...(opts.adminRootPub ? { adminRootPub: opts.adminRootPub } : {}),
        ...(opts.username ? { username: opts.username } : {}),
        ...(opts.activeGrants ? { activeGrants: opts.activeGrants } : {}),
      });
    } catch (e) {
      log(`[entitlement-deposit] carrier rejected: ${(e as Error).message}; falling back to relay`);
      return null;
    }
    try {
      await writeEntitlementBundle(opts.entitlementBundlePath, bundle);
    } catch (e) {
      // Serve now even if the on-disk persist failed; it re-claims next boot.
      log(`[entitlement-deposit] persist failed (continuing): ${(e as Error).message}`);
    }
    log("[entitlement-deposit] claimed a phone-deposited entitlement");
    return bundle;
  }
  return null; // no deposit within the window → caller issues a relay request
}
