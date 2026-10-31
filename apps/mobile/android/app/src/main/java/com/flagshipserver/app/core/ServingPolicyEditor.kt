// The dead-man editor on the server page (issuance-and-lease-records.md section 5): how long the
// server keeps serving its apps when no admin opens Flagship, and what happens then. Saving signs a
// new `serving-policy/v1` with the admin root (opened by the biometric that opened the editor), one
// generation above the current one, posts it to `.com` and the box, and under a time limit signs
// the first lease at once. Mirror of iOS ServingPolicyEditor.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.api.BoxServingPost
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.api.ServingPolicyPost
import com.flagshipserver.app.api.ServingView
import com.google.crypto.tink.subtle.Ed25519Sign

class ServingPolicyEditor(
    val current: ServingView,
    username: String,
    private val serverDomain: String,
    boxPub: String,
    private val adminRoot: Ed25519Sign,
    private val mailbox: SecretMailboxClient,
    private val box: ScreensClient?,
    private val renewer: ServingRenewer,
    /** Drops the server's auto-unlock leases before a policy that locks it is set (SEC-DEADMAN-001); null skips. */
    private val revokeAutoUnlock: (suspend () -> Unit)? = null,
    private val record: (serverDomain: String, onLapse: ServingOnLapse, grace: ServingGrace, until: Long?) -> Unit = { _, _, _, _ -> },
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val username = username.lowercase()
    private val boxPub = boxPub.lowercase()

    var grace: ServingGrace = current.graceValue
        private set
    var onLapse: ServingOnLapse = if (current.graceValue == ServingGrace.INDEFINITE) ServingOnLapse.STOP_APPS else current.onLapseValue

    /** Locking needs a time limit: "Never" greys the second choice out. */
    val canLock: Boolean get() = grace != ServingGrace.INDEFINITE
    val changed: Boolean get() = grace != current.graceValue || onLapse != current.onLapseValue

    fun setGrace(g: ServingGrace) {
        grace = g
        if (g == ServingGrace.INDEFINITE) onLapse = ServingOnLapse.STOP_APPS
    }

    sealed interface Result {
        data object Saved : Result
        data class Failed(val message: String) : Result
    }

    suspend fun save(): Result {
        val lapse = if (canLock) onLapse else ServingOnLapse.STOP_APPS
        val policy = ServingPolicy(
            account = username, box = boxPub, regGen = current.regGen, policyGen = current.policyGen + 1,
            grace = grace.wire, onLapse = lapse.wire, scopeSha256 = current.scopeSha256, issuedAt = now(),
        )
        val signature = runCatching { ServingAuthority.signEd25519(ServingAuthority.canonical(policy), adminRoot) }.getOrNull()
            ?: return Result.Failed(FSStrings.get(R.string.serving_couldnt_sign))
        val lockedBefore = current.onLapseValue == ServingOnLapse.LOCK_SERVER && current.graceValue != ServingGrace.INDEFINITE
        if (lapse == ServingOnLapse.LOCK_SERVER && !lockedBefore && revokeAutoUnlock != null) {
            try {
                revokeAutoUnlock.invoke()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (t: Throwable) {
                return Result.Failed(FSStrings.get(R.string.serving_couldnt_remove_auto_unlock, UserErrorText.of(t)))
            }
        }
        try {
            mailbox.postServingPolicy(username, ServingPolicyPost(policy, signature))
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (t: Throwable) {
            return Result.Failed(message(t))
        }
        runCatching { box?.postServing(BoxServingPost(policy = SignedServingPolicy(policy, signature))) }
        renewer.delegate(adminRoot)
        var until: Long? = null
        renewer.signLease(policy, adminRoot)?.let { lease ->
            renewer.post(listOf(serverDomain to lease))
            until = lease.record.notAfter
        }
        record(serverDomain, lapse, grace, until)
        return Result.Saved
    }

    companion object {
        fun message(t: Throwable): String = when (statusOf(t)) {
            409 -> FSStrings.get(R.string.serving_changed_on_another_device)
            403 -> FSStrings.get(R.string.serving_account_refused)
            else -> FSStrings.get(R.string.serving_couldnt_save)
        }

        private fun statusOf(t: Throwable): Int? = when (t) {
            is HttpException -> t.status
            is com.flagshipserver.app.api.ScreensError.Http -> t.status
            else -> null
        }
    }
}
