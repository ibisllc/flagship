// Keeps "Approve from watch" alive without asking: while this app session is unlocked (the
// biometric session already open, so signing raises no prompt), a watch delegate with under two
// days left is attested again for seven days with the same key, and every per-server "Start-ups
// with this phone locked" copy is deposited again to last as long. Never a prompt: when signing
// would ask, nothing happens and a delegate that lapses is turned on again by the owner as before.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.WatchDelegateMintRequest
import com.google.crypto.tink.subtle.Ed25519Sign
import java.util.UUID

class WatchDelegateRenewal(
    private val server: FlagshipServerClient,
    private val username: () -> String?,
    /** This device's delegate key, or null when Approve from watch is off here. */
    private val delegatePubHex: () -> String?,
    private val saveGrantId: (String) -> Unit,
    /** The sensitive-order key, only when signing raises no prompt; null otherwise. */
    private val silentSigner: suspend () -> Ed25519Sign?,
    /** Deposits the per-server copies again (null: none on this device). */
    private val copies: WatchBootOptIn? = null,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val grantIdGen: () -> String = { UUID.randomUUID().toString() },
) {
    sealed interface Outcome {
        data object NotDue : Outcome
        data object NeedsUnlock : Outcome
        data class Renewed(val expiresAt: Long, val copies: Int) : Outcome
    }

    suspend fun renewIfDue(): Outcome {
        val user = username()?.takeIf { it.isNotEmpty() } ?: return Outcome.NotDue
        val pub = delegatePubHex() ?: return Outcome.NotDue
        val active = server.listWatchDelegates(user).delegates
            .firstOrNull { it.delegatePubKey.equals(pub, ignoreCase = true) && it.expiresAt > now() }
            ?: return Outcome.NotDue
        if (active.expiresAt - now() >= RENEW_WITHIN_MS) return Outcome.NotDue
        val signer = silentSigner() ?: return Outcome.NeedsUnlock
        val issuedAt = now()
        val expiresAt = issuedAt + TTL_MS
        val grantId = grantIdGen()
        val scopes = listOf(WatchDelegateKey.BOOT_APPROVAL_SCOPE)
        val sig = WatchDelegateKey.sign(signer, grantId, user, pub, scopes, issuedAt, expiresAt)
        val res = server.mintWatchDelegate(
            user,
            WatchDelegateMintRequest(
                WatchDelegateMintRequest.Grant(grantId, user, pub, scopes, issuedAt, expiresAt),
                HexUtil.encode(sig),
            ),
        )
        saveGrantId(res.grantId)
        val n = copies?.let { c ->
            runCatching { c.renewAll(pub, res.expiresAt) { d -> FSStrings.get(R.string.watch_boot_enable_reason, d) } }
                .onFailure { ErrorLog.caught("watch-boot-renew", it, NetworkErrorHumanizer.errorCode(it)) }
                .getOrDefault(0)
        } ?: 0
        return Outcome.Renewed(res.expiresAt, n)
    }

    companion object {
        const val TTL_MS = 7L * 24 * 3_600_000
        const val RENEW_WITHIN_MS = 2L * 24 * 3_600_000
    }
}
