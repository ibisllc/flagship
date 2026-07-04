/**
 * Box-side owner-TrustException resolver (docs/maintainer-trust-enforcement.md
 * § "Recovery"). Wires `RelayLockdownController.resolveTrustExceptions`.
 *
 * When the box's relay-trust verdict FAILS, the lockdown controller asks: does
 * a valid owner override cover this relay cert-hash? This resolver answers by
 * fetching the owner's exception directory from `.com`
 * (`GET /api/users/:u/trust-exceptions`) and verifying each candidate against
 * the IRK-anchored device set — which, for a box, is anchored at the OWNER IRK
 * it was provisioned with (`cfg.irkPublicKey`).
 *
 * The account IRK is derived from the shared UMK, so every one of the user's
 * devices signs a TrustException with the SAME `grantedByDevicePub` = the owner
 * IRK pub. The box already pins that key, so the roster it verifies against is
 * exactly `[ownerIrkPub]` — never a `.com`-asserted list. `.com` can drop or
 * replay an exception but cannot forge one (device-key-signed, cert-hash-
 * scoped), so routing the override through the possibly-rogue relay is safe.
 *
 * This is the FAN-OUT mechanism: ONE phone-signed exception for cert-hash X,
 * deposited to `.com`, is pulled here by EVERY box the user owns; any box whose
 * verdict fails on X finds the covering exception, is satisfied, and continues
 * — so one bypass on the phone silences the warning on all affected servers.
 *
 * Best-effort: any fetch/parse failure yields an empty exception list, which
 * the controller treats as UNCOVERED (fail-closed for coverage) — never a
 * throw that could wedge the verdict path.
 */

import type { TrustException } from "@flagship/protocol";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export interface RelayTrustExceptionResolverOptions {
  /** The box's owner account name (cfg.userId). */
  username: string;
  /** The owner IRK pubkey the box was provisioned with (cfg.irkPublicKey) —
   *  the ONLY roster anchor; a TrustException must be signed by it. */
  ownerIrkPub: Uint8Array;
  /** `.com` base URL. */
  controlPlaneBaseUrl: string;
  /** Injected for tests; default = global fetch. */
  fetchImpl?: typeof fetch;
  /** Optional log sink. */
  log?: (line: string) => void;
}

/**
 * Build the `resolveTrustExceptions` callback the lockdown controller expects:
 * `(certHash) => { exceptions, allowedDevicePubs }`. The `certHash` argument is
 * accepted for interface symmetry (the controller filters by it), but this
 * returns the whole verified-shape list — the controller does the final
 * cert-class + cert-hash + signature match.
 */
export function makeRelayTrustExceptionResolver(
  opts: RelayTrustExceptionResolverOptions,
): (
  certHash: string,
) => Promise<{ exceptions: TrustException[]; allowedDevicePubs: string[] }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.controlPlaneBaseUrl.replace(/\/+$/, "");
  const allowedDevicePubs = [bytesToHex(opts.ownerIrkPub).toLowerCase()];
  const log = opts.log ?? (() => {});

  return async (_certHash: string) => {
    const url = `${base}/api/users/${encodeURIComponent(opts.username)}/trust-exceptions`;
    try {
      const res = await fetchImpl(url, { headers: { accept: "application/json" } });
      if (!res.ok) {
        log(`[relay-trust] exception directory ${res.status}; treating as none`);
        return { exceptions: [], allowedDevicePubs };
      }
      const body = (await res.json()) as { exceptions?: unknown };
      const list = Array.isArray(body?.exceptions) ? body.exceptions : [];
      const exceptions = list.filter(
        (e): e is TrustException =>
          !!e &&
          typeof e === "object" &&
          (e as TrustException).kind === "TrustException" &&
          Array.isArray((e as TrustException).signatures),
      );
      return { exceptions, allowedDevicePubs };
    } catch (e) {
      log(
        `[relay-trust] exception directory fetch failed: ${
          e instanceof Error ? e.message : String(e)
        }; treating as none`,
      );
      return { exceptions: [], allowedDevicePubs };
    }
  };
}
