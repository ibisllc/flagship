// Home screen — account-wide overview + drill-down into each pod.
// Mirrors iOS HomeScreen with a Kotlin-idiomatic signature (the
// caller passes data + callbacks rather than reaching into Environment).

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.VpnKey
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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
import com.flagshipserver.app.ui.components.FSAnnouncementCard
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSChipItem
import com.flagshipserver.app.ui.components.FSChipRow
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSListLeading
import com.flagshipserver.app.ui.components.FSListRow
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSearchField
import com.flagshipserver.app.ui.components.HomeStatusFilter
import com.flagshipserver.app.ui.components.PodStatusStyle
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout
import com.flagshipserver.app.viewmodels.LoadingState

@Composable
fun HomeScreen(
    state: LoadingState<ServerDetailResponse>,
    username: String,
    /** Locally-decrypted account name; null while locked or not yet set. */
    accountDisplayName: String? = null,
    /** Locally-decrypted name THIS device chose for itself. */
    deviceDisplayName: String? = null,
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
    /** Lowercased fqdns of servers with a LIVE pending boot-unlock request
     *  (the box is waiting for the owner's approval). Drives the per-card
     *  liveness classification — a waiting box reads "Waiting for approval",
     *  never "Never came online". Source: AppState.serversAwaiting(UNLOCK_KEY). */
    awaitingApproval: Set<String> = emptySet(),
    /** The entitlement (serve-auth) waiting set — same role for the other inbox
     *  lane, so a box waiting on entitlement reads "Waiting for approval", not
     *  "Never came online". Source: AppState.serversAwaiting(ENTITLEMENT). */
    awaitingEntitlement: Set<String> = emptySet(),
) {
    val scroll = rememberScrollState()
    // Search text over the server list (name / fqdn / description). Pure
    // presentation — never mutates `pods`. Empty ⇒ no filtering.
    var search by remember { mutableStateOf("") }
    // Active status filter chip. ALL shows every server; the others narrow the
    // list by derived liveness. Pure presentation; every action is untouched.
    var statusFilter by remember { mutableStateOf(HomeStatusFilter.ALL) }

    // Derived liveness per pod (folds in the cheap directory awaitingUnlock
    // flag OR the account-level biometric-watcher waiting signal).
    fun livenessOf(pod: PodInfo): PodInfo.LivenessState =
        pod.livenessState(
            hasLiveUnlockRequest = pod.awaitingUnlock ||
                awaitingApproval.contains(pod.fqdn.lowercase()) ||
                awaitingEntitlement.contains(pod.fqdn.lowercase()),
        )

    // Per-filter counts off the full pod set (search-independent) so the chip
    // badges read the account-wide totals.
    fun filterCount(f: HomeStatusFilter): Int =
        pods.count { f.matches(livenessOf(it), it.status) }

    // Pods narrowed by the active chip AND the search query.
    val q = search.trim().lowercase()
    val visiblePods = pods.filter { pod ->
        val matchesFilter = statusFilter.matches(livenessOf(pod), pod.status)
        val matchesSearch = q.isEmpty() ||
            pod.name.lowercase().contains(q) ||
            pod.fqdn.lowercase().contains(q) ||
            (pod.description?.lowercase()?.contains(q) ?: false)
        matchesFilter && matchesSearch
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(scroll),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      // Reading column — on an expanded (tablet) pane the rows/cards/chip row
      // are clamped to a comfortable measure and centered; a no-op on phones.
      Column(
        modifier = Modifier
            .widthIn(max = FSLayout.readingMaxWidth)
            .fillMaxWidth()
            .padding(horizontal = FS.space.s6),
      ) {
        Spacer(Modifier.height(FS.space.s12))
        // Large title + greeting subheader.
        Text(
            text = "Home",
            color = FS.colors.text,
            style = TextStyle(fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.Bold),
            modifier = Modifier.testTag("home-title"),
        )
        Text(
            text = homeIdentityLine(accountDisplayName, username, deviceDisplayName),
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
            modifier = Modifier.testTag("home-welcome"),
        )

        if (deviceCapability != null && !deviceCapability.isFullyScoped) {
            Spacer(Modifier.height(FS.space.s2))
            DeviceCapabilityChip(cap = deviceCapability)
        }

        // One announcement at a time, highest priority first: an account-reset
        // (danger) suppresses everything; otherwise the backup banner, then the
        // recovery nudge. All three fold into one FSAnnouncementCard.
        TopAnnouncement(
            accountWasReset = accountWasReset,
            showRecoveryBackupBanner = showRecoveryBackupBanner,
            showRecoveryNudge = showRecoveryNudge,
            onSignInAgain = onSignInAgain,
            onSetUpRecovery = onSetUpRecovery,
            onDismissRecoveryBackupBanner = onDismissRecoveryBackupBanner,
            onDismissRecoveryNudge = onDismissRecoveryNudge,
        )

        Spacer(Modifier.height(FS.space.s8))

        if (pods.isEmpty()) {
            EmptyServerCard(onAddServer = onAddServer)
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                FSSearchField(
                    value = search,
                    onValueChange = { search = it },
                    placeholder = "Search servers",
                )
                FSChipRow(
                    items = HomeStatusFilter.allCases().map {
                        FSChipItem(value = it, label = it.label, count = filterCount(it))
                    },
                    selection = statusFilter,
                    onSelect = { statusFilter = it },
                )
                if (visiblePods.isEmpty()) {
                    FSCard {
                        Text(
                            "No servers match “${if (search.isEmpty()) statusFilter.label.lowercase() else search}”.",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 13.sp),
                        )
                    }
                } else {
                    visiblePods.forEach { pod ->
                        ServerRow(
                            pod = pod,
                            isLeader = pod.podId == leaderPodId,
                            liveness = livenessOf(pod),
                            onTap = { onOpenPod(pod) },
                            onSetLeader = { onSetLeader(pod) },
                            onDelete = { onDeleteServer(pod) },
                        )
                    }
                }
                FSGhostButton(
                    label = "Add a server",
                    onClick = onAddServer,
                    block = true,
                    modifier = Modifier.testTag("home-add-server"),
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
}

/// The single highest-priority announcement card. Folds the three stacked
/// banners (account-reset / backup / recovery-nudge) into one
/// FSAnnouncementCard, danger-tinted for the account-reset case. Each path
/// keeps its own CTA + dismiss callbacks verbatim.
@Composable
private fun TopAnnouncement(
    accountWasReset: Boolean,
    showRecoveryBackupBanner: Boolean,
    showRecoveryNudge: Boolean,
    onSignInAgain: () -> Unit,
    onSetUpRecovery: () -> Unit,
    onDismissRecoveryBackupBanner: () -> Unit,
    onDismissRecoveryNudge: () -> Unit,
) {
    when {
        accountWasReset -> {
            Spacer(Modifier.height(FS.space.s4))
            FSAnnouncementCard(
                icon = Icons.Outlined.ErrorOutline,
                title = "This device was removed from your account",
                message = "Another device on this account ran Disconnect, Replace, or " +
                    "Wipe. Sign in again with your recovery passkey to get back in.",
                ctaLabel = "Sign in again",
                tint = FS.colors.danger,
                onCta = onSignInAgain,
                modifier = Modifier.testTag("account-reset-banner"),
            )
        }
        showRecoveryBackupBanner -> {
            Spacer(Modifier.height(FS.space.s4))
            FSAnnouncementCard(
                icon = Icons.Outlined.VpnKey,
                title = "Your account isn't backed up yet",
                message = "If you lose access to this device, you may lose access to your Flagship cloud",
                ctaLabel = "Secure my account",
                onCta = onSetUpRecovery,
                onDismiss = onDismissRecoveryBackupBanner,
                modifier = Modifier.testTag("recovery-backup-banner"),
            )
        }
        showRecoveryNudge -> {
            Spacer(Modifier.height(FS.space.s4))
            FSAnnouncementCard(
                icon = Icons.Outlined.VpnKey,
                title = "Set up recovery",
                message = "Right now, recovering this account without this phone takes a " +
                    "3-day wait that anyone who knows your username can start. Bank a " +
                    "passkey so you can recover instantly and privately instead.",
                ctaLabel = "Set it up",
                onCta = onSetUpRecovery,
                onDismiss = onDismissRecoveryNudge,
                modifier = Modifier.testTag("recovery-nudge-card"),
            )
        }
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
    val label = "Restricted device · $summary"
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
                "You don't have any servers yet. Add your first server to start running your own services.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
            )
            Spacer(Modifier.height(FS.space.s2))
            FSPrimaryButton(
                label = "Add your first server",
                onClick = onAddServer,
                block = true,
                modifier = Modifier.testTag("home-add-server"),
            )
        }
    }
}

internal fun homeIdentityLine(accountDisplayName: String?, username: String, deviceDisplayName: String?): String {
    val account = accountDisplayName?.takeIf { it.isNotEmpty() } ?: username
    return deviceDisplayName?.takeIf { it.isNotEmpty() }?.let { "$account > $it" } ?: account
}

/// Leading-icon tint for a server row, mirroring iOS
/// `PodStatusStyle.iconColor` — derived off the same pill kind so the row's
/// status icon, the pill, and the label never drift.
@Composable
private fun statusIconColor(liveness: PodInfo.LivenessState, status: PodInfo.Status): Color =
    when (PodStatusStyle.pillKind(liveness, status)) {
        FSPillKind.Online -> FS.colors.success
        FSPillKind.Renewing -> FS.colors.warning
        FSPillKind.Offline -> FS.colors.danger
        FSPillKind.Provisioning -> FS.colors.primary
        FSPillKind.Pending -> FS.colors.warning
        FSPillKind.Idle -> FS.colors.textMuted
    }

/// Status / fqdn subtitle line for a server row. Prefers the user-set
/// description when present (that's what the user named it for), else the
/// fqdn, else the status label.
private fun serverSubtitle(pod: PodInfo, liveness: PodInfo.LivenessState): String {
    if (!pod.description.isNullOrEmpty()) return pod.description!!
    if (pod.fqdn.isNotEmpty()) return pod.fqdn
    return PodStatusStyle.label(liveness, pod.status)
}

/// A single server list row (FSListRow): a leading status-tinted icon, the
/// name as title, the description/fqdn subtitle, a trailing Leader badge +
/// status pill + chevron, and a demo install-progress bar when applicable.
/// Tap opens the server; long-press surfaces the full context menu
/// (make-leader / open / cancel-pending / delete-dead) preserved verbatim.
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ServerRow(
    pod: PodInfo,
    isLeader: Boolean,
    liveness: PodInfo.LivenessState,
    onTap: () -> Unit,
    onSetLeader: () -> Unit,
    onDelete: () -> Unit = {},
) {
    // A pending order, or a GENUINELY dead box (registered, no live unlock
    // request, no check-in, past the grace window), is deletable straight from
    // the list via the release flow. A live, checked-in server — OR one that's
    // waiting for approval / still coming online — is NOT.
    val deletable = pod.status == PodInfo.Status.PENDING || liveness == PodInfo.LivenessState.DEAD
    val canMakeLeader = !isLeader && pod.status == PodInfo.Status.ONLINE && pod.cameOnline

    var menuOpen by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }

    val pillTag: String? = when (liveness) {
        PodInfo.LivenessState.DEAD -> "pod-card-never-online"
        PodInfo.LivenessState.OFFLINE -> "pod-card-offline"
        PodInfo.LivenessState.WAITING_FOR_APPROVAL -> "pod-card-waiting-approval"
        PodInfo.LivenessState.COMING_ONLINE ->
            if (pod.status == PodInfo.Status.PENDING) null else "pod-card-coming-online"
        PodInfo.LivenessState.ONLINE -> null
    }

    Box {
        FSListRow(
            leading = FSListLeading.Icon(Icons.Outlined.Dns, statusIconColor(liveness, pod.status)),
            title = pod.name,
            subtitle = serverSubtitle(pod, liveness),
            modifier = Modifier.combinedClickable(
                onClick = onTap,
                onLongClick = { menuOpen = true },
            ),
            below = {
                // Status pill (+ Leader badge) stacks UNDER the text on its own
                // line — a long label like "Never came online" would be crushed
                // in the right-floated trailing slot against the server name.
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                ) {
                    // Leader = the daemon the screens point at; only badge a
                    // server that actually came online.
                    if (isLeader && pod.cameOnline && pod.status != PodInfo.Status.PENDING) FSPill("Leader", kind = FSPillKind.Online)
                    // Per-service leadership (Phase 6): the services this box leads
                    // (from /pods `leadsServices`). Tolerant of absence.
                    LeadServicesPill(pod)
                    FSPill(
                        label = PodStatusStyle.label(pod, liveness),
                        kind = PodStatusStyle.pillKind(liveness, pod.status),
                        modifier = if (pillTag != null) Modifier.testTag(pillTag) else Modifier,
                    )
                }
            },
            trailing = {
                // Navigation chevron stays right, vertically centered.
                Text("›", color = FS.colors.textMuted, style = TextStyle(fontSize = 18.sp))
            },
        )

        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            if (canMakeLeader) {
                DropdownMenuItem(
                    text = { Text("Make leader") },
                    onClick = { menuOpen = false; onSetLeader() },
                )
            }
            DropdownMenuItem(
                text = { Text("Open") },
                onClick = { menuOpen = false; onTap() },
            )
            if (deletable) {
                DropdownMenuItem(
                    text = { Text("Delete server (free name)") },
                    modifier = Modifier.testTag("pod-card-delete"),
                    onClick = { menuOpen = false; confirming = true },
                )
            }
        }

        // "Your server is being installed" — a thin determinate bar on a demo
        // server still pre-`ready`, overlaid at the row's bottom edge.
        val demo = pod.demoServer
        if (demo != null && ProvisionProgress.shouldShowProgressBar(demo.phase, demo.status)) {
            DemoProgressBar(
                fraction = ProvisionProgress.fraction(demo.phase),
                failed = demo.phase == "failed",
                modifier = Modifier
                    .testTag("pod-card-install-progress")
                    .align(Alignment.BottomStart)
                    .fillMaxWidth()
                    .padding(horizontal = FS.space.s4, vertical = FS.space.s3),
            )
        }
    }

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

/// Reusable compact server card — retained for previews / any non-Home caller.
/// The Home list now renders each server as an [ServerRow]; this dense card is
/// the legacy presentation and is no longer used by HomeScreen itself.
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
    /** Derived per-server liveness. Defaults to deriving from the pod alone
     *  (no live unlock request known) so existing callers / previews keep
     *  their behaviour; the Home list supplies the account-level signal. */
    liveness: PodInfo.LivenessState = pod.livenessState(hasLiveUnlockRequest = false),
) {
    val deletable = pod.status == PodInfo.Status.PENDING || liveness == PodInfo.LivenessState.DEAD
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
                    if (isLeader && pod.cameOnline && pod.status != PodInfo.Status.PENDING) FSPill("Leader", kind = FSPillKind.Online)
                    // Per-service leadership (Phase 6): "Leads N" badge, tolerant
                    // of absence (renders nothing when the box leads nothing).
                    LeadServicesPill(pod)
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
                FSPill(
                    label = PodStatusStyle.label(pod, liveness),
                    kind = PodStatusStyle.pillKind(liveness, pod.status),
                )
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
                "${detail.serviceCount} services · server ${detail.daemonVersion}",
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

/// Per-service leadership (Phase 6) — a small "Leads N" indicator for a box that
/// is the current lead for one or more services (`PodInfo.leadsServices` from
/// `/pods`). Tolerant of absence: renders nothing when the list is empty or the
/// box never came online (a dead box is never badged as leading). Mirror of iOS
/// LeadServicesBadge.
@Composable
fun LeadServicesPill(pod: PodInfo) {
    val services = pod.leadsServices
    if (!pod.cameOnline || services.isEmpty()) return
    val label = if (services.size == 1) "Leads ${services[0]}" else "Leads ${services.size} services"
    FSPill(label, kind = FSPillKind.Online, modifier = Modifier.testTag("pod-leads-badge"))
}
