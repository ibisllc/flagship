// Browser-sessions list — Settings → Browser sessions. Lists every
// docked-browser session on the leader pod; tap to revoke.

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
import androidx.compose.material3.AlertDialog
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
import com.flagshipserver.app.ui.components.FSDangerButton
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
    // Revoking a browser session is destructive (the docked computer loses
    // access), so it gates behind a grey Cancel / red Revoke confirm dialog
    // like every other destructive action (spec S3).
    var revokeTarget by remember { mutableStateOf<PairedSessionSummary?>(null) }

    LaunchedEffect(Unit) {
        try {
            sessions.clear()
            sessions.addAll(client.pairedSessionsList().sessions)
        } catch (t: Throwable) {
            error = t.message
        } finally {
            loaded = true
        }
    }

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        FSGhostButton(label = "← Back", onClick = { nav.popBackStack() })
        Spacer(Modifier.height(FS.space.s3))
        Text(
            "Browser sessions",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s4))

        if (error != null) {
            ErrorCard(message = error!!)
            return@Column
        }
        if (!loaded) {
            ServerCardSkeleton()
            return@Column
        }
        if (sessions.isEmpty()) {
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                    Text(
                        "No browser sessions",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium),
                    )
                    Text(
                        "Dock a browser to manage this account from a computer.",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 12.sp, lineHeight = 18.sp),
                    )
                }
            }
            return@Column
        }
        sessions.forEach { session ->
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                    Text(
                        session.label,
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium),
                    )
                    Text(
                        "token: ${session.tokenPrefix}…",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 12.sp),
                    )
                    if (session.current) FSPill("This device", kind = FSPillKind.Online)
                    if (!session.current) {
                        FSDangerButton(
                            label = "Revoke",
                            onClick = { revokeTarget = session },
                            modifier = Modifier.testTag("revoke-session-${session.tokenPrefix}"),
                        )
                    }
                }
            }
            Spacer(Modifier.height(FS.space.s2))
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
                    Text("Revoke", color = FS.colors.danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { revokeTarget = null }) { Text("Cancel") }
            },
            title = { Text("Revoke this session?") },
            text = { Text("The browser docked from ${target.label} loses access to this account.") },
        )
    }
}
