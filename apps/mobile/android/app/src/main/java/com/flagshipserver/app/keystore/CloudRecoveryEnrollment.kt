// Shared passphrase-gated cloud-recovery ceremony, factored out of the
// enroll screens (RecoveryScreen + SecureAccountScreen) and the restore
// path (LoginViewModel) so the security-critical derive → wrap → sign →
// upload logic lives in ONE place and is unit-tested once.
//
// CANONICAL reference is apps/web/public/recovery/recovery.js — the enroll
// flow mirrors its #enroll branch, the restore flow its #recover branch:
//
//   ENROLL:
//     1. derivePassphraseSecrets(passphrase, username) → {fetchToken, prfSalt}
//     2. create a passkey with PRF input = prfSalt
//     3. wrap the UMK seed under the PRF-derived secret
//     4. escrow the ACME account key under the same secret (#28; optional)
//     5. IRK-sign + POST the envelope with fetchTokenHash + prfSaltHash
//
//   RESTORE:
//     1. derivePassphraseSecrets(passphrase, username) → {fetchToken, prfSalt}
//     2. gated fetch with fetchToken → {wrappedUmk, prfSaltHash?, …}
//     3. assert sha256hex(local prfSalt) == response.prfSaltHash (refuse on mismatch)
//     4. PRF get() with input = prfSalt → unwrap wrappedUmk → UMK seed
//
// The Argon2id step (~1-2s) is the caller's responsibility to run off the
// main thread; these functions are plain suspend fns that block on the CPU.

package com.flagshipserver.app.keystore

import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.RecoveryEnvelopeRequest
import com.flagshipserver.app.core.AcmeAccountKey
import com.flagshipserver.app.core.AdminRootEscrow
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.RecoveryRecordChain
import com.flagshipserver.app.core.SignedRecoveryRecord
import com.google.crypto.tink.subtle.Ed25519Sign

object CloudRecoveryEnrollment {
    const val MIN_PASSPHRASE = 8

    /** Thrown for the user-facing validation failures so callers can map
     *  to the approved copy without string-sniffing. */
    class ValidationError(message: String) : Exception(message)

    /** A passkey ceremony seam — production passes [PasskeyRecoveryManager]
     *  bound to an Activity; tests pass a fake. Both create/assert take the
     *  prfSalt as the PRF eval input. */
    interface PasskeyCeremony {
        /** Create a passkey, return (credentialIdHex, prfSecret). */
        suspend fun create(username: String, prfEvalInput: ByteArray): Pair<String, ByteArray>

        /** PRF-assert an existing credentialId, return the prfSecret. */
        suspend fun assert(credentialId: String, prfEvalInput: ByteArray): ByteArray
    }

    /** Result of a successful enroll — surfaced so callers can mirror the
     *  webapp's local Block Store save (Android keeps a Block Store copy). */
    data class EnrollResult(
        val credentialId: String,
        val wrappedUmk: String,
    )

    /**
     * Validate the passphrase pair, derive the secrets, run the passkey
     * ceremony with PRF input = prfSalt, wrap the UMK + escrow the ACME
     * key, then IRK-sign and upload with the gate hashes.
     *
     * @throws ValidationError when the passphrase is too short / mismatched.
     */
    suspend fun enroll(
        server: FlagshipServerClient,
        passkeys: PasskeyCeremony,
        irk: Ed25519Sign,
        /** The account key's public half, hex: the record names its signer. */
        irkPubHex: String,
        username: String,
        umkSeed: ByteArray,
        passphrase: String,
        passphraseConfirm: String,
        acmeScalar: ByteArray?,
        now: Long,
        /** Slice D (D-3) — the admin master root seed to escrow alongside the
         *  UMK, or null on a legacy account with no admin root. */
        adminRootSeed: ByteArray? = null,
    ): EnrollResult {
        if (passphrase.length < MIN_PASSPHRASE) {
            throw ValidationError("Passphrase must be at least $MIN_PASSPHRASE characters.")
        }
        if (passphrase != passphraseConfirm) {
            throw ValidationError("Passphrases don't match.")
        }

        val secrets = RecoveryDerivation.derivePassphraseSecrets(passphrase, username)
        // PRF input = prfSalt, exactly like recovery.js's createPasskey.
        val (credentialId, prfSecret) = passkeys.create(username, secrets.prfSalt)
        val wrappedUmk = Recovery.wrap(umkSeed = umkSeed, prfSecret = prfSecret)

        // #28 — escrow the ACME account key under the same PRF secret (own
        // HKDF salt). Non-fatal: a failure here never blocks the UMK escrow.
        val wrappedAcme: String? = acmeScalar?.let { scalar ->
            try {
                AcmeAccountKey.wrapForEscrow(scalar, prfSecret)
            } catch (_: Throwable) {
                null
            }
        }

        // Slice D (D-3) — escrow the admin master root under the same PRF secret
        // (own HKDF salt). Non-fatal: a failure never blocks the UMK escrow.
        val wrappedAdminRoot: String? = adminRootSeed?.let { seed ->
            try {
                AdminRootEscrow.wrapForEscrow(seed, prfSecret)
            } catch (_: Throwable) {
                null
            }
        }

        // N03 — sign the COMPLETE record: every ciphertext digest, the fetchToken/prfSalt hashes,
        // the versions and policy, the record's generation and the digest of the record it
        // replaces. An escrow not re-sent is keep:<held digest> (or none), never silently inherited.
        postRecord(
            server, irk, irkPubHex, username, credentialId, wrappedUmk, wrappedAdminRoot, wrappedAcme,
            RecoveryDerivation.sha256Hex(secrets.fetchToken), RecoveryDerivation.sha256Hex(secrets.prfSalt), now,
        )
        return EnrollResult(credentialId = credentialId, wrappedUmk = wrappedUmk)
    }

    /** Recovered material from a gated restore: the UMK seed + the optional
     *  escrowed ACME scalar (null when the account never escrowed one). */
    data class RestoreResult(
        val umkSeed: ByteArray,
        val acmeScalar: ByteArray?,
        /** Slice D (D-3) — the recovered admin master root seed, or null when
         *  the account never escrowed one. The caller re-establishes admin via
         *  Keystore.importAdminRoot. */
        val adminRootSeed: ByteArray? = null,
        /** `.com`'s attestation that this restore cleared the passphrase
         *  gate. The caller carries it into a follow-on re-pair, which
         *  `.com` refuses without a credential. Null on a deployment
         *  that mints none (the re-pair then fails closed). */
        val recoveryProofToken: String? = null,
        /** True when the record came from a v1 row whose escrow extras carry no signature. */
        val recordWasLegacy: Boolean = false,
    )

    /**
     * Passphrase-gated restore. Derives the secrets, runs the gated fetch,
     * asserts the returned prfSaltHash matches the locally-derived prfSalt
     * (refusing on mismatch — defense against a malicious .com swapping the
     * salt), then PRF-asserts with prfSalt and unwraps the UMK (+ ACME key).
     *
     * @throws ValidationError on a too-short passphrase or a prfSaltHash mismatch.
     */
    suspend fun restore(
        server: FlagshipServerClient,
        passkeys: PasskeyCeremony,
        username: String,
        passphrase: String,
        now: Long,
    ): RestoreResult {
        if (passphrase.length < MIN_PASSPHRASE) {
            throw ValidationError("Passphrase must be at least $MIN_PASSPHRASE characters.")
        }
        val secrets = RecoveryDerivation.derivePassphraseSecrets(passphrase, username)

        val fetched = server.fetchWrappedUmkWithToken(
            username = username,
            fetchTokenHex = HexUtil.encode(secrets.fetchToken),
            issuedAt = now,
        )

        // Defense-in-depth: confirm .com returned the same prfSalt we
        // derived locally before we trust its PRF coupling. Mirrors
        // recovery.js's localPrfSaltHash !== prfSaltHash check.
        val serverPrfSaltHash = fetched.prfSaltHash
        if (serverPrfSaltHash != null) {
            val localPrfSaltHash = RecoveryDerivation.sha256Hex(secrets.prfSalt)
            if (localPrfSaltHash != serverPrfSaltHash.lowercase()) {
                throw ValidationError(
                    "Server returned a stale prfSaltHash — refusing to proceed.",
                )
            }
        }

        // N03 — a signed record names the digest of every ciphertext it covers. Refuse before any
        // unwrap if `.com` returned a different one (swapped, dropped or added). A legacy record has
        // no such signature; it is recovered but reported as carrying unsigned extras.
        fetched.signed?.let { signed ->
            val bad = signed.claim.ciphertextMismatch(fetched.wrappedUmk, fetched.wrappedAdminRoot, fetched.wrappedAcmeAccountKey)
            if (bad != null) {
                throw ValidationError("The stored recovery record does not match its signed digest ($bad); refusing to unwrap it.")
            }
        }

        // PRF get() input = prfSalt → unwrap.
        val prfSecret = passkeys.assert(fetched.credentialId, secrets.prfSalt)
        val umkSeed = Recovery.unwrap(
            wrappedUmkBase64 = fetched.wrappedUmk,
            prfSecret = prfSecret,
        )
        // …and the signature itself, now that the recovered key can verify it.
        fetched.signed?.let { signed ->
            if (!recoveredKeySigned(umkSeed, signed)) {
                throw ValidationError("The stored recovery record was not signed by this account's key; refusing to use it.")
            }
        }
        // #28 — recover the escrowed ACME account key under the same PRF
        // secret if present. Non-fatal: a failure here is recoverable via a
        // surviving admin device, so swallow it (caller imports if non-null).
        val acmeScalar: ByteArray? = fetched.wrappedAcmeAccountKey?.let { wrapped ->
            try {
                AcmeAccountKey.unwrapFromEscrow(wrapped, prfSecret)
            } catch (_: Throwable) {
                null
            }
        }
        // Slice D (D-3) — recover the escrowed admin master root under the same
        // PRF secret if present. Non-fatal (a surviving admin device can
        // re-establish); the caller imports it via Keystore.importAdminRoot.
        val adminRootSeed: ByteArray? = fetched.wrappedAdminRoot?.let { wrapped ->
            try {
                AdminRootEscrow.unwrapFromEscrow(wrapped, prfSecret)
            } catch (_: Throwable) {
                null
            }
        }
        return RestoreResult(
            umkSeed = umkSeed,
            acmeScalar = acmeScalar,
            adminRootSeed = adminRootSeed,
            recoveryProofToken = fetched.recoveryProof?.token,
            recordWasLegacy = fetched.signed == null,
        )
    }

    /** Does a key derived from the recovered UMK (any of the first few rotation versions) verify
     *  the owner's signed record? It was signed by the key in force when it was written. */
    internal fun recoveredKeySigned(umkSeed: ByteArray, signed: SignedRecoveryRecord): Boolean {
        for (v in 1..4) {
            val seed = com.google.crypto.tink.subtle.Hkdf.computeHkdf(
                "HMACSHA256", umkSeed, "flagship/irk/v$v".toByteArray(), "ed25519-seed".toByteArray(), 32,
            )
            val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
            if (HexUtil.encode(pub) == signed.claim.irkPubHex) {
                return signed.claim.verify(signed.signatureHex, pub)
            }
        }
        return false
    }

    private suspend fun postRecord(
        server: FlagshipServerClient,
        irk: Ed25519Sign,
        irkPubHex: String,
        username: String,
        credentialId: String,
        wrappedUmk: String,
        wrappedAdminRoot: String?,
        wrappedAcme: String?,
        fetchTokenHashHex: String,
        prfSaltHashHex: String,
        now: Long,
    ) {
        val current = server.recoveryRecordState(username)
        val claim = RecoveryRecordChain.next(
            username = username,
            irkPubHex = irkPubHex,
            adminRootPubHex = server.pinnedAdminRoot(username),
            current = current,
            credentialIdHex = credentialId,
            wrappedUmk = wrappedUmk,
            wrappedAdminRoot = wrappedAdminRoot,
            wrappedAcmeAccountKey = wrappedAcme,
            fetchTokenHashHex = fetchTokenHashHex,
            prfSaltHashHex = prfSaltHashHex,
            issuedAt = now,
        )
        server.registerRecoveryEnvelope(
            RecoveryEnvelopeRequest(
                claim = claim,
                signature = HexUtil.encode(irk.sign(claim.canonicalBytes())),
                wrappedUmk = wrappedUmk,
                wrappedAdminRoot = wrappedAdminRoot,
                wrappedAcmeAccountKey = wrappedAcme,
            ),
        )
    }

    /**
     * Slice D (D-3) post-rotation re-escrow: re-wrap the ROTATED admin master
     * root under the EXISTING recovery credential so a later credential
     * recovery restores the NEW root, not the dead pre-rotation one. No new
     * passkey is created — the wrap key is the same PRF secret, reached the
     * same way as restore: passphrase → gated fetch → PRF assert. The fetched
     * wrappedUmk / wrappedAcmeAccountKey are passed through UNCHANGED and the
     * envelope is re-posted under the SAME credentialId, so the Worker
     * replaces the record in place.
     *
     * The fetched wrappedUmk MUST unwrap under the asserted PRF secret before
     * we post — that proves we hold the right wrap key and can't brick the
     * escrow by overwriting it with a blob wrapped under a different secret.
     *
     * @throws ValidationError on a too-short/wrong passphrase or a
     *   prfSaltHash mismatch; rethrows any wrap/unwrap failure WITHOUT
     *   posting (the stored record is never touched on any failure path).
     */
    suspend fun reEscrowAdminRoot(
        server: FlagshipServerClient,
        passkeys: PasskeyCeremony,
        irk: Ed25519Sign,
        irkPubHex: String,
        username: String,
        passphrase: String,
        newAdminRootSeed: ByteArray,
        now: Long,
    ) {
        if (passphrase.length < MIN_PASSPHRASE) {
            throw ValidationError("Passphrase must be at least $MIN_PASSPHRASE characters.")
        }
        val secrets = RecoveryDerivation.derivePassphraseSecrets(passphrase, username)

        val fetched = try {
            server.fetchWrappedUmkWithToken(
                username = username,
                fetchTokenHex = HexUtil.encode(secrets.fetchToken),
                issuedAt = now,
            )
        } catch (e: HttpException) {
            // The gate 403s on a fetchToken derived from the wrong passphrase.
            if (e.status == 403) throw ValidationError("That passphrase didn't match.")
            throw e
        }

        // Same anti-tamper check as restore(): refuse a .com that passed the
        // fetch gate but returned a prfSaltHash foreign to our passphrase.
        val serverPrfSaltHash = fetched.prfSaltHash
        if (serverPrfSaltHash != null) {
            val localPrfSaltHash = RecoveryDerivation.sha256Hex(secrets.prfSalt)
            if (localPrfSaltHash != serverPrfSaltHash.lowercase()) {
                throw ValidationError(
                    "Server returned a stale prfSaltHash — refusing to proceed.",
                )
            }
        }

        // EXISTING credential — assert, never create.
        val prfSecret = passkeys.assert(fetched.credentialId, secrets.prfSalt)

        // Sanity gate BEFORE overwriting the stored record: the fetched UMK
        // blob must unwrap under this PRF secret (AEADBadTagException aborts).
        Recovery.unwrap(wrappedUmkBase64 = fetched.wrappedUmk, prfSecret = prfSecret)

        val wrappedAdminRoot = AdminRootEscrow.wrapForEscrow(newAdminRootSeed, prfSecret)

        // N03 — chain a new signed record onto the stored one: the UMK is passed through
        // unchanged, the ACME escrow is keep:<digest>, the admin root is replace:<digest>.
        postRecord(
            server, irk, irkPubHex, username, fetched.credentialId, fetched.wrappedUmk, wrappedAdminRoot, null,
            RecoveryDerivation.sha256Hex(secrets.fetchToken), RecoveryDerivation.sha256Hex(secrets.prfSalt), now,
        )
    }
}
