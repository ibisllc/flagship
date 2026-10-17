// Browser-sessions list — Settings → Browser sessions. Lists every
// browser docked through Remote on the current server; tap to revoke.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.PairedSessionSummary
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.core.FlagshipDateFormat
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSEmptyState
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

@Composable
fun PairedSessionsScreen(nav: NavController) {
    val client = LocalScreensClient.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    val sessions = remember { mutableStateListOf<PairedSessionSummary>() }
    var error by remember { mutableStateOf<String?>(null) }
    var loaded by remember { mutableStateOf(false) }
    // Revoking a browser session is destructive (the remote computer loses
    // access), so it gates behind a grey Cancel / red Revoke confirm dialog
    // like every other destructive action (spec S3).
    var revokeTarget by remember { mutableStateOf<PairedSessionSummary?>(null) }

    LaunchedEffect(Unit) {
        try {
            sessions.clear()
            // The box also lists the session this phone (and every other device of
            // the account) paired itself with: those are Trusted devices.
            sessions.addAll(client.pairedSessionsList().sessions.filter { it.isBrowserSession })
        } catch (t: Throwable) {
            error = t.message
        } finally {
            loaded = true
        }
    }

    FSScreen(title = "Browser sessions", onBack = { nav.popBackStack() }) {
        when {
            error != null -> ErrorCard(message = error!!)
            !loaded -> ServerCardSkeleton()
            sessions.isEmpty() -> FSEmptyState(
                title = "No browser sessions",
                message = "Connect a remote browser to manage this account from a computer.",
                icon = Icons.Outlined.Laptop,
            )
            else -> Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    "Computers you've docked a browser from. They can manage this account for a few hours, then expire.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(horizontal = FS.space.s1),
                )
                FSGroup {
                    sessions.forEachIndexed { idx, session ->
                        FSRow(
                            title = "Session ${session.tokenPrefix}",
                            subtitle = "Paired ${FlagshipDateFormat.format(session.addedAt)}",
                            icon = if (session.current) Icons.Outlined.PhoneAndroid else Icons.Outlined.Laptop,
                            iconTint = if (session.current) FS.colors.success else null,
                            trailing = {
                                if (session.current) {
                                    FSPill("This device", kind = FSPillKind.Online)
                                } else {
                                    FSDangerButton(
                                        label = "Revoke",
                                        onClick = { revokeTarget = session },
                                        modifier = Modifier.testTag("revoke-session-${session.tokenPrefix}"),
                                    )
                                }
                            },
                        )
                        if (idx < sessions.size - 1) FSDivider()
                    }
                }
            }
        }
    }

    revokeTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { revokeTarget = null },
            confirmButton = {
                TextButton(onClick = {
                    revokeTarget = null
                    scope.launch {
                        try {
                            client.revokePairedSession(target.tokenPrefix)
                            sessions.removeAll { it.tokenPrefix == target.tokenPrefix }
                            toasts.success("Session revoked.")
                        } catch (t: Throwable) {
                            toasts.error(t.message ?: "Couldn't revoke.")
                        }
                    }
                }) {
                    Text("Revoke", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { revokeTarget = null }) { Text("Cancel") }
            },
            title = { Text("Revoke this session?") },
            text = { Text("Session ${target.tokenPrefix} loses access to this account.") },
        )
    }
}
