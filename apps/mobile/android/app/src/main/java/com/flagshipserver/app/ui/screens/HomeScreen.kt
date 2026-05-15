// Home screen — account-wide overview + drill-down into each pod.
// Mirrors iOS HomeScreen with a Kotlin-idiomatic signature (the
// caller passes data + callbacks rather than reaching into Environment).

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.ServerDetailResponse
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.LoadingState

@Composable
fun HomeScreen(
    state: LoadingState<ServerDetailResponse>,
    username: String,
    pods: List<PodInfo>,
    leaderPodId: String?,
    onOpenPod: (PodInfo) -> Unit,
    onAddServer: () -> Unit,
    onSetLeader: (PodInfo) -> Unit,
    onRefresh: () -> Unit,
    /** When true, renders the C9 recovery-setup nudge card above the
     *  server list. Source-of-truth is AppState.shouldShowRecoveryNudgeNow();
     *  the shell evaluates that and passes the resolved boolean so this
     *  composable stays previewable without an AppState dependency. */
    showRecoveryNudge: Boolean = false,
    onSetUpRecovery: () -> Unit = {},
    onDismissRecoveryNudge: () -> Unit = {},
    /** E7 — renders the account-was-reset danger banner above
     *  everything else. Suppresses the recovery nudge while shown so
     *  the two banners don't stack. */
    accountWasReset: Boolean = false,
    onSignInAgain: () -> Unit = {},
) {
    val scroll = rememberScrollState()
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s12))
        Text(
            text = "Hi${if (username.isNotEmpty()) ", $username." else "."}",
            color = FS.colors.text,
            style = TextStyle(fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            text = when {
                pods.isEmpty() -> "No servers yet."
                pods.any { it.status == PodInfo.Status.OFFLINE } -> "One server is offline."
                else -> "Everything is online."
            },
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
        )

        if (accountWasReset) {
            Spacer(Modifier.height(FS.space.s4))
            AccountResetBanner(onSignInAgain = onSignInAgain)
        }

        if (showRecoveryNudge && !accountWasReset) {
            Spacer(Modifier.height(FS.space.s4))
            RecoveryNudgeCard(
                onSetUp = onSetUpRecovery,
                onDismiss = onDismissRecoveryNudge,
            )
        }

        Spacer(Modifier.height(FS.space.s8))

        if (pods.isEmpty()) {
            EmptyServerCard(onAddServer = onAddServer)
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                pods.forEach { pod ->
                    PodCard(
                        pod = pod,
                        isLeader = pod.podId == leaderPodId,
                        onTap = { onOpenPod(pod) },
                        onSetLeader = { onSetLeader(pod) },
                    )
                }
                FSGhostButton(
                    label = "Add a server",
                    onClick = onAddServer,
                    block = true,
                )
            }
        }

        Spacer(Modifier.height(FS.space.s6))

        when (state) {
            is LoadingState.Loaded -> ServerOverviewCard(state.value, onRefresh = onRefresh)
            is LoadingState.Failed -> ErrorCard(message = state.message, onRetry = onRefresh)
            else -> ServerCardSkeleton()
        }
        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun EmptyServerCard(onAddServer: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s6)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(
                "Add your first server",
                color = FS.colors.text,
                style = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                "Order a pre-built box (~$199) or flash any old PC. Either way, about ten minutes.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
            )
            Spacer(Modifier.height(FS.space.s2))
            FSPrimaryButton(label = "Add a server", onClick = onAddServer, block = true)
        }
    }
}

@Composable
fun PodCard(
    pod: PodInfo,
    isLeader: Boolean,
    onTap: () -> Unit,
    onSetLeader: () -> Unit,
) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.fillMaxWidth().padding(end = FS.space.s4)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                ) {
                    Text(
                        pod.name,
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
                    )
                    if (isLeader) FSPill("Leader", kind = FSPillKind.Online)
                }
                if (!pod.description.isNullOrEmpty()) {
                    Text(
                        pod.description!!,
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 13.sp),
                    )
                }
                Spacer(Modifier.height(FS.space.s1))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    FSPill(
                        label = pod.status.name.lowercase().replaceFirstChar { it.uppercase() },
                        kind = when (pod.status) {
                            PodInfo.Status.ONLINE -> FSPillKind.Online
                            PodInfo.Status.PENDING -> FSPillKind.Provisioning
                            PodInfo.Status.OFFLINE -> FSPillKind.Offline
                            PodInfo.Status.UNKNOWN -> FSPillKind.Offline
                        },
                    )
                }
            }
            FSGhostButton(label = "Open", onClick = onTap)
        }
        if (!isLeader && pod.status == PodInfo.Status.ONLINE) {
            Spacer(Modifier.height(FS.space.s2))
            FSGhostButton(label = "Make leader", onClick = onSetLeader)
        }
    }
}

@Composable
private fun ServerOverviewCard(detail: ServerDetailResponse, onRefresh: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                detail.serverFqdn,
                color = FS.colors.text,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Medium),
            )
            Text(
                "${detail.appCount} apps · daemon ${detail.daemonVersion}",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            FSGhostButton(label = "Refresh", onClick = onRefresh)
        }
    }
}

@Composable
fun ServerCardSkeleton() {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text("…", color = FS.colors.textMuted, style = TextStyle(fontSize = 16.sp))
            Text("Loading…", color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
        }
    }
}

@Composable
fun ErrorCard(message: String, onRetry: (() -> Unit)? = null) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text("Couldn't load", color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
            Text(message, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
            if (onRetry != null) FSGhostButton(label = "Retry", onClick = onRetry)
        }
    }
}

/** E7 — "your account was reset on another device" danger banner.
 *  Renders above everything else (including the recovery nudge,
 *  which is suppressed while shown). Tapping Sign-in-again drops
 *  the user back to Welcome via app.signOut(). */
@Composable
private fun AccountResetBanner(onSignInAgain: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(
                "This device was removed from your account",
                color = FS.colors.text,
                style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                "Another device on this account ran Disconnect, Replace, or " +
                    "Wipe. Sign in again with your recovery passkey to get back in.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
            )
            FSPrimaryButton(label = "Sign in again", onClick = onSignInAgain, block = true)
        }
    }
}

/** Home recovery-setup nudge — mirrors iOS HomeScreen.recoveryNudge.
 *  Visible when the user has at least one online pod and hasn't yet
 *  uploaded a cloud-recovery envelope. "Set it up" routes to the
 *  RecoveryScreen on the Settings tab; "Not now" dismisses for this
 *  session only (banner re-appears next launch by design — recovery
 *  is important enough to keep nudging). */
@Composable
private fun RecoveryNudgeCard(onSetUp: () -> Unit, onDismiss: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(
                "Set up recovery",
                color = FS.colors.text,
                style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                "Right now this phone is the only way back into your account. " +
                    "Bank a passkey so you can recover if you lose this device.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
            ) {
                FSPrimaryButton(label = "Set it up", onClick = onSetUp)
                FSGhostButton(label = "Not now", onClick = onDismiss)
            }
        }
    }
}
