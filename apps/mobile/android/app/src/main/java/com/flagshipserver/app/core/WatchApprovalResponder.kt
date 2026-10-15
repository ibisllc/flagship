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
// unlocked; otherwise it tells the watch what to do on the phone.

package com.flagshipserver.app.core

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
) {
    companion object {
        const val NOT_ENROLLED = "Turn on Quick approve from watch in Flagship on your phone first."
        const val PHONE_LOCKED = "Open Flagship on your phone, then approve again."
        const val SIGNED_OUT = "Sign in to Flagship on your phone first."
        const val GONE = "This server isn't waiting any more."
        const val UNSUPPORTED = "The watch asked for something this phone can't do."
    }

    suspend fun respond(cmd: ApproveCommand): ApproveReply {
        fun fail(message: String) = ApproveReply(cmd.serverFqdn, ok = false, errorMessage = message)
        if (cmd.kind != ApproveCommand.KIND || cmd.serverFqdn.isBlank()) return fail(UNSUPPORTED)
        if (!delegateEnrolled()) return fail(NOT_ENROLLED)
        if (!hasSessionKey()) return fail(PHONE_LOCKED)
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
            fail("Approval failed: ${e.message ?: e.javaClass.simpleName}")
        }
    }
}
