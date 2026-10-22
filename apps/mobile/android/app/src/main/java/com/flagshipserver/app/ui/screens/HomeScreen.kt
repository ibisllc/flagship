// Home screen — account-wide overview + drill-down into each pod.
// Mirrors iOS HomeScreen with a Kotlin-idiomatic signature (the
// caller passes data + callbacks rather than reaching into Environment).

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import androidx.compose.animation.core.animateFloat
import androidx.compose.ui.graphics.graphicsLayer
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
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material3.AlertDialog
import com.flagshipserver.app.ui.components.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
    /** "Restore from backup" in the Add/Restore menu: the chooser of where the backup is
     *  (a file, other servers' pieces (docs/peer-backup.md), or this phone's copies). */
    onRestoreBackup: () -> Unit = {},
    /** "Co-manage a running server": accept a server another account
     *  shares (docs/share-a-server.md), from the Add/Restore menu. */
    onCoManage: () -> Unit = {},
    /** Only an admin device of the account sees "Add/Restore server", in
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
    /** Name dibs notice: the window's end (ms) while it should show, else null. */
    dibsNoticeClosesAt: Long? = null,
    onClaimDibs: () -> Unit = {},
    onDismissDibs: () -> Unit = {},
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
            onRestore = { showAddOrImport = false; onRestoreBackup() },
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
        title = stringResource(R.string.home),
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
        // Add/Restore moves when the card above it appears or goes, and when the
        // list first fills in (the empty-state button becomes the list's). A tap
        // aimed at where it was landed on whatever moved there (device report
        // 2026-10-18), so it waits for the layout to settle after each change.
        val hasAnnouncement = accountWasReset || showRecoveryBackupBanner || showRecoveryNudge
        var addSettled by remember { mutableStateOf(false) }
        LaunchedEffect(hasAnnouncement, pods.isEmpty(), listLocked) {
            addSettled = false
            kotlinx.coroutines.delay(ADD_SETTLE_MS)
            addSettled = true
        }
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
                    text = stringResource(R.string.status_paused),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.weight(1f).testTag("home-status-paused"),
                )
                FSGhostButton(
                    label = stringResource(R.string.refresh_status),
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
            dibsNoticeClosesAt = dibsNoticeClosesAt,
            onClaimDibs = onClaimDibs,
            onDismissDibs = onDismissDibs,
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
            EmptyServerCard(canAddServers = canAddServers, addEnabled = addSettled, onAddOrImport = { showAddOrImport = true })
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    FSSectionHeader(stringResource(R.string.your_servers), modifier = Modifier.weight(1f).padding(bottom = FS.space.s1))
                    Text(
                        pods.size.toString(),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.padding(end = FS.space.s4, top = FS.space.s2, bottom = FS.space.s1),
                    )
                }
                if (canAddServers) AddOrImportServerButton(onClick = { showAddOrImport = true }, enabled = addSettled)
                FSSearchField(
                    value = search,
                    onValueChange = { search = it },
                    placeholder = stringResource(R.string.search_servers),
                )
                FSChipRow(
                    items = HomeStatusFilter.allCases().map {
                        FSChipItem(value = it, label = it.label, count = filterCount(it))
                    },
                    selection = statusFilter,
                    onSelect = { statusFilter = it },
                )
                if (visiblePods.isEmpty()) {
                    FSNote(fsString(R.string.no_servers_match, if (search.isEmpty()) statusFilter.label.lowercase() else search))
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

/** "Create / Co-manage / Restore": the Android sheet for iOS's action sheet. */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun AddOrImportSheet(
    onDismiss: () -> Unit,
    onCreate: () -> Unit,
    onCoManage: () -> Unit,
    onRestore: () -> Unit,
) {
    com.flagshipserver.app.ui.components.ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = Modifier.testTag("home-add-sheet"),
    ) {
        Text(
            stringResource(R.string.add_restore_server),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(horizontal = FS.space.s6, vertical = FS.space.s2),
        )
        FSRow(
            title = stringResource(R.string.create_a_server),
            subtitle = stringResource(R.string.set_up_a_server_on_your),
            icon = Icons.Outlined.AddCircleOutline,
            iconTint = FS.colors.accent,
            onClick = onCreate,
            modifier = Modifier.testTag("home-add-new-server"),
        )
        FSRow(
            title = stringResource(R.string.co_manage_a_running_server),
            subtitle = stringResource(R.string.open_a_server_another_account_shares),
            icon = Icons.Outlined.GroupAdd,
            iconTint = FS.colors.accent,
            onClick = onCoManage,
            modifier = Modifier.testTag("home-co-manage"),
        )
        FSRow(
            title = stringResource(R.string.restore_from_backup),
            subtitle = stringResource(R.string.bring_a_server_back_from_a),
            icon = Icons.Outlined.Restore,
            iconTint = FS.colors.accent,
            onClick = onRestore,
            modifier = Modifier.testTag("home-restore-backup"),
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
    dibsNoticeClosesAt: Long? = null,
    onClaimDibs: () -> Unit = {},
    onDismissDibs: () -> Unit = {},
) {
    when {
        accountWasReset -> {
            FSAnnouncementCard(
                icon = Icons.Outlined.ErrorOutline,
                title = stringResource(R.string.this_device_was_removed_from_your),
                message = stringResource(R.string.another_device_on_this_account_ran),
                ctaLabel = stringResource(R.string.sign_in_again),
                tint = FS.colors.danger,
                onCta = onSignInAgain,
                modifier = Modifier.testTag("account-reset-banner"),
            )
        }
        showRecoveryBackupBanner -> {
            FSAnnouncementCard(
                icon = Icons.Outlined.VpnKey,
                title = stringResource(R.string.your_account_isnt_backed_up_yet),
                message = stringResource(R.string.if_you_lose_access_to_this),
                ctaLabel = stringResource(R.string.secure_my_account),
                onCta = onSetUpRecovery,
                onDismiss = onDismissRecoveryBackupBanner,
                modifier = Modifier.testTag("recovery-backup-banner"),
            )
        }
        showRecoveryNudge -> {
            FSAnnouncementCard(
                icon = Icons.Outlined.VpnKey,
                title = stringResource(R.string.set_up_recovery),
                message = stringResource(R.string.save_a_passkey_so_you_can),
                ctaLabel = stringResource(R.string.set_it_up),
                onCta = onSetUpRecovery,
                onDismiss = onDismissRecoveryNudge,
                modifier = Modifier.testTag("recovery-nudge-card"),
            )
        }
        dibsNoticeClosesAt != null -> {
            Spacer(Modifier.height(FS.space.s4))
            FSAnnouncementCard(
                icon = Icons.Outlined.Flag,
                title = stringResource(R.string.own_a_com_claim_the_matching),
                message = fsString(R.string.until_a_name_that_matches_a, formatDibsDate(dibsNoticeClosesAt)),
                ctaLabel = stringResource(R.string.claim_your_com_name),
                onCta = onClaimDibs,
                onDismiss = onDismissDibs,
                modifier = Modifier.testTag("dibs-notice"),
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
        fsString(R.string.scopes, cap.scopes.size)
    }
    val label = fsString(R.string.restricted_device, summary)
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
        title = stringResource(R.string.your_server_list_is_locked),
        message = stringResource(R.string.flagship_only_shows_your_servers_to),
        icon = Icons.Outlined.Lock,
        modifier = Modifier.testTag("home-servers-locked"),
        action = {
            FSPrimaryButton(
                label = stringResource(R.string.show_my_servers),
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

/** How long Add/Restore waits after the Home layout above it changes. */
internal const val ADD_SETTLE_MS = 450L

internal val ADD_SERVERS_ADMIN_ONLY get() = com.flagshipserver.app.core.AddServerGate.ADMIN_ONLY

/** "Add/Restore server": the one way to bring a server in (Create /
 *  Co-manage / Import), above the list or on the empty state. A tonal
 *  button with a plus, the Android form of iOS's tinted add row. */
@Composable
private fun AddOrImportServerButton(onClick: () -> Unit, primary: Boolean = false, enabled: Boolean = true) {
    val colors = if (primary) {
        ButtonDefaults.buttonColors(containerColor = FS.colors.fill, contentColor = FS.colors.onAccent)
    } else {
        ButtonDefaults.filledTonalButtonColors(containerColor = FS.colors.accent.copy(alpha = 0.14f), contentColor = FS.colors.accentText)
    }
    androidx.compose.material3.FilledTonalButton(
        onClick = onClick,
        enabled = enabled,
        colors = colors,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("home-add-server"),
    ) {
        Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(FS.space.s2))
        Text(stringResource(R.string.add_restore_server), style = MaterialTheme.typography.labelLarge)
    }
}

@Composable
private fun EmptyServerCard(canAddServers: Boolean, addEnabled: Boolean = true, onAddOrImport: () -> Unit) {
    FSEmptyState(
        title = if (canAddServers) stringResource(R.string.your_account_is_ready) else stringResource(R.string.no_servers_yet),
        message = if (canAddServers) stringResource(R.string.add_your_first_server_to_start) else ADD_SERVERS_ADMIN_ONLY,
        icon = if (canAddServers) Icons.Outlined.Verified else Icons.Outlined.Dns,
        iconTint = if (canAddServers) FS.colors.success else null,
        modifier = Modifier.testTag("home-empty-state"),
        // The same button and sheet as a populated list.
        action = if (canAddServers) ({ AddOrImportServerButton(onClick = onAddOrImport, primary = true, enabled = addEnabled) }) else null,
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
            title = stringResource(R.string.build_a_service),
            subtitle = if (enabled) stringResource(R.string.describe_it_in_plain_english_your)
            else stringResource(R.string.this_device_cannot_build_new_services),
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
        FSSectionHeader(stringResource(R.string.recent_activity))
        if (events.isEmpty()) {
            FSNote(stringResource(R.string.no_recent_activity))
        } else {
            FSGroup {
                events.forEachIndexed { i, e ->
                    val (icon, tint, verb) = when (e.kind) {
                        "installed" -> Triple(Icons.Outlined.Download, FS.colors.success, stringResource(R.string.deployed))
                        "uninstalled" -> Triple(Icons.Outlined.Delete, FS.colors.danger, stringResource(R.string.removed))
                        "deploy" -> Triple(Icons.Outlined.Sync, FS.colors.primary, stringResource(R.string.redeployed))
                        "update-pulled" -> Triple(Icons.Outlined.SystemUpdateAlt, FS.colors.primary, stringResource(R.string.updated))
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
                        if (shownBackupWait != null) {
                            FSPill(
                                label = if (shownBackupWait.state == "restoring") stringResource(R.string.restoring_its_backup) else stringResource(R.string.waiting_for_its_backup),
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
                            fsString(R.string.standing_in_for, names),
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
                    contentDescription = fsString(R.string.more_for, pod.name),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        }

        DropdownMenu(expanded = menuOpen && !dragging, onDismissRequest = { menuOpen = false }) {
            if (canMakeLeader) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.make_leader)) },
                    modifier = Modifier.testTag("pod-card-make-leader"),
                    onClick = { menuOpen = false; onSetLeader() },
                )
            }
            if (backupWait?.state == "waiting") {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.send_the_backup)) },
                    modifier = Modifier.testTag("pod-card-send-backup"),
                    onClick = { menuOpen = false; onSendBackup() },
                )
            }
            DropdownMenuItem(
                text = { Text(stringResource(R.string.open_2)) },
                onClick = { menuOpen = false; onOpen() },
            )
            if (canDelete) {
                DropdownMenuItem(
                    text = {
                        Text(if (pod.status == PodInfo.Status.PENDING) stringResource(R.string.delete_server_free_name) else stringResource(R.string.delete_server_2))
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
        FSPill(stringResource(R.string.leader), kind = FSPillKind.Online, modifier = Modifier.testTag("leader-badge"))
    } else {
        FSPill(
            stringResource(R.string.leader),
            kind = FSPillKind.Idle,
            modifier = Modifier
                .testTag("leader-badge-pending")
                .clearAndSetSemantics { contentDescription = FSStrings.get(R.string.leader_waiting_for_the_server_to) },
        )
    }
}

@Composable
fun ServerCardSkeleton() {
    // Rows that breathe, in the shape of the list that is coming, instead of a bare bar.
    val transition = androidx.compose.animation.core.rememberInfiniteTransition(label = "skeleton")
    val alpha by transition.animateFloat(
        initialValue = 0.35f, targetValue = 0.8f,
        animationSpec = androidx.compose.animation.core.infiniteRepeatable(
            androidx.compose.animation.core.tween(900, easing = androidx.compose.animation.core.FastOutSlowInEasing),
            androidx.compose.animation.core.RepeatMode.Reverse,
        ),
        label = "skeleton-alpha",
    )
    val block = MaterialTheme.colorScheme.surfaceContainerHighest
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s4)) {
            repeat(2) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    Box(Modifier.size(40.dp).graphicsLayer { this.alpha = alpha }.background(block, androidx.compose.foundation.shape.CircleShape))
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.weight(1f)) {
                        Box(Modifier.fillMaxWidth(0.55f).height(14.dp).graphicsLayer { this.alpha = alpha }.background(block, MaterialTheme.shapes.extraSmall))
                        Box(Modifier.fillMaxWidth(0.8f).height(12.dp).graphicsLayer { this.alpha = alpha }.background(block, MaterialTheme.shapes.extraSmall))
                    }
                }
            }
            Text(stringResource(R.string.loading), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
fun ErrorCard(message: String, onRetry: (() -> Unit)? = null) {
    FSEmptyState(
        title = stringResource(R.string.couldnt_load),
        message = message,
        icon = Icons.Outlined.ErrorOutline,
        iconTint = FS.colors.danger,
        action = if (onRetry != null) ({ FSSecondaryButton(label = stringResource(R.string.try_again), onClick = onRetry) }) else null,
    )
}
