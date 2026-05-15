// Kotlin mirror of FlagshipUI/Screens/PostRecoveryChoiceScreen.swift.
//
// Presented after the WebAuthn-PRF recovery flow successfully unwraps
// the UMK on this device. Three options with distinct cryptographic
// blast radii; scare-warning copy is verbatim from
// docs/revocation-ui.md (lands in F1).

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.RecoveryChoice
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS

@Composable
fun PostRecoveryChoiceScreen(
    wipeAndRestartEnabled: Boolean = false,
    onContinue: (RecoveryChoice) -> Unit,
) {
    var selection: RecoveryChoice by remember { mutableStateOf(RecoveryChoice.KeepBothDevices) }
    val scroll = rememberScrollState()
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6, vertical = FS.space.s8),
        verticalArrangement = Arrangement.spacedBy(FS.space.s6),
    ) {
        Header()
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            OptionRow(
                choice = RecoveryChoice.KeepBothDevices,
                selected = selection == RecoveryChoice.KeepBothDevices,
                dimmed = false,
                onPick = { selection = it },
            )
            OptionRow(
                choice = RecoveryChoice.ReplaceLostDevice,
                selected = selection == RecoveryChoice.ReplaceLostDevice,
                dimmed = false,
                onPick = { selection = it },
            )
            OptionRow(
                choice = RecoveryChoice.WipeAndRestart,
                selected = selection == RecoveryChoice.WipeAndRestart,
                dimmed = !wipeAndRestartEnabled,
                onPick = { selection = it },
            )
        }
        Spacer(Modifier.height(FS.space.s4))
        FSPrimaryButton(
            label = continueLabel(selection),
            onClick = { onContinue(selection) },
            enabled = continueEnabled(selection, wipeAndRestartEnabled),
            block = true,
            large = true,
            modifier = Modifier.semantics { contentDescription = "post-recovery-continue" },
        )
        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun Header() {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        Text(
            "Welcome back to Flagship on this device.",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "How should this device relate to your other trusted devices?",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        )
    }
}

@Composable
private fun OptionRow(
    choice: RecoveryChoice,
    selected: Boolean,
    dimmed: Boolean,
    onPick: (RecoveryChoice) -> Unit,
) {
    val borderColor = if (selected) FS.colors.primary else FS.colors.border
    val bg = if (selected) FS.colors.primary.copy(alpha = 0.06f) else FS.colors.surface
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(FS.radius.md))
            .background(bg)
            .border(1.dp, borderColor, RoundedCornerShape(FS.radius.md))
            .clickable(enabled = !dimmed) { onPick(choice) }
            .padding(FS.space.s4)
            .semantics { contentDescription = accessibilityIdFor(choice) },
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
    ) {
        RadioGlyph(filled = selected, dimmed = dimmed)
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    titleFor(choice),
                    color = if (dimmed) FS.colors.textMuted else FS.colors.text,
                    style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                )
                warningIconFor(choice)?.let {
                    Icon(it, contentDescription = null, tint = FS.colors.danger, modifier = Modifier.size(14.dp))
                }
                if (dimmed) {
                    ComingSoonPill()
                }
            }
            Text(
                subtitleFor(choice),
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
            )
        }
    }
}

@Composable
private fun RadioGlyph(filled: Boolean, dimmed: Boolean) {
    val ring = when {
        dimmed -> FS.colors.textMuted
        filled -> FS.colors.primary
        else -> FS.colors.border
    }
    Box(
        modifier = Modifier.size(22.dp).clip(CircleShape).border(2.dp, ring, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        if (filled) {
            Box(modifier = Modifier.size(10.dp).clip(CircleShape).background(FS.colors.primary))
        }
    }
}

@Composable
private fun ComingSoonPill() {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(FS.colors.surfaceSunken)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    ) {
        Text(
            "Coming soon",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 11.sp),
        )
    }
}

private fun titleFor(c: RecoveryChoice) = when (c) {
    RecoveryChoice.KeepBothDevices   -> "Keep my other devices working"
    RecoveryChoice.ReplaceLostDevice -> "Replace a device I lost"
    RecoveryChoice.WipeAndRestart    -> "Wipe & restart"
}

private fun subtitleFor(c: RecoveryChoice) = when (c) {
    RecoveryChoice.KeepBothDevices   ->
        "Default. Both this device and any other devices you've already paired stay logged in."
    RecoveryChoice.ReplaceLostDevice ->
        "Rotates your account's identity. Your servers will treat the lost device as expired within ~5 minutes. Cannot be undone."
    RecoveryChoice.WipeAndRestart    ->
        "Replaces your UMK and recovery passkey. Even an attacker holding your old device AND your old passkey is locked out. Cannot be undone."
}

private fun warningIconFor(c: RecoveryChoice) = when (c) {
    RecoveryChoice.KeepBothDevices   -> null
    RecoveryChoice.ReplaceLostDevice -> Icons.Filled.Warning
    RecoveryChoice.WipeAndRestart    -> Icons.Filled.Error
}

private fun continueLabel(c: RecoveryChoice) = when (c) {
    RecoveryChoice.KeepBothDevices   -> "Continue"
    RecoveryChoice.ReplaceLostDevice -> "Replace device"
    RecoveryChoice.WipeAndRestart    -> "Wipe & restart"
}

private fun continueEnabled(c: RecoveryChoice, wipeEnabled: Boolean) =
    !(c == RecoveryChoice.WipeAndRestart && !wipeEnabled)

private fun accessibilityIdFor(c: RecoveryChoice) = when (c) {
    RecoveryChoice.KeepBothDevices   -> "post-recovery-keep-both"
    RecoveryChoice.ReplaceLostDevice -> "post-recovery-replace-lost"
    RecoveryChoice.WipeAndRestart    -> "post-recovery-wipe-restart"
}
