// Drives the phone's half of the boot-secret RELAY handshake
// (docs/security-phone-as-unlock-endpoint.md). Kotlin mirror of
// FlagshipCore/SecretRequestCoordinator.swift.
//
//   1. fetchRequests — builds an IRK-signed DeviceEndpointClaim
//      mailbox-auth credential, POSTs /api/secret-requests, then judges
//      every returned request against the key THIS device pinned for the
//      server (docs/first-contact.md, FirstContact). `.com` is NOT a trust
//      anchor: a request naming another key than the pin is refused and
//      shown ("This server's key changed"); one whose signature fails is
//      DROPPED. A server with no pin yet is a first sight: the request must
//      verify under the key it names, a server this device created must
//      carry its enrollment proof, and the owner sees the six-digit code
//      computed here from that key before Approve pins it.
//   2. confirmAndRespond — for the verified request the user taps "yes,
//      this is my box" (the device-info backstop). By purpose:
//        - unlock-key:  GET the phone-sealed LUKS key, unseal it with the
//                       phone's IRK seed, re-seal it FOR the box's boot key (STK on an older box)
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

import com.flagshipserver.app.R
import com.flagshipserver.app.api.BoxSealedLeaseWire
import com.flagshipserver.app.api.LeaseRevokeWire
import com.flagshipserver.app.api.MailboxAuthEnvelope
import com.flagshipserver.app.api.PairingDepositBody
import com.flagshipserver.app.api.PendingSecretRequest
import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.api.SecretResponseBody
import com.flagshipserver.app.api.DeviceInfoHint
import com.google.crypto.tink.subtle.Ed25519Sign
import com.flagshipserver.app.core.pq.BootUnlockV2

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

/** The watch-delegate key (docs/watch-delegate-key-design.md): a separate,
 *  boot-approval-only key the IRK attested when the owner turned on "Quick
 *  approve from watch". The boot worker honours its signature on the boot
 *  response alone. */
class WatchDelegateSigner(val signer: Ed25519Sign, val pubHex: String)

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
    /**
     * Slice D — resolves the ADMIN MASTER ROOT signer for the SENSITIVE orders
     * this boot-approval ceremony mints (the RootEntitlement + the box-sealed
     * auto-unlock lease), or null when this device holds no admin root (legacy /
     * non-admin). Injected from the keystore-aware UI layer so `core` stays free
     * of a Keystore dependency (like [irk]). Null (the test/legacy default) keeps
     * every order IRK-signed. The mailbox-auth + boot-auth transport envelopes
     * ALWAYS stay IRK-signed regardless — only the ORDER signing key changes, and
     * the box gate resolves the signer by trial (`authorizeSensitiveOrder`), so a
     * reburned admin-pinned box accepts the admin-root RootEntitlement it demands.
     */
    private val adminSigner: (suspend (reason: String) -> Ed25519Sign?)? = null,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val nonceGen: () -> ByteArray = { randomNonce() },
    /**
     * The watch-delegate key, for an approval the owner gave on the watch.
     * When it returns a key, a plain UNLOCK approval signs the boot response
     * as role "delegate" and folds in no entitlement (that is an owner order
     * the delegate can't sign). Null (the default) keeps every approval
     * owner-signed. Mirror of iOS `watchDelegateKeyProvider`.
     */
    private val watchDelegate: () -> WatchDelegateSigner? = { null },
    /** First contact: the pins, the enrollment secrets this device keeps, Studio's report. */
    private val firstContact: FirstContact = FirstContact(),
    /** Leases the worker could not take yet, kept for [retryPendingLeases]. */
    private val pendingLeases: PendingLeases? = null,
    /** Pauses before the 2nd and 3rd try of a lease deposit that failed in passing. */
    private val leaseRetryDelaysMs: List<Long> = listOf(1_000L, 3_000L),
    /** The server's serving policy as this phone last knew it. Under one that locks, a lease never outlives its deadline. */
    private val servingLockBound: (serverDomain: String) -> ServingLockBound? = { null },
    /** What this phone last confirmed about the server's lock: true = locked, null = never confirmed. */
    private val lockedServer: (serverDomain: String) -> Boolean? = { null },
    /** The box keys this phone pinned; a reply is never sealed to another. */
    private val pins: BoxKeyPins = BoxKeyPins.shared,
    /** Boot unlock v2: the account key's hybrid half on this phone (null when it holds none). */
    private val ownerPq: suspend (IrkMaterial) -> OwnerPqSigner? = { null },
    /** Whether the server's policy (as this phone replays it) is strict. */
    private val strictFor: (String) -> Boolean = { false },
) {
    /** The owner key's hybrid public key and a signer for it. */
    class OwnerPqSigner(val publicKey: ByteArray, val sign: BootUnlockV2.OwnerSigner)
    /** A serving policy's lock for one server, as [ServingLockLeaseBound] needs it. */
    data class ServingLockBound(val locks: Boolean, val until: Long?)

    sealed class CoordinatorException(message: String) : Exception(message) {
        object NoSealedLuksKey :
            CoordinatorException(FSStrings.get(R.string.no_sealed_disk_key_is_on))
        object LuksUnsealFailed :
            CoordinatorException(FSStrings.get(R.string.couldnt_unseal_the_disk_key_with))
        class DirectoryMissingServer(domain: String) :
            CoordinatorException("This server ($domain) isn't registered to your account.")
        class PurposeUnsupported(purpose: String) :
            CoordinatorException(FSStrings.get(R.string.unsupported_secret_request_type, purpose))
        class NoPendingRequest(domain: String) :
            CoordinatorException("This server ($domain) isn't waiting for an unlock right now.")
        /** First contact refused: no pin, no blessing. */
        class Refused(val reason: FirstContactRefusal) : CoordinatorException(reason.message())
        /** A first sight: the owner has to see [look]'s code (or Studio's confirmation) and approve that key. */
        class FirstLookRequired(val look: FirstLook) :
            CoordinatorException(FSStrings.get(R.string.server_code_check_first))
        /** Boot unlock v2 refused under strict ([BootUnlockV2] codes). */
        class QuantumSafe(val code: String) : CoordinatorException(
            if (code == "phone-cannot-sign-hybrid") {
                FSStrings.get(R.string.quantum_safe_approve_on_device_with_pq_key)
            } else {
                FSStrings.get(R.string.quantum_safe_no_unlock_key_published)
            },
        )
    }

    /** A request judged against the pin, ready to show the owner. [refusal]
     *  set: shown with its sentence and never answered. [firstLook] set: no
     *  pin yet, the code box sits above Approve. */
    data class VerifiedRequest(
        val pending: PendingSecretRequest,
        /** The server's STK the request is under: the pin, or on a first sight the key the box named. */
        val stkPubHex: String,
        val firstLook: FirstLook? = null,
        /** Approving pins [firstLook]'s key (false: an unlock whose proof comes with the entitlement request). */
        val pinOnApprove: Boolean = false,
        val refusal: FirstContactRefusal? = null,
        /** The key the reply is sealed to: the STK, or the boot key that STK bound (the key that signed). */
        val recipientPubHex: String = stkPubHex,
        /** Boot unlock v2: the box's verified material and this request's per-boot reply key. */
        val pqMaterial: BootUnlockV2.Material? = null,
        val replyKemPub: ByteArray? = null,
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
     *  judge each against this device's pin (FirstContact). Returned: the
     *  ones to answer (pinned, or a first sight with its [FirstLook]) and the
     *  refused ones with their sentence. A request whose signature fails is
     *  SILENTLY dropped. */
    suspend fun fetchRequests(): List<VerifiedRequest> {
        val material = irk.resolve(FSStrings.get(R.string.check_for_servers_waiting_for_approval))
        val auth = buildMailboxAuth(material)
        val pendingResp = mailbox.fetchPendingRequests(auth)
        val listed = HashMap<String, String?>()

        val out = mutableListOf<VerifiedRequest>()
        for (pending in pendingResp.requests) {
            val purpose = SecretPurpose.fromWire(pending.purpose) ?: continue
            // The request names the server's STK, or (a disk unlock from a box whose disk is still
            // shut) is signed by the boot key that STK vouches for: the pinned STK, or before a pin
            // the listed one, whose code the owner then checks before Approve pins it.
            val echo = pending.stkPub.lowercase()
            val signerHex = echo
            val signerPub = HexUtil.decode(echo)?.takeIf { it.size == 32 } ?: continue
            var namedStk = echo
            var keyRefused = false
            val pin = pins.pinned(username, pending.serverDomain)
            if (purpose == SecretPurpose.UNLOCK_KEY && echo != pin) {
                val anchor = pin ?: listed.getOrPut(pending.serverDomain.lowercase()) {
                    BootKey.listedStk(mailbox, username, pending.serverDomain)
                }
                if (anchor != null && anchor != echo) {
                    val boot = try {
                        if (pin != null) {
                            BootKey.bootKeyFor(username, pending.serverDomain, mailbox::fetchBootKeyBinding, pins, mailbox::fetchPqKeyBinding)
                        } else {
                            BootKey.sharedBootKeyFor(pending.serverDomain, anchor, mailbox::fetchBootKeyBinding)
                        }
                    } catch (_: BoxKeyChangedException) {
                        // A changed ML-DSA key is a key change: shown refused, nothing sent.
                        keyRefused = true
                        null
                    }
                    if (boot != null && boot == echo) namedStk = anchor
                }
            }
            val sig = HexUtil.decode(pending.requestSignature) ?: continue
            val verdict = firstContact.judge(
                serverDomain = pending.serverDomain,
                namedStkHex = namedStk,
                purpose = purpose,
                // Under the key that signed: the named STK, or the boot key it vouches for.
                verifySignature = { key, keyHex ->
                    val bootSigned = signerHex != keyHex.lowercase()
                    SecretRequest.verify(
                        signature = sig,
                        stkPub = if (bootSigned) signerPub else key,
                        serverDomain = pending.serverDomain,
                        stkPubHex = if (bootSigned) signerHex else keyHex,
                        purpose = purpose,
                        nonceHex = pending.requestNonceHex,
                        issuedAt = pending.issuedAt,
                    )
                },
                enrollmentProof = pending.deviceInfo?.enrollmentProof,
            )
            val signed = signerHex
            val refused = { stk: String, reason: FirstContactRefusal ->
                ErrorLog.caught("first-contact", IllegalStateException("refused a request from ${pending.serverDomain}: $reason"), reason.name.lowercase())
                out += VerifiedRequest(pending, stk, refusal = reason, recipientPubHex = signed)
            }
            when (verdict) {
                is FirstContact.Verdict.Pinned ->
                    if (keyRefused) {
                        refused(verdict.stkPubHex, FirstContactRefusal.KEY_CHANGED)
                    } else {
                        val (m, kem) = v2For(pending, verdict.stkPubHex, signed)
                        out += VerifiedRequest(pending, verdict.stkPubHex, recipientPubHex = signed, pqMaterial = m, replyKemPub = kem)
                    }
                is FirstContact.Verdict.FirstSight ->
                    out += VerifiedRequest(pending, verdict.look.stkPubHex, verdict.look, verdict.pinOnApprove, recipientPubHex = signed)
                is FirstContact.Verdict.Refused -> refused(verdict.stkPubHex, verdict.reason)
                FirstContact.Verdict.Invalid -> Unit
            }
        }
        return out
    }

    /** Only the requests signed by the key this device pinned (no first sight, no refusal):
     *  what a path that can't show the code box (the watch) may answer. */
    suspend fun fetchVerifiedRequests(): List<VerifiedRequest> =
        fetchRequests().filter { it.refusal == null && it.firstLook == null }

    /** Boot unlock v2: the box's hybrid material through the pinned STK, then the request's hybrid
     *  signature under the boot key's hybrid key. Anything that fails leaves v1. */
    private suspend fun v2For(pending: PendingSecretRequest, stkHex: String, signerHex: String): Pair<BootUnlockV2.Material?, ByteArray?> {
        if (signerHex == stkHex.lowercase() || pending.pq == null) return null to null
        val m = BootKey.v2Material(username, pending.serverDomain, signerHex, mailbox::fetchBootKeyBinding, pins, now())
            ?: return null to null
        val kem = try {
            BootUnlockV2.verifyRequest(pending.serverDomain, signerHex, pending.purpose, pending.requestNonceHex, pending.issuedAt, pending.pq, m)
        } catch (_: BootUnlockV2.Failure) {
            null
        }
        return if (kem != null) m to kem else null to null
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
        // A security notice has this app locked until it is updated: no approval is signed, except
        // the one that lets the owner's own server start.
        if (purpose != SecretPurpose.UNLOCK_KEY) UpdateLock.requireUnlocked()
        verified.refusal?.let { throw CoordinatorException.Refused(it) }
        val stkPub = HexUtil.decode(verified.stkPubHex)
            ?.takeIf { it.size == 32 }
            ?: throw CoordinatorException.DirectoryMissingServer(verified.serverDomain)
        // Before any prompt: a key other than the one this phone pinned gets nothing. A first sight
        // is pinned below, once the owner has approved its code. fetchRequests names a recipient
        // other than the STK only after that STK's binding vouched for it; the disk key and the
        // lease go there, the entitlement to the STK.
        if (verified.firstLook == null) pins.require(username, verified.serverDomain, verified.stkPubHex)

        val material = irk.resolve(FSStrings.get(R.string.approve_your_servers_boot_secret))
        // A strict server needs the owner key's hybrid signature, so the watch's quick approve
        // does not apply to it.
        val strict = strictFor(verified.serverDomain)
        // First blessing: the owner saw the code for this very key. Pin it before anything is sealed.
        val pinnedNow = verified.firstLook != null && verified.pinOnApprove
        if (pinnedNow) firstContact.pin(verified.firstLook!!)
        // A server this device created and has not pinned yet: its unlock goes to the key the box
        // named and signed with, as first contact decides; its entitlement request pins it later.
        val awaitingProof = verified.firstLook != null && !verified.pinOnApprove
        var recipientHex = verified.recipientPubHex.lowercase()
        var pqMaterial = verified.pqMaterial
        var replyKem = verified.replyKemPub
        if (pinnedNow) {
            pins.require(username, verified.serverDomain, verified.stkPubHex)
            if (recipientHex != verified.stkPubHex.lowercase()) {
                // Signed by a boot key: adopt it now through the STK just pinned.
                val boot = BootKey.bootKeyFor(username, verified.serverDomain, mailbox::fetchBootKeyBinding, pins, mailbox::fetchPqKeyBinding)
                if (boot != recipientHex) throw CoordinatorException.Refused(FirstContactRefusal.KEY_CHANGED)
                val (m, kem) = v2For(verified.pending, verified.stkPubHex.lowercase(), recipientHex)
                pqMaterial = m
                replyKem = kem
            }
        }
        val diskKeyRecipient = if (recipientHex != verified.stkPubHex.lowercase()) {
            HexUtil.decode(recipientHex)?.takeIf { it.size == 32 }
                ?: throw CoordinatorException.DirectoryMissingServer(verified.serverDomain)
        } else stkPub
        val reply = verified.copy(recipientPubHex = recipientHex, pqMaterial = pqMaterial, replyKemPub = replyKem)
        val delegate: WatchDelegateSigner? =
            if (purpose == SecretPurpose.UNLOCK_KEY && !depositAutoLease && !strict) watchDelegate() else null
        // Slice D — resolve the admin master root ONCE for this ceremony (silent
        // within the biometric-freshness window opened by irk.resolve above). The
        // RootEntitlement + auto-unlock lease are SENSITIVE orders that sign with
        // it; null ⇒ this device is non-admin/legacy ⇒ they stay IRK-signed. A
        // watch-delegate approval mints neither, so it never asks for it.
        val orderKey: Ed25519Sign? =
            if (delegate == null) adminSigner?.invoke(FSStrings.get(R.string.authorize_your_server_to_serve)) else null

        var unlockKey: ByteArray? = null
        val sealedHex = when (purpose) {
            SecretPurpose.UNLOCK_KEY -> {
                val (hex, key) = buildUnlockReply(reply, diskKeyRecipient, material, strict)
                unlockKey = key
                hex
            }
            SecretPurpose.ENTITLEMENT -> buildEntitlementReply(verified, stkPub, material, orderKey)
        }

        val body = SecretResponseBody(
            serverDomain = verified.serverDomain,
            requestNonceHex = verified.pending.requestNonceHex,
            purpose = purpose.wire,
            sealed = sealedHex,
            issuedAt = now(),
        )
        // The sealed reply goes to the dedicated boot worker (where the box
        // polls), authed via the Flagship-Boot-v1 header: delegate-signed for
        // a watch approval, owner-IRK-signed otherwise.
        val respAuth = if (delegate != null) {
            BootAuth.delegateHeader(
                serverDomain = verified.serverDomain,
                method = "POST",
                path = "/api/boot/response",
                signer = delegate.signer,
                pubHex = delegate.pubHex,
                issuedAt = now(),
                nonce = nonceGen(),
            )
        } else {
            BootAuth.ownerHeader(
                serverDomain = verified.serverDomain,
                method = "POST",
                path = "/api/boot/response",
                signer = material.signer,
                pubHex = material.pubHex,
                issuedAt = now(),
                nonce = nonceGen(),
            )
        }
        mailbox.postResponse(body, respAuth)

        // Fold "authorize it to serve" INTO this unlock approval: pre-deposit an
        // owner-IRK-signed entitlement for the box's STK so it comes online with
        // no second tap (consent to boot ⇒ consent to serve). Best-effort — a
        // failure never fails the unlock; the box can still fetch one via relay.
        // A server this device created and has not pinned yet gets no entitlement here: it asks
        // for one with its enrollment proof, and that request pins it.
        if (purpose == SecretPurpose.UNLOCK_KEY && delegate == null && !awaitingProof) {
            try {
                val carrierHex = buildEntitlementReply(verified, stkPub, material, orderKey)
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

        // The app-name certificate grant, in the same biometric session as the first blessing,
        // over the PINNED key. Sent when the box can be reached; kept to send again otherwise.
        if (pinnedNow && delegate == null) sendWildcardGrant(verified.serverDomain, orderKey ?: material.signer)

        // "auto" mode: deposit a box-sealed lease (the user's IRK authorizes
        // it here — I2) using the key we just recovered (never .com-visible).
        val key = unlockKey
        if (depositAutoLease && purpose == SecretPurpose.UNLOCK_KEY && key != null) {
            return depositAutoUnlockLease(verified.serverDomain, diskKeyRecipient, key, material, reply.pqMaterial, strict)
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
        /** The key whose code the owner was shown (a first sight); null when nothing was shown yet. */
        acceptFirstSightKey: String? = null,
    ): String? {
        val live = livePending(serverDomain, SecretPurpose.UNLOCK_KEY, acceptFirstSightKey)
        return confirmAndRespond(live, depositAutoLease = depositAutoLease)
    }

    /** The live request of [purpose] for [serverDomain]. A refusal throws its sentence; a first
     *  sight whose key the owner hasn't been shown throws [CoordinatorException.FirstLookRequired]. */
    private suspend fun livePending(serverDomain: String, purpose: SecretPurpose, acceptFirstSightKey: String?): VerifiedRequest {
        val live = fetchRequests()
            .filter { it.serverDomain.equals(serverDomain, ignoreCase = true) && it.purpose == purpose }
            .sortedByDescending { it.pending.postedAt }
            .firstOrNull { now() <= it.pending.expiresAt }
            ?: throw CoordinatorException.NoPendingRequest(serverDomain)
        live.refusal?.let { throw CoordinatorException.Refused(it) }
        val look = live.firstLook
        if (look != null && !look.stkPubHex.equals(acceptFirstSightKey, ignoreCase = true)) {
            throw CoordinatorException.FirstLookRequired(look)
        }
        return live
    }

    private suspend fun sendWildcardGrant(serverDomain: String, signer: Ed25519Sign) {
        val pin = firstContact.pinnedHex(serverDomain) ?: return
        val grant = WildcardGrants.sign(username, serverDomain, pin, now(), signer) ?: return
        WildcardGrants.outbox.put(serverDomain, grant)
        val taken = try {
            WildcardGrants.deliver(serverDomain, grant.issuedAt, grant.signatureHex)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            false
        }
        if (taken) WildcardGrants.outbox.remove(serverDomain)
    }

    /** One-tap approval for the directory-driven ENTITLEMENT card — the Box
     *  Request Inbox's serve-authorization lane (docs/box-request-inbox.md).
     *  Detected by the pod's cheap `awaitingEntitlement` flag (no biometric);
     *  fetch + re-verify the live `entitlement` request and respond (mint the
     *  owner-IRK RootEntitlement carrier) under ONE biometric. No lease.
     *  Mirror of iOS SecretRequestCoordinator.approvePendingEntitlement. */
    suspend fun approvePendingEntitlement(serverDomain: String, acceptFirstSightKey: String? = null): String? {
        val live = livePending(serverDomain, SecretPurpose.ENTITLEMENT, acceptFirstSightKey)
        return confirmAndRespond(live, depositAutoLease = false)
    }

    /** Kill switch — revoke a server's auto-unlock lease. The server can no
     *  longer self-unlock and falls back to phone-gated approval (downgrade,
     *  not brick). [leaseId] is the one returned by confirmAndRespond. */
    suspend fun revokeAutoUnlockLease(serverDomain: String, leaseId: String) {
        val material = irk.resolve(FSStrings.get(R.string.require_approval_to_boot_this_server))
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

    /** Deposit a long-lived box-sealed lease (LUKS key sealed for the box's boot key, or the
     *  STK). Returns the lease id, or null when the worker did not take it.
     *
     *  The lease body is signed by the owner IRK, the same key as the
     *  Authorization header: the boot worker verifies the body against the IRK
     *  it read from that header (handleDepositLease) and answers 403 "invalid
     *  lease signature" for any other key, the admin root included. (An
     *  admin-root signature here meant no lease was ever stored and every
     *  restart asked the phone again.) A failed deposit never fails the
     *  approval, which has already been answered: it is logged, and one that
     *  failed in passing is kept to send again ([retryPendingLeases]). */
    private suspend fun depositAutoUnlockLease(
        serverDomain: String,
        stkPub: ByteArray,
        luksKey: ByteArray,
        material: IrkMaterial,
        pqMaterial: BootUnlockV2.Material? = null,
        strict: Boolean = false,
    ): String? {
        val issuedAt = now()
        // A locked server takes no new lease: only an explicit, signed resume re-arms auto-unlock.
        if (lockedServer(serverDomain) == true) return null
        // Under a serving policy that locks the server, a lease may not outlive the deadline
        // (SEC-DEADMAN-001); with no live deadline, no lease at all.
        val dm = servingLockBound(serverDomain)
        val expiresAt = ServingLockLeaseBound.expiry(
            requested = issuedAt + 365L * 24 * 60 * 60 * 1000,  // ~1 year; renewed each approve
            locks = dm?.locks ?: false,
            until = dm?.until,
            now = issuedAt,
        ) ?: return null
        val leaseId = AutoUnlockLeaseV2.randomLeaseId()
        // Boot unlock v2: a v3 lease is sealed to the box's lease key and signed hybrid inside;
        // the worker still checks the classical outer signature.
        val owner = if (pqMaterial != null) ownerPq(material) else null
        val leaseVersion = try {
            BootUnlockV2.chooseLeaseVersion(strict, pqMaterial != null, owner != null)
        } catch (e: BootUnlockV2.Failure) {
            throw CoordinatorException.QuantumSafe(e.code)
        }
        var lease = AutoUnlockLeaseV2.build(
            serverDomain = serverDomain,
            stkPub = stkPub,
            leaseId = leaseId,
            luksKey = luksKey,
            issuedAt = issuedAt,
            expiresAt = expiresAt,
        )
        if (leaseVersion == 3 && pqMaterial != null && owner != null) {
            lease = lease.copy(
                sealedKey = BootUnlockV2.sealLease(
                    serverDomain, HexUtil.encode(stkPub), leaseId, issuedAt, expiresAt,
                    leaseKemPublicKey = pqMaterial.leaseKemPublicKey, diskKey = luksKey,
                    ownerHybridPublicKey = owner.publicKey, sign = owner.sign,
                ),
            )
        }
        val wire = BoxSealedLeaseWire(
            serverDomain = lease.serverDomain,
            stkPub = HexUtil.encode(lease.stkPub),
            leaseId = lease.leaseId,
            sealedKey = HexUtil.encode(lease.sealedKey),
            issuedAt = lease.issuedAt,
            expiresAt = lease.expiresAt,
            maxUses = lease.maxUses,
        )
        val signatureHex = HexUtil.encode(lease.sign(material.signer))
        var attempt = 0
        while (true) {
            try {
                putLease(wire, signatureHex, material)
                pendingLeases?.clear(serverDomain)
                return leaseId
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (t: Throwable) {
                if (isPassing(t) && attempt < leaseRetryDelaysMs.size) {
                    kotlinx.coroutines.delay(leaseRetryDelaysMs[attempt])
                    attempt++
                    continue
                }
                ErrorLog.caught("lease", t, NetworkErrorHumanizer.errorCode(t))
                if (isPassing(t)) pendingLeases?.put(serverDomain, PendingLease(wire, signatureHex))
                return null
            }
        }
    }

    private suspend fun putLease(wire: BoxSealedLeaseWire, signatureHex: String, material: IrkMaterial) {
        val depositAuth = BootAuth.ownerHeader(
            serverDomain = wire.serverDomain,
            method = "PUT",
            path = "/api/boot/lease",
            signer = material.signer,
            pubHex = material.pubHex,
            issuedAt = now(),
            nonce = nonceGen(),
        )
        mailbox.depositBoxSealedLease(wire, signatureHex, depositAuth)
    }

    /** No connection, a timeout or a 5xx: worth sending again. A refusal (4xx) is not. */
    private fun isPassing(t: Throwable): Boolean = when {
        t is HttpException -> t.status >= 500 || t.status == 429 || t.status == 408
        else -> t is java.io.IOException
    }

    /**
     * Send again the leases the worker could not take earlier. Returns
     * (server, lease id) for each one it took, so the caller can keep the id
     * for the kill switch. A lease past its expiry is dropped; a refusal drops
     * it too (it would be refused again); a passing failure keeps it.
     */
    suspend fun retryPendingLeases(): List<Pair<String, String>> {
        val store = pendingLeases ?: return emptyList()
        val waiting = store.all()
        if (waiting.isEmpty()) return emptyList()
        val material = irk.resolve(FSStrings.get(R.string.finish_setting_up_automatic_unlock))
        val done = mutableListOf<Pair<String, String>>()
        for ((server, p) in waiting) {
            if (p.lease.expiresAt <= now()) {
                store.clear(server)
                continue
            }
            // A lease built before a lock, or past a locking serving deadline, must not be sent now.
            val dm = servingLockBound(server)
            if (lockedServer(server) == true || (dm?.locks == true && p.lease.expiresAt > (dm.until ?: 0L))) {
                store.clear(server)
                continue
            }
            try {
                putLease(p.lease, p.signatureHex, material)
                store.clear(server)
                done += server to p.lease.leaseId
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (t: Throwable) {
                ErrorLog.caught("lease-retry", t, NetworkErrorHumanizer.errorCode(t))
                if (!isPassing(t)) store.clear(server)
            }
        }
        return done
    }

    // ---- unlock-key ----------------------------------------------------

    /** Fetch the phone-sealed LUKS key, unseal it with the phone's IRK
     *  seed (the installer sealed it against the phone IRK pub), then
     *  re-seal it FOR the request's signer (boot key or STK) bound to (nonce, purpose). */
    private suspend fun buildUnlockReply(
        verified: VerifiedRequest,
        stkPub: ByteArray,
        material: IrkMaterial,
        strict: Boolean = false,
    ): Pair<String, ByteArray> {
        val sealedLuks = try {
            mailbox.fetchSealedLuksKey(verified.serverDomain, username)
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

        // Boot unlock v2 (pq-suites.md §19): the box's policy, not the request, decides whether a
        // classical reply is still allowed.
        val owner = if (verified.pqMaterial != null) ownerPq(material) else null
        val version = try {
            BootUnlockV2.chooseReplyVersion(strict, verified.pqMaterial != null, verified.replyKemPub != null, owner != null)
        } catch (e: BootUnlockV2.Failure) {
            throw CoordinatorException.QuantumSafe(e.code)
        }
        val reply = verified.replyKemPub
        if (version == 2 && owner != null && reply != null) {
            val sealed = BootUnlockV2.buildReply(
                verified.serverDomain, HexUtil.encode(stkPub), verified.pending.requestNonceHex, reply, luksKey,
                owner.publicKey, now(), owner.sign,
            )
            return HexUtil.encode(sealed) to luksKey
        }
        // Re-seal FOR the boot key or STK, nonce/purpose-bound. Hand back the
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
        // Slice D — issuing a RootEntitlement ("authorize this box under my
        // account") is SENSITIVE and the owner decision is ADMIN-ROOT: a reburned
        // admin-pinned box REJECTS an IRK-signed RootEntitlement at HELLO
        // (entitlementRelay.ts gates on the admin root). Sign with the admin
        // master root when this device holds one, else the IRK (legacy). Only the
        // signing key changes — the carrier bytes are byte-identical.
        orderKey: Ed25519Sign? = null,
    ): String {
        val stkPubHex = HexUtil.encode(stkPub)
        val issuedAt = now()
        val sig = RootEntitlement.sign(
            irk = orderKey ?: material.signer,
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
