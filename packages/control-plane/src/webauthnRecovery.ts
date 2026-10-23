import {
  checkRecoveryEvolution,
  recoveryRecordDigest,
  verifyRecoveryRecord,
  type RecoveryEscrowChange,
  type RecoveryRecordV2,
  type StoredRecoveryState,
} from "@flagship/protocol";
import type {
  UsernameStorage,
  WebauthnRecoveryRecord,
  WebauthnRecoveryStorage,
} from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import { mintRecoveryProof } from "./recoveryProof.js";
import {
  challengeNonce,
  checkRecoveryChallenge,
  issueRecoveryChallenge,
  parseCoseKey,
  readAttestationObject,
  recoveryPasskeyPolicy,
  unb64,
  verifyPasskeyAssertion,
  type PasskeyPolicy,
} from "./passkeyAssertion.js";
import { conflict, forbidden, malformed, notFound, type HandlerResponse } from "./types.js";

/**
 * Webapp cloud-shard recovery (WebAuthn PRF).
 *
 * `POST   /api/recovery`                            IRK-signed v2 envelope (N03); compare-and-swap
 *                                                  on the previous record's digest
 * `GET    /api/recovery/by-username/:username`       public metadata only — returns
 *                                                  credentialId + the SHA-256 of the
 *                                                  stored ciphertext, NOT the ciphertext
 *                                                  itself (Task #74).
 * `POST   /api/recovery/by-username/:username/fetch` Argon2id-gated; releases the
 *                                                  ciphertext only when the caller
 *                                                  presents a fetchToken whose
 *                                                  SHA-256 matches the stored hash.
 * `DELETE /api/recovery/by-username/:username`       IRK-signed; kill switch.
 * `POST   /api/recovery/by-username/:username/challenge`  a short-lived challenge the recovery
 *                                                  passkey signs (SEC-REPAIR-001); the fetch
 *                                                  above then requires that assertion whenever
 *                                                  the record holds the passkey's public key.
 *
 * `.com` only ever stores ciphertext + the credentialId pointer + the
 * passphrase-derived hashes. The unwrap key is the user's WebAuthn
 * passkey PRF output, which never leaves the browser.
 */

export interface WebauthnRecoveryDeps {
  usernames: UsernameStorage;
  webauthnRecovery: WebauthnRecoveryStorage;
  maxAgeMs?: number;
  now?: () => number;
  /**
   * `FLAGSHIP_RECOVERY_PROOF_SECRET` — the symmetric secret the gated
   * fetch MACs its recovery-session proof with. When wired, a
   * successful gated fetch returns `recoveryProof`, which
   * `handleInitiateRePair` requires before it will schedule an IRK
   * swap on a single-device account (see `recoveryProof.ts`).
   *
   * Absent ⇒ no proof is minted and the re-pair initiate it feeds
   * refuses the recovery (fail CLOSED). The ciphertext release itself
   * is unaffected: the passphrase gate above is what authorizes it,
   * and a user restoring a device must not be blocked by a missing
   * recovery-proof secret.
   */
  recoveryProofSecret?: string;
  /**
   * Which rpIds and origins a recovery passkey may come from (`recoveryPasskeyPolicy(apex)`).
   * Defaults to the production apex. The challenge is MACed with `recoveryProofSecret`; without
   * it a record that holds a passkey key cannot be fetched (fail closed).
   */
  passkeyPolicy?: PasskeyPolicy;
}

const DEFAULT_MAX_AGE = 5 * 60_000;

async function sha256Hex(b: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  let s = "";
  for (const x of h) s += x.toString(16).padStart(2, "0");
  return s;
}

function base64DecodeBytes(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const MAX_CIPHERTEXT_BYTES = 16 * 1024;

function hexOf(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}


function parseEscrow(v: unknown): RecoveryEscrowChange | null {
  if (!v || typeof v !== "object") return null;
  const e = v as { change?: unknown; digestHex?: unknown };
  if (e.change === "remove" || e.change === "none") return Object.keys(e).length === 1 ? { change: e.change } : null;
  if ((e.change === "keep" || e.change === "replace") && typeof e.digestHex === "string" && Object.keys(e).length === 2) {
    return { change: e.change, digestHex: e.digestHex };
  }
  return null;
}

const CLAIM_KEYS = [
  "op", "username", "irkPubHex", "adminRootPubHex", "credentialIdHex", "wrappedUmkDigestHex", "adminRoot", "acmeKey",
  "fetchTokenHashHex", "prfSaltHashHex", "kdfVersion", "algVersion", "policy", "generation", "nonceHex",
  "priorDigestHex", "issuedAt",
] as const;

/** Strict claim parse: exactly the signed fields, correct types, nothing extra (N03: reject unknown fields). */
function parseClaim(v: unknown): RecoveryRecordV2 | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== CLAIM_KEYS.length || !CLAIM_KEYS.every((k) => k in o)) return null;
  const adminRoot = parseEscrow(o.adminRoot);
  const acmeKey = parseEscrow(o.acmeKey);
  if (!adminRoot || !acmeKey) return null;
  for (const k of ["op", "username", "irkPubHex", "adminRootPubHex", "credentialIdHex", "wrappedUmkDigestHex", "fetchTokenHashHex", "prfSaltHashHex", "policy", "nonceHex", "priorDigestHex"] as const) {
    if (typeof o[k] !== "string") return null;
  }
  for (const k of ["kdfVersion", "algVersion", "generation", "issuedAt"] as const) {
    if (typeof o[k] !== "number") return null;
  }
  return { ...(o as unknown as RecoveryRecordV2), adminRoot, acmeKey };
}

function b64Field(v: unknown, name: string): { bytes: Uint8Array; b64: string } | { error: string } | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return { error: `${name} must be base64` };
  const bytes = base64DecodeBytes(v);
  if (!bytes) return { error: `${name} must be valid base64` };
  if (bytes.length === 0 || bytes.length > MAX_CIPHERTEXT_BYTES) return { error: `${name} must be 1..${MAX_CIPHERTEXT_BYTES} bytes` };
  return { bytes, b64: v };
}

async function storedState(rec: WebauthnRecoveryRecord): Promise<StoredRecoveryState> {
  const digestOf = async (b64: string | undefined) => (b64 ? sha256Hex(base64DecodeBytes(b64) ?? new Uint8Array()) : undefined);
  const adminRootDigestHex = await digestOf(rec.wrappedAdminRootB64);
  const acmeKeyDigestHex = await digestOf(rec.wrappedAcmeAccountKeyB64);
  return {
    digestHex: rec.signed?.digestHex ?? "legacy",
    generation: rec.signed?.generation ?? 0,
    wrappedUmkDigestHex: (await digestOf(rec.wrappedUmkB64))!,
    ...(adminRootDigestHex ? { adminRootDigestHex } : {}),
    ...(acmeKeyDigestHex ? { acmeKeyDigestHex } : {}),
  };
}

const EVOLUTION_REFUSALS: Record<string, string> = {
  "stale-prior": "the stored recovery record changed since this was signed; refresh and retry",
  "bad-generation": "the record generation is not the next one",
  "keep-mismatch": "the signed escrow state does not match what is stored",
  "keep-without-prior": "there is no earlier record to keep escrow from",
  "nothing-to-remove": "there is no such escrow to remove",
  "delete-needs-prior": "there is no recovery record to delete",
};

/** The checks both writes share: who signed, for which authority, and that the signature is fresh. */
/**
 * The passkey's public key from the attestation object the platform returned at creation (base64),
 * accepted only for the credential the signed request names and a recovery rpId.
 */
export async function passkeyFromAttestation(
  attB64: unknown,
  credentialIdHex: string,
  policy: PasskeyPolicy,
): Promise<{ passkey: { coseHex: string; alg: number } } | { response: HandlerResponse }> {
  const att = unb64(attB64);
  if (!att || att.length > MAX_CIPHERTEXT_BYTES) return { response: malformed("passkeyAttestationObject must be base64") };
  let read: ReturnType<typeof readAttestationObject>;
  try {
    read = readAttestationObject(att);
  } catch (e) {
    return { response: malformed(`passkeyAttestationObject: ${(e as Error).message}`) };
  }
  if (hexOf(read.credentialId) !== credentialIdHex.toLowerCase()) return { response: forbidden("the passkey is not the credential the record names") };
  let rpOk = false;
  for (const rp of policy.rpIds) if (hexOf(read.rpIdHash) === (await sha256Hex(new TextEncoder().encode(rp)))) rpOk = true;
  if (!rpOk) return { response: forbidden("the passkey belongs to another site") };
  try {
    return { passkey: { coseHex: hexOf(read.cose), alg: parseCoseKey(read.cose).alg } };
  } catch (e) {
    return { response: malformed(`passkeyAttestationObject: ${(e as Error).message}`) };
  }
}

async function checkEnvelope(
  deps: WebauthnRecoveryDeps,
  body: unknown,
  op: "put" | "delete",
  urlUsername?: string,
): Promise<
  | { response: HandlerResponse }
  | { claim: RecoveryRecordV2; signatureHex: string; existing: WebauthnRecoveryRecord | undefined; b: Record<string, unknown> }
> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;
  const b = (body ?? {}) as Record<string, unknown>;
  const claim = parseClaim(b.claim);
  if (!claim || typeof b.signature !== "string" || !/^[0-9a-f]{128}$/.test(b.signature)) {
    return { response: malformed("malformed recovery record envelope (a v2 signed record is required)") };
  }
  if (claim.op !== op) return { response: malformed("wrong operation for this route") };
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(claim.username)) return { response: malformed("invalid username") };
  if (urlUsername !== undefined && claim.username.toLowerCase() !== urlUsername.toLowerCase()) {
    return { response: forbidden("username / url mismatch") };
  }
  if (Math.abs(now() - claim.issuedAt) > maxAgeMs) return { response: forbidden("stale request") };
  const userRec = await deps.usernames.get(claim.username);
  if (!userRec) return { response: notFound("unknown username") };
  // The signature must come from the key the account holds now, with the admin root it pins now.
  if (claim.irkPubHex !== userRec.irkPubHex.toLowerCase()) return { response: forbidden("the record was not signed by the account's current key") };
  if (claim.adminRootPubHex !== (userRec.adminRootPubHex ? userRec.adminRootPubHex.toLowerCase() : "none")) {
    return { response: forbidden("the record names a different admin root than the account pins") };
  }
  let ok = false;
  try {
    ok = verifyRecoveryRecord(claim, hexToBytes(b.signature), hexToBytes(userRec.irkPubHex));
  } catch {
    return { response: malformed("the recovery record is not canonical") };
  }
  if (!ok) return { response: forbidden("invalid signature") };
  const existing = await deps.webauthnRecovery.get(claim.username);
  return { claim, signatureHex: b.signature, existing, b };
}

/**
 * Write the account's cloud-recovery record (N03). The body is
 * `{ claim, signature, wrappedUmk, wrappedAdminRoot?, wrappedAcmeAccountKey? }`: the signed claim
 * names the digest of every ciphertext, the position in the record's history and the previous
 * record's digest. A different ciphertext, a stale writer or a skipped generation is refused, so
 * no valid signature authorizes a record other than the one it describes.
 */
export async function handleUploadWebauthnRecovery(
  deps: WebauthnRecoveryDeps,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const checked = await checkEnvelope(deps, body, "put");
  if ("response" in checked) return checked.response;
  const { claim, signatureHex, existing, b } = checked;

  const umk = b64Field(b.wrappedUmk, "wrappedUmk");
  if (!umk) return malformed("wrappedUmk is required");
  if ("error" in umk) return malformed(umk.error);
  const admin = b64Field(b.wrappedAdminRoot, "wrappedAdminRoot");
  if (admin && "error" in admin) return malformed(admin.error);
  const acme = b64Field(b.wrappedAcmeAccountKey, "wrappedAcmeAccountKey");
  if (acme && "error" in acme) return malformed(acme.error);
  if (!/^[0-9a-f]{16,512}$/.test(claim.credentialIdHex)) return malformed("credentialId must be 8-256 hex bytes");
  // SEC-REPAIR-001: the passkey's public key, from the attestation object the platform returned at
  // creation. It rides beside the signed claim, bound to it by the credential id the claim signs.
  let passkey: { coseHex: string; alg: number } | undefined;
  if (b.passkeyAttestationObject !== undefined) {
    const read = await passkeyFromAttestation(b.passkeyAttestationObject, claim.credentialIdHex, deps.passkeyPolicy ?? recoveryPasskeyPolicy());
    if ("response" in read) return read.response;
    passkey = read.passkey;
  } else if (existing?.passkey && existing.credentialIdHex === claim.credentialIdHex) {
    // Same credential, written by a client that does not send the key: keep the one held.
    passkey = existing.passkey;
  }

  if ((await sha256Hex(umk.bytes)) !== claim.wrappedUmkDigestHex) {
    return forbidden("the wrapped UMK is not the one that was signed");
  }
  // A ciphertext is on the wire exactly when the claim replaces it; keep/none/remove carry none.
  const wantsAdmin = claim.adminRoot.change === "replace";
  const wantsAcme = claim.acmeKey.change === "replace";
  if (wantsAdmin !== !!admin || wantsAcme !== !!acme) {
    return malformed("escrow ciphertexts must accompany exactly the fields the record replaces");
  }
  if (claim.adminRoot.change === "replace" && admin && !("error" in admin) && (await sha256Hex(admin.bytes)) !== claim.adminRoot.digestHex) {
    return forbidden("the wrapped admin root is not the one that was signed");
  }
  if (claim.acmeKey.change === "replace" && acme && !("error" in acme) && (await sha256Hex(acme.bytes)) !== claim.acmeKey.digestHex) {
    return forbidden("the wrapped ACME key is not the one that was signed");
  }

  const verdict = checkRecoveryEvolution(existing ? await storedState(existing) : undefined, claim);
  if (!verdict.ok) return conflict(EVOLUTION_REFUSALS[verdict.reason] ?? verdict.reason);

  const t = now();
  const keptAdmin = claim.adminRoot.change === "keep" ? existing?.wrappedAdminRootB64 : undefined;
  const keptAcme = claim.acmeKey.change === "keep" ? existing?.wrappedAcmeAccountKeyB64 : undefined;
  const adminB64 = admin && !("error" in admin) ? admin.b64 : keptAdmin;
  const acmeB64 = acme && !("error" in acme) ? acme.b64 : keptAcme;
  const stored = await deps.webauthnRecovery.replaceIfDigest(
    {
      username: claim.username,
      credentialIdHex: claim.credentialIdHex,
      wrappedUmkB64: umk.b64,
      irkPubHex: claim.irkPubHex,
      fetchTokenHashHex: claim.fetchTokenHashHex,
      prfSaltHashHex: claim.prfSaltHashHex,
      ...(acmeB64 ? { wrappedAcmeAccountKeyB64: acmeB64 } : {}),
      ...(adminB64 ? { wrappedAdminRootB64: adminB64 } : {}),
      signed: {
        digestHex: recoveryRecordDigest(claim),
        generation: claim.generation,
        signedClaimJson: JSON.stringify(claim),
        signatureHex,
      },
      ...(passkey ? { passkey } : {}),
      createdAt: existing?.createdAt ?? t,
      updatedAt: t,
    },
    claim.priorDigestHex,
  );
  if (!stored) return conflict(EVOLUTION_REFUSALS["stale-prior"]!);
  return { status: 200, body: { ok: true, updated: !!existing, generation: claim.generation, digestHex: recoveryRecordDigest(claim), passkeyChecked: !!passkey } };
}

/**
 * Public metadata fetch — returns presence + credentialId + the
 * SHA-256 of the stored ciphertext. Used by:
 *
 *   - `hasCloudRecovery` (webapp UI hint)
 *   - the delete pre-flight (the webapp needs the bytes-hash to pin
 *     the kill-switch signature; it gets the hash here without ever
 *     pulling the ciphertext).
 *
 * Task #74: the ciphertext itself is NO LONGER returned here — fetching
 * it requires `POST /api/recovery/by-username/<u>/fetch` with the
 * passphrase-derived fetchToken. Legacy records (uploaded before the
 * migration) have no fetchTokenHash; those rows still surface presence
 * + credentialId here but cannot be unwrapped through the gated POST
 * until the user re-enrols.
 */
export async function handleFetchWebauthnRecovery(
  deps: WebauthnRecoveryDeps,
  username: string,
): Promise<HandlerResponse> {
  const rec = await deps.webauthnRecovery.get(username);
  if (!rec) return notFound("no recovery record");
  const wrappedBytes = base64DecodeBytes(rec.wrappedUmkB64) ?? new Uint8Array();
  const wrappedUmkHash = await sha256Hex(wrappedBytes);
  return {
    status: 200,
    body: {
      username: rec.username,
      credentialId: rec.credentialIdHex,
      wrappedUmkHash,
      // Surfaces whether the gated-fetch path is available for this row.
      // Pre-migration rows return `false` — the webapp shows a "re-enrol
      // to unlock cloud recovery" hint instead of attempting the fetch.
      hasFetchTokenGate: !!rec.fetchTokenHashHex,
      // SEC-REPAIR-001: true ⇒ the fetch needs a passkey assertion over a fresh challenge; false ⇒
      // a record from before (passphrase only), which the apps offer to update once.
      passkeyRequired: !!rec.passkey,
      // N03: where the signed history stands. `legacy` rows carry unsigned escrow extras and are
      // replaced by a v2 record on the owner's next enrolment.
      legacy: !rec.signed,
      ...(rec.signed ? { generation: rec.signed.generation, digestHex: rec.signed.digestHex } : {}),
      // Digests (never ciphertext) of the escrows held, so the owner's next signed record can say
      // `keep:<digest>` instead of inheriting them silently.
      ...(rec.wrappedAdminRootB64 ? { adminRootDigestHex: await sha256Hex(base64DecodeBytes(rec.wrappedAdminRootB64) ?? new Uint8Array()) } : {}),
      ...(rec.wrappedAcmeAccountKeyB64 ? { acmeKeyDigestHex: await sha256Hex(base64DecodeBytes(rec.wrappedAcmeAccountKeyB64) ?? new Uint8Array()) } : {}),
      updatedAt: rec.updatedAt,
    },
  };
}

/**
 * Argon2id-gated fetch (Task #74). The webapp posts
 *
 *   { fetchToken: <hex>, issuedAt: <ms> }
 *
 * after deriving fetchToken locally from the user's passphrase via
 * Argon2id + HKDF. We hash it and compare to the stored
 * `fetchTokenHashHex`. Only on match do we hand out the wrappedUmk.
 *
 * Rate-limiting happens upstream in apps/com/src/rateLimit.ts
 * (3-per-15min per usernameHash). The endpoint is also called per-IP
 * so a single passphrase-guessing attacker burns out their budget
 * almost immediately; combined with Argon2id's per-attempt cost on
 * the client side, this brings the brute-force cost to "infeasible
 * for any but a state-level attacker, even with a leaked rows dump"
 * — see project's threat-model.md for the math.
 */
export async function handleFetchWrappedUmkWithToken(
  deps: WebauthnRecoveryDeps,
  username: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") {
    return malformed("malformed body");
  }
  if (typeof b.fetchToken !== "string" || !/^[0-9a-fA-F]{32,512}$/.test(b.fetchToken)) {
    return malformed("fetchToken must be hex");
  }
  if (typeof b.issuedAt !== "number" || Math.abs(now() - b.issuedAt) > maxAgeMs) {
    return forbidden("stale request");
  }
  const rec = await deps.webauthnRecovery.get(username);
  if (!rec) return notFound("no recovery record");
  // SEC-REPAIR-001: a record that holds the passkey's key releases nothing without that passkey's
  // signature over a challenge `.com` issued for this account.
  if (rec.passkey) {
    if (!deps.recoveryProofSecret) return { status: 503, body: { error: "passkey recovery is not configured", code: "passkey-unavailable" } };
    const p = b.passkey as { challenge?: unknown; assertion?: unknown } | undefined;
    if (!p || typeof p !== "object" || typeof p.challenge !== "string") {
      return { status: 403, body: { error: "this recovery needs your passkey", code: "passkey-required" } };
    }
    if (!(await checkRecoveryChallenge(deps.recoveryProofSecret, username, p.challenge, now()))) {
      return { status: 403, body: { error: "the passkey challenge expired; try again", code: "passkey-challenge" } };
    }
    const verdict = await verifyPasskeyAssertion({
      coseHex: rec.passkey.coseHex,
      credentialIdHex: rec.credentialIdHex,
      assertion: p.assertion,
      challenge: p.challenge,
      policy: deps.passkeyPolicy ?? recoveryPasskeyPolicy(),
    });
    if (!verdict.ok) return { status: 403, body: { error: verdict.reason, code: "passkey-invalid" } };
    const spent = challengeNonce(p.challenge);
    if (!spent || !(await deps.webauthnRecovery.consumeChallenge(spent.nonceHex, spent.expiresAt, now()))) {
      return { status: 403, body: { error: "that passkey answer was already used; try again", code: "passkey-challenge" } };
    }
  }
  if (!rec.fetchTokenHashHex) {
    // Legacy row uploaded before the migration. Refuse the gated fetch
    // — the user must re-enrol via the recovery sub-origin to acquire
    // a fetchToken hash on the stored row.
    return conflict("record predates passphrase gate — re-enrol cloud recovery");
  }
  const fetchTokenBytes = hexToBytes(b.fetchToken.toLowerCase());
  const presentedHashHex = await sha256Hex(fetchTokenBytes);
  if (presentedHashHex !== rec.fetchTokenHashHex.toLowerCase()) {
    return forbidden("invalid fetch token");
  }
  // Recovery Phase B — surface the CURRENTLY registered IRK so the recovering
  // client can detect whether the account's key was rotated since this recovery
  // envelope was written. Recovered-IRK == registered ⇒ instant pair (the key
  // never moved); != ⇒ the device must re-pair (oldIrkPub = this registered
  // value) and wait out the grace window. Best-effort: a missing username row
  // (shouldn't happen for an enrolled account) simply omits the field, leaving
  // the client on its pre-Phase-B path.
  const userRec = await deps.usernames.get(username);
  // The caller just proved possession of the recovery passphrase. Mint
  // the short-lived proof of that fact so a follow-on re-pair initiate
  // (which has no other way to tell an owner from a stranger — its own
  // envelope is self-signed and `oldIrkPub` is public) can be gated on
  // a real credential. Bound to this username + this record's token
  // hash, so it is useless against another account and dies when the
  // passphrase is rotated.
  const recoveryProof = deps.recoveryProofSecret
    ? await mintRecoveryProof(
        { username, fetchTokenHashHex: rec.fetchTokenHashHex },
        deps.recoveryProofSecret,
        { now: now() },
      )
    : null;
  return {
    status: 200,
    body: {
      username: rec.username,
      credentialId: rec.credentialIdHex,
      wrappedUmk: rec.wrappedUmkB64,
      ...(recoveryProof
        ? {
            recoveryProof: {
              token: recoveryProof.token,
              expiresAt: recoveryProof.expiresAt,
            },
          }
        : {}),
      ...(userRec ? { registeredIrkPubHex: userRec.irkPubHex } : {}),
      // #28 — release the escrowed ACME account key alongside the UMK so a
      // recovering device can restore cert-minting authority. Ciphertext only;
      // absent when the account never minted an account key.
      ...(rec.wrappedAcmeAccountKeyB64
        ? { wrappedAcmeAccountKey: rec.wrappedAcmeAccountKeyB64 }
        : {}),
      // Slice D (D-3) — release the escrowed admin master root alongside the
      // UMK so credential recovery can re-establish (and rotate) admin
      // authority. Ciphertext only; absent when no admin root was escrowed.
      ...(rec.wrappedAdminRootB64
        ? { wrappedAdminRoot: rec.wrappedAdminRootB64 }
        : {}),
      // The PRF salt hash is returned so the client can verify it
      // re-derives the same value from the passphrase locally — a
      // defense against a malicious .com swapping the salt to coerce
      // a different PRF output.
      ...(rec.prfSaltHashHex ? { prfSaltHash: rec.prfSaltHashHex } : {}),
      // N03 — the signed claim exactly as stored, so the client checks every ciphertext above
      // against its signed digest before unwrapping, and the signature once it holds the key.
      // Absent for a legacy row, which the client labels as carrying unsigned extras.
      ...(rec.signed
        ? { signed: { claim: JSON.parse(rec.signed.signedClaimJson) as unknown, signatureHex: rec.signed.signatureHex, digestHex: rec.signed.digestHex, generation: rec.signed.generation } }
        : { legacy: true }),
      // SEC-REPAIR-001: whether the passkey was checked here. `passkeyLegacy` = a record from before,
      // released on the passphrase alone; the apps ask the owner once to update their recovery.
      ...(rec.passkey ? { passkeyChecked: true } : { passkeyLegacy: true }),
      updatedAt: rec.updatedAt,
    },
  };
}

/**
 * `POST /api/recovery/by-username/:u/challenge` → `{ challenge, expiresAt }`. The recovery passkey
 * signs `challenge` (base64url; pass its bytes as the WebAuthn challenge) in the same sheet that
 * yields the PRF output. Stateless and answered the same whether or not the account exists.
 */
export async function handleRecoveryChallenge(
  deps: Pick<WebauthnRecoveryDeps, "recoveryProofSecret" | "now">,
  username: string,
): Promise<HandlerResponse> {
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(username)) return malformed("invalid username");
  if (!deps.recoveryProofSecret) return { status: 503, body: { error: "passkey recovery is not configured", code: "passkey-unavailable" } };
  const now = (deps.now ?? (() => Date.now()))();
  return { status: 200, body: await issueRecoveryChallenge(deps.recoveryProofSecret, username, now) };
}

/**
 * Kill switch — remove the cloud copy. A signed v2 `delete` that names the record it deletes by
 * digest and generation, so a leaked old signature cannot remove a record written since.
 */
export async function handleDeleteWebauthnRecovery(
  deps: WebauthnRecoveryDeps,
  username: string,
  body: unknown,
): Promise<HandlerResponse> {
  const checked = await checkEnvelope(deps, body, "delete", username);
  if ("response" in checked) return checked.response;
  const { claim, existing } = checked;
  if (!existing) return notFound("no recovery record");
  const verdict = checkRecoveryEvolution(await storedState(existing), claim);
  if (!verdict.ok) return conflict(EVOLUTION_REFUSALS[verdict.reason] ?? verdict.reason);
  if (!(await deps.webauthnRecovery.deleteIfDigest(claim.username, claim.priorDigestHex))) {
    return conflict(EVOLUTION_REFUSALS["stale-prior"]!);
  }
  return { status: 200, body: { ok: true } };
}
