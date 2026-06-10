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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.api.DeviceCapabilityBlock
import com.flagshipserver.app.api.DeviceScope
import com.flagshipserver.app.api.ServerDetailResponse
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.ProvisionProgress
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
    /** Decommission a pending or registered-but-dead (never-came-online)
     *  server via the release/free-the-name flow. No-op default. */
    onDeleteServer: (PodInfo) -> Unit = {},
    /** When true, renders the C9 recovery-setup nudge card above the
     *  server list. Source-of-truth is AppState.shouldShowRecoveryNudgeNow();
     *  the shell evaluates that and passes the resolved boolean so this
     *  composable stays previewable without an AppState dependency. */
    showRecoveryNudge: Boolean = false,
    onSetUpRecovery: () -> Unit = {},
    onDismissRecoveryNudge: () -> Unit = {},
    /** Mirror of the webapp's persistent post-creation backup-reminder
     *  banner (apps/web/public/webapp/views/home.js). True when
     *  !hasCloudRecovery AND the user hasn't persistently dismissed.
     *  Distinct from `showRecoveryNudge`: the nudge above quick-actions
     *  gates on at-least-one-online-pod + session-only dismiss; this
     *  banner gates on neither, so it surfaces immediately after
     *  account creation and stays hidden across launches once dismissed. */
    showRecoveryBackupBanner: Boolean = false,
    onDismissRecoveryBackupBanner: () -> Unit = {},
    /** E7 — renders the account-was-reset danger banner above
     *  everything else. Suppresses the recovery nudge while shown so
     *  the two banners don't stack. */
    accountWasReset: Boolean = false,
    onSignInAgain: () -> Unit = {},
    /** v2 device-addressing — when non-null AND not fully-scoped, the
     *  header renders a "Device: <label> · browse-only" chip below
     *  the username. Nil ⇒ legacy single-IRK path, no chip. Source:
     *  AppState.deviceCapability. The home screen itself doesn't yet
     *  render the vibe-code quick-action buttons (those live on the
     *  Apps tab on Android v1.0); the chip is
     *  the first visible v2 surface here. */
    deviceCapability: DeviceCapabilityBlock? = null,
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

        if (deviceCapability != null && !deviceCapability.isFullyScoped) {
            Spacer(Modifier.height(FS.space.s2))
            DeviceCapabilityChip(cap = deviceCapability)
        }

        if (accountWasReset) {
            Spacer(Modifier.height(FS.space.s4))
            AccountResetBanner(onSignInAgain = onSignInAgain)
        }

        if (showRecoveryBackupBanner && !accountWasReset) {
            Spacer(Modifier.height(FS.space.s4))
            RecoveryBackupBanner(
                onSecure = onSetUpRecovery,
                onDismiss = onDismissRecoveryBackupBanner,
            )
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
                        onDelete = { onDeleteServer(pod) },
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

/// v2 device-addressing — "Device: <label> · browse-only" chip
/// surfaced below the username when the active session is a
/// restricted sub-identity. The detailed scope breakdown lives behind
/// Settings → About this device (out-of-scope for this commit).
/// `browse-only` is the canonical reviewer state; anything else
/// summarises as "N scopes" so the chip stays one-line.
@Composable
private fun DeviceCapabilityChip(cap: DeviceCapabilityBlock) {
    val summary = if (cap.scopeSet == setOf(DeviceScope.BROWSE)) {
        "browse-only"
    } else {
        "${cap.scopes.size} scopes"
    }
    val label = "Device: ${cap.label} · $summary"
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .clip(RoundedCornerShape(FS.radius.sm))
            .background(FS.colors.textMuted.copy(alpha = 0.08f))
            .padding(horizontal = FS.space.s3, vertical = 4.dp)
            .semantics { contentDescription = label }
            .testTag("device-capability-chip"),
    ) {
        Text(
            text = label,
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium),
        )
    }
}

@Composable
private fun EmptyServerCard(onAddServer: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s6)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(
                "Your account is ready",
                color = FS.colors.text,
                style = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                "Now add your first server. Order a pre-built box (~$199) or flash any old PC — either way, about ten minutes. You can add more servers anytime.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
            )
            Spacer(Modifier.height(FS.space.s2))
            FSPrimaryButton(label = "Add your first server", onClick = onAddServer, block = true)
        }
    }
}

@Composable
fun PodCard(
    pod: PodInfo,
    isLeader: Boolean,
    onTap: () -> Unit,
    onSetLeader: () -> Unit,
    /** Decommission a pending OR registered-but-dead (never-came-online)
     *  server via the release/free-the-name flow. No-op default keeps the
     *  card previewable + leaves a live server's card unchanged. */
    onDelete: () -> Unit = {},
) {
    // A pending order, or a registered box whose daemon never checked in, is
    // deletable straight from the list via the release flow. A live, checked-in
    // server is NOT — it keeps the lost/stolen revoke on its detail page.
    val deletable = pod.status == PodInfo.Status.PENDING || !pod.cameOnline
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
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
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
                    // Registered during install but never came online — a dead
                    // box. Distinguishes it from a live server in the list.
                    if (pod.status != PodInfo.Status.PENDING && !pod.cameOnline) {
                        FSPill(
                            label = "Never came online",
                            kind = FSPillKind.Offline,
                            modifier = Modifier.testTag("pod-card-never-online"),
                        )
                    }
                }
                // "Your server is being installed" — a thin determinate
                // bar on a demo server still pre-`ready`.
                val demo = pod.demoServer
                if (demo != null &&
                    ProvisionProgress.shouldShowProgressBar(demo.phase, demo.status)
                ) {
                    Spacer(Modifier.height(FS.space.s2))
                    DemoProgressBar(
                        fraction = ProvisionProgress.fraction(demo.phase),
                        failed = demo.phase == "failed",
                        modifier = Modifier.testTag("pod-card-install-progress"),
                    )
                }
            }
            FSGhostButton(label = "Open", onClick = onTap)
        }
        if (!isLeader && pod.status == PodInfo.Status.ONLINE && pod.cameOnline) {
            Spacer(Modifier.height(FS.space.s2))
            FSGhostButton(label = "Make leader", onClick = onSetLeader)
        }
        if (deletable) {
            var confirming by remember { mutableStateOf(false) }
            Spacer(Modifier.height(FS.space.s2))
            FSGhostButton(
                label = "Delete server (free name)",
                onClick = { confirming = true },
                modifier = Modifier.testTag("pod-card-delete"),
            )
            if (confirming) {
                AlertDialog(
                    onDismissRequest = { confirming = false },
                    title = { Text("Delete ${pod.name}?") },
                    text = {
                        Text(
                            "This frees the name for reuse and the box can no longer come online. " +
                                if (pod.status == PodInfo.Status.PENDING) "This install hasn't completed." else "This server never checked in.",
                        )
                    },
                    confirmButton = {
                        TextButton(onClick = { confirming = false; onDelete() }) { Text("Delete") }
                    },
                    dismissButton = {
                        TextButton(onClick = { confirming = false }) { Text("Cancel") }
                    },
                )
            }
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
                "${detail.serviceCount} apps · daemon ${detail.daemonVersion}",
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

/** Persistent post-creation backup-reminder banner. Mirrors the
 *  webapp banner in apps/web/public/webapp/views/home.js — surfaces
 *  the moment the user lands on Home without a cloud-recovery
 *  envelope (no online-pod gate), and stays hidden across launches
 *  once "Not now" is tapped. Tapping "Secure my account" routes into
 *  the existing recovery flow on the Settings tab. */
@Composable
private fun RecoveryBackupBanner(onSecure: () -> Unit, onDismiss: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(
            verticalArrangement = Arrangement.spacedBy(FS.space.s3),
            modifier = Modifier.testTag("recovery-backup-banner"),
        ) {
            Text(
                "Your account isn't backed up yet",
                color = FS.colors.text,
                style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                "If you lose this device, there's no way back in. Set up " +
                    "recovery now (one minute) so you can restore your account.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                FSPrimaryButton(label = "Secure my account", onClick = onSecure)
                FSGhostButton(label = "Not now", onClick = onDismiss)
            }
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
