// Home screen — account-wide overview + drill-down into each pod.
// Mirrors iOS HomeScreen with a Kotlin-idiomatic signature (the
// caller passes data + callbacks rather than reaching into Environment).

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
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
) {
    var showAddOrImport by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    if (showAddOrImport) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { showAddOrImport = false },
            title = { androidx.compose.material3.Text("Add/Import a server") },
            text = {
                Column {
                    androidx.compose.material3.TextButton(
                        onClick = { showAddOrImport = false; onAddServer() },
                        modifier = Modifier.testTag("home-add-new-server"),
                    ) {
                        androidx.compose.material3.Text("Create a new server")
                    }
                    androidx.compose.material3.TextButton(
                        onClick = { showAddOrImport = false; onCoManage() },
                        modifier = Modifier.testTag("home-co-manage"),
                    ) {
                        androidx.compose.material3.Text("Co-manage a running server")
                    }
                    androidx.compose.material3.TextButton(
                        onClick = { showAddOrImport = false; onImportBackup() },
                        modifier = Modifier.testTag("home-import-backup"),
                    ) {
                        androidx.compose.material3.Text("Import a backup")
                    }
                }
            },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = { showAddOrImport = false }) {
                    androidx.compose.material3.Text("Cancel")
                }
            },
        )
    }
    val scroll = rememberScrollState()
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

        val listLocked = statusPaused && pods.none { it.status != PodInfo.Status.PENDING }
        if (statusPaused && !listLocked) {
            Spacer(Modifier.height(FS.space.s2))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "Status paused",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                    modifier = Modifier.testTag("home-status-paused"),
                )
                Spacer(Modifier.width(FS.space.s2))
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

        Spacer(Modifier.height(FS.space.s8))

        if (listLocked) {
            LockedServerListCard(onShowServers = onShowServers)
        } else if (pods.isEmpty()) {
            EmptyServerCard(canAddServers = canAddServers, onAddOrImport = { showAddOrImport = true })
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
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
                    FSCard {
                        Text(
                            "No servers match “${if (search.isEmpty()) statusFilter.label.lowercase() else search}”.",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 13.sp),
                        )
                    }
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

        sharedWithMe?.let {
            Spacer(Modifier.height(FS.space.s6))
            it()
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
                message = "Save a passkey so you can recover your account if you get a new device.",
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
private fun LockedServerListCard(onShowServers: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s6), modifier = Modifier.testTag("home-servers-locked")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(
                "Your server list is locked",
                color = FS.colors.text,
                style = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                "Flagship only shows your servers to this device once it has proved it's yours. Confirm it's you once and your servers will appear.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
            )
            Spacer(Modifier.height(FS.space.s2))
            FSPrimaryButton(
                label = "Show my servers",
                onClick = onShowServers,
                block = true,
                modifier = Modifier.testTag("home-show-servers"),
            )
        }
    }
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
 *  Co-manage / Import), above the list or on the empty state. */
@Composable
private fun AddOrImportServerButton(onClick: () -> Unit) {
    FSGhostButton(
        label = "Add/Import a server",
        onClick = onClick,
        block = true,
        modifier = Modifier.testTag("home-add-server"),
    )
}

@Composable
private fun EmptyServerCard(canAddServers: Boolean, onAddOrImport: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s6), modifier = Modifier.testTag("home-empty-state")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(
                if (canAddServers) "Your account is ready" else "No servers yet",
                color = FS.colors.text,
                style = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                if (canAddServers) "Add your first server to start running your own services." else ADD_SERVERS_ADMIN_ONLY,
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
            )
            if (canAddServers) {
                Spacer(Modifier.height(FS.space.s2))
                // The same button and menu as a populated list.
                AddOrImportServerButton(onClick = onAddOrImport)
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
/// subtitle, the Leader badge + status pill under it, and a chevron. Tap opens
/// the server; touch and hold opens the menu (make leader / open / delete).
@OptIn(ExperimentalFoundationApi::class)
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
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = rowModifier
                .fillMaxWidth()
                .height(IntrinsicSize.Min)
                .clip(RoundedCornerShape(FS.radius.md))
                .background(FS.colors.surface)
                .border(1.dp, FS.colors.border, RoundedCornerShape(FS.radius.md)),
        ) {
            handle?.invoke()
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
                modifier = Modifier
                    .weight(1f)
                    .combinedClickable(onClick = onTap, onLongClick = { menuOpen = true })
                    .semantics { if (moveActions.isNotEmpty()) customActions = moveActions }
                    .padding(
                        start = if (handle != null) 0.dp else FS.space.s4,
                        top = FS.space.s4,
                        bottom = FS.space.s4,
                        end = FS.space.s4,
                    ),
            ) {
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(
                            Icons.Outlined.Dns,
                            contentDescription = null,
                            tint = FS.colors.textMuted,
                            modifier = Modifier.size(14.dp),
                        )
                        Text(
                            pod.name,
                            color = FS.colors.text,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                        )
                    }
                    val subtitle = serverSubtitle(pod, liveness)
                    if (subtitle.isNotEmpty()) {
                        Text(
                            subtitle,
                            color = FS.colors.textMuted,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = TextStyle(fontSize = 13.sp),
                        )
                    }
                    Spacer(Modifier.height(FS.space.s1))
                    // Status pill (+ Leader badge) stacks UNDER the text on its own
                    // line — a long label like "Never came online" would be crushed
                    // against the server name.
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
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
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 12.sp),
                            modifier = Modifier.testTag("pod-standing-in"),
                        )
                    }
                }
                // Navigation chevron stays right, vertically centered.
                Text("›", color = FS.colors.textMuted, style = TextStyle(fontSize = 18.sp))
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

/// Reusable compact server card — retained for previews / any non-Home caller.
/// The Home list now renders each server as an [ServerRow]; this dense card is
/// the legacy presentation and is no longer used by HomeScreen itself.
@Composable
fun PodCard(
    pod: PodInfo,
    isLeader: Boolean,
    onTap: () -> Unit,
    onSetLeader: () -> Unit,
    /** Delete the server once [DeleteServerDialog] confirms. No-op default
     *  keeps the card previewable. */
    onDelete: () -> Unit = {},
    /** Derived per-server liveness. Defaults to deriving from the pod alone
     *  (no live unlock request known) so existing callers / previews keep
     *  their behaviour; the Home list supplies the account-level signal. */
    liveness: PodInfo.LivenessState = pod.livenessState(hasLiveUnlockRequest = false),
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
        if (!isLeader && pod.status == PodInfo.Status.ONLINE && pod.cameOnline && !pod.isRevoked) {
            Spacer(Modifier.height(FS.space.s2))
            FSGhostButton(label = "Make leader", onClick = onSetLeader)
        }
        var confirming by remember { mutableStateOf(false) }
        Spacer(Modifier.height(FS.space.s2))
        FSGhostButton(
            label = if (pod.status == PodInfo.Status.PENDING) "Delete server (free name)" else "Delete server",
            onClick = { confirming = true },
            modifier = Modifier.testTag("pod-card-delete"),
        )
        if (confirming) {
            DeleteServerDialog(
                pod = pod,
                onConfirm = { confirming = false; onDelete() },
                onDismiss = { confirming = false },
            )
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
