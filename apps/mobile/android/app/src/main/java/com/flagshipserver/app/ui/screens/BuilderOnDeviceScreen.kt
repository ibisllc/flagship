// "Burn to USB on this device" — the on-device USB-OTG builder UI (Android only).
//
// Public entry: BuilderOnDeviceScreen(recipeJson, onDone). Mirrors the desktop
// builder's option set: detected-drive picker, "this erases the drive" warning,
// a phase progress bar (download / verify / prepare / write), and success.
//
// The recipe-embedding step is a documented seam (VerbatimInjector) — see
// OTG-BUILDER-NOTES.md. The download/verify/USB-write pipeline is fully real.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.R
import com.flagshipserver.app.ui.components.fsFocusRing
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Usb
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import com.flagshipserver.app.ui.components.RadioButton
import androidx.compose.foundation.layout.width
import com.flagshipserver.app.ui.components.FSScreen
import android.app.Application
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.flagshipserver.app.builder.BuilderOnDeviceViewModel
import com.flagshipserver.app.builder.usb.UsbHost
import com.flagshipserver.app.builder.usb.UsbMassStorageDevice
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout

/**
 * Self-contained on-device builder. Hook this up to the create-server delivery
 * chooser separately (it's intentionally NOT wired here).
 */
@Composable
fun BuilderOnDeviceScreen(recipeJson: String, onDone: () -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext as Application

    val vm: BuilderOnDeviceViewModel = viewModel(
        factory = viewModelFactory {
            initializer { BuilderOnDeviceViewModel(app, recipeJson) }
        },
    )
    val state by vm.state.collectAsState()

    // System USB permission dialog → broadcast back to the VM.
    DisposableEffect(Unit) {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, intent: Intent?) {
                if (intent?.action == UsbHost.ACTION_USB_PERMISSION) vm.onPermissionResult()
            }
        }
        val filter = IntentFilter(UsbHost.ACTION_USB_PERMISSION)
        context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        onDispose { runCatching { context.unregisterReceiver(receiver) } }
    }

    fun requestPermission() {
        val sel = state.selected ?: return
        val flags = PendingIntent.FLAG_MUTABLE
        val pi = PendingIntent.getBroadcast(
            context, 0, Intent(UsbHost.ACTION_USB_PERMISSION).setPackage(context.packageName), flags,
        )
        UsbHost.requestPermission(UsbHost.manager(context), sel.device, pi)
    }

    FSScreen(
        title = stringResource(R.string.burn_to_usb),
        onBack = onDone,
        subtitle = stringResource(R.string.connect_a_usb_drive_with_an),
        spacing = 0.dp,
    ) {
        Spacer(Modifier.height(FS.space.s4))
        state.recipe?.let { r ->
            FSCard {
                Text(stringResource(R.string.server_2), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)
                Spacer(Modifier.height(FS.space.s1))
                Text(r.serverName, style = MaterialTheme.typography.titleMedium)
                Text(r.serverDomain, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
            }
            Spacer(Modifier.height(FS.space.s4))
        }

        when (state.phase) {
            BuilderOnDeviceViewModel.Phase.Error -> ErrorBlock(state.error, onRetry = { vm.refreshDevices() })
            BuilderOnDeviceViewModel.Phase.Done -> DoneBlock(state.statusLine, onDone)
            BuilderOnDeviceViewModel.Phase.NoUsb -> NoUsbBlock(onRefresh = { vm.refreshDevices() })
            else -> {
                DrivePicker(state, onSelect = { vm.select(it) }, onRefresh = { vm.refreshDevices() })
                Spacer(Modifier.height(FS.space.s4))
                when (state.phase) {
                    BuilderOnDeviceViewModel.Phase.NeedPermission -> {
                        WarningCard(stringResource(R.string.allow_access_to_this_usb_drive))
                        Spacer(Modifier.height(FS.space.s3))
                        FSPrimaryButton(label = stringResource(R.string.allow_usb_access), onClick = { requestPermission() }, block = true)
                    }

                    BuilderOnDeviceViewModel.Phase.Ready -> {
                        WarningCard(stringResource(R.string.writing_erases_everything_on_the_selected))
                        Spacer(Modifier.height(FS.space.s3))
                        FSPrimaryButton(
                            label = stringResource(R.string.erase_and_write),
                            onClick = { vm.startBurn() },
                            enabled = state.selected != null,
                            block = true,
                        )
                    }

                    BuilderOnDeviceViewModel.Phase.Downloading,
                    BuilderOnDeviceViewModel.Phase.Verifying,
                    BuilderOnDeviceViewModel.Phase.Injecting,
                    BuilderOnDeviceViewModel.Phase.Writing,
                    -> ProgressBlock(state)

                    else -> {}
                }
            }
        }

    }
}

@Composable
private fun DrivePicker(
    state: BuilderOnDeviceViewModel.State,
    onSelect: (UsbMassStorageDevice) -> Unit,
    onRefresh: () -> Unit,
) {
    com.flagshipserver.app.ui.components.FSSectionHeader(stringResource(R.string.usb_drive))
    Spacer(Modifier.height(FS.space.s2))
    com.flagshipserver.app.ui.components.FSGroup {
        state.devices.forEachIndexed { i, d ->
            val selected = state.selected?.device?.deviceId == d.device.deviceId
            Row(
                Modifier
                    .fillMaxWidth()
                    .fsFocusRing(8.dp).selectable(selected = selected, onClick = { onSelect(d) }, role = androidx.compose.ui.semantics.Role.RadioButton)
                    .padding(horizontal = FS.space.s2, vertical = FS.space.s1),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = selected, onClick = null, modifier = Modifier.padding(FS.space.s3))
                Icon(Icons.Outlined.Usb, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(FS.space.s3))
                Text(d.displayName, style = MaterialTheme.typography.bodyLarge)
            }
            if (i < state.devices.size - 1) com.flagshipserver.app.ui.components.FSDivider()
        }
    }
    Spacer(Modifier.height(FS.space.s2))
    FSSecondaryButton(label = stringResource(R.string.rescan), onClick = onRefresh)
}

@Composable
private fun WarningCard(text: String) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .background(FS.colors.warning.copy(alpha = 0.10f))
            .border(1.dp, FS.colors.warning.copy(alpha = 0.4f), MaterialTheme.shapes.medium)
            .padding(FS.space.s4),
        horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(FS.space.s3),
    ) {
        Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = FS.colors.warning)
        Text(text, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun ProgressBlock(state: BuilderOnDeviceViewModel.State) {
    val label = when (state.phase) {
        BuilderOnDeviceViewModel.Phase.Downloading -> stringResource(R.string.downloading_2)
        BuilderOnDeviceViewModel.Phase.Verifying -> stringResource(R.string.verifying)
        BuilderOnDeviceViewModel.Phase.Injecting -> stringResource(R.string.preparing_2)
        BuilderOnDeviceViewModel.Phase.Writing -> stringResource(R.string.writing)
        else -> ""
    }
    FSCard {
        Text(label, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(FS.space.s2))
        if (state.progress > 0.0) {
            LinearProgressIndicator(
                progress = { state.progress.toFloat() },
                modifier = Modifier.fillMaxWidth().height(6.dp),
                color = FS.colors.accentText,
                trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
            )
        } else {
            LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth().height(6.dp),
                color = FS.colors.accentText,
                trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
            )
        }
        if (state.statusLine.isNotBlank()) {
            Spacer(Modifier.height(FS.space.s2))
            Text(state.statusLine, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun DoneBlock(message: String, onDone: () -> Unit) {
    FSCard {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(FS.space.s2)) {
            Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = FS.colors.success)
            Text(stringResource(R.string.all_done), style = MaterialTheme.typography.titleMedium)
        }
        Spacer(Modifier.height(FS.space.s2))
        Text(message, style = MaterialTheme.typography.bodyMedium)
    }
    Spacer(Modifier.height(FS.space.s4))
    FSPrimaryButton(label = stringResource(R.string.done), onClick = onDone, block = true)
}

@Composable
private fun ErrorBlock(error: String?, onRetry: () -> Unit) {
    FSCard {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(FS.space.s2)) {
            Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = MaterialTheme.colorScheme.error)
            Text(stringResource(R.string.couldnt_write_the_drive), style = MaterialTheme.typography.titleMedium)
        }
        Spacer(Modifier.height(FS.space.s2))
        Text(error ?: stringResource(R.string.unknown_error), style = MaterialTheme.typography.bodyMedium)
    }
    Spacer(Modifier.height(FS.space.s4))
    FSSecondaryButton(label = stringResource(R.string.try_again), onClick = onRetry, block = true)
}

@Composable
private fun NoUsbBlock(onRefresh: () -> Unit) {
    FSCard {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(FS.space.s2)) {
            Icon(Icons.Outlined.Usb, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(stringResource(R.string.no_usb_drive_detected), style = MaterialTheme.typography.titleMedium)
        }
        Spacer(Modifier.height(FS.space.s2))
        Text(
            stringResource(R.string.plug_a_usb_drive_into_this),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
    Spacer(Modifier.height(FS.space.s4))
    FSPrimaryButton(label = stringResource(R.string.rescan), onClick = onRefresh, block = true)
}
