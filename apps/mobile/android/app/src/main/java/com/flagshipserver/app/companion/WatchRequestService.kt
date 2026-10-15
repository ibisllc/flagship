// Receives the watch's requests over the Wearable Data Layer. Today the one
// request is Approve (WatchPaths.APPROVE_UNLOCK), answered by the responder
// the app holds (WatchBridge.responder). When the app isn't running there is no
// responder, and the watch is told to open Flagship on the phone and unlock it:
// nothing here can open a biometric prompt.

package com.flagshipserver.app.companion

import com.flagshipserver.app.core.WatchApprovalPrompt
import com.flagshipserver.app.core.WatchApprovalResponder
import com.flagshipserver.companion.ApproveCommand
import com.flagshipserver.companion.ApproveReply
import com.flagshipserver.companion.WatchPaths
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.WearableListenerService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class WatchRequestService : WearableListenerService() {
    override fun onRequest(nodeId: String, path: String, request: ByteArray): Task<ByteArray>? {
        if (path != WatchPaths.APPROVE_UNLOCK) return null
        val cmd = ApproveCommand.decode(request)
            ?: return Tasks.forResult(ApproveReply("", ok = false, errorMessage = WatchApprovalResponder.UNSUPPORTED).encode())
        val responder = WatchBridge.responder ?: run {
            // The app shows the ask once it is opened.
            WatchApprovalPrompt.shared.watchIsWaiting(cmd.serverFqdn)
            return Tasks.forResult(
                ApproveReply(cmd.serverFqdn, ok = false, errorMessage = WatchApprovalResponder.OPEN_AND_UNLOCK).encode(),
            )
        }
        val result = TaskCompletionSource<ByteArray>()
        scope.launch { result.setResult(responder.respond(cmd).encode()) }
        return result.task
    }

    private companion object {
        // Outlives the service instance: the reply may land after the system
        // unbinds it.
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }
}
