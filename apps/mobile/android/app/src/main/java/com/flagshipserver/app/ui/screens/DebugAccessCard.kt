// The server page's "Debug access" (docs/recipe-delivery-and-remote-install.md
// "Debug access"): a banner while it's on, and for an admin device the
// controls to turn it on for an SSH key, renew it, or turn it off. Mirrors the
// webapp and iOS server page.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.ui.components.fsFocusRing
import androidx.compose.ui.unit.dp
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import com.flagshipserver.app.ui.components.RadioButton
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.DebugAccess
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.DebugAccessViewModel
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

/** "Debug access is on until <time>." */
internal fun debugAccessBannerText(expiresAt: Long): String =
    "Debug access is on until ${DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(expiresAt))}."

/** Shown at the top of the server page while debug access is on. */
@Composable
internal fun DebugAccessBanner(vm: DebugAccessViewModel) {
    val state by vm.state.collectAsState()
    val v = state.view ?: return
    if (!vm.isOn()) return
    Text(
        debugAccessBannerText(v.expiresAt ?: return),
        color = FS.colors.danger,
        style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8))
            .background(FS.colors.danger.copy(alpha = 0.08f))
            .padding(FS.space.s3)
            .semantics { contentDescription = "sd-debug-access-banner" },
    )
    Spacer(Modifier.height(FS.space.s6))
}

@Composable
internal fun DebugAccessCard(vm: DebugAccessViewModel, onChanged: () -> Unit) {
    val state by vm.state.collectAsState()
    val scope = rememberCoroutineScope()
    var editing by remember { mutableStateOf(false) }
    var key by remember { mutableStateOf("") }
    var duration by remember { mutableStateOf(DebugAccess.Duration.DAY) }
    var confirmOff by remember { mutableStateOf(false) }
    val on = vm.isOn()
    val view = state.view

    com.flagshipserver.app.ui.components.FSSectionHeader("Debug access")
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            if (on && view != null) {
                Text(
                    debugAccessBannerText(view.expiresAt ?: 0L),
                    color = FS.colors.text,
                    style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium),
                )
                view.keyFingerprint?.let {
                    Text(
                        "Key $it",
                        color = FS.colors.textMuted,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    )
                }
            } else {
                Text(
                    "Off. Turn it on to let one SSH key in as the debug user for a while.",
                    color = FS.colors.textMuted,
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            if (!vm.canChange) {
                Text(
                    DebugAccess.ADMIN_ONLY,
                    color = FS.colors.textMuted,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.semantics { contentDescription = "sd-debug-access-admin-only" },
                )
            } else if (editing) {
                FSField(
                    value = key,
                    onValueChange = { key = it },
                    label = "SSH public key",
                    placeholder = "ssh-ed25519 AAAA… you@laptop",
                    fieldTag = "sd-debug-access-key",
                )
                DebugAccess.Duration.values().forEach { d ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .fsFocusRing(8.dp).selectable(selected = duration == d, onClick = { duration = d })
                            .testTag("sd-debug-access-duration-${d.name.lowercase()}"),
                    ) {
                        RadioButton(selected = duration == d, onClick = { duration = d })
                        Text(d.label, color = FS.colors.text, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                Text(
                    DebugAccess.WARNING,
                    color = FS.colors.danger,
                    style = MaterialTheme.typography.bodySmall,
                )
                FSPrimaryButton(
                    label = if (state.busy) "Signing…" else if (on) "Renew" else "Turn on",
                    onClick = {
                        scope.launch {
                            if (vm.turnOn(key, duration)) {
                                editing = false
                                key = ""
                                onChanged()
                            }
                        }
                    },
                    enabled = !state.busy,
                    block = true,
                    modifier = Modifier.testTag("sd-debug-access-submit"),
                )
                FSSecondaryButton(label = "Cancel", onClick = { editing = false }, block = true)
            } else {
                FSPrimaryButton(
                    label = if (on) "Renew…" else "Turn on…",
                    onClick = { editing = true },
                    enabled = !state.busy,
                    block = true,
                    modifier = Modifier.testTag("sd-debug-access-open"),
                )
                if (on) {
                    FSDangerButton(
                        label = if (state.busy) "Turning off…" else "Turn off",
                        onClick = { confirmOff = true },
                        enabled = !state.busy,
                        block = true,
                        modifier = Modifier.testTag("sd-debug-access-off"),
                    )
                }
            }
            state.error?.let {
                Text(it, color = FS.colors.danger, style = MaterialTheme.typography.bodySmall, modifier = Modifier.semantics { contentDescription = "sd-debug-access-error" })
            }
            state.notice?.let {
                Text(it, color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            }
        }
    }

    if (confirmOff) {
        AlertDialog(
            onDismissRequest = { confirmOff = false },
            title = { Text("Turn off debug access?") },
            text = { Text("The key stops working now and anyone signed in with it is disconnected.") },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmOff = false
                        scope.launch { if (vm.turnOff()) onChanged() }
                    },
                    modifier = Modifier.testTag("sd-debug-access-confirm-off"),
                ) { Text("Turn off") }
            },
            dismissButton = { TextButton(onClick = { confirmOff = false }) { Text("Cancel") } },
        )
    }
}
