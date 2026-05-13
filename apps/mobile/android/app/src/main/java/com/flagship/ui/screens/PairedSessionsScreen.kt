// Paired-sessions list — Settings → Paired devices. Lists every
// session token registered on the leader pod; tap to revoke.

package com.flagship.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagship.api.PairedSessionSummary
import com.flagship.core.LocalScreensClient
import com.flagship.core.LocalToastCenter
import com.flagship.ui.components.FSCard
import com.flagship.ui.components.FSGhostButton
import com.flagship.ui.components.FSPill
import com.flagship.ui.components.FSPillKind
import com.flagship.ui.theme.FS
import kotlinx.coroutines.launch

@Composable
fun PairedSessionsScreen(nav: NavController) {
    val client = LocalScreensClient.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    val sessions = remember { mutableStateListOf<PairedSessionSummary>() }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        try {
            sessions.clear()
            sessions.addAll(client.pairedSessionsList().sessions)
        } catch (t: Throwable) {
            error = t.message
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
            "Paired devices",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s4))

        if (error != null) {
            ErrorCard(message = error!!)
            return@Column
        }
        if (sessions.isEmpty()) {
            ServerCardSkeleton()
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
                        FSGhostButton(label = "Revoke", onClick = {
                            scope.launch {
                                try {
                                    client.revokePairedSession(session.tokenPrefix)
                                    sessions.removeAll { it.tokenPrefix == session.tokenPrefix }
                                    toasts.success("Device revoked.")
                                } catch (t: Throwable) {
                                    toasts.error(t.message ?: "Couldn't revoke.")
                                }
                            }
                        })
                    }
                }
            }
            Spacer(Modifier.height(FS.space.s2))
        }
    }
}
