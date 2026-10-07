/**
 * Recovery-session proof — the artifact that makes a single-device
 * re-pair (account key rotation) credential-gated instead of open.
 *
 * ## Why this exists
 *
 * `handleInitiateRePair` schedules a swap of the account's registered
 * IRK. Its envelope is signed by the INCOMING key, so the signature is
 * self-asserted: it proves the caller holds the key they are asking
 * `.com` to install, and nothing about whether they own the account.
 * The other input, `oldIrkPub`, is PUBLIC (the username lookup serves
 * it). So for an account with no TOTP enrolled, initiate used to demand
 * nothing a stranger could not supply — the grace window was the only
 * brake, and no veto exists for the displaced owner (`/re-pair/object`
 * is self-cancel only). That contradicts the product invariant in
 * `docs/naming-recovery-and-name-change.md` §1.6: "Nothing recovers an
 * account without a credential."
 *
 * The credential that single-device accounts actually have is the cloud
 * recovery passphrase + passkey. `.com` cannot verify the passkey (it
 * stores only `credentialId`), and it must never see the passphrase.
 * What it CAN verify is the Argon2id-derived `fetchToken`, which is
 * already the gate on the wrapped-UMK fetch. So the gated fetch becomes
 * the authenticator: when it releases the ciphertext, it also mints a
 * short-lived proof that the caller passed the passphrase gate, and
 * initiate requires that proof.
 *
 * The webapp's recovery UI runs on its OWN origin and hands the parent
 * only the unwrapped seed — it never exposes the fetchToken to the
 * webapp origin. A server-minted proof is therefore the only shape that
 * works for all three surfaces without widening that boundary: the
 * recovery origin forwards an opaque token (far less sensitive than the
 * seed it already forwards) and the webapp presents it.
 *
 * ## Shape
 *
 *     rp1.<expiresAt>.<hex mac>
 *     mac = HMAC-SHA256(secret, TAG|username|fetchTokenHashHex|expiresAt)
 *
 * Stateless by design — no table, no migration, nothing to garbage-
 * collect, and no deploy-ordering hazard between the schema and the
 * Worker. The trade is that it is bearer, not single-use:
 *
 *   - Bound to ONE username: it cannot be replayed against another
 *     account.
 *   - Bound to the record's `fetchTokenHashHex`: re-enrolling cloud
 *     recovery (a new passphrase) invalidates every outstanding proof.
 *   - TTL-bounded at mint AND re-checked at verify, so a token minted
 *     with an absurd expiry by a future caller is still refused.
 *   - Residual: the token is bearer, not single-use. Reading one
 *     requires breaking TLS to `.com` or owning the recovering client —
 *     and a client that holds the proof also holds the recovered seed,
 *     which is strictly more powerful. The exposure is also narrower
 *     than "bearer" suggests: a successful initiate takes the
 *     one-row-per-account lock (`pending_re_pairs.username` is the PK),
 *     so a replay inside the TTL hits 409 "re-pair already pending".
 *     The only replay that lands is the legitimate recoverer SELF-
 *     CANCELLING inside the five-minute window and an attacker
 *     re-initiating in what is left of it.
 *
 *     Reviewers ask why the proof is not bound to the incoming
 *     `newIrkPub`, which would kill even that: the client cannot know
 *     that key yet. It derives the new IRK from the UMK seed that THIS
 *     fetch is what hands it, so at mint time the value does not exist.
 *     Binding would need a second round trip, which an attacker holding
 *     the first token could make themselves — circular. Making the
 *     proof single-use is the real upgrade and it needs server state
 *     (one row per issued proof); worth it only if the TTL ever has to
 *     grow, since at five minutes the window is thinner than the one
 *     the signed envelopes beside it already accept.
 *
 * The secret is `FLAGSHIP_RECOVERY_PROOF_SECRET` — a MAC key, not a
 * key-encrypting key (nothing here is encrypted, and no user data is
 * derived from it), so it is named like
 * `FLAGSHIP_INFERENCE_TOKEN_SECRET` rather than `FLAGSHIP_TOTP_KEK`.
 * Any high-entropy value works; 32 random bytes of hex is the house
 * size. Rotating it invalidates proofs minted under the old value,
 * which costs a recovering user one extra passphrase round-trip and
 * nothing else — there is no stored ciphertext keyed to it.
 *
 * Callers FAIL CLOSED when
 * it is unset (see `handleInitiateRePair`): an unconfigured deployment
 * refuses recovery loudly rather than silently reopening the hole. That
 * is the opposite of the deploy-safe degrade the rest of the v1.2
 * cascade uses, and deliberately so — degrading this dep IS the bug.
 */

/** Wire prefix. Bump if the MAC input ever changes shape. */
const PREFIX = "rp1";

/** Canonical MAC-input tag. Distinct from every signing tag — this is a
 *  symmetric first-party MAC, never an Ed25519 envelope. */
const TAG = "flagship/recovery-proof/v1";

/**
 * How long a minted proof stays usable.
 *
 * The legitimate flow presents it SECONDS after the gated fetch —
 * unwrap → install the recovered UMK → derive the rotated key →
 * initiate, with no human step in between (every client confirms the
 * takeover BEFORE the unwrap). Five minutes is therefore already
 * generous, and it matches the freshness bound every signed envelope in
 * this package uses (`DEFAULT_MAX_AGE`), so there is one window to
 * reason about rather than two.
 */
export const RECOVERY_PROOF_TTL_MS = 5 * 60_000;

export interface RecoveryProofBinding {
  /** Account the proof authorizes recovery for (compared lowercased). */
  username: string;
  /** SHA-256 of the record's fetchToken, hex (compared lowercased). */
  fetchTokenHashHex: string;
}

export interface MintedRecoveryProof {
  token: string;
  expiresAt: number;
}

export type RecoveryProofVerdict =
  | { ok: true; expiresAt: number }
  | {
      ok: false;
      reason: "malformed" | "bad-signature" | "expired" | "ttl-too-long";
    };

function macInput(b: RecoveryProofBinding, expiresAt: number): string {
  return [
    TAG,
    b.username.toLowerCase(),
    b.fetchTokenHashHex.toLowerCase(),
    expiresAt,
  ].join("|");
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  let out = "";
  for (const b of sig) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Constant-time compare over equal-length hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint a proof that the caller passed the passphrase gate for
 * `binding.username`. Called by the gated wrapped-UMK fetch, which has
 * just verified the fetchToken against the stored hash.
 */
export async function mintRecoveryProof(
  binding: RecoveryProofBinding,
  secret: string,
  opts?: { now?: number; ttlMs?: number },
): Promise<MintedRecoveryProof> {
  const now = opts?.now ?? Date.now();
  const ttlMs = opts?.ttlMs ?? RECOVERY_PROOF_TTL_MS;
  const expiresAt = now + ttlMs;
  const mac = await hmacHex(secret, macInput(binding, expiresAt));
  return { token: `${PREFIX}.${expiresAt}.${mac}`, expiresAt };
}

/**
 * Verify a presented proof against the account it must be bound to.
 *
 * The `binding` is assembled by the VERIFIER from its own stored row
 * (never from the request body), so a caller cannot choose what their
 * token is checked against.
 */
export async function verifyRecoveryProof(
  token: unknown,
  binding: RecoveryProofBinding,
  secret: string,
  opts?: { now?: number; maxTtlMs?: number },
): Promise<RecoveryProofVerdict> {
  const now = opts?.now ?? Date.now();
  const maxTtlMs = opts?.maxTtlMs ?? RECOVERY_PROOF_TTL_MS;
  if (typeof token !== "string") return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    return { ok: false, reason: "malformed" };
  }
  const expiresAt = Number(parts[1]);
  const mac = parts[2]!;
  if (!Number.isSafeInteger(expiresAt) || !/^[0-9a-f]{64}$/.test(mac)) {
    return { ok: false, reason: "malformed" };
  }
  // Signature BEFORE expiry: an unsigned token should never be able to
  // distinguish "expired" from "forged" by timing or by error string.
  const expected = await hmacHex(secret, macInput(binding, expiresAt));
  if (!timingSafeEqualHex(expected, mac)) {
    return { ok: false, reason: "bad-signature" };
  }
  if (expiresAt <= now) return { ok: false, reason: "expired" };
  // A valid MAC over an over-long window is still refused: the ceiling
  // lives with the verifier, so widening the TTL at the minter can
  // never outlive a deploy of this file.
  if (expiresAt - now > maxTtlMs) return { ok: false, reason: "ttl-too-long" };
  return { ok: true, expiresAt };
}
