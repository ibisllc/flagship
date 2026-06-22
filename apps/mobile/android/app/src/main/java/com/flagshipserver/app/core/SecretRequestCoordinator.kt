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

import com.flagshipserver.app.api.BoxSealedLeaseWire
import com.flagshipserver.app.api.LeaseRevokeWire
import com.flagshipserver.app.api.MailboxAuthEnvelope
import com.flagshipserver.app.api.PairingDepositBody
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
        class NoPendingRequest(domain: String) :
            CoordinatorException("This box ($domain) isn't waiting for an unlock right now.")
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
    /** Confirm + post the reply. When [depositAutoLease] is true (the
     *  server's chosen mode is "auto"), ALSO deposit a box-sealed lease so
     *  future boots self-unlock without the phone — returns the lease id
     *  (store it per-server for the kill switch). Otherwise returns null. */
    suspend fun confirmAndRespond(
        verified: VerifiedRequest,
        depositAutoLease: Boolean = false,
    ): String? {
        val purpose = verified.purpose
            ?: throw CoordinatorException.PurposeUnsupported(verified.pending.purpose)
        val stkPub = HexUtil.decode(verified.directoryStkPubHex)
            ?.takeIf { it.size == 32 }
            ?: throw CoordinatorException.DirectoryMissingServer(verified.serverDomain)

        val material = irk.resolve("Approve your box's boot secret")

        var unlockKey: ByteArray? = null
        val sealedHex = when (purpose) {
            SecretPurpose.UNLOCK_KEY -> {
                val (hex, key) = buildUnlockReply(verified, stkPub, material)
                unlockKey = key
                hex
            }
            SecretPurpose.ENTITLEMENT -> buildEntitlementReply(verified, stkPub, material)
        }

        val body = SecretResponseBody(
            serverDomain = verified.serverDomain,
            requestNonceHex = verified.pending.requestNonceHex,
            purpose = purpose.wire,
            sealed = sealedHex,
            issuedAt = now(),
        )
        // The sealed reply goes to the dedicated boot worker (where the box
        // polls), owner-IRK-authed via the Flagship-Boot-v1 header.
        val respAuth = BootAuth.ownerHeader(
            serverDomain = verified.serverDomain,
            method = "POST",
            path = "/api/boot/response",
            signer = material.signer,
            pubHex = material.pubHex,
            issuedAt = now(),
            nonce = nonceGen(),
        )
        mailbox.postResponse(body, respAuth)

        // Fold "authorize it to serve" INTO this unlock approval: pre-deposit an
        // owner-IRK-signed entitlement for the box's STK so it comes online with
        // no second tap (consent to boot ⇒ consent to serve). Best-effort — a
        // failure never fails the unlock; the box can still fetch one via relay.
        if (purpose == SecretPurpose.UNLOCK_KEY) {
            try {
                val carrierHex = buildEntitlementReply(verified, stkPub, material)
                val auth = buildMailboxAuth(material)
                mailbox.depositEntitlement(
                    verified.serverDomain,
                    PairingDepositBody(
                        auth = auth.auth,
                        authSignature = auth.authSignature,
                        deposit = PairingDepositBody.Deposit(
                            serverDomain = verified.serverDomain,
                            requestNonceHex = HexUtil.encode(nonceGen()),
                            stkPub = HexUtil.encode(stkPub),
                            sealed = carrierHex,
                            issuedAt = now(),
                        ),
                    ),
                )
            } catch (_: Throwable) {
                // best-effort — the box can still fetch one via the relay
            }
        }

        // "auto" mode: deposit a box-sealed lease (the user's IRK authorizes
        // it here — I2) using the key we just recovered (never .com-visible).
        val key = unlockKey
        if (depositAutoLease && purpose == SecretPurpose.UNLOCK_KEY && key != null) {
            return depositAutoUnlockLease(verified.serverDomain, stkPub, key, material)
        }
        return null
    }

    /** One-tap approval for the directory-driven server card: fetch + verify
     *  the live unlock-key request for [serverDomain] and respond, all under a
     *  SINGLE biometric (the IRK is resolved twice inside fetch + respond, but
     *  the same Keystore-gated derive backs both). No separate "check" step —
     *  the directory's `awaitingUnlock` flag already told the UI a request is
     *  pending. Throws [CoordinatorException.NoPendingRequest] if the box gave
     *  up between the directory refresh and the tap. Mirror of iOS
     *  SecretRequestCoordinator.approvePendingUnlock. */
    suspend fun approvePendingUnlock(
        serverDomain: String,
        depositAutoLease: Boolean = false,
    ): String? {
        val mine = fetchVerifiedRequests()
            .filter {
                it.serverDomain.equals(serverDomain, ignoreCase = true) &&
                    it.purpose == SecretPurpose.UNLOCK_KEY
            }
            .sortedByDescending { it.pending.postedAt }
        val live = mine.firstOrNull { now() <= it.pending.expiresAt }
            ?: throw CoordinatorException.NoPendingRequest(serverDomain)
        return confirmAndRespond(live, depositAutoLease = depositAutoLease)
    }

    /** Kill switch — revoke a server's auto-unlock lease. The box can no
     *  longer self-unlock and falls back to phone-gated approval (downgrade,
     *  not brick). [leaseId] is the one returned by confirmAndRespond. */
    suspend fun revokeAutoUnlockLease(serverDomain: String, leaseId: String) {
        val material = irk.resolve("Require approval to boot this server")
        val issuedAt = now()
        // The boot worker's DELETE carries no body signature — it's
        // authorized by the owner-IRK Flagship-Boot-v1 header bound to the
        // exact path (so it can't replay against another route).
        val auth = BootAuth.ownerHeader(
            serverDomain = serverDomain,
            method = "DELETE",
            path = "/api/boot/lease/$serverDomain/$leaseId",
            signer = material.signer,
            pubHex = material.pubHex,
            issuedAt = issuedAt,
            nonce = nonceGen(),
        )
        mailbox.revokeBoxSealedLease(LeaseRevokeWire(serverDomain, leaseId, issuedAt), auth)
    }

    /** Deposit a long-lived box-sealed lease (LUKS key sealed for the box
     *  STK). Returns the lease id. */
    private suspend fun depositAutoUnlockLease(
        serverDomain: String,
        stkPub: ByteArray,
        luksKey: ByteArray,
        material: IrkMaterial,
    ): String {
        val issuedAt = now()
        val leaseId = AutoUnlockLeaseV2.randomLeaseId()
        val expiresAt = issuedAt + 365L * 24 * 60 * 60 * 1000  // ~1 year; renewed each approve
        val lease = AutoUnlockLeaseV2.build(
            serverDomain = serverDomain,
            stkPub = stkPub,
            leaseId = leaseId,
            luksKey = luksKey,
            issuedAt = issuedAt,
            expiresAt = expiresAt,
        )
        val depositAuth = BootAuth.ownerHeader(
            serverDomain = serverDomain,
            method = "PUT",
            path = "/api/boot/lease",
            signer = material.signer,
            pubHex = material.pubHex,
            issuedAt = now(),
            nonce = nonceGen(),
        )
        mailbox.depositBoxSealedLease(
            BoxSealedLeaseWire(
                serverDomain = lease.serverDomain,
                stkPub = HexUtil.encode(lease.stkPub),
                leaseId = lease.leaseId,
                sealedKey = HexUtil.encode(lease.sealedKey),
                issuedAt = lease.issuedAt,
                expiresAt = lease.expiresAt,
                maxUses = lease.maxUses,
            ),
            HexUtil.encode(lease.sign(material.signer)),
            depositAuth,
        )
        return leaseId
    }

    // ---- unlock-key ----------------------------------------------------

    /** Fetch the phone-sealed LUKS key, unseal it with the phone's IRK
     *  seed (the installer sealed it against the phone IRK pub), then
     *  re-seal it FOR the box's STK bound to (nonce, purpose). */
    private suspend fun buildUnlockReply(
        verified: VerifiedRequest,
        stkPub: ByteArray,
        material: IrkMaterial,
    ): Pair<String, ByteArray> {
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

        // Re-seal FOR the box's STK, nonce/purpose-bound. Hand back the
        // recovered key so an "auto" approval can deposit a box-sealed lease.
        val sealedHex = HexUtil.encode(
            SealedSecretResponse.build(
                secret = luksKey,
                stkPub = stkPub,
                nonceHex = verified.pending.requestNonceHex,
                purpose = SecretPurpose.UNLOCK_KEY,
            )
        )
        return sealedHex to luksKey
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
