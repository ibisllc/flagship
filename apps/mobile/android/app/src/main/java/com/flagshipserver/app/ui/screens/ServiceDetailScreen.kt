package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.outlined.Autorenew
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.Feedback
import androidx.compose.material.icons.outlined.GppMaybe
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Tab
import androidx.compose.material.icons.outlined.Tune
import com.flagshipserver.app.ui.components.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import com.flagshipserver.app.ui.components.OutlinedTextField
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.repeatOnLifecycle
import com.flagshipserver.app.api.boxError
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavController
import com.flagshipserver.app.api.AppDetailResponse
import com.flagshipserver.app.api.AppLinksResponse
import com.flagshipserver.app.api.AppSummary
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.SlugUtil
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSCardDivider
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.plural
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.pillKind
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout
import com.flagshipserver.app.viewmodels.AdapterReport
import com.flagshipserver.app.viewmodels.AdapterReportViewModel
import com.flagshipserver.app.viewmodels.AppEgressViewModel
import com.flagshipserver.app.viewmodels.EgressCardState
import com.flagshipserver.app.viewmodels.LoadingState
import com.flagshipserver.app.viewmodels.RenameServicePhase
import com.flagshipserver.app.viewmodels.RenameServiceViewModel
import com.flagshipserver.app.viewmodels.ServiceDetailViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Service detail — the per-app management surface. Kotlin mirror of
 * FlagshipUI's ServiceDetailScreen, driven by a real [ServiceDetailViewModel]
 * (loads app-detail off the box; no more sample data). Sections:
 *
 *   1. Header — slug, creator, status pill, version + immutable package id.
 *   2. Internet access, then Edit / Report a problem with the adaptation.
 *   3. Runs on — every server ticked exactly where the app is (from each
 *      server's own apps list); tick copies it there, untick removes that copy
 *      (docs/app-placement.md §4).
 *   4. Web domains — canonical FQDN + per-pod aliases + Replace stem
 *      (RenameServiceViewModel, unchanged).
 *   5. Browser viewer (conditional), Access control, Environment, API keys,
 *      Database, recent logs, backup.
 *   6. Uninstall — the owner-signed uninstall of this server's copy.
 *
 * The order follows iOS's ServiceDetailScreen.
 */
@Composable
fun ServiceDetailScreen(nav: NavController, serviceId: String) {
    val appState = LocalAppState.current
    val client = LocalScreensClient.current
    val server = LocalFlagshipServerClient.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()

    val pods = appState.pods.collectAsState().value
    val leaderId = appState.leaderPodId.collectAsState().value
    // The box this page works on: the server it was opened on, else the
    // current one (docs/app-placement.md §4).
    val pagePod = com.flagshipserver.app.core.LocalPodScope.current?.pod ?: appState.currentPod
    val pagePodState = androidx.compose.runtime.rememberUpdatedState(pagePod)
    val podClients = com.flagshipserver.app.core.LocalPodClients.current
    // Uninstalling, "Runs on", the access list, API keys and database writes
    // are admin orders: an admin-pinned box refuses them from any other device.
    val adminDevice = remember(pods) { com.flagshipserver.app.core.AdminOrderGate.allows(appState) }

    val detailVm: ServiceDetailViewModel = viewModel(
        key = "service-detail-$serviceId-${pagePod?.podId}",
        factory = viewModelFactory {
            initializer {
                ServiceDetailViewModel(
                    serviceId = serviceId,
                    client = client,
                    fallbackServerDomain = { pagePodState.value?.fqdn },
                )
            }
        },
    )
    // Runs on: every server's own apps list, over its own session.
    val placementVm = remember(serviceId, podClients, client) {
        com.flagshipserver.app.viewmodels.AppPlacementViewModel(
            serviceId = serviceId,
            appName = serviceId.substringAfter("--").replaceFirstChar { it.uppercase() },
            pods = { appState.pods.value },
            clientFor = { pod -> podClients.screens(pod) ?: client.takeIf { pod.podId == pagePodState.value?.podId } },
            pagePodId = { pagePodState.value?.podId },
        )
    }
    val placementRows by placementVm.rows.collectAsState()
    val placementMessage by placementVm.message.collectAsState()
    var confirmRemoveFrom by remember { mutableStateOf<com.flagshipserver.app.viewmodels.AppPlacementViewModel.Row?>(null) }
    LaunchedEffect(placementVm, pods.map { it.podId to it.status }) { placementVm.load() }
    // While a copy is underway and the page is visible, follow it.
    val lifecycleOwner = androidx.compose.ui.platform.LocalLifecycleOwner.current
    LaunchedEffect(placementVm) {
        lifecycleOwner.repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.STARTED) {
            while (true) {
                delay(2_000)
                if (placementVm.anyCopying) placementVm.refreshCopying()
            }
        }
    }
    // Replace ceremony VM. Stored in the composition so the phase StateFlow
    // survives recompositions of the WEB DOMAINS section.
    val renameVm: RenameServiceViewModel = viewModel(
        key = "rename-service-$serviceId",
        factory = viewModelFactory {
            initializer {
                RenameServiceViewModel(
                    server = server,
                    serviceId = serviceId,
                    username = { appState.currentUser.value },
                )
            }
        },
    )

    val detail by detailVm.detail.collectAsState()
    val certMismatch by detailVm.certMismatch.collectAsState()
    val phase by renameVm.phase.collectAsState()
    val appLinks by renameVm.links.collectAsState()

    var showReplaceDialog by remember { mutableStateOf(false) }
    var replaceDraft by remember { mutableStateOf("") }
    var showUninstallDialog by remember { mutableStateOf(false) }
    var showAdapterReport by remember { mutableStateOf(false) }
    var uninstalling by remember { mutableStateOf(false) }

    LaunchedEffect(serviceId, detailVm) {
        detailVm.load()
        renameVm.loadLinks()
    }

    val loaded = detail.loadedValue()
    FSScreen(
        title = loaded?.app?.slug?.replaceFirstChar { it.uppercase() } ?: stringResource(R.string.service),
        onBack = { nav.popBackStack() },
    ) {
        when (val d = detail) {
            is LoadingState.Idle, is LoadingState.Loading -> {
                ServerCardSkeleton()
            }
            is LoadingState.Failed -> {
                if (certMismatch) {
                    FSCard(modifier = Modifier.semantics { testTag = "service-detail-cert-warning" }) {
                        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                                Icon(Icons.Outlined.GppMaybe, contentDescription = null, tint = MaterialTheme.colorScheme.error)
                                Text(
                                    stringResource(R.string.connection_not_trusted),
                                    color = MaterialTheme.colorScheme.error,
                                    style = MaterialTheme.typography.titleMedium,
                                )
                            }
                            Text(d.message, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                } else {
                    ErrorCard(message = d.message, onRetry = { scope.launch { detailVm.load() } })
                }
            }
            is LoadingState.Loaded -> {
                val resp = d.value
                Header(app = resp.app)
                // Access lists (§3a); a box from before them may still send
                // the v1 egress approval.
                val access = resp.app.access
                if (access != null) {
                    InternetAccessSection(
                        nav = nav,
                        serviceId = serviceId,
                        appName = resp.app.slug.replaceFirstChar { it.uppercase() },
                        summary = access,
                        restricted = appState.isRestrictedDevice() || !adminDevice,
                        readOnlyNote = if (appState.isRestrictedDevice()) com.flagshipserver.app.viewmodels.AppAccessViewModel.READ_ONLY_NOTE
                        else com.flagshipserver.app.core.AdminOrderGate.ACCESS_LIST,
                        fallbackServerDomain = { pagePodState.value?.fqdn ?: appState.sessionPod?.fqdn },
                    )
                } else {
                    EgressSection(
                        serviceId = serviceId,
                        egress = resp.app.egress,
                        restricted = appState.isRestrictedDevice() || !adminDevice,
                        fallbackServerDomain = { pagePodState.value?.fqdn ?: appState.sessionPod?.fqdn },
                    )
                }
                AppStorageSection(resp.storage)
                val adaptedFrom = resp.adaptedFrom
                if (resp.editable == true || adaptedFrom != null) {
                    FSGroup {
                        if (resp.editable == true) {
                            FSRow(
                                title = EditService.ROW_TITLE,
                                subtitle = EditService.ROW_CAPTION,
                                icon = Icons.Outlined.EditNote,
                                iconTint = FS.colors.accent,
                                onClick = { nav.navigate("edit-service/$serviceId") },
                                modifier = Modifier.semantics { testTag = "service-detail-edit" },
                            )
                        }
                        if (resp.editable == true && adaptedFrom != null) FSDivider()
                        if (adaptedFrom != null) {
                            FSRow(
                                title = AdapterReport.ROW_TITLE,
                                subtitle = AdapterReport.rowCaption(adaptedFrom.repo),
                                icon = Icons.Outlined.Feedback,
                                iconTint = FS.colors.accent,
                                onClick = { showAdapterReport = true },
                                modifier = Modifier.semantics { testTag = "service-detail-report-adapter" },
                            )
                        }
                    }
                }

                // Runs on (docs/app-placement.md §4).
                RunsOnSection(
                    vm = placementVm,
                    rows = placementRows,
                    leaderPodId = leaderId,
                    message = placementMessage,
                    restricted = appState.isRestrictedDevice(),
                    adminDevice = adminDevice,
                    onCopy = { row ->
                        if (adminDevice) scope.launch { placementVm.copyTo(row.pod.podId) }
                        else toasts.error(com.flagshipserver.app.core.AdminOrderGate.RUNS_ON)
                    },
                    onRemove = { row ->
                        if (adminDevice) confirmRemoveFrom = row
                        else toasts.error(com.flagshipserver.app.core.AdminOrderGate.RUNS_ON)
                    },
                    onDismissMessage = { placementVm.dismissMessage() },
                )

                // Web domains (Replace).
                val selectedPods = placementRows.filter { it.presence is com.flagshipserver.app.viewmodels.AppPlacementViewModel.Presence.Has }.map { it.pod }
                WebDomainsSection(
                    fallbackLabel = resp.app.urlLabel,
                    username = appState.currentUser.collectAsState().value,
                    links = appLinks,
                    selectedPods = selectedPods,
                    onReplaceTap = {
                        replaceDraft = appLinks?.displayLabel ?: resp.app.urlLabel
                        showReplaceDialog = true
                    },
                )

                // Browser viewer: only when the daemon reports tabs.
                if (resp.browserTabs.isNotEmpty()) {
                    FSGroup(header = stringResource(R.string.browser)) {
                        FSRow(
                            title = stringResource(R.string.open_browser_viewer),
                            subtitle = FSStrings.plural(R.plurals.tabs_running_on_your_server, resp.browserTabs.size, resp.browserTabs.size),
                            icon = Icons.Outlined.Tab,
                            iconTint = FS.colors.accent,
                            onClick = { nav.navigate("browser-tabs/$serviceId") },
                            modifier = Modifier.semantics { testTag = "service-detail-open-browser-viewer" },
                        )
                    }
                }

                // Access control (#92).
                FSGroup(header = stringResource(R.string.access_control)) {
                    FSRow(
                        title = stringResource(R.string.access_control),
                        subtitle = stringResource(R.string.open_to_all_or_members_only),
                        icon = Icons.Filled.People,
                        iconTint = FS.colors.accent,
                        onClick = { nav.navigate("service-access/$serviceId") },
                        modifier = Modifier.semantics { testTag = "service-detail-access-row" },
                    )
                }

                // Environment.
                FSGroup(header = stringResource(R.string.environment)) {
                    FSRow(
                        title = stringResource(R.string.configure_environment),
                        subtitle = stringResource(R.string.set_api_keys_and_secrets_values),
                        icon = Icons.Outlined.Tune,
                        iconTint = FS.colors.accent,
                        onClick = { nav.navigate("service-env/$serviceId") },
                        modifier = Modifier.semantics { testTag = "service-detail-env-row" },
                    )
                }

                // API keys (docs/app-apis.md §3); hidden on a box without them.
                ApiKeysSection(
                    serviceId = serviceId,
                    appName = resp.app.slug.replaceFirstChar { it.uppercase() },
                    restricted = appState.isRestrictedDevice() || !adminDevice,
                    readOnlyNote = if (appState.isRestrictedDevice()) com.flagshipserver.app.viewmodels.AppApiKeysViewModel.READ_ONLY_NOTE
                    else com.flagshipserver.app.core.AdminOrderGate.API_KEYS,
                    fallbackServerDomain = { pagePodState.value?.fqdn ?: appState.sessionPod?.fqdn },
                )
                ServicePermissionsSection(serviceId = serviceId, restricted = appState.isRestrictedDevice() || !adminDevice)
                // The owner's Database section (docs/app-apis.md §6): owner
                // only, hidden on a box without it.
                DatabaseEntrySection(
                    nav = nav,
                    serviceId = serviceId,
                    detail = resp,
                    restricted = appState.isRestrictedDevice(),
                )

                // Recent logs.
                if (resp.recentLogs.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        FSSectionHeader(stringResource(R.string.recent_logs))
                        FSCard {
                            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                                resp.recentLogs.forEach { line ->
                                    Text(
                                        line,
                                        color = MaterialTheme.colorScheme.onSurface,
                                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace),
                                    )
                                }
                            }
                        }
                    }
                }

                // Backup.
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    FSSectionHeader(stringResource(R.string.backup))
                    AppBackupCard(
                        serviceId = serviceId,
                        client = client,
                        lastBackup = resp.lastBackup?.let { fsString(R.string.last_backup_mb, it.bytes / 1024 / 1024, relativeTime(it.createdAt)) },
                    )
                }

                // Uninstall (this server's copy).
                if (adminDevice) {
                    FSDangerButton(
                        label = stringResource(R.string.uninstall),
                        onClick = { showUninstallDialog = true },
                        enabled = !uninstalling,
                        block = true,
                        modifier = Modifier
                            .padding(top = FS.space.s4)
                            .semantics { testTag = "service-detail-uninstall-btn" },
                    )
                } else {
                    Text(
                        UNINSTALL_ADMIN_ONLY_LINE,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier
                            .padding(top = FS.space.s4, start = FS.space.s1)
                            .semantics { testTag = "service-detail-uninstall-admin-only" },
                    )
                }
            }
        }
    }

    if (showReplaceDialog) {
        ReplaceStemDialog(
            draft = replaceDraft,
            currentStem = appLinks?.displayLabel ?: (detail.loadedValue()?.app?.urlLabel ?: ""),
            onDraftChange = { replaceDraft = it },
            phase = phase,
            onCancel = { showReplaceDialog = false },
            onConfirm = {
                scope.launch {
                    val ok = renameVm.rename(replaceDraft)
                    if (ok) showReplaceDialog = false
                }
            },
        )
    }

    if (showAdapterReport) {
        AdapterReportDialog(serviceId = serviceId, onDismiss = { showAdapterReport = false })
    }

    confirmRemoveFrom?.let { row ->
        AlertDialog(
            onDismissRequest = { confirmRemoveFrom = null },
            title = { Text(fsString(R.string.remove_from, row.pod.name)) },
            text = {
                Text(
                    fsString(R.string.the_copy_on_and_its_data, row.pod.name),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmRemoveFrom = null
                        scope.launch { placementVm.removeFrom(row.pod.podId) }
                    },
                    modifier = Modifier.semantics { testTag = "runs-on-remove-confirm" },
                ) { Text(stringResource(R.string.remove_3), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmRemoveFrom = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }

    if (showUninstallDialog) {
        AlertDialog(
            onDismissRequest = { if (!uninstalling) showUninstallDialog = false },
            title = { Text(stringResource(R.string.uninstall_service)) },
            text = {
                Text(
                    fsString(R.string.this_removes_the_service_from_and, pagePod?.name ?: stringResource(R.string.your_server)),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            },
            confirmButton = {
                TextButton(
                    enabled = !uninstalling,
                    onClick = {
                        scope.launch {
                            uninstalling = true
                            try {
                                detailVm.uninstall()
                                showUninstallDialog = false
                                toasts.success(FSStrings.get(R.string.uninstalled, detailVm.serviceId))
                                nav.popBackStack()
                            } catch (t: kotlinx.coroutines.CancellationException) {
                                throw t
                            } catch (t: IllegalStateException) {
                                toasts.error(FSStrings.get(R.string.uninstall_failed, t.message))
                            } catch (t: Throwable) {
                                toasts.error(FSStrings.get(R.string.uninstall_failed, t.boxError() ?: com.flagshipserver.app.core.NetworkErrorHumanizer.humanize(t)))
                            } finally {
                                uninstalling = false
                            }
                        }
                    },
                ) { Text(if (uninstalling) stringResource(R.string.uninstalling) else stringResource(R.string.uninstall), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { if (!uninstalling) showUninstallDialog = false }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}

/**
 * The v1 internet approval, for a box that sends `egress` but no `access`
 * (from before access lists). Shown only when the box reports `egress` (it has
 * the egress gateway) and the app declares hosts: a pending card asking the
 * owner to allow them, and the hosts it can reach now with "Stop access".
 * Both sign with the sensitive-order key; a restricted profile only sees them.
 */
@Composable
private fun EgressSection(
    serviceId: String,
    egress: com.flagshipserver.app.api.AppEgress?,
    restricted: Boolean,
    fallbackServerDomain: () -> String?,
) {
    val client = LocalScreensClient.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    val vm = remember(serviceId) {
        AppEgressViewModel(serviceId, client, egress, fallbackServerDomain = fallbackServerDomain)
    }
    LaunchedEffect(egress) { vm.update(egress) }
    val current by vm.egress.collectAsState()
    val busy by vm.busy.collectAsState()
    val error by vm.error.collectAsState()
    val card = EgressCardState.from(current, restricted) ?: return

    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s4)) {
        if (card.showsPending) {
            FSCard(
                padding = PaddingValues(FS.space.s4),
                modifier = Modifier.fillMaxWidth().semantics { testTag = "service-detail-egress-pending" },
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        Icon(Icons.Outlined.Public, contentDescription = null, tint = FS.colors.warning)
                        Text(
                            AppEgressViewModel.PENDING_TITLE,
                            color = MaterialTheme.colorScheme.onSurface,
                            style = MaterialTheme.typography.titleMedium,
                        )
                    }
                    card.pending.forEach { host ->
                        Text(host, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace))
                    }
                    Text(
                        AppEgressViewModel.PENDING_NOTE,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    if (card.canSign) {
                        FSPrimaryButton(
                            label = if (busy) stringResource(R.string.allowing) else AppEgressViewModel.ALLOW,
                            enabled = !busy,
                            block = true,
                            modifier = Modifier.padding(top = FS.space.s1).semantics { testTag = "service-detail-egress-allow" },
                            onClick = {
                                scope.launch {
                                    if (vm.allow()) toasts.success(FSStrings.get(R.string.the_app_can_reach_these_hosts))
                                }
                            },
                        )
                    }
                }
            }
        }
        if (card.showsApproved) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                FSSectionHeader(stringResource(R.string.internet_access))
                FSCard(
                    padding = PaddingValues(FS.space.s4),
                    modifier = Modifier.fillMaxWidth().semantics { testTag = "service-detail-egress-approved" },
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        Text(
                            AppEgressViewModel.APPROVED_TITLE,
                            color = MaterialTheme.colorScheme.onSurface,
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(
                            AppEgressViewModel.APPROVED_NOTE,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        card.approved.forEach { host ->
                            Text(host, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace))
                        }
                        if (card.canSign) {
                            FSDangerButton(
                                label = if (busy) stringResource(R.string.stopping) else AppEgressViewModel.STOP,
                                enabled = !busy,
                                block = true,
                                modifier = Modifier.padding(top = FS.space.s1).semantics { testTag = "service-detail-egress-stop" },
                                onClick = {
                                    scope.launch {
                                        if (vm.stopAccess()) toasts.success(FSStrings.get(R.string.the_app_cant_reach_the_internet))
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }
        error?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun AdapterReportDialog(serviceId: String, onDismiss: () -> Unit) {
    val client = LocalScreensClient.current
    val vm = remember(serviceId) { AdapterReportViewModel(serviceId, client) }
    val sending by vm.sending.collectAsState()
    val sent by vm.sent.collectAsState()
    val error by vm.error.collectAsState()
    var detail by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = { if (!sending) onDismiss() },
        title = { Text(AdapterReport.TITLE) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                if (sent) {
                    Text(
                        AdapterReport.SENT,
                        color = FS.colors.success,
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(AdapterReport.SENT_NEXT, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                } else {
                    Text(AdapterReport.PROMPT, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyMedium)
                    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        Icon(Icons.Outlined.Shield, contentDescription = null, tint = FS.colors.warning)
                        Text(
                            AdapterReport.WARNING,
                            color = FS.colors.warning,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                    OutlinedTextField(
                        value = detail,
                        onValueChange = { detail = it },
                        minLines = 5,
                        maxLines = 8,
                        modifier = Modifier
                            .fillMaxWidth()
                            .semantics { testTag = "adapter-report-text" },
                    )
                    Text(
                        AdapterReport.counter(detail),
                        color = if (detail.length > AdapterReport.MAX_LENGTH) FS.colors.danger else FS.colors.textMuted,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                }
            }
        },
        confirmButton = {
            if (sent) {
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.done)) }
            } else {
                TextButton(
                    onClick = { vm.send(detail) },
                    enabled = AdapterReport.canSend(detail, sending),
                    modifier = Modifier.semantics { testTag = "adapter-report-send" },
                ) { Text(if (sending) stringResource(R.string.sending_2) else stringResource(R.string.send_report)) }
            }
        },
        dismissButton = {
            if (!sent) TextButton(onClick = { if (!sending) onDismiss() }) { Text(stringResource(R.string.cancel)) }
        },
    )
}

private fun LoadingState<AppDetailResponse>.loadedValue(): AppDetailResponse? =
    (this as? LoadingState.Loaded)?.value

@Composable
private fun Header(app: AppSummary) {
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    text = app.slug.replaceFirstChar { it.uppercase() },
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.headlineSmall,
                    modifier = Modifier.weight(1f),
                )
                // This server's state of the app (docs/app-placement.md §6); an older
                // box's "unknown" shows no pill.
                com.flagshipserver.app.core.AppStatus.pill(app)?.let { pill ->
                    FSPill(
                        label = pill.label,
                        kind = pill.tone.pillKind(),
                        modifier = Modifier.semantics { testTag = "app-status-pill" },
                    )
                }
            }
            Text(
                text = fsString(R.string.by, app.creator),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyLarge,
            )
            // The package id stays out of the page; the version is the only technical line.
            app.version?.takeIf { it.isNotBlank() }?.let { v ->
                Text(
                    text = fsString(R.string.version_2, v),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.semantics { testTag = "app-detail-version" },
                )
            }
            app.summary?.takeIf { it.isNotEmpty() }?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(top = FS.space.s1),
                )
            }
        }
    }
}

/** Runs on: each of the account's servers, ticked exactly where the app is
 *  (docs/app-placement.md §4). Tick copies it there; untick removes that copy. */
@Composable
private fun RunsOnSection(
    vm: com.flagshipserver.app.viewmodels.AppPlacementViewModel,
    rows: List<com.flagshipserver.app.viewmodels.AppPlacementViewModel.Row>,
    leaderPodId: String?,
    message: String?,
    restricted: Boolean,
    adminDevice: Boolean,
    onCopy: (com.flagshipserver.app.viewmodels.AppPlacementViewModel.Row) -> Unit,
    onRemove: (com.flagshipserver.app.viewmodels.AppPlacementViewModel.Row) -> Unit,
    onDismissMessage: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        FSGroup(header = stringResource(R.string.runs_on)) {
            if (rows.isEmpty()) {
                FSRow(title = stringResource(R.string.checking_your_servers), titleColor = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            rows.forEachIndexed { idx, row ->
                if (idx > 0) FSDivider(inset = 64.dp)
                val unknown = row.presence is com.flagshipserver.app.viewmodels.AppPlacementViewModel.Presence.Unknown
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = FS.space.s2, end = FS.space.s4, top = FS.space.s2, bottom = FS.space.s2),
                ) {
                    Checkbox(
                        checked = row.ticked,
                        enabled = !restricted && adminDevice && vm.canChange(row),
                        onCheckedChange = { on -> if (on) onCopy(row) else onRemove(row) },
                        modifier = Modifier.semantics { testTag = "runs-on-toggle-${row.pod.podId}" },
                    )
                    Column(Modifier.weight(1f).padding(start = FS.space.s2), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                            Text(
                                row.pod.name,
                                color = MaterialTheme.colorScheme.onSurface,
                                style = MaterialTheme.typography.bodyLarge,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                            if (row.pod.podId == leaderPodId) FSPill(label = stringResource(R.string.preferred), kind = FSPillKind.Idle)
                            if (unknown) FSPill(label = stringResource(R.string.unknown), kind = FSPillKind.Idle)
                        }
                        com.flagshipserver.app.viewmodels.AppPlacementViewModel.rowNote(vm, row)?.let {
                            Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    // That server's state of the app (docs/app-placement.md §6).
                    com.flagshipserver.app.viewmodels.AppPlacementViewModel.rowPill(row)?.let { pill ->
                        FSPill(
                            label = pill.label,
                            kind = pill.tone.pillKind(),
                            modifier = Modifier
                                .padding(start = FS.space.s2)
                                .semantics { testTag = "runs-on-status-${row.pod.podId}" },
                        )
                    }
                }
            }
        }
        if (message != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    message,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.weight(1f).padding(start = FS.space.s1).semantics { testTag = "runs-on-message" },
                )
                FSGhostButton(label = "OK", onClick = onDismissMessage)
            }
        }
        Text(
            text = if (adminDevice) stringResource(R.string.tick_a_server_to_copy_the)
            else com.flagshipserver.app.core.AdminOrderGate.RUNS_ON,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(horizontal = FS.space.s4)
                .semantics { testTag = if (adminDevice) "runs-on-help" else "runs-on-admin-only" },
        )
    }
}

private fun relativeTime(ms: Long): String {
    val deltaMs = System.currentTimeMillis() - ms
    val mins = deltaMs / 60_000
    return when {
        mins < 1 -> FSStrings.get(R.string.just_now)
        mins < 60 -> FSStrings.get(R.string.min_ago, mins)
        mins < 60 * 24 -> FSStrings.get(R.string.hr_ago, mins / 60)
        else -> FSStrings.get(R.string.d_ago, mins / (60 * 24))
    }
}

// ---------------------------------------------------------------
// WEB DOMAINS section + Replace stem dialog (unchanged behavior —
// driven by RenameServiceViewModel / appLinks, not the detail VM).
// ---------------------------------------------------------------

/** Three labelled groups: short redirect (top, bold), canonical
 *  (shared by all instances), and individual instances. A Replace
 *  button floats top-right of the section header. */
@Composable
private fun WebDomainsSection(
    fallbackLabel: String,
    username: String?,
    links: AppLinksResponse?,
    selectedPods: List<PodInfo>,
    onReplaceTap: () -> Unit,
) {
    val stem = links?.displayLabel ?: fallbackLabel
    val user = username ?: "you"
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            FSSectionHeader(stringResource(R.string.web_domains), modifier = Modifier.weight(1f))
            TextButton(
                onClick = onReplaceTap,
                modifier = Modifier.semantics { testTag = "app-replace-stem-btn" },
            ) {
                Icon(
                    Icons.Outlined.Autorenew,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(end = FS.space.s1),
                )
                Text(stringResource(R.string.replace), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelLarge)
            }
        }
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                    UrlGroupLabel(stringResource(R.string.short_redirect))
                    UrlGroupNote(stringResource(R.string.a_convenient_short_link_that_redirects))
                    val short = links?.shortUrl
                    if (!short.isNullOrEmpty()) {
                        UrlRow(url = short, prominent = true)
                    } else {
                        Text(
                            text = stringResource(R.string.no_short_link_yet_tap_replace),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
                FSCardDivider()
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                    UrlGroupLabel(stringResource(R.string.canonical_shared_by_all_instances))
                    UrlGroupNote(stringResource(R.string.the_permanent_verifiable_address_safe_to))
                    UrlRow(url = links?.canonicalUrl ?: "https://$stem.$user.${com.flagshipserver.app.core.Endpoints.dataApex}")
                }
                if (selectedPods.isNotEmpty()) {
                    FSCardDivider()
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                        UrlGroupLabel(stringResource(R.string.individual_instances))
                        selectedPods.forEach { pod ->
                            UrlRowMuted(url = "https://$stem.${SlugUtil.slugify(pod.name)}.$user.${com.flagshipserver.app.core.Endpoints.dataApex}")
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun UrlGroupLabel(label: String) {
    Text(
        text = label,
        color = MaterialTheme.colorScheme.onSurface,
        style = MaterialTheme.typography.labelLarge,
    )
}

@Composable
private fun UrlGroupNote(text: String) {
    Text(
        text = text,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodySmall,
    )
}

@Composable
private fun UrlRow(url: String, prominent: Boolean = false) {
    val ctx = LocalContext.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = wrapAtDots(stripScheme(url)),
            color = MaterialTheme.colorScheme.onSurface,
            style = (if (prominent) MaterialTheme.typography.titleSmall else MaterialTheme.typography.bodyMedium)
                .copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace),
            modifier = Modifier.weight(1f),
        )
        IconButton(onClick = { copyToClipboard(ctx, url) }) {
            Icon(Icons.Outlined.ContentCopy, contentDescription = fsString(R.string.copy_2, url), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun UrlRowMuted(url: String) {
    Text(
        text = wrapAtDots(stripScheme(url)),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace),
    )
}

// Insert a zero-width space after each dot so an FQDN wraps between segments
// instead of mid-label. The clipboard path uses the raw url (no ZWSP) so a
// paste is still clean — mirrors iOS wrapAtDots.
private fun wrapAtDots(s: String): String = s.replace(".", ".​")

// Mirrors the Worker's DNS_LABEL_RE in appRename.ts. Keep in sync — drift
// means the button enables for stems the server then rejects.
private val STEM_RE = Regex("^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$")

internal val UNINSTALL_ADMIN_ONLY_LINE get() = com.flagshipserver.app.core.AdminOrderGate.UNINSTALL

@Composable
private fun ReplaceStemDialog(
    draft: String,
    currentStem: String,
    onDraftChange: (String) -> Unit,
    phase: RenameServicePhase,
    onCancel: () -> Unit,
    onConfirm: () -> Unit,
) {
    val busy = phase is RenameServicePhase.Signing || phase is RenameServicePhase.Posting
    val trimmed = draft.trim()
    val stemValid = STEM_RE.matches(trimmed) && trimmed != currentStem
    AlertDialog(
        onDismissRequest = { if (!busy) onCancel() },
        title = { Text(stringResource(R.string.replace_access_urls)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    text = fsString(R.string.this_will_update_all_the_links, currentStem),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
                OutlinedTextField(
                    value = draft,
                    onValueChange = onDraftChange,
                    singleLine = true,
                    label = { Text(stringResource(R.string.new_stem)) },
                )
                Text(
                    text = stringResource(R.string.lowercase_letters_digits_or_hyphens_1),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                )
                (phase as? RenameServicePhase.Failed)?.let { f ->
                    Text(f.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                enabled = !busy && stemValid,
            ) {
                Text(
                    when (phase) {
                        is RenameServicePhase.Signing -> stringResource(R.string.signing)
                        is RenameServicePhase.Posting -> stringResource(R.string.replacing)
                        else -> stringResource(R.string.replace)
                    },
                    color = MaterialTheme.colorScheme.error,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = { if (!busy) onCancel() }) { Text(stringResource(R.string.cancel)) }
        },
    )
}

private fun stripScheme(s: String): String =
    s.removePrefix("https://").removePrefix("http://")

private fun copyToClipboard(context: Context, text: String) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    cm?.setPrimaryClip(ClipData.newPlainText("flagship", text))
}

/** The app's disk use against its limits (docs/app-runtimes.md 5.3), and why new data is refused when it is full. Hidden on a box that sends none. */
@Composable
internal fun AppStorageSection(storage: com.flagshipserver.app.api.AppStorage?) {
    val lines = com.flagshipserver.app.core.AppStorageText.appLines(storage)
    if (lines.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        FSSectionHeader(stringResource(R.string.storage))
        FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.semantics { testTag = "service-detail-storage" }) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                lines.forEach { l ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(l.label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                        Text(
                            l.text,
                            color = if (l.full) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.semantics { testTag = "service-detail-storage-${l.label.lowercase()}" },
                        )
                    }
                    if (l.note.isNotEmpty()) {
                        Text(
                            l.note,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.semantics { testTag = "service-detail-storage-full" },
                        )
                    }
                }
            }
        }
    }
}
