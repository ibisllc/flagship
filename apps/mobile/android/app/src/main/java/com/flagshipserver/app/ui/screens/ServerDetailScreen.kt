// Drill-down view for one pod. Shows daemon version, cert expiry,
// recent install events, paired sessions, and a metrics charts strip.
// Lighter than iOS — Compose tooling for line charts is heavier, so we
// summarize the metrics as last-sample numbers + a status line until
// MPAndroidChart (or Vico) is wired up.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.RadioButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.ui.Alignment
import androidx.compose.material.icons.outlined.Apps
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AddLink
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Fingerprint
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.LockOpen
import androidx.compose.material.icons.outlined.PowerSettingsNew
import androidx.compose.material.icons.outlined.RestartAlt
import androidx.compose.material.icons.outlined.Upgrade
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.size
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.FSNote
import com.flagshipserver.app.ui.components.FSCardDivider
import com.flagshipserver.app.ui.components.plural
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.LastUpdate
import com.flagshipserver.app.api.ReleaseCatalogResponse
import com.flagshipserver.app.api.ReleaseEntry
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.loadReleaseCatalog
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.api.userFacing
import androidx.compose.foundation.clickable
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalSecretMailboxClient
import com.flagshipserver.app.core.LocalServerTransferClient
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.viewmodels.TransferGiverViewModel
import com.flagshipserver.app.viewmodels.UpdateServerViewModel
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.DeadManReminders
import com.flagshipserver.app.core.JournalUnits
import com.flagshipserver.app.core.PendingUpdate
import com.flagshipserver.app.core.PendingUpdateStore
import com.flagshipserver.app.core.PowerMode
import com.flagshipserver.app.core.SharedPrefsPendingUpdateStore
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.flagshipserver.app.core.SecretPurpose
import com.flagshipserver.app.core.SecretRequestCoordinator
import com.flagshipserver.app.core.ServerSettingsStore
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.KeystoreIrkAccess
import com.flagshipserver.app.push.DeadManReminderScheduler
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout
import kotlinx.coroutines.launch
import com.flagshipserver.app.viewmodels.BootUnlockApprovalViewModel
import com.flagshipserver.app.viewmodels.CoordinatorApprovalSource
import com.flagshipserver.app.viewmodels.DeadManPhase
import com.flagshipserver.app.viewmodels.DeadManViewModel
import com.flagshipserver.app.viewmodels.FrontPagePhase
import com.flagshipserver.app.viewmodels.FrontPageViewModel
import com.flagshipserver.app.viewmodels.DeadManWindow
import com.flagshipserver.app.viewmodels.HomeViewModel
import com.flagshipserver.app.viewmodels.LoadingState
import com.flagshipserver.app.viewmodels.MigrationViewModel
import com.flagshipserver.app.viewmodels.JournalPhase
import com.flagshipserver.app.viewmodels.JournalViewModel
import com.flagshipserver.app.viewmodels.PowerOffPhase
import com.flagshipserver.app.viewmodels.PowerOffViewModel
import com.flagshipserver.app.viewmodels.RevokeServerPhase
import com.flagshipserver.app.viewmodels.RevokeServerReason
import com.flagshipserver.app.viewmodels.RevokeServerViewModel
import com.flagshipserver.app.viewmodels.ServerMetricsViewModel
import com.flagshipserver.app.viewmodels.UnrevokeServerPhase
import com.flagshipserver.app.viewmodels.UnrevokeServerViewModel
import com.flagshipserver.app.core.FlagshipDateFormat
import com.flagshipserver.app.core.ServerHealthVerdict
import java.util.Date
import java.util.Locale

@Composable
fun ServerDetailScreen(
    podId: String,
    onBack: () -> Unit,
    // The directory's cheap `awaitingUnlock` flag for this box. When true the
    // box is definitely waiting for a boot-unlock approval, so the inline
    // approval card must be offered REGARDLESS of whether the daemon BFF loaded
    // (a locked box never answers its BFF — that's the whole point).
    awaitingUnlock: Boolean = false,
    // The directory's `awaitingEntitlement` flag — the box posted a serve-auth
    // request and is waiting to be authorized to serve. Surfaces a second
    // approval card, same pattern as `awaitingUnlock` (Box Request Inbox).
    awaitingEntitlement: Boolean = false,
    // The pod's FQDN, available even when the daemon BFF load fails — drives the
    // approval card. The loaded detail path prefers its own serverFqdn.
    serverFqdn: String? = null,
    health: com.flagshipserver.app.api.BoxHealthWire? = null,
) {
    val appState = LocalAppState.current
    val allPods by appState.pods.collectAsState()
    val leaderPodId by appState.leaderPodId.collectAsState()
    val currentPodId by appState.currentPodId.collectAsState()
    val pod = allPods.firstOrNull { it.podId == podId }
    // This server's own client (its base URL + session), so the page shows
    // this box, not the current one. The global client is only this box's
    // when this box is the current server; for any other it would show the
    // current server's detail under this one's name.
    val podClients = com.flagshipserver.app.core.LocalPodClients.current
    val globalClient = LocalScreensClient.current
    // Bumped after pairing so the per-server client is looked up again with
    // the new token.
    var pairedGeneration by remember { mutableStateOf(0) }
    val podClient = remember(pod, pairedGeneration) { pod?.let { podClients.screens(it) } }
    val isCurrent = remember(allPods, leaderPodId, currentPodId, podId) { appState.currentPod?.podId == podId }
    val client = podClient ?: globalClient.takeIf { isCurrent }
    val detailVm = remember(podId, client) { client?.let { HomeViewModel(it) } }
    val metricsVm = remember(podId, client) { client?.let { ServerMetricsViewModel(podId = podId, client = it) } }
    val notPaired = remember {
        kotlinx.coroutines.flow.MutableStateFlow<LoadingState<Nothing>>(
            LoadingState.Failed("This device isn't paired with this server yet."),
        )
    }
    val detail by (detailVm?.state ?: notPaired).collectAsState()
    val metrics by (metricsVm?.state ?: notPaired).collectAsState()
    val noFlow = remember { kotlinx.coroutines.flow.MutableStateFlow(0) }
    val failures by (detailVm?.failures ?: noFlow).collectAsState()
    val boxNeedsPairing by (detailVm?.needsPairing ?: remember { kotlinx.coroutines.flow.MutableStateFlow(false) }).collectAsState()

    // HONEST LIVENESS — the directory's view of this box decides what the page
    // says while its own detail can't load. Mirror of iOS ServerDetailContainer.
    val liveness = pod?.let { appState.liveness(it) }
    val deadServer = liveness == com.flagshipserver.app.core.PodInfo.LivenessState.DEAD
    val comingUp = liveness == com.flagshipserver.app.core.PodInfo.LivenessState.COMING_ONLINE &&
        pod?.status != com.flagshipserver.app.core.PodInfo.Status.PENDING
    val wontAnswer = liveness == com.flagshipserver.app.core.PodInfo.LivenessState.OFFLINE ||
        liveness == com.flagshipserver.app.core.PodInfo.LivenessState.REVOKED || comingUp
    // Still called live by the directory but silent for ~30 s (four tries), e.g.
    // a hosted VM that was just stopped.
    val notAnswering = failures >= 4
    val offline = notAnswering || liveness == com.flagshipserver.app.core.PodInfo.LivenessState.OFFLINE
    val pairFqdn = pod?.fqdn?.takeIf { it.isNotEmpty() }
    val notPairedHere = pairFqdn != null && (detailVm == null || boxNeedsPairing)

    LaunchedEffect(podId, client, wontAnswer) {
        // Retry until the box answers its BFF — an online box whose daemon
        // raced readiness no longer sticks on the skeleton until manual refresh.
        // A box the directory calls offline / coming up gets one try.
        detailVm?.loadUntilLoaded(wontAnswer = wontAnswer)
        metricsVm?.load()
    }

    val sessionStore = com.flagshipserver.app.core.LocalSessionStore.current
    val flagshipServer = com.flagshipserver.app.core.LocalFlagshipServerClient.current
    val pairToasts = LocalToastCenter.current
    val pairScope = rememberCoroutineScope()
    var pairing by remember { mutableStateOf(false) }
    val onPair: () -> Unit = onPair@{
        val fqdn = pairFqdn ?: return@onPair
        if (pairing) return@onPair
        pairing = true
        pairScope.launch {
            try {
                val demo = pod?.demoServer
                val user = appState.currentUser.value
                if (demo != null && user != null) {
                    try {
                        com.flagshipserver.app.core.DemoSessionPairer.ensurePaired(
                            username = user,
                            server = demo,
                            client = flagshipServer,
                            store = sessionStore,
                            replacingExistingToken = true,
                        )
                        pairedGeneration++
                    } catch (_: Throwable) {
                        pairToasts.error("The demo server is online, but this device couldn't create a paired session. Try again.")
                    }
                    return@launch
                }
                val vm = com.flagshipserver.app.viewmodels.PodPairViewModel(store = sessionStore, serverDomain = fqdn)
                // Shown only once the box proved this device's token absent or
                // rejected, so a stale token is replaced rather than kept.
                vm.pair(replacingExistingToken = true)
                when (val p = vm.phase.value) {
                    is com.flagshipserver.app.viewmodels.PodPairPhase.Paired,
                    is com.flagshipserver.app.viewmodels.PodPairPhase.AlreadyPaired,
                    -> pairedGeneration++
                    is com.flagshipserver.app.viewmodels.PodPairPhase.Failed -> pairToasts.error(p.message)
                    else -> Unit
                }
            } finally {
                pairing = false
            }
        }
    }

    val title = pod?.name?.takeIf { it.isNotBlank() }
        ?: serverFqdn?.substringBefore('.')?.takeIf { it.isNotBlank() }
        ?: "Server"
    // Every order on this page signs under the admin root (`.com` and an
    // admin-pinned box refuse the IRK): another device sees it read-only.
    val serverReadOnly = !com.flagshipserver.app.core.AdminOrderGate.allows(LocalAppState.current)
    androidx.compose.runtime.CompositionLocalProvider(LocalServerReadOnly provides serverReadOnly) {
    FSScreen(
        title = title,
        onBack = onBack,
        spacing = FS.space.s6,
        onRefresh = detailVm?.let { vm -> { vm.load(); metricsVm?.load(); Unit } },
    ) {
        if (serverReadOnly) {
            Text(
                com.flagshipserver.app.core.AdminOrderGate.SERVER,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = FS.space.s1).testTag("sd-server-admin-only"),
            )
        }
        if (pod != null && pod.isRevoked) {
            RevokedServerCard(pod = pod)
        }

        // Owner debug access: a banner while it's on, the controls further down.
        val loadedDetail = (detail as? LoadingState.Loaded)?.value
        val debugVm = remember(loadedDetail?.serverFqdn, client) {
            val fqdn = loadedDetail?.serverFqdn
            if (fqdn != null && client != null) {
                com.flagshipserver.app.viewmodels.DebugAccessViewModel(fqdn, client, loadedDetail.debugAccess)
            } else {
                null
            }
        }
        LaunchedEffect(debugVm, loadedDetail?.debugAccess) { debugVm?.reconcile(loadedDetail?.debugAccess) }
        debugVm?.let { DebugAccessBanner(it) }

        // Boot-unlock approval — hoisted ABOVE the load-state branch so a box
        // waiting for the owner to release its disk key is always actionable
        // here, even when the daemon BFF can't load. Prefer the loaded detail's
        // FQDN, else the pod FQDN the caller always passes. Renders nothing
        // until the directory says this box is waiting (`awaitingUnlock`).
        val approvalFqdn = (detail as? LoadingState.Loaded)?.value?.serverFqdn
            ?.takeIf { it.isNotEmpty() }
            ?: serverFqdn?.takeIf { it.isNotEmpty() }
        approvalFqdn?.let { fqdn ->
            BootUnlockApprovalCard(serverDomain = fqdn, awaitingUnlock = awaitingUnlock)
            // The Box Request Inbox's serve-authorization lane: a box that posted
            // an entitlement request (no deposit, or an unencrypted box) is now
            // actionable here too, not silently stuck.
            BootUnlockApprovalCard(
                serverDomain = fqdn,
                awaitingUnlock = awaitingEntitlement,
                purpose = SecretPurpose.ENTITLEMENT,
            )
        }

        val revoked = pod?.isRevoked == true
        when (val d = detail) {
            is LoadingState.Loaded -> ServerInfoCard(d.value)
            // The revoked card above already says why nothing loads.
            else -> if (!revoked) {
                ServerDetailPlaceholder(
                    kind = ServerDetailPlaceholderKind.of(
                        loading = d !is LoadingState.Failed,
                        attempted = failures > 0,
                        deadServer = deadServer,
                        offline = offline,
                        comingUp = comingUp,
                        notPaired = notPairedHere,
                    ),
                    lastSeen = pod?.humanizedLastSeen(),
                    pairing = pairing,
                    onPair = onPair,
                    onRetry = detailVm?.let { vm -> { vm.loadUntilLoaded(wontAnswer = wontAnswer); Unit } },
                )
            }
        }

        // This server's apps (docs/app-placement.md §3).
        if (pod != null && !pod.isRevoked && podClient != null) {
            (detail as? LoadingState.Loaded)?.value?.appSandbox?.notice?.let { n ->
                Text(
                    n.text,
                    color = if (n.danger) FS.colors.danger else MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier
                        .padding(horizontal = FS.space.s1)
                        .semantics { contentDescription = "sd-app-sandbox-notice" },
                )
            }
            ServerAppsSection(podId = podId, client = podClient)
        }

        (detail as? LoadingState.Loaded)?.value?.let { d ->
            MonitoringSection(
                health = health,
                metrics = metrics,
                cert = MonitoringCert(notAfter = d.certNotAfter, notBefore = d.certNotBefore, sans = d.certSans.orEmpty()),
                onRetryMetrics = metricsVm?.let { vm -> { vm.load() } },
            )
        }

        (detail as? LoadingState.Loaded)?.let { d ->
            BootUnlockCard(serverDomain = d.value.serverFqdn)
            LeaderCard(serverDomain = d.value.serverFqdn)
            ShareServerCard(serverDomain = d.value.serverFqdn, podId = podId)
            FrontPageCard(serverDomain = d.value.serverFqdn)
            PowerCard(serverDomain = d.value.serverFqdn)
            DeadManCard(serverDomain = d.value.serverFqdn)
            JournalCard(serverDomain = d.value.serverFqdn)
            debugVm?.let { vm -> DebugAccessCard(vm = vm, onChanged = { detailVm?.load() }) }
            ServerBackupsSection(serverDomain = d.value.serverFqdn)
            BackupMigrateCard(serverDomain = d.value.serverFqdn)
            UpdateServerCard(
                serverDomain = d.value.serverFqdn,
                currentCommit = d.value.currentCommit,
                lastUpdate = d.value.lastUpdate,
                onRefresh = { detailVm?.load() },
            )
        }

        // The health report comes from the directory, not the box, so it still
        // shows when the box's own detail can't load.
        if (detail !is LoadingState.Loaded && ServerHealthVerdict.evaluate(health, System.currentTimeMillis()) != null) {
            MonitoringSection(health = health, metrics = null, cert = null)
        }

        // Outside the loaded branch: none of these need the box, so an offline,
        // never-online or revoked server can still be revoked or deleted.
        if (pod != null) {
            DangerZoneCard(pod = pod, canTransfer = detail is LoadingState.Loaded, onDeleted = onBack)
        }
    }
    }
}

// Boot-unlock status + kill switch for one server. Reads the per-server choice
// + lease from ServerSettingsStore and, for an "auto" server with a deposited
// lease, offers the revoke (downgrade to phone-gated, not a brick). Mirror of
// iOS ServerDetailScreen.BootUnlockCard.
@Composable
private fun BootUnlockCard(serverDomain: String) {
    val mailbox = LocalSecretMailboxClient.current
    val app = LocalAppState.current
    val toasts = LocalToastCenter.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val username by app.currentUser.collectAsState()
    val store = remember { ServerSettingsStore.from(context) }

    val mode = remember(serverDomain) { store.effectiveMode(serverDomain) }
    var leaseId by remember(serverDomain) { mutableStateOf(store.leaseId(serverDomain)) }
    var revoking by remember { mutableStateOf(false) }

    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
        FSSectionHeader("Boot unlock")
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                when (mode) {
                    ServerSettingsStore.Mode.AUTO -> {
                        IconLine(Icons.Outlined.Bolt, "Reboots on its own")
                        if (leaseId != null) {
                            Text(
                                "This server unlocks its encrypted disk by itself after a reboot, no phone needed. flagshipserver.com only ever holds a key it can't read.",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            FSDangerButton(
                                label = if (revoking) "Disabling…" else "Require my phone each boot",
                                onClick = onClick@{
                                    val id = leaseId ?: return@onClick
                                    val user = username ?: return@onClick
                                    revoking = true
                                    scope.launch {
                                        try {
                                            val coord = SecretRequestCoordinator(
                                                mailbox = mailbox,
                                                username = user,
                                                irk = KeystoreIrkAccess(),
                                            )
                                            coord.revokeAutoUnlockLease(serverDomain, id)
                                            store.setLeaseId(serverDomain, null)
                                            leaseId = null
                                            toasts.success("Auto-unlock disabled. This server will ask your phone on its next reboot.")
                                        } catch (t: Throwable) {
                                            toasts.error("Couldn't disable auto-unlock: ${t.message}")
                                        } finally {
                                            revoking = false
                                        }
                                    }
                                },
                                enabled = !revoking,
                                block = true,
                            )
                        } else {
                            Text(
                                "After you approve its first boot, this server unlocks by itself on future reboots. Nothing to do until then.",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                    ServerSettingsStore.Mode.APPROVE -> {
                        IconLine(Icons.Outlined.Fingerprint, "Authorize each boot")
                        Text(
                            "This server asks your phone for approval on every reboot, the most theft-resistant mode.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }
        }
    }
}

// Inline "Approve unlock" card. DIRECTORY-DRIVEN: the box's pending request is
// detected by the pod's cheap `awaitingUnlock` flag (no biometric), so the
// Approve/Deny prompt surfaces directly when it's set and renders nothing
// otherwise. The biometric fires ONCE, only when the owner taps Approve (the
// whole ceremony — mailbox fetch, unseal, response, lease — runs behind it).
// Mirror of iOS ServerDetailScreen.BootUnlockApprovalCard.
@Composable
private fun BootUnlockApprovalCard(
    serverDomain: String,
    awaitingUnlock: Boolean,
    purpose: SecretPurpose = SecretPurpose.UNLOCK_KEY,
) {
    val mailbox = LocalSecretMailboxClient.current
    val app = LocalAppState.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val username by app.currentUser.collectAsState()
    val store = remember { ServerSettingsStore.from(context) }
    val isEntitlement = purpose == SecretPurpose.ENTITLEMENT
    val headline = if (isEntitlement) "Your server is waiting for authorization to serve"
                   else "Your server is waiting for your approval to unlock"
    val bodyCopy = if (isEntitlement)
        "Authorize this server to serve your account so it can come online. Your phone will ask you to unlock once to approve."
    else
        "If you just powered it on, release its disk key to bring it online. Your phone will ask you to unlock once to approve."
    val ctaLabel = if (isEntitlement) "Authorize" else "Approve unlock"
    val approvedCopy = if (isEntitlement) "Authorized. Your server should come online shortly."
                       else "Unlock approved. Your server should come online shortly."

    val vm = remember(serverDomain, purpose) {
        BootUnlockApprovalViewModel(
            serverDomain = serverDomain,
            makeSource = {
                username?.let { user ->
                    CoordinatorApprovalSource(
                        SecretRequestCoordinator(
                            mailbox = mailbox,
                            username = user,
                            irk = KeystoreIrkAccess(),
                            // Slice D — the boot-approval ceremony mints the
                            // RootEntitlement (owner decision: ADMIN-ROOT — a
                            // reburned admin-pinned box rejects an IRK-signed one)
                            // + the box-sealed auto-unlock lease; both sign with
                            // the admin master root when held. Transport envelopes
                            // stay IRK.
                            adminSigner = { r ->
                                if (Keystore.hasAdminRoot()) Keystore.adminRootKey(r) else null
                            },
                        ),
                    )
                }
            },
            // "auto" servers (default; absent ⇒ auto) deposit a self-unlock
            // lease on approve — matching the create-time choice.
            depositAutoLease = {
                store.effectiveMode(serverDomain) == ServerSettingsStore.Mode.AUTO
            },
            purpose = purpose,
        )
    }
    val state by vm.state.collectAsState()

    // Directory-driven surfacing — no biometric, no network. Arms/clears the
    // prompt on entry + whenever the flag changes. ALSO keyed on the VM
    // instance: `remember(serverDomain, …)` re-creates the VM when the loaded
    // BFF detail supplies its own FQDN, and the fresh (Idle) VM must re-arm or
    // the card silently vanishes the moment the detail loads. On a real box
    // the BFF FQDN equals the pod FQDN so the key never changes — this only
    // matters when the two strings differ (the mock client's canned detail).
    LaunchedEffect(vm, awaitingUnlock) { vm.setAwaitingUnlock(awaitingUnlock) }

    when (val s = state) {
        is BootUnlockApprovalViewModel.State.Idle -> Unit
        is BootUnlockApprovalViewModel.State.RequestPending -> SdSection("Server waiting") {
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Icon(
                            if (isEntitlement) Icons.Outlined.VerifiedUser else Icons.Outlined.LockOpen,
                            contentDescription = null,
                            tint = FS.colors.accent,
                        )
                        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                            Text(
                                headline,
                                color = MaterialTheme.colorScheme.onSurface,
                                style = MaterialTheme.typography.titleMedium,
                            )
                            Text(
                                bodyCopy,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                    FSPrimaryButton(
                        label = ctaLabel,
                        onClick = { scope.launch { vm.approve() } },
                        block = true,
                        large = true,
                        modifier = Modifier
                            .padding(top = FS.space.s2)
                            .semantics { contentDescription = "sd-approve-unlock" },
                    )
                    FSSecondaryButton(
                        label = "Deny",
                        onClick = { vm.deny() },
                        block = true,
                        modifier = Modifier.semantics { contentDescription = "sd-deny-unlock" },
                    )
                }
            }
        }
        is BootUnlockApprovalViewModel.State.Approving -> SdSection("Boot unlock") {
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                    Text("Sending approval…", color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge)
                }
            }
        }
        is BootUnlockApprovalViewModel.State.Approved -> SdSection("Boot unlock") {
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = FS.colors.success)
                    Text(
                        approvedCopy,
                        color = MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
            }
        }
        is BootUnlockApprovalViewModel.State.Failed -> SdSection("Boot unlock") {
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Text(s.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                    FSSecondaryButton(
                        label = "Retry",
                        onClick = { vm.retry() },
                        block = true,
                        modifier = Modifier.semantics { contentDescription = "sd-approve-unlock-retry" },
                    )
                }
            }
        }
    }
}

/** A server's apps, each opening its page, plus "Create app here". An app
 *  being copied here is greyed out with its progress; the list is polled
 *  while a copy is underway and the page is visible. */
@Composable
private fun ServerAppsSection(podId: String, client: com.flagshipserver.app.api.ScreensClient) {
    val deepLinker = com.flagshipserver.app.core.LocalDeepLinker.current
    val vm = remember(podId, client) { com.flagshipserver.app.viewmodels.ServerAppsViewModel(client) }
    val phase by vm.phase.collectAsState()
    val retryScope = rememberCoroutineScope()
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(vm) {
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
            vm.load()
            while (vm.underway) {
                kotlinx.coroutines.delay(2_000)
                vm.load()
            }
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
        FSSectionHeader(com.flagshipserver.app.viewmodels.ServerAppsViewModel.TITLE)
        when (val p = phase) {
            is com.flagshipserver.app.viewmodels.ServerAppsViewModel.Phase.Loading -> ServerCardSkeleton()
            is com.flagshipserver.app.viewmodels.ServerAppsViewModel.Phase.Failed ->
                ErrorCard(p.message, onRetry = { retryScope.launch { vm.load() } })
            is com.flagshipserver.app.viewmodels.ServerAppsViewModel.Phase.Loaded -> {
                if (p.rows.isEmpty()) {
                    FSNote(com.flagshipserver.app.viewmodels.ServerAppsViewModel.EMPTY)
                }
                p.rows.forEach { row ->
                    val greyed = !row.opens
                    com.flagshipserver.app.ui.components.FSListRow(
                        leading = com.flagshipserver.app.ui.components.FSListLeading.Icon(
                            icon = androidx.compose.material.icons.Icons.Outlined.Apps,
                            color = if (greyed) FS.colors.textMuted else FS.colors.primary,
                        ),
                        title = row.name,
                        subtitle = row.status,
                        detail = row.address.ifEmpty { null },
                        onClick = if (row.opens) {
                            { deepLinker.enqueue(com.flagshipserver.app.core.DeepLink.AppDetail(row.serviceId, podId)) }
                        } else {
                            null
                        },
                        modifier = Modifier
                            .then(if (greyed) Modifier.alpha(0.55f) else Modifier)
                            .testTag("server-app-${row.serviceId}"),
                    )
                }
            }
        }
        FSSecondaryButton(
            label = com.flagshipserver.app.viewmodels.ServerAppsViewModel.CREATE_HERE,
            onClick = { deepLinker.enqueue(com.flagshipserver.app.core.DeepLink.CreateApp(podId)) },
            block = true,
            modifier = Modifier.testTag("server-create-app-here"),
        )
    }
}

/** The bar across the top of a full-screen sheet: a close button and its
 *  title (iOS's sheet with a navigation title and Done). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SheetTopBar(title: String, onClose: () -> Unit) {
    androidx.compose.material3.TopAppBar(
        title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        navigationIcon = {
            androidx.compose.material3.IconButton(onClick = onClose, modifier = Modifier.testTag("sheet-close")) {
                Icon(Icons.Outlined.Close, contentDescription = "Close")
            }
        },
        windowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
        colors = androidx.compose.material3.TopAppBarDefaults.topAppBarColors(
            containerColor = MaterialTheme.colorScheme.background,
        ),
    )
}

/** An icon and a line of text, like iOS's Label. */
@Composable
private fun IconLine(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String, tint: Color? = null, modifier: Modifier = Modifier) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier,
    ) {
        Icon(icon, contentDescription = null, tint = tint ?: MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
        Text(text, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge)
    }
}

/** A section header over its card, the pair kept close together. */
@Composable
private fun SdSection(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
        FSSectionHeader(title)
        content()
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun ServerInfoCard(detail: com.flagshipserver.app.api.ServerDetailResponse) {
    // Mirror of iOS ServerDetailScreen.overview: status, address, the
    // headline numbers, and how long it has been up.
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            FSPill("Online", kind = FSPillKind.Online)
            Text(
                detail.serverFqdn.replace(".", ".\u200B"),
                color = MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            )
            androidx.compose.foundation.layout.FlowRow(
                horizontalArrangement = Arrangement.spacedBy(FS.space.s6),
                verticalArrangement = Arrangement.spacedBy(FS.space.s2),
            ) {
                OverviewStat("Apps", "${detail.serviceCount}")
                OverviewStat("Devices", "${detail.pairedSessionCount}")
                OverviewStat("Software", detail.daemonVersion)
                // The box-reported running commit (short) — the version the
                // update card orders away from. Hidden until the box reports.
                shortCommit(detail.currentCommit)?.let { short -> OverviewStat("Version", short) }
            }
            Text(
                "Up for ${uptimeLabel(detail.uptimeMs)}",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun OverviewStat(label: String, value: String) {
    Column {
        Text(value, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleMedium, maxLines = 1)
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelSmall)
    }
}

private fun uptimeLabel(ms: Long): String {
    val seconds = ms / 1000
    val days = (seconds / 86_400).toInt()
    val hours = ((seconds % 86_400) / 3_600).toInt()
    val minutes = ((seconds % 3_600) / 60).toInt()
    return when {
        days > 0 -> plural(days, "day")
        hours > 0 -> plural(hours, "hour")
        else -> plural(minutes, "minute")
    }
}

// "Front page" picker: choose which installed app the box's root domain
// redirects to (a visible 302 to the app's tier-1 canonical), or keep the
// default Flagship page. Save signs a `set-front-page` order with the owner
// IRK (biometric inside the signer) and POSTs it pod-direct. Mirror of iOS
// FrontPageCard.
@Composable
private fun FrontPageCard(serverDomain: String) {
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()

    val vm = remember(serverDomain) {
        FrontPageViewModel(
            serverDomain = serverDomain,
            // Slice D — set-front-page is SENSITIVE: sign with the admin master
            // root when this device holds one (else the owner IRK).
            signer = { reason -> Keystore.adminSigningKey(reason) },
        )
    }
    val phase by vm.phase.collectAsState()
    val current by vm.current.collectAsState()
    val options by vm.options.collectAsState()
    var selection by remember { mutableStateOf("") }

    LaunchedEffect(serverDomain) {
        vm.load()
        selection = vm.current.value ?: ""
    }

    val busy = phase is FrontPagePhase.Signing || phase is FrontPagePhase.Posting

    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
        FSSectionHeader("Front page")
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text("What visitors see", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Point $serverDomain at one of your apps, or keep the default Flagship page.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
                when (phase) {
                    is FrontPagePhase.Idle, is FrontPagePhase.Loading -> {
                        Text("Loading…", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                    }
                    is FrontPagePhase.Failed -> {
                        Text(
                            (phase as FrontPagePhase.Failed).message,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        FSSecondaryButton(
                            label = "Retry",
                            onClick = {
                                scope.launch {
                                    vm.load()
                                    selection = vm.current.value ?: ""
                                }
                            },
                            block = true,
                        )
                    }
                    else -> {
                        // "" = the default page; then one row per installed app.
                        // An assigned-but-uninstalled label still shows (marked)
                        // so the owner can see and clear a stale assignment.
                        val rows = buildList {
                            add(Triple("", "Default Flagship page", null as String?))
                            for (o in options) add(Triple(o.urlLabel, o.name ?: o.urlLabel, o.name?.let { o.urlLabel }))
                            current?.let { cur ->
                                if (options.none { it.urlLabel == cur }) add(Triple(cur, cur, "No longer installed"))
                            }
                        }
                        for ((value, labelText, detailText) in rows) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .testTag("sd-front-page-option-${value.ifEmpty { "default" }}")
                                    .selectable(selected = selection == value, enabled = !busy) {
                                        selection = value
                                    },
                            ) {
                                RadioButton(
                                    selected = selection == value,
                                    onClick = { if (!busy) selection = value },
                                )
                                Column(Modifier.padding(vertical = FS.space.s1)) {
                                    Text(labelText, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge)
                                    if (detailText != null) {
                                        Text(
                                            detailText,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                        )
                                    }
                                }
                            }
                        }
                        FSPrimaryButton(
                            label = if (busy) "Saving…" else "Save",
                            onClick = {
                                if (!busy && selection != (current ?: "")) {
                                    scope.launch {
                                        vm.save(selection)
                                        val p = vm.phase.value
                                        if (p is FrontPagePhase.Failed) {
                                            toasts.error(p.message)
                                            selection = vm.current.value ?: ""
                                        } else {
                                            toasts.success(
                                                if (selection.isEmpty()) "Front page reset to default"
                                                else "Front page set to $selection",
                                            )
                                        }
                                    }
                                }
                            },
                            enabled = !busy && !LocalServerReadOnly.current && selection != (current ?: ""),
                            block = true,
                            modifier = Modifier.semantics { contentDescription = "sd-front-page-save" },
                        )
                    }
                }
            }
        }
    }
}

// "Make leader" — moves this server to the top of the owner's server order
// (docs/server-order.md) through the same saver and AppState order as Home's
// drag, so Home already lists it first with the Leader badge on the way back,
// and puts the old order back everywhere if signing or saving fails.
@Composable
private fun LeaderCard(serverDomain: String) {
    val app = LocalAppState.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    val saver = com.flagshipserver.app.core.rememberServerOrderSaver()

    val ordered by app.orderedPods.collectAsState()
    val orderIssuedAt by app.serverOrderIssuedAt.collectAsState()
    val acks by app.serverOrderAcks.collectAsState()

    val orderable = ordered.filter(com.flagshipserver.app.core.ServerOrderProtocol::orderable)
    val pod = orderable.firstOrNull { it.fqdn.equals(serverDomain, ignoreCase = true) }
    // Only meaningful among two or more servers this one can be ranked against.
    if (pod == null || orderable.size < 2) return
    val index = orderable.indexOf(pod)
    // The same leader Home badges: the first server in the order that is online.
    val isLeader = leaderLabel(ordered)?.podId == pod.podId
    val confirmed = leaderConfirmed(false, orderIssuedAt, acks, pod.podId)

    var working by remember(serverDomain) { mutableStateOf(false) }

    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
        FSSectionHeader("Server order")
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (isLeader) {
                        Icon(Icons.Outlined.Flag, contentDescription = null, tint = FS.colors.accent, modifier = Modifier.size(20.dp))
                    }
                    Text(
                        if (isLeader) "This server leads"
                        else successionLine(orderable.take(index).map { it.name }),
                        color = MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.testTag("sd-leader-status"),
                    )
                }
                if (isLeader && !confirmed) {
                    Text(
                        "Waiting for it to confirm the new order.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.testTag("sd-leader-pending"),
                    )
                }
                // `.com` takes the server order only under the admin root.
                if (index != 0 && LocalServerReadOnly.current) {
                    Text(
                        com.flagshipserver.app.core.AdminOrderGate.SERVER_ORDER,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.testTag("sd-leader-admin-only"),
                    )
                } else if (index != 0) {
                    FSPrimaryButton(
                        label = if (working) "Saving…" else "Make leader",
                        onClick = {
                            if (working) return@FSPrimaryButton
                            working = true
                            scope.launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
                                when (val outcome = saver.makeLeader(pod.podId)) {
                                    is com.flagshipserver.app.core.ServerOrderSaver.Outcome.Failed ->
                                        toasts.warning(outcome.message)
                                    com.flagshipserver.app.core.ServerOrderSaver.Outcome.Superseded ->
                                        toasts.info("Another device changed the order. Showing the newest one.")
                                    else -> toasts.success("${pod.name} is now first in your server list.")
                                }
                                working = false
                            }
                        },
                        enabled = !working,
                        block = true,
                        modifier = Modifier.testTag("sd-make-leader"),
                    )
                }
            }
        }
    }
}

// Manual lock-&-power buttons. "Lock and turn off" / "Lock and restart"
// drop "Lock and " when the box is non-LUKS. Confirm dialog → owner-IRK-signed
// `power-off` order (the deriveIRK signer fires the biometric) → POST to the
// box's /api/power. Mirror of iOS PowerCard.
//
// LUKS LABEL: ServerDetailResponse carries no diskEncryption flag (set at
// create-time on the InstallBlob, never surfaced on the detail model), so we
// default to LUKS labeling. Tracked as a gap — when the detail model gains the
// flag, pass it here to flip to plain "Turn off"/"Restart" for non-LUKS boxes.
@Composable
private fun PowerCard(serverDomain: String, isLuks: Boolean = true) {
    val app = LocalAppState.current
    val toasts = LocalToastCenter.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val username by app.currentUser.collectAsState()

    val vm = remember(serverDomain) {
        PowerOffViewModel(
            serverDomain = serverDomain,
            // Slice D — power-off is SENSITIVE: the biometric gate signs with the
            // admin master root when this device holds one (else the owner IRK,
            // the key the daemon's /api/power pins on a legacy box). Never silent.
            signer = { reason -> Keystore.adminSigningKey(reason) },
        )
    }
    val phase by vm.phase.collectAsState()
    var pending by remember { mutableStateOf<PowerMode?>(null) }
    val busy = phase is PowerOffPhase.Signing || phase is PowerOffPhase.Posting

    val prefix = if (isLuks) "Lock and " else ""
    val offLabel = "${prefix}turn off".replaceFirstChar { it.uppercase() }
    val restartLabel = "${prefix}restart".replaceFirstChar { it.uppercase() }

    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
        FSSectionHeader("Power")
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                (phase as? PowerOffPhase.Failed)?.let { f ->
                    Text(f.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
                (phase as? PowerOffPhase.Completed)?.let { c ->
                    IconLine(
                        if (c.mode == PowerMode.RESTART) Icons.Outlined.RestartAlt else Icons.Outlined.PowerSettingsNew,
                        "This server is ${if (c.mode == PowerMode.RESTART) "restarting" else "powering off"} — it will go offline.",
                    )
                }
                FSSecondaryButton(
                    label = if (busy) "Working…" else offLabel,
                    onClick = { if (!busy) pending = PowerMode.OFF },
                    enabled = !busy && !LocalServerReadOnly.current,
                    block = true,
                    modifier = Modifier.semantics { contentDescription = "sd-power-off" },
                )
                FSSecondaryButton(
                    label = if (busy) "Working…" else restartLabel,
                    onClick = { if (!busy) pending = PowerMode.RESTART },
                    enabled = !busy && !LocalServerReadOnly.current,
                    block = true,
                    modifier = Modifier.semantics { contentDescription = "sd-power-restart" },
                )
            }
        }
    }

    pending?.let { mode ->
        val confirmLabel = if (mode == PowerMode.RESTART) restartLabel else offLabel
        AlertDialog(
            onDismissRequest = { pending = null },
            title = { Text("$confirmLabel?") },
            text = { Text("$serverDomain will go offline.") },
            confirmButton = {
                TextButton(onClick = {
                    pending = null
                    scope.launch {
                        // The deriveIRK signer fires the biometric prompt inside
                        // vm.run — no separate gate needed (matches DeadManCard).
                        vm.run(mode)
                        when (val p = vm.phase.value) {
                            is PowerOffPhase.Completed ->
                                toasts.success("Command sent to the server.")
                            is PowerOffPhase.Failed ->
                                toasts.error(p.message)
                            else -> {}
                        }
                    }
                }) { Text(confirmLabel, color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { pending = null }) { Text("Cancel") }
            },
        )
    }
}

// Diagnostics: fetch + show the box's recent journal. Owner-only (the deriveIRK
// signer fires the biometric) and pod-direct — .com never sees the request or
// the logs. Mirror of iOS JournalCard.
@Composable
private fun JournalCard(serverDomain: String) {
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()

    val vm = remember(serverDomain) {
        JournalViewModel(
            serverDomain = serverDomain,
            signer = { reason -> Keystore.deriveIRK(reason) },
        )
    }
    val phase by vm.phase.collectAsState()
    var unit by remember { mutableStateOf(JournalUnits.DEFAULT_UNIT) }
    val busy = phase is JournalPhase.Loading

    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
        FSSectionHeader("Diagnostics")
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                // Unit picker — which systemd unit's journal to fetch (mirror of the
                // iOS segmented Picker over JournalUnits.all + the webapp <select>).
                if (JournalUnits.ALL.size > 1) {
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                        for (u in JournalUnits.ALL) {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .selectable(selected = unit == u, enabled = !busy, onClick = { unit = u })
                                    .semantics { contentDescription = "sd-journal-unit-$u" },
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(selected = unit == u, onClick = { if (!busy) unit = u })
                                Text(u, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
                (phase as? JournalPhase.Failed)?.let { f ->
                    Text(f.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
                FSSecondaryButton(
                    label = if (busy) "Fetching…" else "View journal",
                    onClick = {
                        if (!busy) scope.launch {
                            vm.load(unit, JournalUnits.DEFAULT_LINES)
                            (vm.phase.value as? JournalPhase.Failed)?.let { toasts.error(it.message) }
                        }
                    },
                    enabled = !busy,
                    block = true,
                    modifier = Modifier.semantics { contentDescription = "sd-journal-fetch" },
                )
                (phase as? JournalPhase.Loaded)?.let { loaded ->
                    val text = if (loaded.lines.isEmpty()) {
                        "(${loaded.unit}: journal is empty)"
                    } else {
                        loaded.lines.joinToString("\n")
                    }
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(max = 280.dp)
                            .clip(RoundedCornerShape(FS.radius.md))
                            .background(FS.colors.surface)
                            .verticalScroll(rememberScrollState())
                            .padding(FS.space.s2),
                    ) {
                        Text(
                            text,
                            color = MaterialTheme.colorScheme.onSurface,
                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        )
                    }
                }
            }
        }
    }
}

// Dead-man heartbeat-lock opt-in + the manual affirmation loop. Toggle arms
// the IRK-signed SetDeadManPolicy; a window picker (24h default, down to
// minutes) + a one-tap "tighten now" + a lockout-action choice (off default /
// restart). "Affirm now" sends an IRK-signed DeadManAffirmation and reschedules
// the T-6h/T-1h/T-15m reminders. Mirror of iOS DeadManCard.
@Composable
private fun DeadManCard(serverDomain: String) {
    val app = LocalAppState.current
    val toasts = LocalToastCenter.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val username by app.currentUser.collectAsState()
    val store = remember { ServerSettingsStore.from(context) }

    val vm = remember(serverDomain) {
        DeadManViewModel(
            serverDomain = serverDomain,
            username = { username },
            // Slice D — dead-man policy/affirm is SENSITIVE: sign with the admin
            // master root when this device holds one (else the owner IRK). The
            // biometric gate is never silent.
            signer = { reason -> Keystore.adminSigningKey(reason) },
        )
    }
    val phase by vm.phase.collectAsState()
    val busy = phase is DeadManPhase.Signing || phase is DeadManPhase.Posting

    // Hydrate from the per-server store so a return visit restores the armed
    // state + window + lockout + the last lease deadline (mirror of iOS
    // DeadManViewModel.init reading DeadManStore).
    var enabled by remember(serverDomain) { mutableStateOf(store.deadManEnabled(serverDomain)) }
    var window by remember(serverDomain) {
        mutableStateOf(
            DeadManWindow.fromMs(store.deadManWindowMs(serverDomain)) ?: DeadManWindow.DEFAULT,
        )
    }
    var lockout by remember(serverDomain) {
        mutableStateOf(PowerMode.fromWire(store.deadManLockoutMode(serverDomain)) ?: PowerMode.OFF)
    }
    var leaseExpiry by remember(serverDomain) { mutableStateOf(store.deadManLeaseExpiry(serverDomain)) }

    // 1s ticker so the "Locks in …" countdown re-renders each second while
    // armed (mirror of iOS LockPowerViews ticker + webapp startDeadManCountdown).
    var nowTick by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(enabled, leaseExpiry) {
        while (enabled) {
            nowTick = System.currentTimeMillis()
            kotlinx.coroutines.delay(1000)
        }
    }

    fun applyPolicy(targetEnabled: Boolean, targetWindow: DeadManWindow, targetLockout: PowerMode) {
        scope.launch {
            val ok = vm.setPolicy(targetEnabled, targetWindow, targetLockout)
            if (ok) {
                enabled = targetEnabled
                window = targetWindow
                lockout = targetLockout
                store.saveDeadManPolicy(
                    serverDomain = serverDomain,
                    enabled = targetEnabled,
                    windowMs = targetWindow.windowMs,
                    graceMs = vm.graceMs,
                    lockoutMode = targetLockout.wire,
                )
                if (!targetEnabled) {
                    leaseExpiry = null
                    store.setDeadManLeaseExpiry(serverDomain, null)
                    DeadManReminderScheduler.cancel(context, serverDomain)
                    toasts.success("Lock-down off.")
                } else {
                    toasts.success("Lock-down on. Affirm to keep ${serverDomain.substringBefore('.')} unlocked.")
                }
            } else {
                (vm.phase.value as? DeadManPhase.Failed)?.let { toasts.error(it.message) }
            }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
        FSSectionHeader("Lock-down")
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Auto lock-down", color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge)
                        Text(
                            "If you don't affirm in time, this server locks itself: it powers off (or restarts) and needs your phone to come back.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                    Switch(
                        checked = enabled,
                        enabled = !busy && !LocalServerReadOnly.current,
                        onCheckedChange = { applyPolicy(it, window, lockout) },
                        modifier = Modifier.semantics { contentDescription = "sd-deadman-toggle" },
                    )
                }

                if (enabled) {
                    FSCardDivider()
                    Text("Window", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelLarge)
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                        for (w in DeadManWindow.entries) {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .selectable(selected = window == w, enabled = !busy && !LocalServerReadOnly.current, onClick = { applyPolicy(true, w, lockout) })
                                    .semantics { contentDescription = "deadman-window-${w.windowMs}" },
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(selected = window == w, onClick = null, enabled = !busy)
                                Text(w.label, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge)
                            }
                        }
                    }

                    Text("On lapse", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelLarge)
                    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s4)) {
                        for (m in listOf(PowerMode.OFF to "Turn off", PowerMode.RESTART to "Restart")) {
                            Row(
                                Modifier
                                    .selectable(selected = lockout == m.first, enabled = !busy && !LocalServerReadOnly.current, onClick = { applyPolicy(true, window, m.first) })
                                    .semantics { contentDescription = "deadman-lockout-${m.first.wire}" },
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(selected = lockout == m.first, onClick = null, enabled = !busy)
                                Text(m.second, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge)
                            }
                        }
                    }

                    // Live countdown — re-renders each second off `nowTick`. Three
                    // states mirror iOS LockPowerViews.leaseSection + webapp:
                    // "Locks in …" while time remains, "Window lapsed" once it does,
                    // and a "not affirmed yet" prompt when no lease exists.
                    FSCardDivider()
                    Text("Stay unlocked", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelLarge)
                    val exp = leaseExpiry
                    if (exp != null) {
                        val remaining = exp - nowTick
                        Text(
                            if (remaining > 0) "Locks in ${DeadManReminders.remainingLabel(exp, nowTick)}"
                            else "Window lapsed — affirm now",
                            color = if (remaining > 0) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.titleMedium,
                            modifier = Modifier.semantics { contentDescription = "sd-deadman-remaining" },
                        )
                    } else {
                        Text(
                            "Not affirmed yet — affirm to start the window.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.semantics { contentDescription = "sd-deadman-remaining" },
                        )
                    }

                    FSDangerButton(
                        label = "Tighten now (5 min)",
                        onClick = { applyPolicy(true, DeadManWindow.TIGHTEN, lockout) },
                        enabled = !busy && !LocalServerReadOnly.current,
                        block = true,
                    )
                    FSPrimaryButton(
                        // "Keep <server> unlocked" mirrors iOS LockPowerViews +
                        // the webapp affirm CTA; busy reads "Affirming…".
                        label = if (busy) "Affirming…" else "Keep ${serverDomain.substringBefore('.')} unlocked",
                        onClick = {
                            scope.launch {
                                val exp = vm.affirm()
                                if (exp != null) {
                                    leaseExpiry = exp
                                    store.setDeadManLeaseExpiry(serverDomain, exp)
                                    DeadManReminderScheduler.schedule(context, serverDomain, exp)
                                    toasts.success("Stay confirmed.")
                                } else {
                                    (vm.phase.value as? DeadManPhase.Failed)?.let { toasts.error(it.message) }
                                }
                            }
                        },
                        enabled = !busy && !LocalServerReadOnly.current,
                        block = true,
                        modifier = Modifier.semantics { contentDescription = "sd-deadman-affirm" },
                    )
                }
            }
        }
    }
}

/** Short display form of the box-reported HEAD, or null while unknown
 *  (e.g. an un-reburned box whose daemon predates the field). */
private fun shortCommit(sha: String?): String? =
    sha?.takeIf { it.length == 40 && it.all { c -> c in '0'..'9' || c in 'a'..'f' } }?.take(8)

// "Update this server" entry on server-detail (docs/server-update-mechanism.md).
// Admin-only — the update order is signed with the admin master root (when
// pinned) behind the biometric inside UpdateServerViewModel, and it is only
// HALF the gate: the box also requires the target commit to be maintainer-
// endorsed, and rolls back automatically if the new version fails to boot.
// Disabled (with a hint) until the box reports its running commit — the
// order's `fromCommit` must be truth, never a guess. Mirror of iOS
// UpdateServerCard.
@Composable
internal fun UpdateServerCard(
    serverDomain: String,
    currentCommit: String?,
    lastUpdate: LastUpdate? = null,
    onRefresh: () -> Unit = {},
    pendingStore: PendingUpdateStore? = null,
    clock: () -> Long = { System.currentTimeMillis() },
) {
    val app = LocalAppState.current
    val mailbox = LocalSecretMailboxClient.current
    val screens = LocalScreensClient.current
    val toasts = LocalToastCenter.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val username by app.currentUser.collectAsState()
    val store = pendingStore ?: remember { SharedPrefsPendingUpdateStore.from(context) }
    var showSheet by remember { mutableStateOf(false) }
    var latestTag by remember { mutableStateOf<String?>(null) }
    val reported = shortCommit(currentCommit) != null

    // Keyed on the running commit so the order's `fromCommit` is always the
    // box's latest report; the pending order survives in the store.
    val vm = remember(serverDomain, currentCommit, username) {
        UpdateServerViewModel(
            username = username ?: "",
            serverFqdn = serverDomain,
            currentCommit = currentCommit,
            mailbox = mailbox,
            now = clock,
            pendingStore = store,
        ).also { it.reconcile(currentCommit, lastUpdate) }
    }
    val pending by vm.pending.collectAsState()
    val phase by vm.phase.collectAsState()
    var now by remember { mutableStateOf(clock()) }

    LaunchedEffect(vm, lastUpdate) { vm.reconcile(currentCommit, lastUpdate) }

    // While an order is pending and the page is on screen, re-read
    // server-detail now and then so the card notices the outcome.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val refresh by rememberUpdatedState(onRefresh)
    LaunchedEffect(pending != null) {
        if (pending == null) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                now = clock()
                kotlinx.coroutines.delay(PendingUpdate.REFRESH_EVERY_MS)
                refresh()
            }
        }
    }

    LaunchedEffect(currentCommit) {
        latestTag = runCatching {
            loadReleaseCatalog(screens, mailbox, currentCommit, refresh = false).latest?.tag
        }.getOrNull()
    }

    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
        FSSectionHeader("Update server")
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                shortCommit(currentCommit)?.let { short ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "Running",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            short,
                            color = MaterialTheme.colorScheme.onSurface,
                            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                        )
                    }
                }
                if (pending == null) {
                    latestTag?.let { tag ->
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Outlined.Upgrade, contentDescription = null, tint = FS.colors.accent, modifier = Modifier.size(20.dp))
                            Text(
                                "New release available: $tag",
                                color = FS.colors.primary,
                                style = MaterialTheme.typography.titleSmall,
                                modifier = Modifier.semantics { contentDescription = "sd-update-available" },
                            )
                        }
                    }
                }
                lastUpdate?.summary?.let { summary ->
                    Text(
                        summary,
                        color = if (lastUpdate.outcome == "applied") FS.colors.textMuted else FS.colors.danger,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.semantics { contentDescription = "sd-update-last-outcome" },
                    )
                }
                val p = pending
                if (p != null) {
                    PendingUpdateNotice(
                        pending = p,
                        nowMs = maxOf(now, p.orderedAt),
                        phase = phase,
                        onSendAgain = { scope.launch { if (vm.sendAgain()) toasts.success("Update ordered") } },
                        onForget = { vm.forget() },
                    )
                } else {
                    val updateLabel = if (latestTag == null) "Update this server" else "Update to latest"
                    val updateEnabled = reported && !LocalServerReadOnly.current
                    val updateMod = Modifier.semantics { contentDescription = "sd-update-server" }
                    if (latestTag == null) {
                        com.flagshipserver.app.ui.components.FSSecondaryButton(
                            label = updateLabel,
                            onClick = { vm.clearFailure(); showSheet = true },
                            block = true,
                            enabled = updateEnabled,
                            modifier = updateMod,
                        )
                    } else {
                        FSPrimaryButton(
                            label = updateLabel,
                            onClick = { vm.clearFailure(); showSheet = true },
                            block = true,
                            enabled = updateEnabled,
                            modifier = updateMod,
                        )
                    }
                    if (!reported) {
                        Text(
                            "Waiting for this server to report its current version — it can't be updated in place until it does.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }
        }
    }

    if (showSheet) {
        Dialog(
            onDismissRequest = { showSheet = false },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            UpdateServerSheet(
                serverDomain = serverDomain,
                currentCommit = currentCommit,
                vm = vm,
                onDone = { showSheet = false },
                nowMs = now,
            )
        }
    }
}

/** The sent-but-not-yet-applied state, shared by the card and the sheet:
 *  a progress line until 30 minutes pass, then the stale copy with
 *  Send again / Forget it. */
@Composable
private fun PendingUpdateNotice(
    pending: PendingUpdate,
    nowMs: Long,
    phase: UpdateServerViewModel.Phase,
    onSendAgain: () -> Unit,
    onForget: () -> Unit,
) {
    val working = phase is UpdateServerViewModel.Phase.Signing ||
        phase is UpdateServerViewModel.Phase.Posting
    val stale = pending.isStale(nowMs)
    Column(
        verticalArrangement = Arrangement.spacedBy(FS.space.s2),
        modifier = Modifier.semantics { contentDescription = "sd-update-pending" },
    ) {
        Row(
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
        ) {
            if (!stale) {
                CircularProgressIndicator(
                    modifier = Modifier.padding(top = 2.dp).size(16.dp),
                    strokeWidth = 2.dp,
                )
            }
            Text(
                pending.sentLine(nowMs),
                color = MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        if (stale) {
            Text(
                PendingUpdate.STALE_COPY,
                color = FS.colors.warning,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.semantics { contentDescription = "sd-update-pending-stale" },
            )
            FSPrimaryButton(
                label = if (working) "Working…" else "Send again",
                onClick = onSendAgain,
                enabled = !working,
                block = true,
                modifier = Modifier.semantics { contentDescription = "sd-update-send-again" },
            )
            FSSecondaryButton(
                label = "Forget it",
                onClick = onForget,
                enabled = !working,
                block = true,
                modifier = Modifier.semantics { contentDescription = "sd-update-forget" },
            )
        }
        (phase as? UpdateServerViewModel.Phase.Failed)?.let { f ->
            Text(f.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

private const val DOWNGRADE_WARNING =
    "Older releases don't have the fixes made since, and may not understand changes made to this server after them, such as a rotated admin key. In the worst case the server stops accepting updates and has to be reinstalled. Only go back if a newer release broke something."

/** Plain copy for a failed release-list call; a bare status code never reaches the UI. */
private fun releaseCheckProblem(t: Throwable): String = when ((t as? ScreensError.Http)?.status ?: (t as? HttpException)?.status) {
    null -> t.userFacing()
    401, 403 -> "You're not signed in for that. Try signing in again."
    404 -> "We couldn't find that. It may have moved or been removed."
    408, 429 -> "The server is busy right now. Give it a moment and try again."
    in 500..599 -> "Service temporarily unavailable. Try again in a few minutes."
    else -> "That didn't work. Check your connection and try again."
}

// The box lists the releases it verified for itself; the main action is
// "Update to latest", other newer releases sit below, and going back to an
// older release (or pasting any commit) is under Advanced behind a warning and
// a confirmation. Whatever is picked, the signed order names one exact commit.
// Mirror of iOS UpdateServerSheet.
@Composable
internal fun UpdateServerSheet(
    serverDomain: String,
    currentCommit: String?,
    vm: UpdateServerViewModel,
    onDone: () -> Unit,
    nowMs: Long = System.currentTimeMillis(),
) {
    val screens = LocalScreensClient.current
    val mailbox = LocalSecretMailboxClient.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    val phase by vm.phase.collectAsState()
    val pending by vm.pending.collectAsState()
    var target by remember { mutableStateOf("") }
    var catalog by remember { mutableStateOf<ReleaseCatalogResponse?>(null) }
    var catalogError by remember { mutableStateOf<String?>(null) }
    var loadingCatalog by remember { mutableStateOf(false) }
    var showAdvanced by remember { mutableStateOf(false) }
    val working = phase is UpdateServerViewModel.Phase.Signing ||
        phase is UpdateServerViewModel.Phase.Posting

    suspend fun loadCatalog(refresh: Boolean) {
        loadingCatalog = true
        try {
            catalog = loadReleaseCatalog(screens, mailbox, currentCommit, refresh)
            catalogError = null
        } catch (c: kotlinx.coroutines.CancellationException) {
            throw c
        } catch (t: Throwable) {
            if (catalog == null) catalogError = releaseCheckProblem(t)
        } finally {
            loadingCatalog = false
        }
    }

    fun order(commit: String, tag: String? = null) {
        if (working) return
        val known = tag ?: catalog?.let { c ->
            (listOfNotNull(c.latest) + c.releases).firstOrNull { it.commit.equals(commit, ignoreCase = true) }?.tag
        }
        scope.launch {
            if (vm.update(commit, known)) toasts.success("Update ordered")
        }
    }

    LaunchedEffect(Unit) { loadCatalog(refresh = false) }

    val muted = MaterialTheme.typography.bodyMedium
    val mono = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace)

    @Composable
    fun releaseRow(r: ReleaseEntry, actionLabel: String, action: () -> Unit) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                r.tag,
                color = MaterialTheme.colorScheme.onSurface,
                style = mono,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            FSGhostButton(label = actionLabel, onClick = action, enabled = vm.canUpdate && !working)
        }
    }

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        SheetTopBar(title = "Update server", onClose = onDone)
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = FS.space.s4, vertical = FS.space.s2),
            verticalArrangement = Arrangement.spacedBy(FS.space.s4),
        ) {
            Text(
                "Update $serverDomain",
                color = MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.titleLarge,
            )
            vm.runningShort?.let { short ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Running", color = MaterialTheme.colorScheme.onSurfaceVariant, style = muted, modifier = Modifier.weight(1f))
                    Text(catalog?.currentTag ?: short, color = MaterialTheme.colorScheme.onSurface, style = mono)
                }
            }
            val sent = pending
            if (sent != null) {
                PendingUpdateNotice(
                    pending = sent,
                    nowMs = maxOf(nowMs, sent.orderedAt),
                    phase = phase,
                    onSendAgain = { scope.launch { if (vm.sendAgain()) toasts.success("Update ordered") } },
                    onForget = { vm.forget() },
                )
            } else if (phase is UpdateServerViewModel.Phase.Done) {
                Text(
                    "Update sent. The server picks it up within about five minutes, checks the maintainers' signature, restarts into the new version, and goes back by itself if that version doesn't start.",
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.bodyMedium,
                )
            } else {
                val latest = catalog?.latest
                when {
                    latest != null -> FSCard(padding = PaddingValues(FS.space.s4)) {
                        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                            Text("Latest release", color = MaterialTheme.colorScheme.onSurfaceVariant, style = muted)
                            Text(latest.tag, color = MaterialTheme.colorScheme.onSurface, style = mono)
                            FSPrimaryButton(
                                label = if (working) "Working…" else "Update to latest",
                                onClick = { order(latest.commit, latest.tag) },
                                block = true,
                                enabled = vm.canUpdate && !working,
                                modifier = Modifier.semantics { contentDescription = "update-latest-btn" },
                            )
                            Text(
                                "Approve with biometrics. The server rolls back by itself if the new version doesn't start.",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = muted,
                            )
                        }
                    }
                    loadingCatalog && catalog == null -> Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                    ) {
                        CircularProgressIndicator(modifier = Modifier.height(16.dp).width(16.dp), strokeWidth = 2.dp)
                        Text("Checking for new releases…", color = MaterialTheme.colorScheme.onSurfaceVariant, style = muted)
                    }
                    catalog != null -> Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = FS.colors.success, modifier = Modifier.size(20.dp))
                        Text(
                            "This server is on the latest release.",
                            color = MaterialTheme.colorScheme.onSurface,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                        FSGhostButton(
                            label = "Check again",
                            onClick = { scope.launch { loadCatalog(refresh = true) } },
                            enabled = !loadingCatalog,
                        )
                    }
                    catalogError != null -> Text(
                        "Couldn't check for releases: $catalogError You can still enter a release under Advanced.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = muted,
                    )
                }
                if (catalog?.stale == true) {
                    Text(
                        "The server couldn't reach GitHub, so this list may be out of date.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = muted,
                    )
                }

                val others = catalog?.otherNewer.orEmpty()
                if (others.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                        Text("Other new releases", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelLarge)
                        others.forEach { r -> releaseRow(r, "Update") { order(r.commit, r.tag) } }
                    }
                }

                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { showAdvanced = !showAdvanced }
                        .padding(vertical = FS.space.s2)
                        .semantics { contentDescription = "update-advanced" },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "Advanced",
                        color = MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.weight(1f),
                    )
                    Icon(
                        if (showAdvanced) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (showAdvanced) {
                    Text(DOWNGRADE_WARNING, color = FS.colors.warning, style = muted)
                    catalog?.older.orEmpty().forEach { r ->
                        releaseRow(r, "Go back") { order(r.commit, r.tag) }
                    }
                    FSField(
                        value = target,
                        onValueChange = { target = it },
                        label = "Or enter any release (full commit)",
                        placeholder = "40-character commit hash",
                        fieldTag = "update-target-field",
                    )
                    vm.targetProblem(target)?.let { problem ->
                        Text(problem, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                    }
                    FSDangerButton(
                        label = if (working) "Working…" else "Order update",
                        onClick = onClick@{
                            if (!vm.canOrder(target) || working) return@onClick
                            order(target.trim().lowercase())
                        },
                        block = true,
                        enabled = vm.canOrder(target) && !working,
                        modifier = Modifier.semantics { contentDescription = "update-order-btn" },
                    )
                }
                (phase as? UpdateServerViewModel.Phase.Failed)?.let { f ->
                    Text(f.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
            Spacer(Modifier.height(FS.space.s6))
        }
    }
}

// Transfer-a-box entry on server-detail (docs/account-deletion-and-name-reclaim.md §4).
// Owner-only — the offer is IRK-signed behind the biometric inside
// TransferGiverViewModel, so only the box's owner can complete it. Opens the
// existing TransferGiverScreen (type-to-confirm → QR → disk-key hand-off) in a
// full-screen dialog. First button in the danger zone. Mirror of iOS DangerZoneCard.
@Composable
private fun TransferButton(serverDomain: String) {
    val app = LocalAppState.current
    val transfer = LocalServerTransferClient.current
    val mailbox = LocalSecretMailboxClient.current
    val username by app.currentUser.collectAsState()
    var showSheet by remember { mutableStateOf(false) }

    FSDangerButton(
        label = "Transfer to another account",
        onClick = { showSheet = true },
        block = true,
        enabled = !LocalServerReadOnly.current,
        modifier = Modifier.semantics { contentDescription = "sd-transfer-server" },
    )

    if (showSheet) {
        val vm = remember(serverDomain) {
            TransferGiverViewModel(
                serverDomain = serverDomain,
                username = username ?: "",
                client = transfer,
                mailbox = mailbox,
            )
        }
        Dialog(
            onDismissRequest = { showSheet = false },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                SheetTopBar(title = "Transfer server", onClose = { showSheet = false })
                TransferGiverScreen(vm = vm, serverDomain = serverDomain)
            }
        }
    }
}

// The server page's Backup / Migrate card: just the two action buttons.
// Mirror of iOS BackupMigrateCard.
@Composable
private fun BackupMigrateCard(serverDomain: String) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
        FSSectionHeader("Backup / migrate")
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                ServerBackupButton(serverDomain = serverDomain)
                MigrateServerButton(serverDomain = serverDomain)
            }
        }
    }
}

// "Migrate to new machine / VM" entry on server-detail (docs/server-migration.md).
// Same owner, same address, NEW box: the guided flow provisions a replacement,
// pre-seeds it from backup, and hands the name over — the old box is wiped
// only after a confirmed take-over. Owner-only; the migration order is
// admin-signed behind the biometric inside MigrationViewModel. Distinct from
// the old box keeps serving until the new one is ready, then is retired and
// wiped. Mirror of iOS MigrateServerButton.
@Composable
private fun MigrateServerButton(serverDomain: String) {
    val app = LocalAppState.current
    val mailbox = LocalSecretMailboxClient.current
    val screens = LocalScreensClient.current
    val context = LocalContext.current
    val username by app.currentUser.collectAsState()
    var showSheet by remember { mutableStateOf(false) }

    com.flagshipserver.app.ui.components.FSSecondaryButton(
        label = "Migrate to new machine / VM",
        onClick = { showSheet = true },
        block = true,
        enabled = !LocalServerReadOnly.current,
        modifier = Modifier.semantics { contentDescription = "sd-migrate-server" },
    )

    if (showSheet) {
        val vm = remember(serverDomain) {
            MigrationViewModel(
                serverFqdn = serverDomain,
                username = username ?: "",
                mailbox = mailbox,
                screens = screens,
                holdStore = com.flagshipserver.app.core.MigrationHoldStore.from(context),
            )
        }
        Dialog(
            onDismissRequest = { showSheet = false },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                SheetTopBar(title = "Migrate server", onClose = { showSheet = false })
                MigrateServerScreen(vm = vm)
            }
        }
    }
}

/** True on a device without the account's admin root: every order on the
 *  server page would be refused, so its controls show off (AdminOrderGate). */
internal val LocalServerReadOnly = androidx.compose.runtime.staticCompositionLocalOf { false }

// Per-server danger zone: the reversible Revoke (hidden once revoked; the
// revoked card offers Un-revoke) and Delete. Rendered whatever the box's state,
// since neither needs the box to answer. Revoke keeps the hold-to-confirm sheet
// (RevokeServerViewModel); Delete is gated on typing the server's name.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DangerZoneCard(pod: com.flagshipserver.app.core.PodInfo, canTransfer: Boolean, onDeleted: () -> Unit) {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val mailbox = LocalSecretMailboxClient.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    val username by app.currentUser.collectAsState()
    var showSheet by remember { mutableStateOf(false) }
    var confirmingDelete by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    // `.com` takes transfer, revoke and release only under the admin root.
    val readOnly = LocalServerReadOnly.current

    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
        FSSectionHeader("Danger zone")
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                if (canTransfer) TransferButton(serverDomain = pod.fqdn)
                if (!pod.isRevoked) {
                    FSDangerButton(
                        label = "Revoke server (reversible)",
                        onClick = { showSheet = true },
                        block = true,
                        enabled = !deleting && !readOnly,
                        modifier = Modifier.semantics { contentDescription = "sd-revoke-server" },
                    )
                }
                FSDangerButton(
                    label = if (deleting) "Deleting…" else "Delete and wipe this server",
                    onClick = { confirmingDelete = true },
                    block = true,
                    enabled = !deleting && !readOnly,
                    modifier = Modifier.semantics { contentDescription = "sd-delete-server" },
                )
            }
        }
    }

    if (confirmingDelete) {
        DeleteServerDialog(
            pod = pod,
            onConfirm = {
                confirmingDelete = false
                deleting = true
                scope.launch {
                    try {
                        com.flagshipserver.app.core.deleteServer(
                            pod, app, server, mailbox, toasts, onDeleted = onDeleted,
                        )
                    } finally {
                        deleting = false
                    }
                }
            },
            onDismiss = { confirmingDelete = false },
        )
    }

    if (showSheet) {
        ModalBottomSheet(
            onDismissRequest = { showSheet = false },
            sheetState = sheetState,
        ) {
            RevokeServerSheetBody(
                serverDomain = pod.fqdn,
                username = { username },
                server = server,
                onCompleted = { reason ->
                    app.setPodRevocation(pod.podId, System.currentTimeMillis(), reason.wire)
                    toasts.success("Server revoked. It can't connect or unlock until you un-revoke it.")
                    showSheet = false
                },
                onFailed = { msg ->
                    toasts.error("Revoke failed: $msg")
                },
                onCancel = { showSheet = false },
            )
        }
    }
}

private const val REVOKE_EXPLAINER =
    "Locks this server out right away: it can't connect or unlock until you un-revoke it. " +
        "Its name stays reserved. Use this if the server is lost or stolen."

// Shown at the top of a revoked server's page. Un-revoking signs with the
// sensitive-order key (UnrevokeServerViewModel) and needs nothing from the box.
@Composable
private fun RevokedServerCard(pod: com.flagshipserver.app.core.PodInfo) {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    val vm = remember(pod.fqdn) {
        UnrevokeServerViewModel(server = server, serverDomain = pod.fqdn, username = { app.currentUser.value })
    }
    val phase by vm.phase.collectAsState()
    val busy = phase is UnrevokeServerPhase.Signing || phase is UnrevokeServerPhase.Posting
    val reason = pod.revocationReason?.let { RevokeServerReason.fromWire(it)?.label?.lowercase() }
    val whenRevoked = pod.revokedAt?.let { FlagshipDateFormat.format(it) }

    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.testTag("sd-revoked-card")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
            ) {
                FSPill("Revoked", kind = FSPillKind.Offline)
                listOfNotNull(reason?.let { "Marked $it" }, whenRevoked).takeIf { it.isNotEmpty() }?.let {
                    Text(
                        it.joinToString(" · "),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            Text(
                "${pod.name} can't connect or unlock until you un-revoke it. Its name stays reserved.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
            (phase as? UnrevokeServerPhase.Failed)?.let { f ->
                Text(f.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
            FSPrimaryButton(
                label = if (busy) "Restoring…" else "Un-revoke server",
                onClick = {
                    scope.launch {
                        vm.run()
                        if (vm.phase.value is UnrevokeServerPhase.Completed) {
                            app.setPodRevocation(pod.podId, null, null)
                            toasts.success(UnrevokeServerViewModel.SUCCESS_MESSAGE)
                        }
                    }
                },
                enabled = !busy && !LocalServerReadOnly.current,
                block = true,
                modifier = Modifier.semantics { contentDescription = "sd-unrevoke-server" },
            )
        }
    }
}

@Composable
private fun RevokeServerSheetBody(
    serverDomain: String,
    username: () -> String?,
    server: com.flagshipserver.app.api.FlagshipServerClient,
    onCompleted: (RevokeServerReason) -> Unit,
    onFailed: (String) -> Unit,
    onCancel: () -> Unit,
) {
    var reason by remember { mutableStateOf(RevokeServerReason.STOLEN) }
    val scope = rememberCoroutineScope()
    val vm = remember(serverDomain) {
        RevokeServerViewModel(
            server = server,
            serverDomain = serverDomain,
            username = username,
        )
    }
    val phase by vm.phase.collectAsState()
    var holding by remember { mutableStateOf(false) }

    Column(
        Modifier.padding(FS.space.s4),
        verticalArrangement = Arrangement.spacedBy(FS.space.s3),
    ) {
        Text(
            "Revoke this server?",
            color = MaterialTheme.colorScheme.onSurface,
            style = MaterialTheme.typography.titleLarge,
        )
        Text(
            "$REVOKE_EXPLAINER Other servers on your account stay running.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
        )

        Text(
            "Reason",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelLarge,
        )
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
            for (r in RevokeServerReason.entries) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .selectable(
                            selected = reason == r,
                            onClick = { reason = r },
                            enabled = !isBusy(phase),
                        )
                        .semantics {
                            contentDescription = "revoke-reason-${r.wire}"
                        },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = reason == r, onClick = null)
                    Text(
                        r.label,
                        color = MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
            }
        }

        (phase as? RevokeServerPhase.Failed)?.let { f ->
            Text(f.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }

        // Primary: hold-to-confirm. 1.5s long-press fires the run.
        // Pinned to docs/revocation-ui.md (must match iOS). A short
        // tap does nothing destructive.
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .clip(RoundedCornerShape(FS.radius.md))
                // The button inside takes the press itself, so watch it before the
                // button does (Initial pass, consumed or not): a hold must still count.
                .pointerInput(reason, phase) {
                    awaitEachGesture {
                        awaitFirstDown(
                            requireUnconsumed = false,
                            pass = androidx.compose.ui.input.pointer.PointerEventPass.Initial,
                        )
                        if (isBusy(phase)) return@awaitEachGesture
                        holding = true
                        var fired = false
                        try {
                            withTimeout(REVOKE_HOLD_MS) {
                                waitForUpOrCancellation(
                                    pass = androidx.compose.ui.input.pointer.PointerEventPass.Initial,
                                )
                            }
                            // Released before the time was up: a short tap, nothing happens.
                        } catch (_: androidx.compose.ui.input.pointer.PointerEventTimeoutCancellationException) {
                            fired = true
                        }
                        holding = false
                        if (fired) {
                            scope.launch {
                                val chosen = reason
                                vm.run(chosen)
                                when (val p = vm.phase.value) {
                                    is RevokeServerPhase.Completed -> onCompleted(chosen)
                                    is RevokeServerPhase.Failed -> onFailed(p.message)
                                    else -> {}
                                }
                            }
                        }
                    }
                }
                .semantics { contentDescription = "revoke-confirm-hold" },
            contentAlignment = Alignment.Center,
        ) {
            FSDangerButton(
                label = buttonLabel(phase, holding),
                onClick = { /* hold-to-confirm — onClick is a no-op */ },
                block = true,
                enabled = !isBusy(phase),
            )
        }

        FSGhostButton(label = "Cancel", onClick = onCancel, block = true)
        Spacer(Modifier.height(FS.space.s2))
    }
}

// P13 — hold-to-confirm duration. Pinned to docs/revocation-ui.md
// (must match iOS RevokeServerSheet.holdSeconds).
private const val REVOKE_HOLD_MS = 1500L

private fun isBusy(p: RevokeServerPhase): Boolean = when (p) {
    is RevokeServerPhase.Signing, is RevokeServerPhase.Posting -> true
    else -> false
}

private fun buttonLabel(p: RevokeServerPhase, holding: Boolean): String = when {
    p is RevokeServerPhase.Signing || p is RevokeServerPhase.Posting -> "Revoking…"
    holding -> "Hold to confirm…"
    else -> "Hold to revoke"
}

/** What a server page shows while the box's own detail isn't loaded. Mirror of
 *  the iOS ServerDetailScreen state switch. */
internal enum class ServerDetailPlaceholderKind {
    SKELETON, CONNECTING, NEVER_ONLINE, OFFLINE, COMING_UP, NOT_PAIRED;

    companion object {
        /** [loading]: still trying (or not yet tried); [attempted]: at least one
         *  try failed. A box the directory calls offline or still coming up says
         *  so at once instead of a skeleton that never resolves. */
        fun of(
            loading: Boolean,
            attempted: Boolean,
            deadServer: Boolean,
            offline: Boolean,
            comingUp: Boolean,
            notPaired: Boolean,
        ): ServerDetailPlaceholderKind = when {
            loading && offline -> OFFLINE
            loading && comingUp -> COMING_UP
            loading -> if (attempted) CONNECTING else SKELETON
            deadServer -> NEVER_ONLINE
            offline -> OFFLINE
            comingUp -> COMING_UP
            notPaired -> NOT_PAIRED
            else -> CONNECTING
        }
    }
}

@Composable
private fun ServerDetailPlaceholder(
    kind: ServerDetailPlaceholderKind,
    lastSeen: String?,
    pairing: Boolean,
    onPair: () -> Unit,
    onRetry: (() -> Unit)?,
) {
    if (kind == ServerDetailPlaceholderKind.SKELETON) {
        ServerCardSkeleton()
        return
    }
    val (title, body, tag) = when (kind) {
        ServerDetailPlaceholderKind.NOT_PAIRED -> Triple(
            "This server isn't paired with this device yet",
            "Pair it to manage this server here. Your phone will ask you to unlock once to approve.",
            "server-detail-not-paired",
        )
        ServerDetailPlaceholderKind.NEVER_ONLINE -> Triple(
            "This server never came online",
            "The install reserved this name and registered the server, but its software never checked in. If the install failed, you can delete it below — that frees the name so you can try again.",
            "server-detail-never-online",
        )
        ServerDetailPlaceholderKind.OFFLINE -> Triple(
            lastSeen?.let { "Offline — last seen $it" } ?: "Offline",
            "This server has gone offline: its software isn't checking in right now. Its data is safe, and it reconnects when it's back online.",
            "server-detail-offline",
        )
        ServerDetailPlaceholderKind.COMING_UP -> Triple(
            "Still coming up…",
            "This server is registered and powering on, but hasn't checked in for the first time yet. This can take a few minutes after a fresh install.",
            "server-detail-coming-up",
        )
        else -> Triple(
            "Connecting to your server…",
            "Your server is online. We're fetching its details, which can take a moment right after it comes up.",
            "server-detail-connecting",
        )
    }
    val spinner = kind == ServerDetailPlaceholderKind.CONNECTING || kind == ServerDetailPlaceholderKind.COMING_UP
    val (icon, iconTint) = when (kind) {
        ServerDetailPlaceholderKind.NOT_PAIRED -> Icons.Outlined.AddLink to MaterialTheme.colorScheme.primary
        ServerDetailPlaceholderKind.NEVER_ONLINE -> Icons.Outlined.Warning to MaterialTheme.colorScheme.error
        ServerDetailPlaceholderKind.OFFLINE -> Icons.Outlined.WifiOff to MaterialTheme.colorScheme.onSurfaceVariant
        else -> null to MaterialTheme.colorScheme.onSurfaceVariant
    }
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.testTag(tag)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                if (spinner) {
                    CircularProgressIndicator(
                        modifier = Modifier.padding(top = 2.dp).size(20.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else if (icon != null) {
                    Icon(icon, contentDescription = null, tint = iconTint, modifier = Modifier.size(24.dp))
                }
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        title,
                        color = MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(body, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                }
            }
            when {
                kind == ServerDetailPlaceholderKind.NOT_PAIRED -> FSPrimaryButton(
                    label = if (pairing) "Pairing…" else "Pair this server",
                    onClick = onPair,
                    enabled = !pairing,
                    block = true,
                    large = true,
                    modifier = Modifier.testTag("sd-pair-server"),
                )
                kind != ServerDetailPlaceholderKind.NEVER_ONLINE && onRetry != null ->
                    FSSecondaryButton(label = "Check again", onClick = onRetry)
                else -> Unit
            }
        }
    }
}
