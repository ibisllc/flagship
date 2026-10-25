import {
  ACCOUNT_KEY_ATTESTATION_TTL_MS,
  canonicalShareKeyAttestationRequest,
  ed,
  SHARE_KEY_ATTESTATION_REQUEST_SKEW_MS,
  signAccountKeyAttestation,
  signAuthTime,
  verifyAuthTime,
  signUserPubKeyBinding,
  verifyCaSignedAccountKeyAttestation,
  verifyCaSignedUserPubKeyBinding,
  verifyShareKeyAttestationRequest,
  type CaTrustChain,
  type ShareKeyAttestationRequest,
  type Keypair,
  type UserPubKeyBinding,
} from "@flagship/protocol";
import type { UsernameStorage } from "@flagship/storage";
import { hexToBytes, bytesToHex } from "./hex.js";
import { authorizeSensitiveComOp, type AdminAuthorityGateDeps } from "./adminAuthorityGate.js";
import {
  malformed,
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

/**
 * `POST /api/users/:u/share-key-attestation` — the CA's word that an admin of
 * SOME account vouched for a per-share key (keyKind `share`). An admin device
 * of the joining account derives the key from its UMK and the share id
 * (`deriveShareAdminKey`), signs `flagship/share-key-attestation-request/v1`
 * with the account's sensitive key (admin root or an admin-granted device; the
 * IRK only when the account pins no admin root: `authorizeSensitiveComOp`),
 * and seals the attestation into the share acceptance, so the shared server
 * checks "an admin of the joining account accepted" without `.com` learning
 * the share or the server learning any key `.com` serves by name (AT-LNK-10,
 * docs/share-a-server.md §5.1). Body: `{ request: {username, keyPubHex,
 * issuedAt}, signature }`. A non-admin device's signature is refused with
 * `code: accept-not-admin`.
 */
export async function handleShareKeyAttestation(
  deps: PubkeyCertDeps & AdminAuthorityGateDeps,
  username: string,
  body: { request?: unknown; signature?: unknown } | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const r = body?.request as Partial<ShareKeyAttestationRequest> | undefined;
  if (!r || typeof r !== "object" || typeof body?.signature !== "string" || !/^[0-9a-f]{128}$/.test(body.signature)) {
    return malformed("request and a 64-byte hex signature are required");
  }
  const request: ShareKeyAttestationRequest = { username: r.username as string, keyPubHex: r.keyPubHex as string, issuedAt: r.issuedAt as number };
  try {
    canonicalShareKeyAttestationRequest(request);
  } catch (e) {
    return malformed((e as Error).message);
  }
  if (request.username.toLowerCase() !== username.toLowerCase()) return malformed("request names another account");
  if (Math.abs(now - request.issuedAt) > SHARE_KEY_ATTESTATION_REQUEST_SKEW_MS) return forbidden("stale request");
  const u = await deps.usernames.get(username.toLowerCase());
  if (!u) return notFound("username not registered");
  const sig = hexToBytes(body.signature);
  const auth = await authorizeSensitiveComOp(deps, {
    username: u.username,
    userRec: u,
    verifyWith: (pubHex) => verifyShareKeyAttestationRequest(request, sig, hexToBytes(pubHex)),
    now,
  });
  if (!auth.ok) {
    return {
      status: 403,
      body: {
        error: "Only an admin device of your account can accept a co-manage invitation.",
        code: "accept-not-admin",
      },
    };
  }
  const attestation = signAccountKeyAttestation(
    { keyKind: "share", keyPubHex: request.keyPubHex, issuedAt: now, expiresAt: now + ACCOUNT_KEY_ATTESTATION_TTL_MS },
    deps.ca.keypair,
  );
  const gateResp = evaluateCaGate(deps.caGate, "AccountKeyAttestation", u.username, now, () =>
    verifyCaSignedAccountKeyAttestation(attestation, deps.caGate!.caTrustChain, now),
  );
  if (gateResp) return gateResp;
  return ok({ attestation }, { "cache-control": "private, no-store" });
}

/**
 * `GET /api/auth-time?nonce=<32 hex>` — the CA's word on what time it is, for one caller's nonce
 * (SECURITY-HARDENING-PLAN.md 18.5, N07). A box anchors its privileged deadlines to this instead of
 * its own clock. Names nobody, learns nothing about the caller, and is never cached.
 */
export async function handleAuthTime(
  deps: Pick<PubkeyCertDeps, "ca" | "caGate" | "now">,
  nonceHex: string | null,
): Promise<HandlerResponseWithHeaders> {
  if (!nonceHex || !/^[0-9a-f]{32}$/.test(nonceHex)) return malformed("nonce must be 32 lowercase hex");
  const now = (deps.now ?? (() => Date.now()))();
  const stamp = signAuthTime(nonceHex, now, deps.ca.keypair);
  const gateResp = evaluateCaGate(deps.caGate, "AuthTime", "-", now, () =>
    verifyAuthTime(stamp, nonceHex, deps.caGate!.caTrustChain),
  );
  if (gateResp) return gateResp;
  return ok({ stamp }, { "cache-control": "no-store" });
}

/**
 * The public maintainer-trust material a client verifies against its own
 * baked pin. `mandates` / `caEndorsements` are passed through verbatim as
 * JSON (the control-plane package does not interpret them — clients do),
 * so they are typed loosely to keep this package free of an
 * `@ibisllc/maintainers` dependency.
 */
export interface MaintainerBlessingMaterial {
  pinnedMandateHash: string;
  /** ca-track Mandate log, oldest-first. */
  mandates: readonly unknown[];
  /** Committed CaEndorsement leases. */
  caEndorsements: readonly unknown[];
  /** Their hybrid PQ companions and the ca-track key's binding (caLeasePq.ts). */
  caLeasePq?: unknown;
}

export interface MaintainerBlessingDeps {
  ca: CaIssuer;
  material: MaintainerBlessingMaterial;
  /** Optional — lets `.com` report its OWN view of whether the served
   *  key is authorized right now (diagnostic only; clients re-verify
   *  against their baked pin + their own clock). */
  caTrustChain?: CaTrustChain | null;
  now?: () => number;
  cacheMaxAgeSec?: number;
}

/**
 * `GET /api/maintainer-blessing` — expose the chain so a client can prove
 * `.com` is maintainer-blessed WITHOUT trusting `.com`'s word. The client:
 *   verifyMandateChainFromPin(BAKED_PIN, mandates) → chain
 *   authorizedCaKeys(caEndorsements, chain, clientNow) ∋ caPubkey
 * If the served `caPubkey` is not in that set (or the chain does not
 * anchor to the baked pin), the client treats `.com` as untrusted.
 *
 * `caPubkeyAuthorizedNow` is `.com`'s self-assessment — purely advisory;
 * a client must never substitute it for its own verification.
 */
export function handleMaintainerBlessing(
  deps: MaintainerBlessingDeps,
): HandlerResponseWithHeaders {
  const now = (deps.now ?? (() => Date.now()))();
  const caPubkey = bytesToHex(deps.ca.keypair.publicKey);
  const caPubkeyAuthorizedNow = deps.caTrustChain
    ? deps.caTrustChain.authorizedCaKeys(now).includes(caPubkey)
    : null;
  const cacheMaxAgeSec = deps.cacheMaxAgeSec ?? 300;
  return ok(
    {
      version: 1,
      pinnedMandateHash: deps.material.pinnedMandateHash,
      caPubkey,
      issuer: deps.ca.issuer,
      mandates: deps.material.mandates,
      caEndorsements: deps.material.caEndorsements,
      ...(deps.material.caLeasePq !== undefined ? { caLeasePq: deps.material.caLeasePq } : {}),
      caPubkeyAuthorizedNow,
      now,
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

// The CA key never changes inside an isolate (it comes from a Worker secret), and
// deriving its public half is a scalar multiplication (about 0.3 ms of CPU) that
// every control-plane request used to repeat. Remembered per (secret, issuer).
const CA_KEYPAIRS = new Map<string, CaIssuer>();

export function caKeypairFromEnv(env: Record<string, string | undefined>): CaIssuer {
  const privHex = env.FLAGSHIP_CA_PRIV_HEX;
  const real = !!privHex && /^[0-9a-f]{64}$/i.test(privHex);
  const issuer = env.FLAGSHIP_CA_ISSUER ?? (real ? "flagship-ca-v1" : "flagship-ca-dev");
  const memo = `${real ? privHex!.toLowerCase() : "dev"}|${issuer}`;
  const known = CA_KEYPAIRS.get(memo);
  if (known) return known;
  let sk: Uint8Array;
  if (real) {
    sk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) sk[i] = parseInt(privHex!.slice(i * 2, i * 2 + 2), 16);
  } else {
    sk = new Uint8Array(32).fill(0xCA);
  }
  const made: CaIssuer = { keypair: { privateKey: sk, publicKey: ed.getPublicKey(sk) }, issuer };
  if (CA_KEYPAIRS.size >= 8) CA_KEYPAIRS.clear();
  CA_KEYPAIRS.set(memo, made);
  return made;
}
