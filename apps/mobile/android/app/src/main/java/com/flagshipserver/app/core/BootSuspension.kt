// Durable boot suspension, the phone's side (SEC-LOCK-001, SEC-DEADMAN-001).
// Kotlin mirror of FlagshipCore/BootSuspension.swift and
// @flagship/protocol bootSuspension.ts; canonical bytes are pinned by the
// shared vectors packages/protocol/test-vectors/boot-suspension/vectors.json.
//
// A lock lives at the boot worker, not on the box: while it says "suspended"
// no auto-unlock lease is released for the server, whoever asks, and the box's
// own key can set it but never clear it. The owner starts every change as a NEW
// epoch (current + 1).

package com.flagshipserver.app.core

import android.content.SharedPreferences
import com.flagshipserver.app.api.BootSuspensionOrderWire
import com.flagshipserver.app.api.BootSuspensionStateWire
import com.flagshipserver.app.api.SecretMailboxClient
import com.google.crypto.tink.subtle.Ed25519Sign

data class BootSuspensionOrder(
    val serverDomain: String,
    val epoch: Long,
    val seq: Long = 0,
    val action: Action,
    val reason: String,
    val signer: String = "owner",
    val issuedAt: Long,
) {
    enum class Action(val wire: String) { SUSPEND("suspend"), RESUME("resume") }

    /** `flagship/boot-suspension/v1|<serverDomain>|<epoch>|<seq>|<action>|<reason>|<signer>|<issuedAt>` */
    fun canonicalBytes(): ByteArray {
        guard("serverDomain", serverDomain)
        guard("reason", reason)
        require(epoch >= 0) { "boot-suspension: bad epoch" }
        require(seq >= 0) { "boot-suspension: bad seq" }
        require(issuedAt >= 0) { "boot-suspension: bad issuedAt" }
        require(signer == "owner" || signer == "box") { "boot-suspension: bad signer" }
        return listOf(CANONICAL_TAG, serverDomain, epoch.toString(), seq.toString(), action.wire, reason, signer, issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun sign(key: Ed25519Sign): ByteArray = key.sign(canonicalBytes())

    fun wire() = BootSuspensionOrderWire(serverDomain, epoch, seq, action.wire, reason, signer, issuedAt)

    private fun guard(name: String, v: String) {
        require(v.isNotEmpty()) { "boot-suspension: empty $name" }
        for (ch in v) require(ch != '|' && ch.code > 0x1f && ch.code != 0x7f) { "boot-suspension: bad character in $name" }
    }

    companion object {
        const val CANONICAL_TAG = "flagship/boot-suspension/v1"
    }
}

/** What a lock or resume came to, in terms a screen can show without overclaiming. */
sealed interface BootLockOutcome {
    /** The boot worker durably recorded it. */
    data class Confirmed(val leasesRevoked: Int, val alreadyInState: Boolean) : BootLockOutcome
    /** NOT recorded. */
    data class Pending(val why: String) : BootLockOutcome
}

/** The phone's memory of locks: what it last confirmed, and locks not yet confirmed. Non-secret. */
class BootLockStateStore(private val prefs: SharedPreferences) {
    fun lastKnownSuspended(server: String): Boolean? =
        if (prefs.contains(key(server))) prefs.getBoolean(key(server), false) else null

    fun setLastKnown(suspended: Boolean, server: String) {
        prefs.edit().putBoolean(key(server), suspended).apply()
    }

    fun pending(): Set<String> = prefs.getStringSet(PENDING, emptySet()) ?: emptySet()

    fun markPending(server: String) {
        prefs.edit().putStringSet(PENDING, pending() + server.lowercase()).apply()
    }

    fun clearPending(server: String) {
        prefs.edit().putStringSet(PENDING, pending() - server.lowercase()).apply()
    }

    private fun key(server: String) = "bootLock.suspended.${server.lowercase()}"

    companion object {
        private const val PENDING = "bootLock.pending"
        const val PREFS = "flagship.bootLock"
        fun from(context: android.content.Context): BootLockStateStore =
            BootLockStateStore(context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE))
    }
}

/** Lock and resume against the boot worker: read the record, sign the next owner epoch, retry when it moved. */
class BootLock(
    private val client: SecretMailboxClient,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val nonce: () -> ByteArray = { SecretRequestCoordinator.randomNonce() },
) {
    suspend fun read(serverDomain: String, signer: Ed25519Sign, pubHex: String): BootSuspensionStateWire? = try {
        client.readBootSuspension(
            serverDomain,
            BootAuth.ownerHeader(serverDomain, "GET", "/api/boot/suspension/$serverDomain", signer, pubHex, now(), nonce()),
        )
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (_: Throwable) {
        null
    }

    suspend fun setOwner(
        serverDomain: String,
        action: BootSuspensionOrder.Action,
        signer: Ed25519Sign,
        pubHex: String,
        reason: String = if (action == BootSuspensionOrder.Action.SUSPEND) "manual-lock" else "owner-resume",
    ): BootLockOutcome {
        var last: BootLockOutcome = BootLockOutcome.Pending("unreachable")
        repeat(3) {
            val cur = read(serverDomain, signer, pubHex) ?: return last
            if (action == BootSuspensionOrder.Action.SUSPEND && cur.suspended) return BootLockOutcome.Confirmed(0, true)
            if (action == BootSuspensionOrder.Action.RESUME && !cur.suspended) return BootLockOutcome.Confirmed(0, true)
            val order = BootSuspensionOrder(serverDomain, cur.epoch + 1, 0, action, reason, "owner", now())
            try {
                val sig = HexUtil.encode(order.sign(signer))
                val auth = BootAuth.ownerHeader(serverDomain, "PUT", "/api/boot/suspension", signer, pubHex, now(), nonce())
                val r = client.putBootSuspension(order.wire(), sig, auth)
                if (r.durable) return BootLockOutcome.Confirmed(r.leasesRevoked, false)
                if (r.status == 409) { last = BootLockOutcome.Pending("moved"); return@repeat }
                return BootLockOutcome.Pending(r.refusal ?: "refused")
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Throwable) {
                last = BootLockOutcome.Pending("unreachable")
            }
        }
        return last
    }

    /** Revoke every lease for the server (the dead-man switch was turned on). */
    suspend fun revokeAllLeases(serverDomain: String, signer: Ed25519Sign, pubHex: String) {
        val auth = BootAuth.ownerHeader(serverDomain, "DELETE", "/api/boot/lease/$serverDomain", signer, pubHex, now(), nonce())
        client.revokeAllBoxSealedLeases(serverDomain, auth)
    }
}

/** A lease never outlives the dead-man affirmation that keeps the switch alive. */
object DeadManLeaseBound {
    /** The lease expiry to use, or null when no lease may be deposited (the switch is on and has no live deadline). */
    fun expiry(requested: Long, enabled: Boolean, deadline: Long?, now: Long): Long? {
        if (!enabled) return requested
        if (deadline == null || deadline <= now) return null
        return minOf(requested, deadline)
    }
}

/** The words for a lock result. Never says "locked" for less than a durable record. */
object LockWords {
    fun describe(lock: BootLockOutcome?, powerSent: Boolean?, mode: PowerMode, executed: PowerMode? = null): String {
        val parts = mutableListOf<String>()
        if (powerSent != null) {
            if (powerSent) {
                val did = executed ?: mode
                var s = if (did == PowerMode.OFF) "The server is powering off" else "The server is restarting"
                if (executed != null && executed != mode) s += " (it shut down instead of restarting because the lock could not be confirmed)"
                parts += s
            } else {
                parts += "The power command didn't reach the server"
            }
        }
        when (lock) {
            is BootLockOutcome.Confirmed -> parts += "locked: it can't unlock itself until you resume it"
            is BootLockOutcome.Pending -> parts += "remote lock pending: it will be retried"
            null -> {}
        }
        return if (parts.isEmpty()) "" else parts.joinToString("; ") + "."
    }
}
