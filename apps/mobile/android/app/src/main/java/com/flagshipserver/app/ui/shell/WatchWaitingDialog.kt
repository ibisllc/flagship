// Says in the app that the watch's Approve is waiting for this session's first
// biometric. The watch's reply already told the owner to unlock; this is the
// same ask where they now are. The biometric opens only from the owner's tap
// here, in front, never from the watch's request. Twin of iOS's
// WatchWaitingPrompt.

package com.flagshipserver.app.ui.shell

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.Lifecycle
import androidx.compose.ui.platform.LocalLifecycleOwner
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.WatchApprovalPrompt
import com.flagshipserver.app.keystore.BiometricAuthority
import com.flagshipserver.app.keystore.SessionIrkAccess
import kotlinx.coroutines.launch

@Composable
fun WatchWaitingDialog(prompt: WatchApprovalPrompt = WatchApprovalPrompt.shared) {
    val app = LocalAppState.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    val waiting by prompt.waiting.collectAsState()
    val unlocked by app.isUnlocked.collectAsState()
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateFlow.collectAsState()
    val ask = waiting != null && prompt.shouldAsk(
        inFront = lifecycle.isAtLeast(Lifecycle.State.STARTED),
        appUnlocked = unlocked,
        sessionUnlocked = SessionIrkAccess.isSessionUnlocked(),
    )
    if (!ask) return
    val fqdn = waiting?.serverFqdn
    val name = fqdn?.let { f -> app.pods.value.firstOrNull { it.fqdn.equals(f, ignoreCase = true) }?.name }
    AlertDialog(
        // Asked once: a cancelled biometric doesn't bring it back.
        onDismissRequest = { prompt.clear() },
        confirmButton = {
            TextButton(
                onClick = {
                    prompt.clear()
                    scope.launch {
                        runCatching {
                            BiometricAuthority.current()?.ensureFresh(
                                "Let your watch approve",
                                "Unlock Flagship once so Quick approve can sign",
                            )
                        }
                        if (SessionIrkAccess.isSessionUnlocked()) toasts.success(WatchApprovalPrompt.AFTER_UNLOCK)
                    }
                },
                modifier = Modifier.testTag("watch-waiting-unlock"),
            ) { Text("Unlock") }
        },
        dismissButton = {
            TextButton(onClick = { prompt.clear() }) { Text("Not now") }
        },
        title = { Text(WatchApprovalPrompt.TITLE) },
        text = { Text(WatchApprovalPrompt.message(name)) },
        modifier = Modifier.testTag("watch-waiting-dialog"),
    )
}
