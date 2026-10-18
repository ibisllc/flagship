// "Restore from backup" (Home's Add/Restore server menu): one chooser for the three
// places a backup can come from, and the list of the copies this phone kept.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.FileOpen
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import com.flagshipserver.app.core.BackupsText
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.PhoneBackupCopies
import com.flagshipserver.app.ui.components.FSEmptyState
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.theme.FS

/** Where the backup comes from: a file, other servers, or this phone's own copies. */
@Composable
fun RestoreFromBackupScreen(
    onFile: () -> Unit,
    onPeers: () -> Unit,
    onPhone: () -> Unit,
    onBack: () -> Unit,
) {
    FSScreen(title = "Restore from backup", onBack = onBack, modifier = Modifier.testTag("restore-chooser")) {
        FSGroup {
            FSRow(
                title = "From a file",
                subtitle = "Pick a .flagship backup file.",
                icon = Icons.Outlined.FileOpen,
                iconTint = FS.colors.accent,
                onClick = onFile,
                modifier = Modifier.testTag("restore-source-file"),
            )
            FSDivider()
            FSRow(
                title = "From other servers",
                subtitle = "Rebuild a lost server from pieces other servers keep.",
                icon = Icons.Outlined.Dns,
                iconTint = FS.colors.accent,
                onClick = onPeers,
                modifier = Modifier.testTag("restore-source-peers"),
            )
            FSDivider()
            FSRow(
                title = "From this phone",
                subtitle = "Use a copy this phone kept when backups ran.",
                icon = Icons.Outlined.PhoneAndroid,
                iconTint = FS.colors.accent,
                onClick = onPhone,
                modifier = Modifier.testTag("restore-source-phone"),
            )
        }
    }
}

/** The copies this phone kept (the phone-side backup policy), by server and date. */
@Composable
fun RestoreFromPhoneScreen(onPick: (PhoneBackupCopies.Copy) -> Unit, onBack: () -> Unit) {
    val context = LocalContext.current
    val app = LocalAppState.current
    val copies = remember { PhoneBackupCopies.from(context) }
    val pods = app.pods.value
    // Servers of this account first (a server with no copy says so), then servers
    // that are gone but whose copies are still here.
    val known = pods.map { it.fqdn.lowercase() to it.name.ifEmpty { it.fqdn.substringBefore('.') } }
    val extra = copies.servers().filter { s -> known.none { it.first == s } }.map { it to it.substringBefore('.') }
    val servers = known + extra
    FSScreen(title = "From this phone", onBack = onBack, modifier = Modifier.testTag("restore-phone")) {
        if (servers.isEmpty()) {
            FSEmptyState(
                title = "No copies on this phone",
                message = "A server with the phone backup policy keeps its newest backups here. Nothing has been kept yet.",
                icon = Icons.Outlined.PhoneAndroid,
            )
            return@FSScreen
        }
        servers.forEach { (fqdn, name) ->
            val kept = copies.copies(fqdn)
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
                FSSectionHeader(name)
                FSGroup {
                    if (kept.isEmpty()) {
                        FSRow(
                            title = "No copy on this phone yet",
                            subtitle = copies.note(fqdn) ?: "This phone keeps a copy when the server's backup policy is on this phone.",
                            enabled = false,
                            modifier = Modifier.testTag("restore-phone-missing-$fqdn"),
                        )
                    }
                    kept.forEachIndexed { i, c ->
                        if (i > 0) FSDivider(inset = FS.space.s4)
                        FSRow(
                            title = BackupsText.whenText(c.meta.createdAt),
                            subtitle = "${BackupsText.size(c.meta)} · ${c.meta.apps.size} apps",
                            onClick = { onPick(c) },
                            modifier = Modifier.testTag("restore-phone-copy-${c.meta.archiveId}"),
                        )
                    }
                }
            }
        }
    }
}
