// Approving a server's start-up from the watch while the phone is locked (option (a),
// docs/watch-boot-approval-without-unlock.md). Beside the watch-delegate signing key this device
// keeps a boot-only X25519 key that never leaves the Keystore. Per server, an owner opt-in deposits
// a copy of the disk key sealed to it (`flagship/watch-boot-delegate/v1`, attested by the account
// key) with the boot worker. A watch Approve then needs no account key: read the server's pending
// start-up from /pods (the read token needs no prompt), fetch this watch's copy, open it with the
// boot-only key, seal it for the box and post the answer signed by the delegate. The boot worker
// refuses both reads and answers with 423 while the server is locked: a locked server is started
// from the phone with the account key.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.api.SecretResponseBody
import com.flagshipserver.app.api.WatchBootDepositWire

/** The boot-only decryption key: its public half, and an X25519 agreement done where the key lives. */
interface BootDecryptKey {
    val publicKey: ByteArray
    fun agree(peerPublicKey: ByteArray): ByteArray
}

/** Where this device keeps the boot-only key and which servers hold a copy for it (until when). */
interface WatchBootKeyStore {
    /** The key, minted on first use. Throws when the secure hardware can't keep one. */
    fun loadOrCreate(): BootDecryptKey
    fun existing(): BootDecryptKey?
    fun copies(): Map<String, Long>
    fun setCopy(serverDomain: String, expiresAt: Long?)
    /** Forget the key and every copy (the delegate was turned off or the device removed). */
    fun clear()
}

/** The owner's per-server opt-in: deposit a copy, or take every copy away. */
class WatchBootOptIn(
    private val mailbox: SecretMailboxClient,
    private val irk: IrkAccess,
    private val store: WatchBootKeyStore,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val nonceGen: () -> ByteArray = { SecretRequestCoordinator.randomNonce() },
) {
    /** Deposit a copy for [delegatePubHex], lasting no longer than the delegate. Returns its end. */
    suspend fun enable(serverDomain: String, delegatePubHex: String, delegateExpiresAt: Long, reason: String): Long {
        val key = store.loadOrCreate()
        val material = irk.resolve(reason)
        val sealed = HexUtil.decode(mailbox.fetchSealedLuksKey(serverDomain).sealedKey)?.takeIf { it.isNotEmpty() }
            ?: throw SecretRequestCoordinator.CoordinatorException.NoSealedLuksKey
        val diskKey = try {
            SecretSeal.openWithEd25519Seed(sealed, material.seed)
        } catch (_: Throwable) {
            throw SecretRequestCoordinator.CoordinatorException.LuksUnsealFailed
        }
        val issuedAt = now()
        // A minute short of the delegate's end, so the worker's "cannot outlast" check holds.
        val expiresAt = minOf(issuedAt + WatchBootDelegate.MAX_MS - 60_000, delegateExpiresAt - 60_000)
        require(expiresAt > issuedAt) { "the watch delegate has expired" }
        val delegatePub = HexUtil.decode(delegatePubHex) ?: error("delegate key")
        val deposit = WatchBootDelegate.build(serverDomain, diskKey, delegatePub, key.publicKey, issuedAt, expiresAt) { material.signer.sign(it) }
        val auth = BootAuth.ownerHeader(serverDomain, "PUT", "/api/boot/watch-key", material.signer, material.pubHex, now(), nonceGen())
        mailbox.putWatchBootKey(WatchBootDepositWire.of(deposit), auth)
        store.setCopy(serverDomain.lowercase(), expiresAt)
        return expiresAt
    }

    /** Take every watch copy for the server away. The local mark goes even if the worker can't be reached. */
    suspend fun disable(serverDomain: String, reason: String) {
        try {
            val material = irk.resolve(reason)
            val path = "/api/boot/watch-key/$serverDomain"
            val auth = BootAuth.ownerHeader(serverDomain, "DELETE", path, material.signer, material.pubHex, now(), nonceGen())
            mailbox.deleteWatchBootKey(serverDomain, auth)
        } finally {
            store.setCopy(serverDomain.lowercase(), null)
        }
    }

    /** Servers with a live copy for this device, and until when. */
    fun live(): Map<String, Long> = store.copies().filterValues { it > now() }
}

/** Answer a start-up from the watch without the account key. */
class WatchBootApprover(
    private val mailbox: SecretMailboxClient,
    private val username: String,
    private val delegate: () -> WatchDelegateSigner?,
    private val store: WatchBootKeyStore,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val nonceGen: () -> ByteArray = { SecretRequestCoordinator.randomNonce() },
) {
    sealed interface Outcome {
        data object Approved : Outcome
        /** The boot worker says the server is locked: only the phone can start it. */
        data object Locked : Outcome
        /** No copy for this watch, or nothing to use it with: try the account-key path. */
        data object NotAvailable : Outcome
        /** The server isn't waiting for a start-up any more. */
        data object NotWaiting : Outcome
        data class Failed(val message: String) : Outcome
    }

    fun available(serverDomain: String): Boolean =
        delegate() != null && store.existing() != null && (store.copies()[serverDomain.lowercase()] ?: 0L) > now()

    suspend fun approve(serverDomain: String, requestId: String?): Outcome {
        val signer = delegate() ?: return Outcome.NotAvailable
        val key = store.existing() ?: return Outcome.NotAvailable
        val pods = mailbox.fetchPods(username)
        val pod = pods.pods.firstOrNull { it.serverDomain.equals(serverDomain, ignoreCase = true) && it.revokedAt == null }
            ?: return Outcome.NotAvailable
        val stkPub = HexUtil.decode(pod.identityPubKey)?.takeIf { it.size == 32 } ?: return Outcome.NotAvailable
        val waiting = pod.pendingRequests.filter { it.type == SecretPurpose.UNLOCK_KEY.wire && (it.expiresAt == 0L || it.expiresAt > now()) }
        val req = (if (requestId != null) waiting.firstOrNull { it.id == requestId } else null)
            ?: waiting.maxByOrNull { it.issuedAt }
            ?: return Outcome.NotWaiting
        val domain = pod.serverDomain
        val deposit = try {
            mailbox.getWatchBootKey(domain, BootAuth.delegateHeader(domain, "GET", "/api/boot/watch-key/$domain", signer.signer, signer.pubHex, now(), nonceGen()))
        } catch (e: HttpException) {
            return when (e.status) {
                423 -> Outcome.Locked
                404, 403 -> {
                    store.setCopy(domain.lowercase(), null)
                    Outcome.NotAvailable
                }
                else -> throw e
            }
        }
        if (!deposit.decryptPubHex.equals(HexUtil.encode(key.publicKey), ignoreCase = true) ||
            !deposit.delegatePubHex.equals(signer.pubHex, ignoreCase = true) ||
            !deposit.serverDomain.equals(domain, ignoreCase = true)
        ) {
            return Outcome.NotAvailable
        }
        val diskKey = WatchBootDelegate.openKeyWith(deposit.toDeposit()) { key.agree(it) } ?: return Outcome.NotAvailable
        val sealed = SealedSecretResponse.build(diskKey, stkPub, req.id, SecretPurpose.UNLOCK_KEY)
        val body = SecretResponseBody(domain, req.id, SecretPurpose.UNLOCK_KEY.wire, HexUtil.encode(sealed), now())
        return try {
            mailbox.postResponse(body, BootAuth.delegateHeader(domain, "POST", "/api/boot/response", signer.signer, signer.pubHex, now(), nonceGen()))
            Outcome.Approved
        } catch (e: HttpException) {
            when (e.status) {
                423 -> Outcome.Locked
                404, 409 -> Outcome.NotWaiting
                else -> throw e
            }
        }
    }
}
