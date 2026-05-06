package com.flagship.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagship.ui.components.FSCard
import com.flagship.ui.components.FSGhostButton
import com.flagship.ui.components.FSPill
import com.flagship.ui.components.FSPillKind
import com.flagship.ui.components.FSPrimaryButton
import com.flagship.ui.theme.FS

/**
 * D.3.1 — ServerListView (HomeScreen here, since this is the start
 * destination after login). Empty state on first run; populated rows
 * once the user adds a server.
 */
@Composable
fun HomeScreen(nav: NavController) {
    val servers by remember { mutableStateOf(sampleServers()) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s12))

        // Greeting
        Text(
            text = "Hi, harry.",
            color = FS.colors.text,
            style = TextStyle(fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            text = if (servers.isEmpty()) "No servers yet." else "Everything is online.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
        )

        Spacer(Modifier.height(FS.space.s8))

        if (servers.isEmpty()) {
            FSCard(padding = PaddingValues(FS.space.s6)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    Text(
                        text = "Add your first server",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
                    )
                    Text(
                        text = "Order a pre-built box (~$199) or flash any old PC. Either way, about ten minutes.",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
                    )
                    Spacer(Modifier.height(FS.space.s2))
                    FSPrimaryButton(
                        label = "Order a server",
                        onClick = { /* TODO: nav.navigate("order") */ },
                        block = true,
                    )
                    FSGhostButton(
                        label = "Build my own",
                        onClick = { nav.navigate("build-code") },
                        block = true,
                    )
                }
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                servers.forEach { ServerRow(it) }
            }
        }

        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun ServerRow(server: ServerSummary) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.fillMaxWidth().padding(end = FS.space.s4)) {
                Text(
                    text = server.fqdn,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
                )
                Spacer(Modifier.height(FS.space.s1))
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), verticalAlignment = Alignment.CenterVertically) {
                    FSPill(
                        label = when (server.status) {
                            ServerStatus.Online -> "Online"
                            ServerStatus.Renewing -> "Cert renewing"
                            ServerStatus.Offline -> "Offline"
                            ServerStatus.Provisioning -> "Provisioning"
                        },
                        kind = when (server.status) {
                            ServerStatus.Online -> FSPillKind.Online
                            ServerStatus.Renewing -> FSPillKind.Renewing
                            ServerStatus.Offline -> FSPillKind.Offline
                            ServerStatus.Provisioning -> FSPillKind.Provisioning
                        },
                    )
                    Text(
                        text = server.tldDescription,
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 13.sp),
                    )
                }
            }
        }
    }
}

private fun sampleServers() = emptyList<ServerSummary>()

enum class ServerStatus { Online, Renewing, Offline, Provisioning }

data class ServerSummary(
    val fqdn: String,
    val status: ServerStatus,
    val tldDescription: String,
)
