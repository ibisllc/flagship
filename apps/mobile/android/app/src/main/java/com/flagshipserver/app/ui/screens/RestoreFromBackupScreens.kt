// "Restore from backup" (Home's Add/Restore server menu): one chooser for the three
// places a backup can come from, and the list of the copies this phone kept.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
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
    FSScreen(title = stringResource(R.string.restore_from_backup), onBack = onBack, modifier = Modifier.testTag("restore-chooser")) {
        FSGroup {
            FSRow(
                title = stringResource(R.string.from_a_file),
                subtitle = stringResource(R.string.pick_a_flagship_backup_file),
                icon = Icons.Outlined.FileOpen,
                iconTint = FS.colors.accent,
                onClick = onFile,
                modifier = Modifier.testTag("restore-source-file"),
            )
            FSDivider()
            FSRow(
                title = stringResource(R.string.from_other_servers),
                subtitle = stringResource(R.string.rebuild_a_lost_server_from_pieces),
                icon = Icons.Outlined.Dns,
                iconTint = FS.colors.accent,
                onClick = onPeers,
                modifier = Modifier.testTag("restore-source-peers"),
            )
            FSDivider()
            FSRow(
                title = stringResource(R.string.from_this_phone),
                subtitle = stringResource(R.string.use_a_copy_this_phone_kept),
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
    FSScreen(title = stringResource(R.string.from_this_phone), onBack = onBack, modifier = Modifier.testTag("restore-phone")) {
        if (servers.isEmpty()) {
            FSEmptyState(
                title = stringResource(R.string.no_copies_on_this_phone),
                message = stringResource(R.string.a_server_with_the_phone_backup),
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
                            title = stringResource(R.string.no_copy_on_this_phone_yet),
                            subtitle = copies.note(fqdn) ?: stringResource(R.string.this_phone_keeps_a_copy_when),
                            enabled = false,
                            modifier = Modifier.testTag("restore-phone-missing-$fqdn"),
                        )
                    }
                    kept.forEachIndexed { i, c ->
                        if (i > 0) FSDivider(inset = FS.space.s4)
                        FSRow(
                            title = BackupsText.whenText(c.meta.createdAt),
                            subtitle = fsString(R.string.apps, BackupsText.size(c.meta), c.meta.apps.size),
                            onClick = { onPick(c) },
                            modifier = Modifier.testTag("restore-phone-copy-${c.meta.archiveId}"),
                        )
                    }
                }
            }
        }
    }
}
