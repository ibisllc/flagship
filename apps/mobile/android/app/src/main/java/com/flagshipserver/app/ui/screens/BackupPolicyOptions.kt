// The three backup policies with their reserve picker (docs/server-backup-
// and-clone.md, "Backup policy"): the create wizard's backups step and the
// server page's Change both show these. MIRRORS the iOS BackupPolicyOptions.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.ui.components.fsFocusRing
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import com.flagshipserver.app.ui.components.RadioButton
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.BackupsText
import com.flagshipserver.app.core.ServerArchive
import com.flagshipserver.app.ui.theme.FS

/** [policy]: `phone` | `peer` | `none`; [reserveGb] is the phone's reserve (phone only). */
@Composable
internal fun BackupPolicyOptions(
    policy: String?,
    onPolicy: (String) -> Unit,
    reserveGb: Int,
    onReserveGb: (Int) -> Unit,
    phoneFreeBytes: Long,
    tagPrefix: String,
    /** Create-server's step: nothing preselected, No backup first, one short sentence each. */
    forCreate: Boolean = false,
) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        if (forCreate) {
            PolicyOption(policy == "none", BackupsText.CREATE_NONE_TITLE, BackupsText.CREATE_NONE_BODY, warn = false, tag = "$tagPrefix-none") { onPolicy("none") }
        }
        PolicyOption(policy == "phone", if (forCreate) BackupsText.CREATE_PHONE_TITLE else BackupsText.PHONE_TITLE, if (forCreate) BackupsText.CREATE_PHONE_BODY else BackupsText.PHONE_BODY, warn = false, tag = "$tagPrefix-phone") { onPolicy("phone") }
        if (policy == "phone") {
            val maxGb = maxOf(BackupsText.defaultReserveGb(phoneFreeBytes), (phoneFreeBytes / BackupsText.GB).toInt())
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = FS.space.s4)) {
                androidx.compose.material3.FilledTonalIconButton(
                    onClick = { onReserveGb(maxOf(1, reserveGb - 1)) },
                    enabled = reserveGb > 1,
                    modifier = Modifier.testTag("$tagPrefix-reserve-down"),
                ) { androidx.compose.material3.Icon(androidx.compose.material.icons.Icons.Filled.Remove, contentDescription = "Less") }
                Text(
                    "$reserveGb GB",
                    color = FS.colors.text,
                    style = MaterialTheme.typography.titleMedium,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    modifier = Modifier.width(80.dp).testTag("$tagPrefix-reserve"),
                )
                androidx.compose.material3.FilledTonalIconButton(
                    onClick = { onReserveGb(minOf(maxGb, reserveGb + 1)) },
                    enabled = reserveGb < maxGb,
                    modifier = Modifier.testTag("$tagPrefix-reserve-up"),
                ) { androidx.compose.material3.Icon(androidx.compose.material.icons.Icons.Filled.Add, contentDescription = "More") }
            }
            Text(
                "This phone has ${ServerArchive.formatBytes(phoneFreeBytes)} free",
                color = FS.colors.textMuted,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(start = FS.space.s4),
            )
        }
        PolicyOption(policy == "peer", if (forCreate) BackupsText.CREATE_PEER_TITLE else BackupsText.PEER_TITLE, if (forCreate) BackupsText.CREATE_PEER_BODY else BackupsText.PEER_BODY, warn = false, tag = "$tagPrefix-peer") { onPolicy("peer") }
        if (!forCreate) {
            PolicyOption(policy == "none", BackupsText.NONE_TITLE, BackupsText.NONE_BODY, warn = true, tag = "$tagPrefix-none") { onPolicy("none") }
        }
        if (forCreate) {
            Text(BackupsText.CREATE_CHANGE_NOTE, color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = FS.space.s1).testTag("$tagPrefix-note"))
        }
    }
}

@Composable
private fun PolicyOption(selected: Boolean, title: String, body: String, warn: Boolean, tag: String, onClick: () -> Unit) {
    val border = when {
        selected && warn -> FS.colors.warning
        selected -> FS.colors.primary
        else -> FS.colors.border
    }
    Column(
        Modifier
            .fillMaxWidth()
            .border(if (selected) 2.dp else 1.dp, border, androidx.compose.foundation.shape.RoundedCornerShape(FS.radius.md))
            .fsFocusRing(FS.radius.md)
            .clickable(onClick = onClick)
            .padding(FS.space.s3)
            .testTag(tag),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            RadioButton(selected = selected, onClick = onClick)
            Spacer(Modifier.width(FS.space.s2))
            Text(title, color = FS.colors.text, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium))
        }
        Spacer(Modifier.height(FS.space.s1))
        Text(body, color = if (warn) FS.colors.warning else FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
    }
}
