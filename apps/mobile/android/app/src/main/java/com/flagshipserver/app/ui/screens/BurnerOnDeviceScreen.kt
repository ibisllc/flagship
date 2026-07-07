// "Burn to USB on this device" — the on-device USB-OTG burner UI (Android only).
//
// Public entry: BurnerOnDeviceScreen(recipeJson, onDone). Mirrors the desktop
// burner's option set: detected-drive picker, "this erases the drive" warning,
// a phase progress bar (download / verify / prepare / write), and success.
//
// The recipe-embedding step is a documented seam (VerbatimInjector) — see
// OTG-BURNER-NOTES.md. The download/verify/USB-write pipeline is fully real.

package com.flagshipserver.app.ui.screens

import android.app.Application
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
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
import com.flagshipserver.app.burner.BurnerOnDeviceViewModel
import com.flagshipserver.app.burner.usb.UsbHost
import com.flagshipserver.app.burner.usb.UsbMassStorageDevice
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout

/**
 * Self-contained on-device burner. Hook this up to the create-server delivery
 * chooser separately (it's intentionally NOT wired here).
 */
@Composable
fun BurnerOnDeviceScreen(recipeJson: String, onDone: () -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext as Application

    val vm: BurnerOnDeviceViewModel = viewModel(
        factory = viewModelFactory {
            initializer { BurnerOnDeviceViewModel(app, recipeJson) }
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
        if (Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(receiver, filter)
        }
        onDispose { runCatching { context.unregisterReceiver(receiver) } }
    }

    fun requestPermission() {
        val sel = state.selected ?: return
        val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        val pi = PendingIntent.getBroadcast(
            context, 0, Intent(UsbHost.ACTION_USB_PERMISSION).setPackage(context.packageName), flags,
        )
        UsbHost.requestPermission(UsbHost.manager(context), sel.device, pi)
    }

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      // Reading column — clamp + center on expanded panes; a no-op on phones.
      Column(
        modifier = Modifier
            .widthIn(max = FSLayout.readingMaxWidth)
            .fillMaxWidth()
            .padding(horizontal = FS.space.s6),
      ) {
        Spacer(Modifier.height(FS.space.s8))
        FSGhostButton(label = "← Back", onClick = onDone)
        Spacer(Modifier.height(FS.space.s3))
        Text(
            "Burn to USB on this device",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s2))
        Text(
            "Connect a USB drive with an OTG adapter, then write the bootable installer right here — no computer needed.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        )
        Spacer(Modifier.height(FS.space.s5))

        state.recipe?.let { r ->
            FSCard {
                Text("Server", color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium))
                Spacer(Modifier.height(FS.space.s1))
                Text(r.serverName, color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
                Spacer(Modifier.height(FS.space.s1))
                Text(r.serverDomain, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
            }
            Spacer(Modifier.height(FS.space.s4))
        }

        when (state.phase) {
            BurnerOnDeviceViewModel.Phase.Error -> ErrorBlock(state.error, onRetry = { vm.refreshDevices() })
            BurnerOnDeviceViewModel.Phase.Done -> DoneBlock(state.statusLine, onDone)
            BurnerOnDeviceViewModel.Phase.NoUsb -> NoUsbBlock(onRefresh = { vm.refreshDevices() })
            else -> {
                DrivePicker(state, onSelect = { vm.select(it) }, onRefresh = { vm.refreshDevices() })
                Spacer(Modifier.height(FS.space.s4))
                when (state.phase) {
                    BurnerOnDeviceViewModel.Phase.NeedPermission -> {
                        WarningCard("Allow access to this USB drive to continue.")
                        Spacer(Modifier.height(FS.space.s3))
                        FSPrimaryButton(label = "Allow USB access", onClick = { requestPermission() }, block = true)
                    }

                    BurnerOnDeviceViewModel.Phase.Ready -> {
                        WarningCard("Writing ERASES everything on the selected drive. Make sure it's the right one.")
                        Spacer(Modifier.height(FS.space.s3))
                        FSPrimaryButton(
                            label = "Erase and write",
                            onClick = { vm.startBurn() },
                            enabled = state.selected != null,
                            block = true,
                        )
                    }

                    BurnerOnDeviceViewModel.Phase.Downloading,
                    BurnerOnDeviceViewModel.Phase.Verifying,
                    BurnerOnDeviceViewModel.Phase.Injecting,
                    BurnerOnDeviceViewModel.Phase.Writing,
                    BurnerOnDeviceViewModel.Phase.Finalizing,
                    -> ProgressBlock(state)

                    else -> {}
                }
            }
        }

        Spacer(Modifier.height(FS.space.s10))
      }
    }
}

@Composable
private fun DrivePicker(
    state: BurnerOnDeviceViewModel.State,
    onSelect: (UsbMassStorageDevice) -> Unit,
    onRefresh: () -> Unit,
) {
    Text("USB drive", color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium))
    Spacer(Modifier.height(FS.space.s2))
    state.devices.forEach { d ->
        val selected = state.selected?.device?.deviceId == d.device.deviceId
        FSCard(modifier = Modifier.fillMaxWidth()) {
            Row(
                Modifier.fillMaxWidth().clickable(
                    interactionSource = MutableInteractionSource(),
                    indication = null,
                    onClick = { onSelect(d) },
                ),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    if (selected) "●" else "○",
                    color = if (selected) FS.colors.primary else FS.colors.textMuted,
                    modifier = Modifier.padding(end = FS.space.s3),
                )
                Text(d.displayName, color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Medium))
            }
        }
        Spacer(Modifier.height(FS.space.s2))
    }
    FSGhostButton(label = "Rescan", onClick = onRefresh)
}

@Composable
private fun WarningCard(text: String) {
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(FS.radius.md))
            .background(FS.colors.warning.copy(alpha = 0.10f))
            .border(1.dp, FS.colors.warning.copy(alpha = 0.4f), RoundedCornerShape(FS.radius.md))
            .padding(FS.space.s4),
    ) {
        Text(text, color = FS.colors.warning, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
    }
}

@Composable
private fun ProgressBlock(state: BurnerOnDeviceViewModel.State) {
    val label = when (state.phase) {
        BurnerOnDeviceViewModel.Phase.Downloading -> "Downloading"
        BurnerOnDeviceViewModel.Phase.Verifying -> "Verifying"
        BurnerOnDeviceViewModel.Phase.Injecting -> "Preparing"
        BurnerOnDeviceViewModel.Phase.Writing -> "Writing"
        BurnerOnDeviceViewModel.Phase.Finalizing -> "Finalizing"
        else -> ""
    }
    FSCard {
        Text(label, color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
        Spacer(Modifier.height(FS.space.s2))
        if (state.progress > 0.0) {
            LinearProgressIndicator(
                progress = { state.progress.toFloat() },
                modifier = Modifier.fillMaxWidth().height(6.dp),
                color = FS.colors.primary,
                trackColor = FS.colors.surfaceSunken,
            )
        } else {
            LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth().height(6.dp),
                color = FS.colors.primary,
                trackColor = FS.colors.surfaceSunken,
            )
        }
        if (state.statusLine.isNotBlank()) {
            Spacer(Modifier.height(FS.space.s2))
            Text(state.statusLine, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
        }
    }
}

@Composable
private fun DoneBlock(message: String, onDone: () -> Unit) {
    FSCard {
        Text("All done", color = FS.colors.success, style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold))
        Spacer(Modifier.height(FS.space.s2))
        Text(message, color = FS.colors.text, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
    }
    Spacer(Modifier.height(FS.space.s4))
    FSPrimaryButton(label = "Done", onClick = onDone, block = true)
}

@Composable
private fun ErrorBlock(error: String?, onRetry: () -> Unit) {
    FSCard {
        Text("Something went wrong", color = FS.colors.danger, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
        Spacer(Modifier.height(FS.space.s2))
        Text(error ?: "Unknown error.", color = FS.colors.text, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
    }
    Spacer(Modifier.height(FS.space.s4))
    FSSecondaryButton(label = "Try again", onClick = onRetry, block = true)
}

@Composable
private fun NoUsbBlock(onRefresh: () -> Unit) {
    FSCard {
        Text("No USB drive detected", color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
        Spacer(Modifier.height(FS.space.s2))
        Text(
            "Plug a USB drive into this phone with a USB-OTG adapter, then tap Rescan.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        )
    }
    Spacer(Modifier.height(FS.space.s4))
    FSPrimaryButton(label = "Rescan", onClick = onRefresh, block = true)
}
