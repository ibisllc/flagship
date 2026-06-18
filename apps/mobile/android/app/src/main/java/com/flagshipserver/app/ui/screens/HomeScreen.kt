// Home screen — account-wide overview + drill-down into each pod.
// Mirrors iOS HomeScreen with a Kotlin-idiomatic signature (the
// caller passes data + callbacks rather than reaching into Environment).

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.AddCircleOutline
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.GroupAdd
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.PauseCircle
import androidx.compose.material.icons.outlined.Restore
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.SystemUpdateAlt
import androidx.compose.material.icons.outlined.Verified
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSEmptyState
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSNote
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSSectionHeader
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.VpnKey
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.api.DeviceCapabilityBlock
import com.flagshipserver.app.api.DeviceScope
import com.flagshipserver.app.api.ServerDetailResponse
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.ProvisionProgress
import com.flagshipserver.app.core.ServerOrderProtocol
import com.flagshipserver.app.ui.components.FSAnnouncementCard
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSChipItem
import com.flagshipserver.app.ui.components.FSChipRow
import com.flagshipserver.app.ui.components.FSGhostButton
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
    /** The servers in the owner's order (AppState.orderedPods). */
    pods: List<PodInfo>,
    /** issuedAt of the order on screen; 0 when the owner never ordered
     *  (AppState.serverOrderIssuedAt). */
    serverOrderIssuedAt: Long = 0,
    /** Per pod id, the issuedAt of the order that box holds
     *  (AppState.serverOrderAcks): the Leader badge is gray until the
     *  leader holds the order on screen. */
    serverOrderAcks: Map<String, Long> = emptyMap(),
    onOpenPod: (PodInfo) -> Unit,
    onAddServer: () -> Unit,
    /** "Import a backup" in the Add/Import chooser. */
    onImportBackup: () -> Unit = {},
    /** "Restore from other servers": a lost server's backup comes back from
     *  the pieces other accounts' servers keep (docs/peer-backup.md). */
    onRestoreFromPeers: () -> Unit = {},
    /** "Co-manage a running server": accept a server another account
     *  shares (docs/share-a-server.md), from the Add/Import chooser. */
    onCoManage: () -> Unit = {},
    /** Only an admin device of the account sees "Add/Import a server", in
     *  the list and on the empty state ([showsAddServer]). */
    canAddServers: Boolean = true,
    /** Reorder, Make leader and Delete are admin orders `.com` checks under
     *  the admin root (AdminOrderGate): other devices list servers only. */
    canChangeServers: Boolean = true,
    /** Move a server to the top of the order (docs/server-order.md). */
    onMakeLeader: (PodInfo) -> Unit,
    onRefresh: () -> Unit,
    /** The owner dropped a server somewhere new: the pod ids in their new order. */
    onReorder: (List<String>) -> Unit = {},
    /** Delete a server after [DeleteServerDialog] confirms: a pending order
     *  is cancelled, a registered server deleted. No-op default. */
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
    /** Servers other accounts share with this one (docs/share-a-server.md §8), under the server list. */
    sharedWithMe: (@Composable () -> Unit)? = null,
    /** `.com` refused the account read token and none could be minted
     *  without a prompt (docs/account-read-token.md): the list shows its
     *  last state, and a quiet line says so. */
    statusPaused: Boolean = false,
    /** Unlock the account key once, mint a read token and reload
     *  (docs/account-read-token.md "A refused read is never no servers"). */
    onShowServers: () -> Unit = {},
    /** Servers created to restore a backup that still wait for it (lowercased
     *  fqdn → state), and the action that sends it (docs/server-backup-and-clone.md). */
    awaitingBackup: Map<String, com.flagshipserver.app.api.AwaitingBackupWire> = emptyMap(),
    onSendBackup: (PodInfo) -> Unit = {},
    /** "Build a service" (iOS's quick action): opens the Services tab's
     *  build chooser. Null hides it. */
    onBuildService: (() -> Unit)? = null,
) {
    var showAddOrImport by remember { mutableStateOf(false) }
    if (showAddOrImport) {
        AddOrImportSheet(
            onDismiss = { showAddOrImport = false },
            onCreate = { showAddOrImport = false; onAddServer() },
            onCoManage = { showAddOrImport = false; onCoManage() },
            onImport = { showAddOrImport = false; onImportBackup() },
            onRestoreFromPeers = { showAddOrImport = false; onRestoreFromPeers() },
        )
    }
    // Search text over the server list (name / fqdn / description). Pure
    // presentation — never mutates `pods`. Empty ⇒ no filtering.
    var search by remember { mutableStateOf("") }
    // Active status filter chip. ALL shows every server; the others narrow the
    // list by derived liveness. Pure presentation; every action is untouched.
    var statusFilter by remember { mutableStateOf(HomeStatusFilter.ALL) }
    val drag = rememberServerListDrag()

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

    FSScreen(
        title = "Home",
        titleTag = "home-title",
        subtitle = homeIdentityLine(accountDisplayName, username, deviceDisplayName),
        subtitleTag = "home-welcome",
        onRefresh = onRefresh,
        spacing = FS.space.s6,
    ) {
        if (deviceCapability != null && !deviceCapability.isFullyScoped) {
            DeviceCapabilityChip(cap = deviceCapability)
        }

        val listLocked = statusPaused && pods.none { it.status != PodInfo.Status.PENDING }
        if (statusPaused && !listLocked) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Icon(
                    Icons.Outlined.PauseCircle,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(FS.space.s2))
                Text(
                    text = "Status paused",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.weight(1f).testTag("home-status-paused"),
                )
                FSGhostButton(
                    label = "Refresh status",
                    onClick = onShowServers,
                    modifier = Modifier.testTag("home-status-paused-unlock"),
                )
            }
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

        if (pods.isNotEmpty() && onBuildService != null) {
            // A restricted device without the build scope sees it disabled, with the reason.
            val canBuild = deviceCapability == null ||
                deviceCapability.scopeSet.contains(DeviceScope.VIBE_CODE)
            BuildServiceAction(enabled = canBuild, onClick = onBuildService)
        }

        if (listLocked) {
            LockedServerListCard(onShowServers = onShowServers)
        } else if (pods.isEmpty()) {
            EmptyServerCard(canAddServers = canAddServers, onAddOrImport = { showAddOrImport = true })
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    FSSectionHeader("Your servers", modifier = Modifier.weight(1f).padding(bottom = FS.space.s1))
                    Text(
                        pods.size.toString(),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.padding(end = FS.space.s4, top = FS.space.s2, bottom = FS.space.s1),
                    )
                }
                if (canAddServers) AddOrImportServerButton(onClick = { showAddOrImport = true })
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
                    FSNote("No servers match “${if (search.isEmpty()) statusFilter.label.lowercase() else search}”.")
                } else {
                    val reorderable = canChangeServers && q.isEmpty() && statusFilter == HomeStatusFilter.ALL &&
                        pods.count(ServerOrderProtocol::orderable) >= 2
                    // The rows and the Leader badge read the same order: the
                    // drag's draft while one shows, else the committed order.
                    val shownPods = applyDraft(pods, drag.draft)
                    val leader = leaderLabel(shownPods)
                    val confirmed = leaderConfirmed(
                        draftShowing = drag.draft != null,
                        orderIssuedAt = serverOrderIssuedAt,
                        acks = serverOrderAcks,
                        leaderPodId = leader?.podId,
                    )
                    val firstOrderable = shownPods.firstOrNull(ServerOrderProtocol::orderable)?.podId
                    ReorderableServerList(
                        pods = visiblePods,
                        enabled = reorderable,
                        drag = drag,
                        onReorder = onReorder,
                    ) { pod, rowModifier, dragging, handle, moveActions ->
                        val liveness = livenessOf(pod)
                        val backupWait = awaitingBackup[pod.fqdn.lowercase()]
                        ServerRow(
                            pod = pod,
                            liveness = liveness,
                            onTap = { if (liveness == PodInfo.LivenessState.ONLINE && backupWait?.state == "waiting") onSendBackup(pod) else onOpenPod(pod) },
                            onOpen = { onOpenPod(pod) },
                            backupWait = backupWait,
                            onSendBackup = { onSendBackup(pod) },
                            onSetLeader = { onMakeLeader(pod) },
                            onDelete = { onDeleteServer(pod) },
                            leader = leader?.takeIf { it.podId == pod.podId },
                            leaderConfirmed = confirmed,
                            canMakeLeader = canChangeServers && ServerOrderProtocol.orderable(pod) && pod.podId != firstOrderable,
                            canDelete = canChangeServers,
                            rowModifier = rowModifier,
                            dragging = dragging,
                            handle = handle,
                            moveActions = moveActions,
                        )
                    }
                }
            }
        }

        sharedWithMe?.invoke()

        // Like iOS: Home never shows a "couldn't load" card. The server list
        // carries each server's state; a failed load only drops this section.
        if (state is LoadingState.Loaded && pods.isNotEmpty()) {
            RecentActivitySection(state.value.recentInstallEvents)
        }
    }
}

/** "Create / Co-manage / Import": the Android sheet for iOS's action sheet. */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun AddOrImportSheet(
    onDismiss: () -> Unit,
    onCreate: () -> Unit,
    onCoManage: () -> Unit,
    onImport: () -> Unit,
    onRestoreFromPeers: () -> Unit,
) {
    androidx.compose.material3.ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Text(
            "Add/Import a server",
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(horizontal = FS.space.s6, vertical = FS.space.s2),
        )
        FSRow(
            title = "Create a new server",
            subtitle = "Set up a server on your hardware or in the cloud.",
            icon = Icons.Outlined.AddCircleOutline,
            iconTint = FS.colors.accent,
            onClick = onCreate,
            modifier = Modifier.testTag("home-add-new-server"),
        )
        FSRow(
            title = "Co-manage a running server",
            subtitle = "Open a server another account shares with you.",
            icon = Icons.Outlined.GroupAdd,
            iconTint = FS.colors.accent,
            onClick = onCoManage,
            modifier = Modifier.testTag("home-co-manage"),
        )
        FSRow(
            title = "Import a backup",
            subtitle = "Restore a server's apps from a backup file.",
            icon = Icons.Outlined.Restore,
            iconTint = FS.colors.accent,
            onClick = onImport,
            modifier = Modifier.testTag("home-import-backup"),
        )
        FSRow(
            title = "Restore from other servers",
            subtitle = "Bring a lost server's apps back from the pieces other servers keep.",
            icon = Icons.Outlined.Restore,
            iconTint = FS.colors.accent,
            onClick = onRestoreFromPeers,
            modifier = Modifier.testTag("home-restore-peers"),
        )
        Spacer(Modifier.height(FS.space.s6))
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
            FSAnnouncementCard(
                icon = Icons.Outlined.VpnKey,
                title = "Your account isn't backed up yet",
                message = "If you lose access to this device, you may lose access to your Flagship cloud.",
                ctaLabel = "Secure my account",
                onCta = onSetUpRecovery,
                onDismiss = onDismissRecoveryBackupBanner,
                modifier = Modifier.testTag("recovery-backup-banner"),
            )
        }
        showRecoveryNudge -> {
            FSAnnouncementCard(
                icon = Icons.Outlined.VpnKey,
                title = "Set up recovery",
                message = "Save a passkey so you can recover your account if you get a new device.",
                ctaLabel = "Set it up",
                onCta = onSetUpRecovery,
                onDismiss = onDismissRecoveryNudge,
                modifier = Modifier.testTag("recovery-nudge-card"),
            )
        }
    }
}

/// v2 device-addressing — "Restricted device · browse-only" chip surfaced
/// below the username when the active session is a restricted sub-identity.
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
        horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
        modifier = Modifier
            .clip(MaterialTheme.shapes.small)
            .background(MaterialTheme.colorScheme.surfaceContainerHighest)
            .padding(horizontal = FS.space.s3, vertical = 6.dp)
            .semantics { contentDescription = label }
            .testTag("device-capability-chip"),
    ) {
        Icon(Icons.Outlined.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
        Text(
            text = label,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelLarge,
        )
    }
}

@Composable
private fun LockedServerListCard(onShowServers: () -> Unit) {
    FSEmptyState(
        title = "Your server list is locked",
        message = "Flagship only shows your servers to this device once it has proved it's yours. Confirm it's you once and your servers will appear.",
        icon = Icons.Outlined.Lock,
        modifier = Modifier.testTag("home-servers-locked"),
        action = {
            FSPrimaryButton(
                label = "Show my servers",
                onClick = onShowServers,
                block = true,
                modifier = Modifier.testTag("home-show-servers"),
            )
        },
    )
}

/** Only an admin device of the account adds servers to it
 *  (docs/service-access-gating.md "Account members"): the device that holds
 *  the account's admin root. Every account is opened with one, so an account
 *  never lacks an admin device. A demo account's device stands in for its
 *  owner (it holds no keys; the operator runs the account). */
fun showsAddServer(holdsAdminRoot: Boolean, isDemoAccount: Boolean): Boolean =
    com.flagshipserver.app.core.AddServerGate.allows(holdsAdminRoot, isDemoAccount)

internal const val ADD_SERVERS_ADMIN_ONLY = com.flagshipserver.app.core.AddServerGate.ADMIN_ONLY

/** "Add/Import a server": the one way to bring a server in (Create /
 *  Co-manage / Import), above the list or on the empty state. A tonal
 *  button with a plus, the Android form of iOS's tinted add row. */
@Composable
private fun AddOrImportServerButton(onClick: () -> Unit, primary: Boolean = false) {
    val colors = if (primary) {
        ButtonDefaults.buttonColors(containerColor = FS.colors.fill, contentColor = FS.colors.onAccent)
    } else {
        ButtonDefaults.filledTonalButtonColors(containerColor = FS.colors.accent.copy(alpha = 0.14f), contentColor = FS.colors.accentText)
    }
    androidx.compose.material3.FilledTonalButton(
        onClick = onClick,
        colors = colors,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("home-add-server"),
    ) {
        Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(FS.space.s2))
        Text("Add/Import a server", style = MaterialTheme.typography.labelLarge)
    }
}

@Composable
private fun EmptyServerCard(canAddServers: Boolean, onAddOrImport: () -> Unit) {
    FSEmptyState(
        title = if (canAddServers) "Your account is ready" else "No servers yet",
        message = if (canAddServers) "Add your first server to start running your own services." else ADD_SERVERS_ADMIN_ONLY,
        icon = if (canAddServers) Icons.Outlined.Verified else Icons.Outlined.Dns,
        iconTint = if (canAddServers) FS.colors.success else null,
        modifier = Modifier.testTag("home-empty-state"),
        // The same button and sheet as a populated list.
        action = if (canAddServers) ({ AddOrImportServerButton(onClick = onAddOrImport, primary = true) }) else null,
    )
}

/** The one quick action on Home, as on iOS: build a service. */
@Composable
private fun BuildServiceAction(enabled: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().testTag("quick-action-vibe-code"),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLowest,
    ) {
        FSRow(
            title = "Build a service",
            subtitle = if (enabled) "Describe it in plain English. Your server builds and runs it."
            else "This device cannot build new services. Use a primary device.",
            icon = if (enabled) Icons.Outlined.AutoAwesome else Icons.Outlined.Lock,
            iconTint = if (enabled) MaterialTheme.colorScheme.primary else null,
            enabled = enabled,
        )
    }
}

/** Recent installs across the account, newest first (iOS HomeScreen.recentActivity). */
@Composable
private fun RecentActivitySection(events: List<com.flagshipserver.app.api.RecentInstallEvent>) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.testTag("home-recent-activity")) {
        FSSectionHeader("Recent activity")
        if (events.isEmpty()) {
            FSNote("No recent activity.")
        } else {
            FSGroup {
                events.forEachIndexed { i, e ->
                    val (icon, tint, verb) = when (e.kind) {
                        "installed" -> Triple(Icons.Outlined.Download, FS.colors.success, "Deployed")
                        "uninstalled" -> Triple(Icons.Outlined.Delete, FS.colors.danger, "Removed")
                        "deploy" -> Triple(Icons.Outlined.Sync, FS.colors.primary, "Redeployed")
                        "update-pulled" -> Triple(Icons.Outlined.SystemUpdateAlt, FS.colors.primary, "Updated")
                        else -> Triple(Icons.Outlined.Circle, FS.colors.textMuted, "Event:")
                    }
                    FSRow(
                        title = "$verb ${e.serviceId}",
                        subtitle = e.detail,
                        icon = icon,
                        iconTint = tint,
                        trailing = {
                            Text(
                                com.flagshipserver.app.core.FlagshipDateFormat.format(e.at),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.labelMedium,
                            )
                        },
                    )
                    if (i < events.size - 1) FSDivider()
                }
            }
        }
    }
}

internal fun homeIdentityLine(accountDisplayName: String?, username: String, deviceDisplayName: String?): String {
    val account = accountDisplayName?.takeIf { it.isNotEmpty() } ?: username
    return deviceDisplayName?.takeIf { it.isNotEmpty() }?.let { "$account > $it" } ?: account
}

/// Status / fqdn subtitle line for a server row. Prefers the user-set
/// description when present (that's what the user named it for), else the
/// fqdn, else the status label.
private fun serverSubtitle(pod: PodInfo, liveness: PodInfo.LivenessState): String {
    if (!pod.description.isNullOrEmpty()) return pod.description!!
    if (pod.fqdn.isNotEmpty()) return pod.fqdn
    return PodStatusStyle.label(liveness, pod.status)
}

/// A single server list row: a drag handle on the left while the list can be
/// reordered, the name behind a small server glyph, the description/fqdn
/// subtitle, the Leader badge + status pill under it, and a menu button. Tap
/// opens the server; the menu (also on touch and hold) makes it leader, opens
/// or deletes it.
@OptIn(ExperimentalFoundationApi::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun ServerRow(
    pod: PodInfo,
    liveness: PodInfo.LivenessState,
    onTap: () -> Unit,
    onSetLeader: () -> Unit,
    onDelete: () -> Unit = {},
    /** Set on the leader's row only (docs/server-order.md). */
    leader: LeaderLabel? = null,
    /** False while the leader doesn't yet hold the order on screen: the badge is gray. */
    leaderConfirmed: Boolean = true,
    /** "Make leader" moves the server to the top of the order; any registered
     *  server can be first, up or not (the next one up stands in meanwhile). */
    canMakeLeader: Boolean = false,
    rowModifier: Modifier = Modifier,
    dragging: Boolean = false,
    /** The drag handle's slot; null when the list can't be reordered. */
    handle: (@Composable () -> Unit)? = null,
    moveActions: List<CustomAccessibilityAction> = emptyList(),
    /** The menu's Open, when a tap does something else (sends a waiting server its backup). */
    onOpen: () -> Unit = onTap,
    /** Set while the server waits for its backup, or restores it (docs/server-backup-and-clone.md). */
    backupWait: com.flagshipserver.app.api.AwaitingBackupWire? = null,
    onSendBackup: () -> Unit = {},
    /** Delete releases the name, an admin order (AdminOrderGate). */
    canDelete: Boolean = true,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val shownBackupWait = backupWait.takeIf { liveness == PodInfo.LivenessState.ONLINE }
    var confirming by remember { mutableStateOf(false) }

    val pillTag: String? = when (liveness) {
        PodInfo.LivenessState.REVOKED -> "pod-card-revoked"
        PodInfo.LivenessState.DEAD -> "pod-card-never-online"
        PodInfo.LivenessState.OFFLINE -> "pod-card-offline"
        PodInfo.LivenessState.WAITING_FOR_APPROVAL -> "pod-card-waiting-approval"
        PodInfo.LivenessState.COMING_ONLINE ->
            if (pod.status == PodInfo.Status.PENDING) null else "pod-card-coming-online"
        PodInfo.LivenessState.ONLINE -> null
    }

    Box {
        Surface(
            modifier = rowModifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.surfaceContainerLowest,
        ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .height(IntrinsicSize.Min),
        ) {
            handle?.invoke()
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                modifier = Modifier
                    .weight(1f)
                    .testTag("home-pod-row")
                    .combinedClickable(onClick = onTap, onLongClick = { menuOpen = true })
                    .semantics { if (moveActions.isNotEmpty()) customActions = moveActions }
                    .padding(
                        start = if (handle != null) 0.dp else FS.space.s4,
                        top = FS.space.s3,
                        bottom = FS.space.s3,
                        end = 0.dp,
                    ),
            ) {
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(
                            Icons.Outlined.Dns,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(16.dp),
                        )
                        Text(
                            pod.name,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.titleMedium,
                        )
                    }
                    val subtitle = serverSubtitle(pod, liveness)
                    if (subtitle.isNotEmpty()) {
                        Text(
                            subtitle,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                    Spacer(Modifier.height(FS.space.s1))
                    // Status pill (+ Leader badge) stacks UNDER the text on its own
                    // line — a long label like "Never came online" would be crushed
                    // against the server name.
                    androidx.compose.foundation.layout.FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                        verticalArrangement = Arrangement.spacedBy(FS.space.s1),
                    ) {
                        if (leader != null) LeaderPill(confirmed = leaderConfirmed)
                        // Per-service leadership (Phase 6): the services this box leads
                        // (from /pods `leadsServices`). Tolerant of absence.
                        LeadServicesPill(pod)
                        if (shownBackupWait != null) {
                            FSPill(
                                label = if (shownBackupWait.state == "restoring") "Restoring its backup" else "Waiting for its backup",
                                kind = FSPillKind.Provisioning,
                                modifier = Modifier.testTag("pod-card-awaiting-backup"),
                            )
                        } else {
                            FSPill(
                                label = PodStatusStyle.label(pod, liveness),
                                kind = PodStatusStyle.pillKind(liveness, pod.status),
                                modifier = if (pillTag != null) Modifier.testTag(pillTag) else Modifier,
                            )
                        }
                    }
                    leader?.standingInFor?.let { names ->
                        Text(
                            "Standing in for $names",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.testTag("pod-standing-in"),
                        )
                    }
                }
            }
            // The row's menu, also on touch and hold.
            IconButton(onClick = { menuOpen = true }, modifier = Modifier.testTag("pod-card-menu")) {
                Icon(
                    Icons.Outlined.MoreVert,
                    contentDescription = "More for ${pod.name}",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        }

        DropdownMenu(expanded = menuOpen && !dragging, onDismissRequest = { menuOpen = false }) {
            if (canMakeLeader) {
                DropdownMenuItem(
                    text = { Text("Make leader") },
                    modifier = Modifier.testTag("pod-card-make-leader"),
                    onClick = { menuOpen = false; onSetLeader() },
                )
            }
            if (backupWait?.state == "waiting") {
                DropdownMenuItem(
                    text = { Text("Send the backup") },
                    modifier = Modifier.testTag("pod-card-send-backup"),
                    onClick = { menuOpen = false; onSendBackup() },
                )
            }
            DropdownMenuItem(
                text = { Text("Open") },
                onClick = { menuOpen = false; onOpen() },
            )
            if (canDelete) {
                DropdownMenuItem(
                    text = {
                        Text(if (pod.status == PodInfo.Status.PENDING) "Delete server (free name)" else "Delete server")
                    },
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
        DeleteServerDialog(
            pod = pod,
            onConfirm = { confirming = false; onDelete() },
            onDismiss = { confirming = false },
        )
    }
}

/// The leader's badge: gray until the leader confirms it holds the order on screen.
@Composable
private fun LeaderPill(confirmed: Boolean) {
    if (confirmed) {
        FSPill("Leader", kind = FSPillKind.Online, modifier = Modifier.testTag("leader-badge"))
    } else {
        FSPill(
            "Leader",
            kind = FSPillKind.Idle,
            modifier = Modifier
                .testTag("leader-badge-pending")
                .clearAndSetSemantics { contentDescription = "Leader, waiting for the server to confirm" },
        )
    }
}

@Composable
fun ServerCardSkeleton() {
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            androidx.compose.material3.LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth(),
                color = MaterialTheme.colorScheme.primary,
                trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
            )
            Text("Loading…", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
fun ErrorCard(message: String, onRetry: (() -> Unit)? = null) {
    FSEmptyState(
        title = "Couldn't load",
        message = message,
        icon = Icons.Outlined.ErrorOutline,
        iconTint = FS.colors.danger,
        action = if (onRetry != null) ({ FSSecondaryButton(label = "Try again", onClick = onRetry) }) else null,
    )
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
