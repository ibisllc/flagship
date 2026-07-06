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
import com.flagshipserver.app.core.RecoveryUpload
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

        val wrappedUmkBytes = java.util.Base64.getDecoder().decode(wrappedUmk)
        val wrappedUmkHashHex = RecoveryUpload.wrappedUmkHashHex(wrappedUmkBytes)
        val signature = RecoveryUpload.sign(
            irk = irk,
            username = username,
            credentialId = credentialId,
            wrappedUmkHashHex = wrappedUmkHashHex,
            issuedAt = now,
        )
        server.registerRecoveryEnvelope(
            RecoveryEnvelopeRequest(
                request = RecoveryEnvelopeRequest.Inner(
                    username = username,
                    credentialId = credentialId,
                    wrappedUmk = wrappedUmk,
                    issuedAt = now,
                    wrappedAcmeAccountKey = wrappedAcme,
                    wrappedAdminRoot = wrappedAdminRoot,
                    // Task #74 — the passphrase-gate hashes.
                    fetchTokenHash = RecoveryDerivation.sha256Hex(secrets.fetchToken),
                    prfSaltHash = RecoveryDerivation.sha256Hex(secrets.prfSalt),
                ),
                signature = HexUtil.encode(signature),
            ),
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

        // PRF get() input = prfSalt → unwrap.
        val prfSecret = passkeys.assert(fetched.credentialId, secrets.prfSalt)
        val umkSeed = Recovery.unwrap(
            wrappedUmkBase64 = fetched.wrappedUmk,
            prfSecret = prfSecret,
        )
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
        return RestoreResult(umkSeed = umkSeed, acmeScalar = acmeScalar, adminRootSeed = adminRootSeed)
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

        // Sign over the PASSED-THROUGH wrappedUmk bytes (the record content
        // the protocol hashes is unchanged; only the sibling ciphertext moves).
        val wrappedUmkBytes = java.util.Base64.getDecoder().decode(fetched.wrappedUmk)
        val signature = RecoveryUpload.sign(
            irk = irk,
            username = username,
            credentialId = fetched.credentialId,
            wrappedUmkHashHex = RecoveryUpload.wrappedUmkHashHex(wrappedUmkBytes),
            issuedAt = now,
        )
        server.registerRecoveryEnvelope(
            RecoveryEnvelopeRequest(
                request = RecoveryEnvelopeRequest.Inner(
                    username = username,
                    credentialId = fetched.credentialId,
                    wrappedUmk = fetched.wrappedUmk,
                    issuedAt = now,
                    wrappedAcmeAccountKey = fetched.wrappedAcmeAccountKey,
                    wrappedAdminRoot = wrappedAdminRoot,
                    fetchTokenHash = RecoveryDerivation.sha256Hex(secrets.fetchToken),
                    prfSaltHash = RecoveryDerivation.sha256Hex(secrets.prfSalt),
                ),
                signature = HexUtil.encode(signature),
            ),
        )
    }
}
