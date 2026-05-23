// Drives the phone's half of the boot-secret RELAY handshake
// (docs/security-phone-as-unlock-endpoint.md). Kotlin mirror of
// FlagshipCore/SecretRequestCoordinator.swift.
//
//   1. fetchVerifiedRequests — builds an IRK-signed DeviceEndpointClaim
//      mailbox-auth credential, POSTs /api/secret-requests, then
//      RE-VERIFIES every returned request against the box's STK as
//      INDEPENDENTLY resolved from the directory (/api/users/:u/pods).
//      `.com` is NOT a trust anchor: a request whose STK mismatches the
//      directory (or whose signature fails under it) is DROPPED, never
//      surfaced for confirm.
//   2. confirmAndRespond — for the verified request the user taps "yes,
//      this is my box" (the device-info backstop). By purpose:
//        - unlock-key:  GET the phone-sealed LUKS key, unseal it with the
//                       phone's IRK seed, re-seal it FOR the box's STK
//                       (nonce/purpose-bound), POST it.
//        - entitlement: IRK-sign a root-only RootEntitlement, serialize it
//                       as the daemon's EntitlementBundle carrier, hex,
//                       POST it.
//
// The crypto lives in PhoneEndpoint.kt; this coordinator only orchestrates
// + decides. Freshness windows mirror the Worker's ±5-min mailbox-auth
// window. The IRK is the ONLY Ed25519 key material on Android (no per-
// server BAK) — it both signs and unseals.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.MailboxAuthEnvelope
import com.flagshipserver.app.api.PendingSecretRequest
import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.api.SecretResponseBody
import com.flagshipserver.app.api.DeviceInfoHint
import com.google.crypto.tink.subtle.Ed25519Sign

/** Resolves the IRK signer + its raw 32-byte seed for the active version.
 *  Injectable so tests don't touch the AndroidKeyStore / biometric prompt.
 *  `signer` is biometric-gated (deriveIRK runs the BiometricAuthority);
 *  `seed` is the same key's raw seed (requireIrkSeedForVersion) used to
 *  drive the seal/unseal — the IRK both signs and unseals on Android. */
interface IrkAccess {
    /** Biometric-gated derive of the active-version IRK signer + its raw
     *  seed. The seed is what SecretSeal.openWithEd25519Seed uses to
     *  unseal the phone-sealed LUKS key. */
    suspend fun resolve(reason: String): IrkMaterial
}

data class IrkMaterial(
    val signer: Ed25519Sign,
    /** 32-byte Ed25519 seed of [signer] — drives the IRK-seed unseal path. */
    val seed: ByteArray,
    /** Public half of [signer], hex (32 bytes) — the account IRK pubkey. */
    val pubHex: String,
)

class SecretRequestCoordinator(
    private val mailbox: SecretMailboxClient,
    private val username: String,
    private val irk: IrkAccess,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val nonceGen: () -> ByteArray = { randomNonce() },
) {
    sealed class CoordinatorException(message: String) : Exception(message) {
        object NoSealedLuksKey :
            CoordinatorException("No sealed disk key is on file for this box yet.")
        object LuksUnsealFailed :
            CoordinatorException("Couldn't unseal the disk key with this phone's keys.")
        class DirectoryMissingServer(domain: String) :
            CoordinatorException("This box ($domain) isn't registered to your account.")
        class PurposeUnsupported(purpose: String) :
            CoordinatorException("Unsupported secret request type: $purpose.")
    }

    /** A request that PASSED directory re-verification, ready to show the
     *  user the device-info confirm sheet. The raw [PendingSecretRequest] +
     *  the directory-resolved STK are retained so confirm doesn't re-resolve. */
    data class VerifiedRequest(
        val pending: PendingSecretRequest,
        /** STK as resolved from the DIRECTORY (not the mailbox echo). */
        val directoryStkPubHex: String,
    ) {
        val id: String get() = pending.id
        val serverDomain: String get() = pending.serverDomain
        val purpose: SecretPurpose? get() = SecretPurpose.fromWire(pending.purpose)
        val deviceInfo: DeviceInfoHint? get() = pending.deviceInfo
    }

    companion object {
        private val rng = java.security.SecureRandom()
        fun randomNonce(): ByteArray = ByteArray(32).also(rng::nextBytes)
    }

    // ---- 1. Fetch + re-verify -----------------------------------------

    /** Build the mailbox auth, fetch the account's pending requests, and
     *  keep only those that re-verify against the DIRECTORY STK. A request
     *  `.com` returns whose STK isn't directory-bound (or whose signature
     *  fails under that STK) is SILENTLY dropped — never offered for
     *  confirm. */
    suspend fun fetchVerifiedRequests(): List<VerifiedRequest> {
        val material = irk.resolve("Check for boxes waiting for approval")
        val auth = buildMailboxAuth(material)
        val pendingResp = mailbox.fetchPendingRequests(auth)
        val directory = mailbox.fetchPods(username)

        val verified = mutableListOf<VerifiedRequest>()
        for (pending in pendingResp.requests) {
            // The DIRECTORY is the trust anchor for the STK — not the
            // mailbox echo. No directory entry ⇒ `.com` can't vouch.
            val stkHex = directory.identityPubKey(pending.serverDomain) ?: continue
            val stkPub = HexUtil.decode(stkHex) ?: continue
            if (stkPub.size != 32) continue
            // The mailbox echo MUST equal the directory STK — a relay can't
            // splice in a different stkPub.
            if (!pending.stkPub.equals(stkHex, ignoreCase = true)) continue
            val purpose = SecretPurpose.fromWire(pending.purpose) ?: continue
            val sig = HexUtil.decode(pending.requestSignature) ?: continue
            // RE-VERIFY the box's request against the DIRECTORY STK.
            val ok = SecretRequest.verify(
                signature = sig,
                stkPub = stkPub,
                serverDomain = pending.serverDomain,
                stkPubHex = stkHex,
                purpose = purpose,
                nonceHex = pending.requestNonceHex,
                issuedAt = pending.issuedAt,
            )
            if (!ok) continue
            verified.add(VerifiedRequest(pending = pending, directoryStkPubHex = stkHex))
        }
        return verified
    }

    // ---- 2. Confirm (one tap = the human backstop) --------------------

    /** The user has confirmed "yes, this is my box". Perform the crypto +
     *  post the reply. Returns when `.com` has accepted the write-once
     *  reply (the box then picks it up on its poll). */
    suspend fun confirmAndRespond(verified: VerifiedRequest) {
        val purpose = verified.purpose
            ?: throw CoordinatorException.PurposeUnsupported(verified.pending.purpose)
        val stkPub = HexUtil.decode(verified.directoryStkPubHex)
            ?.takeIf { it.size == 32 }
            ?: throw CoordinatorException.DirectoryMissingServer(verified.serverDomain)

        val material = irk.resolve("Approve your box's boot secret")
        val auth = buildMailboxAuth(material)

        val sealedHex = when (purpose) {
            SecretPurpose.UNLOCK_KEY -> buildUnlockReply(verified, stkPub, material)
            SecretPurpose.ENTITLEMENT -> buildEntitlementReply(verified, stkPub, material)
        }

        val body = SecretResponseBody(
            serverDomain = verified.serverDomain,
            requestNonceHex = verified.pending.requestNonceHex,
            purpose = purpose.wire,
            sealed = sealedHex,
            issuedAt = now(),
        )
        mailbox.postResponse(auth, body)
    }

    // ---- unlock-key ----------------------------------------------------

    /** Fetch the phone-sealed LUKS key, unseal it with the phone's IRK
     *  seed (the installer sealed it against the phone IRK pub), then
     *  re-seal it FOR the box's STK bound to (nonce, purpose). */
    private suspend fun buildUnlockReply(
        verified: VerifiedRequest,
        stkPub: ByteArray,
        material: IrkMaterial,
    ): String {
        val sealedLuks = try {
            mailbox.fetchSealedLuksKey(verified.serverDomain)
        } catch (e: HttpException) {
            if (e.status == 404) throw CoordinatorException.NoSealedLuksKey else throw e
        }
        val sealedBlob = HexUtil.decode(sealedLuks.sealedKey)?.takeIf { it.isNotEmpty() }
            ?: throw CoordinatorException.NoSealedLuksKey

        // Android has no per-server BAK; the installer seals the LUKS key
        // against the phone's IRK pub, so the IRK seed opens it.
        val luksKey = try {
            SecretSeal.openWithEd25519Seed(sealedBlob, material.seed)
        } catch (_: Throwable) {
            throw CoordinatorException.LuksUnsealFailed
        }

        // Re-seal FOR the box's STK, nonce/purpose-bound.
        return HexUtil.encode(
            SealedSecretResponse.build(
                secret = luksKey,
                stkPub = stkPub,
                nonceHex = verified.pending.requestNonceHex,
                purpose = SecretPurpose.UNLOCK_KEY,
            )
        )
    }

    // ---- entitlement ---------------------------------------------------

    /** IRK-sign a root-only RootEntitlement binding (username, podPubKey =
     *  box STK, podCanonical = serverDomain) and serialize it as the
     *  daemon's EntitlementBundle on-disk carrier, hex-encoded. MUST
     *  byte-match parseEntitlementBundle (entitlementBundleStore.ts). */
    private fun buildEntitlementReply(
        verified: VerifiedRequest,
        stkPub: ByteArray,
        material: IrkMaterial,
    ): String {
        val stkPubHex = HexUtil.encode(stkPub)
        val issuedAt = now()
        val sig = RootEntitlement.sign(
            irk = material.signer,
            username = username,
            podPubKeyHex = stkPubHex,
            podCanonical = verified.serverDomain,
            issuedAt = issuedAt,
        )
        val carrier = EntitlementBundleCarrier.serialize(
            username = username,
            podPubKeyHex = stkPubHex,
            podCanonical = verified.serverDomain,
            issuedAt = issuedAt,
            rootEntitlementSigHex = HexUtil.encode(sig),
        )
        return HexUtil.encode(carrier)
    }

    // ---- mailbox auth --------------------------------------------------

    private fun buildMailboxAuth(material: IrkMaterial): MailboxAuthEnvelope {
        val issuedAt = now()
        // No hosted endpoint; "device" is a constant label (the Worker only
        // checks phoneIrkPub == account IRK).
        val endpointLabel = "device"
        val nonceHex = HexUtil.encode(nonceGen())
        // Short-lived — the claim only needs to live for one fetch/post.
        val expiresAt = issuedAt + 120_000
        val sig = DeviceEndpointClaim.sign(
            irk = material.signer,
            username = username,
            endpointLabel = endpointLabel,
            phoneIrkPubHex = material.pubHex,
            issuedAt = issuedAt,
            expiresAt = expiresAt,
            nonceHex = nonceHex,
        )
        return MailboxAuthEnvelope(
            auth = MailboxAuthEnvelope.Auth(
                username = username,
                endpointLabel = endpointLabel,
                phoneIrkPub = material.pubHex,
                issuedAt = issuedAt,
                expiresAt = expiresAt,
                nonce = nonceHex,
            ),
            authSignature = HexUtil.encode(sig),
        )
    }
}
