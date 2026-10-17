// Author-side approve screen for a friend's acceptance reply link. Mirror of
// iOS InviteAcceptScreen; driven by InviteAcceptViewModel.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.InviteAcceptPhase
import com.flagshipserver.app.viewmodels.InviteAcceptViewModel
import kotlinx.coroutines.launch

@Composable
fun InviteAcceptScreen(rawReply: String, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    val toasts = LocalToastCenter.current
    val vm = remember(rawReply) { InviteAcceptViewModel(rawReply) }
    val phase by vm.phase.collectAsState()
    val app = vm.serviceRef.ifEmpty { "your app" }

    FSScreen(title = "Approve access", onBack = onDone) {
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                when (val p = phase) {
                    is InviteAcceptPhase.Done -> {
                        Text("Approved", color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleLarge)
                        Text(
                            "They now have access to ${p.serviceRef.ifEmpty { "the app" }}.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyLarge,
                        )
                        FSPrimaryButton(
                            label = "Done",
                            block = true,
                            large = true,
                            onClick = onDone,
                            modifier = Modifier.semantics { testTag = "invite-accept-done" },
                        )
                    }
                    else -> {
                        Text("Approve this person", color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleLarge)
                        Text(
                            "You sent an invite to $app and they accepted. Approving gives them access. " +
                                "You won't see their username, only the label you gave them.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyLarge,
                        )
                        val submitting = p is InviteAcceptPhase.Submitting
                        if (vm.serverDomain != null) {
                            FSPrimaryButton(
                                label = if (submitting) "Approving…" else "Approve",
                                enabled = !submitting,
                                block = true,
                                large = true,
                                onClick = {
                                    scope.launch {
                                        vm.approve()
                                        when (val after = vm.phase.value) {
                                            is InviteAcceptPhase.Done -> toasts.success("Approved.")
                                            is InviteAcceptPhase.Failed -> toasts.error(after.message)
                                            else -> {}
                                        }
                                    }
                                },
                                modifier = Modifier.semantics { testTag = "invite-accept-approve" },
                            )
                        }
                        (p as? InviteAcceptPhase.Failed)?.let {
                            Text(it.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.semantics { testTag = "invite-accept-error" })
                        }
                        FSSecondaryButton(label = "Not now", block = true, onClick = onDone)
                    }
                }
            }
        }
    }
}
