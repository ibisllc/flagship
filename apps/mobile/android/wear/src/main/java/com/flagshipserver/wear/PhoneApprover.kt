// Asks the phone to approve a box's boot unlock and waits for its answer. The
// watch holds no key and sends no consent: the phone runs its own approval and
// signs with the watch-delegate key, or says why it can't.

package com.flagshipserver.wear

import androidx.compose.ui.res.stringResource
import android.content.Context
import com.flagshipserver.companion.ApproveCommand
import com.flagshipserver.companion.ApproveReply
import com.flagshipserver.companion.PendingApproval
import com.flagshipserver.companion.WatchPaths
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeout

object PhoneApprover {
    val UNREACHABLE get() = FSStrings.get(R.string.phone_not_reachable_bring_it_nearby)

    suspend fun approve(ctx: Context, approval: PendingApproval): ApproveReply {
        fun fail(message: String) = ApproveReply(approval.serverFqdn, ok = false, errorMessage = message)
        return try {
            val nodes = Wearable.getNodeClient(ctx).connectedNodes.await()
            val phone = nodes.firstOrNull { it.isNearby } ?: nodes.firstOrNull() ?: return fail(UNREACHABLE)
            val cmd = ApproveCommand(requestId = approval.requestId, serverFqdn = approval.serverFqdn)
            val bytes = withTimeout(60_000) {
                Wearable.getMessageClient(ctx).sendRequest(phone.id, WatchPaths.APPROVE_UNLOCK, cmd.encode()).await()
            }
            ApproveReply.decode(bytes) ?: fail(FSStrings.get(R.string.couldnt_read_your_phones_answer))
        } catch (e: Exception) {
            fail(FSStrings.get(R.string.couldnt_reach_your_phone, e.message ?: e.javaClass.simpleName))
        }
    }
}
