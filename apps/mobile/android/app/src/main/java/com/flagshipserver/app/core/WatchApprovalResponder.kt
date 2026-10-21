// Answers the watch's "approve this boot unlock" on the phone, the Kotlin twin
// of iOS's WatchApprovalResponder. The watch only asks; the phone runs the
// approval its own Approve button runs: it re-fetches the pending requests,
// re-verifies each against the directory STK, unseals the disk key and posts
// the sealed response signed with the watch-delegate key (role "delegate"),
// which the boot relay checks against the owner's IRK-attested grant. The
// consent is that signature, never a flag the watch sends.
//
// It never opens a biometric prompt: the phone may be in a pocket with the app
// in the background, so it proceeds only when the owner turned on Quick
// approve (a delegate key is enrolled here) and this app session is already
// unlocked. Otherwise it tells the watch exactly what to do on the phone (turn
// on Quick approve, unlock the open app once, or open the app and unlock it)
// and calls onNeedsUnlock, so the app, once in front, can say the watch is
// waiting.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.companion.ApproveCommand
import com.flagshipserver.companion.ApproveReply

/** What the watch's Approve needs from the boot-secret relay. Production is a
 *  [SecretRequestCoordinator] built with the session IRK and the delegate key. */
interface WatchApprovalSource {
    suspend fun fetchVerifiedRequests(): List<SecretRequestCoordinator.VerifiedRequest>
    suspend fun confirmAndRespond(verified: SecretRequestCoordinator.VerifiedRequest, depositAutoLease: Boolean): String?
}

fun SecretRequestCoordinator.asWatchApprovalSource(): WatchApprovalSource {
    val coordinator = this
    return object : WatchApprovalSource {
        override suspend fun fetchVerifiedRequests() = coordinator.fetchVerifiedRequests()
        override suspend fun confirmAndRespond(verified: SecretRequestCoordinator.VerifiedRequest, depositAutoLease: Boolean) =
            coordinator.confirmAndRespond(verified, depositAutoLease)
    }
}

class WatchApprovalResponder(
    private val delegateEnrolled: () -> Boolean,
    private val hasSessionKey: () -> Boolean,
    private val makeSource: () -> WatchApprovalSource?,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val appInForeground: () -> Boolean = { false },
    private val onNeedsUnlock: (ApproveCommand) -> Unit = {},
) {
    companion object {
        val NOT_ENROLLED get() = FSStrings.get(R.string.turn_on_quick_approve_from_watch)
        /** The app is in front on the phone but hasn't used biometrics this session. */
        val UNLOCK_ONCE get() = FSStrings.get(R.string.unlock_flagship_on_your_phone_once)
        /** The app is closed or in the background. */
        val OPEN_AND_UNLOCK get() = FSStrings.get(R.string.open_flagship_on_your_phone_and)
        val SIGNED_OUT get() = FSStrings.get(R.string.sign_in_to_flagship_on_your)
        val GONE get() = FSStrings.get(R.string.this_server_isnt_waiting_any_more)
        val UNSUPPORTED get() = FSStrings.get(R.string.the_watch_asked_for_something_this)
    }

    suspend fun respond(cmd: ApproveCommand): ApproveReply {
        fun fail(message: String) = ApproveReply(cmd.serverFqdn, ok = false, errorMessage = message)
        if (cmd.kind != ApproveCommand.KIND || cmd.serverFqdn.isBlank()) return fail(UNSUPPORTED)
        // A security notice has this app locked until it is updated: no approval is signed.
        if (UpdateLock.isLocked) return fail(UpdateLock.REFUSAL)
        if (!delegateEnrolled()) return fail(NOT_ENROLLED)
        if (!hasSessionKey()) {
            onNeedsUnlock(cmd)
            return fail(if (appInForeground()) UNLOCK_ONCE else OPEN_AND_UNLOCK)
        }
        val source = makeSource() ?: return fail(SIGNED_OUT)
        return try {
            val live = source.fetchVerifiedRequests().filter {
                it.purpose == SecretPurpose.UNLOCK_KEY &&
                    it.serverDomain.equals(cmd.serverFqdn, ignoreCase = true) &&
                    now() <= it.pending.expiresAt
            }
            val req = (if (cmd.requestId != null) live.firstOrNull { it.id == cmd.requestId } else null)
                ?: live.maxByOrNull { it.pending.postedAt }
                ?: return fail(GONE)
            // No auto-unlock lease: that deposit is an owner order, and the
            // delegate's approval covers this unlock alone.
            source.confirmAndRespond(req, depositAutoLease = false)
            ApproveReply(cmd.serverFqdn, ok = true)
        } catch (e: Throwable) {
            fail(FSStrings.get(R.string.approval_failed, e.message ?: e.javaClass.simpleName))
        }
    }
}
