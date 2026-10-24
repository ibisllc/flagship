// Approving a server's start-up from the watch while the phone is locked (option (a),
// docs/watch-boot-approval-without-unlock.md). Beside the watch-delegate signing key this device
// keeps a boot-only X25519 key that never leaves the Keystore. Per server, an owner opt-in deposits
// a copy of the disk key sealed to it (`flagship/watch-boot-delegate/v1`, attested by the account
// key) with the boot worker. A watch Approve then needs no account key: learn the server's waiting
// start-up, fetch this watch's copy, open it with the boot-only key, seal it for the PINNED STK
// only (ServerKeyPins.pinnedStk, pinned at the first blessing, never a key `.com` names) and post the answer signed by the
// delegate. The waiting request is read with the account read token and must carry the box's
// signature under that pinned STK. The boot worker
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
    fun copies(): Map<String, WatchBootCopy>
    fun setCopy(serverDomain: String, copy: WatchBootCopy?)
    /** Forget the key and every copy (the delegate was turned off or the device removed). */
    fun clear()
}

/** A copy the boot worker holds for this device, and the server's STK pinned when it was made. */
data class WatchBootCopy(val expiresAt: Long)

/** A start-up the server is waiting on, as the box signed it. [stkPubHex] is what the source says
 *  the box's key is: it must equal the pinned one, and the signature must verify under the pin. */
data class WaitingStartUp(
    val serverDomain: String,
    val nonceHex: String,
    val stkPubHex: String,
    val issuedAt: Long,
    val signatureHex: String,
    val expiresAt: Long,
)

/** Where the watch path learns of a waiting start-up: nothing it says is trusted until verified. */
fun interface StartUpSource {
    suspend fun waiting(serverDomain: String, requestId: String?): WaitingStartUp?
}

/** `.com`'s GET /api/users/:u/secret-requests, read with the account read token (no prompt). */
class ReadTokenStartUpSource(
    private val mailbox: SecretMailboxClient,
    private val username: String,
) : StartUpSource {
    override suspend fun waiting(serverDomain: String, requestId: String?): WaitingStartUp? {
        val mine = mailbox.readSecretRequests(username).requests.filter {
            it.serverDomain.equals(serverDomain, ignoreCase = true) && it.purpose == SecretPurpose.UNLOCK_KEY.wire
        }
        val nonce = requestId?.substringAfterLast('#')
        val r = (if (nonce != null) mine.firstOrNull { it.requestNonceHex.equals(nonce, ignoreCase = true) } else null)
            ?: mine.maxByOrNull { it.issuedAt } ?: return null
        return WaitingStartUp(r.serverDomain, r.requestNonceHex, r.stkPub, r.issuedAt, r.requestSignature, r.expiresAt)
    }
}

/** The owner's per-server opt-in: deposit a copy, or take every copy away. */
class WatchBootOptIn(
    private val mailbox: SecretMailboxClient,
    private val irk: IrkAccess,
    private val store: WatchBootKeyStore,
    private val pins: ServerKeyPins,
    /** The signed-in account: `.com` hands the sealed disk key only to its own devices. */
    private val username: () -> String?,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val nonceGen: () -> ByteArray = { SecretRequestCoordinator.randomNonce() },
) {
    /** Deposit a copy for [delegatePubHex], lasting no longer than the delegate. Returns its end. */
    suspend fun enable(serverDomain: String, delegatePubHex: String, delegateExpiresAt: Long, reason: String): Long {
        // The key is pinned at the server's first blessing (docs/first-contact.md); this only reads it.
        pins.pinnedStk(serverDomain) ?: throw ServerKeyNotPinnedException()
        val key = store.loadOrCreate()
        val material = irk.resolve(reason)
        val user = username() ?: throw IllegalStateException(FSStrings.get(com.flagshipserver.app.R.string.sign_in_to_approve_this_server))
        val sealed = HexUtil.decode(mailbox.fetchSealedLuksKey(serverDomain, user).sealedKey)?.takeIf { it.isNotEmpty() }
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
        store.setCopy(serverDomain.lowercase(), WatchBootCopy(expiresAt))
        return expiresAt
    }

    /** After the delegate was renewed: deposit every live copy again to last as long as it. */
    suspend fun renewAll(delegatePubHex: String, delegateExpiresAt: Long, reason: (String) -> String): Int {
        var n = 0
        for (domain in live().keys) {
            enable(domain, delegatePubHex, delegateExpiresAt, reason(domain))
            n++
        }
        return n
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
    fun live(): Map<String, Long> = store.copies().filterValues { it.expiresAt > now() }.mapValues { it.value.expiresAt }
}

/** Answer a start-up from the watch without the account key. */
class WatchBootApprover(
    private val mailbox: SecretMailboxClient,
    private val delegate: () -> WatchDelegateSigner?,
    private val store: WatchBootKeyStore,
    private val source: StartUpSource,
    private val pins: ServerKeyPins,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val nonceGen: () -> ByteArray = { SecretRequestCoordinator.randomNonce() },
) {
    sealed interface Outcome {
        data object Approved : Outcome
        /** The boot worker says the server is locked: only the phone can start it. */
        data object Locked : Outcome
        /** The key named for the box isn't the one this phone pinned: nothing is sealed. */
        data object KeyMismatch : Outcome
        /** No copy for this watch, or nothing to use it with: try the account-key path. */
        data object NotAvailable : Outcome
        /** The server isn't waiting for a start-up any more. */
        data object NotWaiting : Outcome
        data class Failed(val message: String) : Outcome
    }

    private fun copyFor(serverDomain: String): WatchBootCopy? =
        store.copies()[serverDomain.lowercase()]?.takeIf { it.expiresAt > now() }

    fun available(serverDomain: String): Boolean =
        delegate() != null && store.existing() != null && copyFor(serverDomain) != null

    suspend fun approve(serverDomain: String, requestId: String?): Outcome {
        val signer = delegate() ?: return Outcome.NotAvailable
        val key = store.existing() ?: return Outcome.NotAvailable
        copyFor(serverDomain) ?: return Outcome.NotAvailable
        val stkPub = pins.pinnedStk(serverDomain) ?: return Outcome.NotAvailable
        val pinnedHex = HexUtil.encode(stkPub)
        val req = source.waiting(serverDomain, requestId) ?: return Outcome.NotWaiting
        if (!req.stkPubHex.equals(pinnedHex, ignoreCase = true)) {
            ErrorLog.caught("watch-boot", IllegalStateException("the key named for $serverDomain isn't the pinned one"), "stk-mismatch")
            return Outcome.KeyMismatch
        }
        val sig = HexUtil.decode(req.signatureHex)
        val signed = sig != null && req.serverDomain.equals(serverDomain, ignoreCase = true) && SecretRequest.verify(
            signature = sig,
            stkPub = stkPub,
            serverDomain = req.serverDomain,
            stkPubHex = pinnedHex,
            purpose = SecretPurpose.UNLOCK_KEY,
            nonceHex = req.nonceHex,
            issuedAt = req.issuedAt,
        )
        if (!signed) {
            ErrorLog.caught("watch-boot", IllegalStateException("a start-up for $serverDomain the pinned key didn't sign"), "bad-request-signature")
            return Outcome.KeyMismatch
        }
        if (req.expiresAt <= now()) return Outcome.NotWaiting
        val domain = req.serverDomain
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
        val sealed = SealedSecretResponse.build(diskKey, stkPub, req.nonceHex, SecretPurpose.UNLOCK_KEY)
        val body = SecretResponseBody(domain, req.nonceHex, SecretPurpose.UNLOCK_KEY.wire, HexUtil.encode(sealed), now())
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
