// "Quick approve from watch" on Settings → Account security, the twin of
// iOS's "Quick approve from Apple Watch" (docs/watch-delegate-key-design.md
// §4). Default off. On mints this device's boot-approval-only delegate key and
// has the account key attest it (one biometric); off revokes it. The Wear OS
// app's Approve works only while it is on.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.FlagshipDateFormat
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.WatchDelegatePhase
import com.flagshipserver.app.viewmodels.WatchDelegateViewModel
import kotlinx.coroutines.launch

@Composable
fun WatchQuickApproveCard(server: FlagshipServerClient, app: AppState) {
    val vm: WatchDelegateViewModel = viewModel(
        key = "watch-delegate",
        factory = viewModelFactory {
            initializer { WatchDelegateViewModel(server = server, username = { app.currentUser.value }) }
        },
    )
    val phase by vm.phase.collectAsState()
    val enabled by vm.isEnabled.collectAsState()
    val expiresAt by vm.expiresAt.collectAsState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { vm.load() }

    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Quick approve from watch",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                    modifier = Modifier.weight(1f),
                )
                Switch(
                    checked = enabled,
                    onCheckedChange = { want -> scope.launch { if (want) vm.enable() else vm.disable() } },
                    enabled = phase != WatchDelegatePhase.Enabling && phase != WatchDelegatePhase.Disabling,
                    modifier = Modifier.testTag("watch-delegate-toggle"),
                )
            }
            Spacer(Modifier.height(FS.space.s2))
            Text(
                "Approve a server boot from your Wear OS watch while Flagship is unlocked on this phone. " +
                    "Other actions (revoke server, wipe & restart, replace device) always need your phone. Off by default.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            val exp = expiresAt
            if (enabled && exp != null) {
                Spacer(Modifier.height(FS.space.s2))
                Text(
                    "Active — renews by ${FlagshipDateFormat.format(exp)}",
                    color = FS.colors.success,
                    style = TextStyle(fontSize = 13.sp),
                    modifier = Modifier.testTag("watch-delegate-active"),
                )
            }
            (phase as? WatchDelegatePhase.Failed)?.let {
                Spacer(Modifier.height(FS.space.s2))
                Text(
                    it.message,
                    color = FS.colors.danger,
                    style = TextStyle(fontSize = 13.sp),
                    modifier = Modifier.testTag("watch-delegate-failed-msg"),
                )
            }
        }
    }
}
