/**
 * Box-side relay-trust verifier (docs/maintainer-trust-enforcement.md §
 * "The relay blessing", task #5).
 *
 * On HELLO_ACK the hub MAY present a `.com`-CA-signed `ServiceBlessing`
 * over its own key plus a `hubSig` over the box's HELLO nonce. The box:
 *   (a) fetches the maintainer chain from `.com`
 *       `GET /api/maintainer-blessing` (mandates + caEndorsements) and
 *       builds a `CaTrustChain` anchored at the BAKED pin,
 *   (b) calls `shouldRelayThroughHub` to verify the blessing chains to the
 *       baked pin + is unexpired, and
 *   (c) verifies `hubSig` over the box's nonce against the blessing's
 *       `hubKeyPub` — proof the hub HOLDS the blessed key (defeats a MITM
 *       that merely replays an observed blessing).
 *
 * It emits a structured `relay-trust` log line with the verdict.
 *
 * OBSERVE (the only behavior here): the verdict is computed + logged but
 * RELAYING CONTINUES regardless — this module never refuses. Enforcement
 * (lockdown + SOS on a fail) lives in `relayLockdown.ts`, gated behind
 * `FLAGSHIP_RELAY_TRUST_ENFORCE` (default OFF). A `.com` fetch error yields
 * NO verdict (`reason: "chain-fetch-error"`, `verified: undefined`) so a
 * network blip never bricks a box.
 */

import {
  MAINTAINER_PINNED_MANDATE_HASH,
  ed,
  type ServiceBlessing,
} from "@flagship/protocol";
import {
  authorizedCaKeys,
  verifyMandateChainFromPin,
  type CaEndorsement,
  type Mandate,
} from "@ibisllc/maintainers";
import { shouldRelayThroughHub, type RelayGateReason } from "./relayBlessing.js";

export type RelayTrustVerdictReason =
  | RelayGateReason
  | "no-blessing"
  | "hubsig-missing"
  | "hubsig-mismatch"
  | "chain-fetch-error";

export interface RelayTrustVerdict {
  /**
   * `true`  — the blessing chained to the baked pin, was unexpired, AND the
   *           hubSig proves the hub holds the blessed key.
   * `false` — a blessing/hubSig was present but verification FAILED.
   * `undefined` — no verdict was reachable (no blessing presented, or the
   *           chain couldn't be fetched). OBSERVE keeps relaying; ENFORCE
   *           does NOT lock down on an undefined verdict (only on `false`).
   */
  verified: boolean | undefined;
  reason: RelayTrustVerdictReason;
  /** lower-hex of the hub key the blessing covers, when one was presented. */
  hubKeyPub?: string;
}

export interface MaintainerChainMaterial {
  mandates: Mandate[];
  caEndorsements: CaEndorsement[];
}

export interface RelayTrustVerifierOptions {
  /** `.com` base URL, e.g. `https://flagshipserver.com`. */
  comBaseUrl: string;
  /** Baked maintainer pin. Defaults to the protocol constant. */
  pinnedMandateHash?: string;
  /** How long to cache the fetched maintainer chain. Default 1h. */
  chainCacheMs?: number;
  /** Test seam — replace global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam — clock. */
  now?: () => number;
  /** Structured log sink. Default console.log. */
  log?: (line: string) => void;
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const DEFAULT_CHAIN_CACHE_MS = 60 * 60_000;

/**
 * Verifies hub relay blessings against the maintainer chain. Caches the
 * fetched chain briefly so a reconnect storm doesn't hammer `.com`.
 */
export class RelayTrustVerifier {
  private readonly comBaseUrl: string;
  private readonly pinnedMandateHash: string;
  private readonly chainCacheMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private cache: { material: MaintainerChainMaterial; fetchedAt: number } | null = null;

  constructor(opts: RelayTrustVerifierOptions) {
    this.comBaseUrl = opts.comBaseUrl.replace(/\/$/, "");
    this.pinnedMandateHash = opts.pinnedMandateHash ?? MAINTAINER_PINNED_MANDATE_HASH;
    this.chainCacheMs = opts.chainCacheMs ?? DEFAULT_CHAIN_CACHE_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((l) => console.log(l));
  }

  /** Fetch + cache the maintainer chain material. Throws on a fetch failure. */
  private async fetchChainMaterial(): Promise<MaintainerChainMaterial> {
    const now = this.now();
    if (this.cache && now - this.cache.fetchedAt < this.chainCacheMs) {
      return this.cache.material;
    }
    const resp = await this.fetchImpl(`${this.comBaseUrl}/api/maintainer-blessing`);
    if (!resp.ok) throw new Error(`maintainer-blessing status ${resp.status}`);
    const body = (await resp.json()) as {
      mandates?: Mandate[];
      caEndorsements?: CaEndorsement[];
    };
    const material: MaintainerChainMaterial = {
      mandates: Array.isArray(body.mandates) ? body.mandates : [],
      caEndorsements: Array.isArray(body.caEndorsements) ? body.caEndorsements : [],
    };
    this.cache = { material, fetchedAt: now };
    return material;
  }

  /**
   * Verify a presented blessing + hubSig over the box's HELLO nonce.
   *
   * @param blessing the ServiceBlessing the hub attached (or undefined).
   * @param hubSigHex lower-hex hub signature over `nonce` (or undefined).
   * @param nonce the box's HELLO nonce bytes (the same the box signed).
   */
  async verify(
    blessing: ServiceBlessing | undefined,
    hubSigHex: string | undefined,
    nonce: Uint8Array,
  ): Promise<RelayTrustVerdict> {
    if (!blessing) {
      const v: RelayTrustVerdict = { verified: undefined, reason: "no-blessing" };
      this.emit(v);
      return v;
    }
    const hubKeyPub = blessing.hubKeyPub?.toLowerCase();

    // (a) build the chain from the baked pin.
    let chainResult: RelayTrustVerdict | null = null;
    let chain;
    try {
      const material = await this.fetchChainMaterial();
      const verified = verifyMandateChainFromPin(this.pinnedMandateHash, material.mandates);
      const caEndorsements = material.caEndorsements;
      chain = {
        authorizedCaKeys: (n: number): string[] =>
          authorizedCaKeys(caEndorsements, verified, new Date(n)),
      };
    } catch (e) {
      chainResult = {
        verified: undefined,
        reason: "chain-fetch-error",
        ...(hubKeyPub ? { hubKeyPub } : {}),
      };
      this.emit(chainResult, e instanceof Error ? e.message : String(e));
      return chainResult;
    }

    // (b) chain + TTL gate.
    const gate = shouldRelayThroughHub(blessing, chain, this.pinnedMandateHash, this.now());
    if (!gate.ok) {
      const v: RelayTrustVerdict = {
        verified: false,
        reason: gate.reason,
        ...(hubKeyPub ? { hubKeyPub } : {}),
      };
      this.emit(v);
      return v;
    }

    // (c) proof-of-possession: hubSig over the box nonce under hubKeyPub.
    if (!hubSigHex) {
      const v: RelayTrustVerdict = {
        verified: false,
        reason: "hubsig-missing",
        ...(hubKeyPub ? { hubKeyPub } : {}),
      };
      this.emit(v);
      return v;
    }
    let sigOk = false;
    try {
      sigOk = ed.verify(hexToBytes(hubSigHex), nonce, hexToBytes(blessing.hubKeyPub));
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      const v: RelayTrustVerdict = {
        verified: false,
        reason: "hubsig-mismatch",
        ...(hubKeyPub ? { hubKeyPub } : {}),
      };
      this.emit(v);
      return v;
    }

    const ok: RelayTrustVerdict = {
      verified: true,
      reason: "ok",
      ...(hubKeyPub ? { hubKeyPub } : {}),
    };
    this.emit(ok);
    return ok;
  }

  private emit(v: RelayTrustVerdict, detail?: string): void {
    this.log(
      `[relay-trust] verified=${String(v.verified)} reason=${v.reason}` +
        (v.hubKeyPub ? ` hubKey=${v.hubKeyPub.slice(0, 16)}…` : "") +
        (detail ? ` detail=${detail}` : "") +
        " mode=observe (relaying continues)",
    );
  }
}
