import {
  ed,
  signUserPubKeyBinding,
  verifyCaSignedUserPubKeyBinding,
  type CaTrustChain,
  type Keypair,
  type UserPubKeyBinding,
} from "@flagship/protocol";
import type { UsernameStorage } from "@flagship/storage";
import { hexToBytes, bytesToHex } from "./hex.js";
import {
  forbidden,
  notFound, ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface CaIssuer {
  keypair: Keypair;
  issuer: string;
}

/**
 * Maintainer→CA hierarchy gate (#30). When `caGate` is wired the
 * handler runs the FULL chokepoint
 * (`verifyCaSignedUserPubKeyBinding` — pinned-mandate-hash → forward
 * ca-track chain → live CaEndorsement → artifact sig/TTL) over the
 * binding it is about to mint, BEFORE signing.
 *
 * DEPLOY-SAFE: `enforce` defaults false (OBSERVE). In OBSERVE the
 * verdict is structured-logged and signing proceeds **byte-for-byte
 * as before** — there is no committed CaEndorsement until the human
 * YubiKey ceremony, so hard-enforcing on deploy would fail-close
 * every live attestation. ENFORCE (refuse to sign when the gate is
 * unauthorized) engages ONLY when a human explicitly flips the
 * documented switch post-ceremony.
 */
export interface CaGate {
  /** Links 2-3 (forward ca-track chain + live CaEndorsement set).
   *  `null` ⇒ the chokepoint fail-closes `no-authorized-ca-keys`
   *  (still OBSERVE-safe: logged, signed-as-today). */
  caTrustChain: CaTrustChain | null;
  /** false/unset ⇒ OBSERVE (log only, sign as today). true ⇒
   *  ENFORCE (refuse to sign when unauthorized). */
  enforce: boolean;
  /** Structured sink. Defaults to `console.warn`. */
  log?: (line: Record<string, unknown>) => void;
}

export interface PubkeyCertDeps {
  ca: CaIssuer;
  usernames: UsernameStorage;
  ttlMs?: number;
  cacheMaxAgeSec?: number;
  now?: () => number;
  /** Optional #30 chokepoint. Absent ⇒ legacy behavior (no gate, no
   *  log) — used by the Fastify path that never minted CA artifacts. */
  caGate?: CaGate;
}

/**
 * Run the #30 chokepoint over a candidate CA-signed artifact and decide
 * whether to sign it. Returns `null` to proceed-and-sign (OBSERVE, or a
 * genuinely-authorized ENFORCE); a `HandlerResponseWithHeaders` to
 * refuse (ENFORCE + unauthorized). Either way the verdict is logged.
 *
 * `verify` is the protocol chokepoint bound to the concrete artifact
 * type (`verifyCaSignedUserPubKeyBinding` / `…DemoDirective`).
 */
export function evaluateCaGate(
  gate: CaGate | undefined,
  artifactKind: string,
  username: string,
  now: number,
  verify: () => { ok: true } | { ok: false; reason: string },
): HandlerResponseWithHeaders | null {
  if (!gate) return null;
  const verdict = verify();
  const log = gate.log ?? ((l) => console.warn(JSON.stringify(l)));
  log({
    tag: "ca-gate",
    artifact: artifactKind,
    username,
    now,
    mode: gate.enforce ? "enforce" : "observe",
    authorized: verdict.ok,
    reason: verdict.ok ? null : verdict.reason,
  });
  if (gate.enforce && !verdict.ok) {
    // ENFORCE + unauthorized: refuse to mint. Never reached until a
    // human flips the switch post-ceremony.
    return forbidden(`ca-gate: ${verdict.reason}`);
  }
  return null;
}

export async function handleUserPubKeyCert(
  deps: PubkeyCertDeps,
  username: string,
): Promise<HandlerResponseWithHeaders> {
  const ttlMs = deps.ttlMs ?? 7 * 24 * 60 * 60_000;
  const cacheMaxAgeSec = deps.cacheMaxAgeSec ?? 60 * 60;
  const now = (deps.now ?? (() => Date.now()))();
  const u = await deps.usernames.get(username);
  if (!u) return notFound("username not registered");

  const binding: UserPubKeyBinding = {
    version: 1,
    username: u.username,
    pubKey: hexToBytes(u.irkPubHex),
    issuedAt: now,
    expiresAt: now + ttlMs,
    issuer: deps.ca.issuer,
  };
  const sig = signUserPubKeyBinding(binding, deps.ca.keypair);
  // #30 chokepoint over the FULLY-FORMED, signed binding (so the
  // ENFORCE-authorized path also proves the artifact verifies through
  // the pin-anchored chain). OBSERVE ⇒ proceeds; ENFORCE+unauthorized
  // ⇒ refuses below.
  const gateResp = evaluateCaGate(
    deps.caGate,
    "UserPubKeyBinding",
    u.username,
    now,
    () =>
      verifyCaSignedUserPubKeyBinding(
        binding,
        sig,
        deps.caGate!.caTrustChain,
        now,
      ),
  );
  if (gateResp) return gateResp;
  return ok(
    {
      binding: {
        version: binding.version,
        username: binding.username,
        pubKey: u.irkPubHex,
        issuedAt: binding.issuedAt,
        expiresAt: binding.expiresAt,
        issuer: binding.issuer,
      },
      signature: bytesToHex(sig),
    },
    { "cache-control": `public, max-age=${cacheMaxAgeSec}` },
  );
}

export function handleCaCert(deps: PubkeyCertDeps): HandlerResponseWithHeaders {
  const ttlMs = deps.ttlMs ?? 7 * 24 * 60 * 60_000;
  return ok({
    issuer: deps.ca.issuer,
    pubKey: bytesToHex(deps.ca.keypair.publicKey),
    ttlMs,
    retiredIssuers: [],
  });
}

export function caKeypairFromEnv(env: Record<string, string | undefined>): CaIssuer {
  const privHex = env.FLAGSHIP_CA_PRIV_HEX;
  if (privHex && /^[0-9a-f]{64}$/i.test(privHex)) {
    const sk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) sk[i] = parseInt(privHex.slice(i * 2, i * 2 + 2), 16);
    return {
      keypair: { privateKey: sk, publicKey: ed.getPublicKey(sk) },
      issuer: env.FLAGSHIP_CA_ISSUER ?? "flagship-ca-v1",
    };
  }
  const sk = new Uint8Array(32).fill(0xCA);
  return {
    keypair: { privateKey: sk, publicKey: ed.getPublicKey(sk) },
    issuer: env.FLAGSHIP_CA_ISSUER ?? "flagship-ca-dev",
  };
}
