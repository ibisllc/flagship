package com.flagshipserver.app.ui.screens

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
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.Feedback
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
 *   2. RUNS ON — every server ticked exactly where the app is (from each
 *      server's own apps list); tick copies it there, untick removes that copy
 *      (docs/app-placement.md §4).
 *   3. WEB DOMAINS — canonical FQDN + per-pod aliases + Replace stem
 *      (RenameServiceViewModel, unchanged).
 *   4. Browser viewer (conditional), Access control, recent logs, last backup.
 *   5. Uninstall — the owner-signed uninstall of this server's copy.
 *
 * "Configure environment" is reachable from the toolbar overflow → the
 * service-env route (see ServicesTab).
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

    val scroll = rememberScrollState()
    Column(
        modifier = Modifier
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
        Spacer(Modifier.height(FS.space.s10))
        when (val d = detail) {
            is LoadingState.Idle, is LoadingState.Loading -> {
                ServerCardSkeleton()
            }
            is LoadingState.Failed -> {
                if (certMismatch) {
                    FSCard(modifier = Modifier.semantics { testTag = "service-detail-cert-warning" }) {
                        Column {
                            Text(
                                "Connection not trusted",
                                color = FS.colors.danger,
                                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                            )
                            Spacer(Modifier.height(FS.space.s1))
                            Text(d.message, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
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
                        restricted = appState.isRestrictedDevice(),
                        fallbackServerDomain = { pagePodState.value?.fqdn ?: appState.sessionPod?.fqdn },
                    )
                } else {
                    EgressSection(
                        serviceId = serviceId,
                        egress = resp.app.egress,
                        restricted = appState.isRestrictedDevice(),
                        fallbackServerDomain = { pagePodState.value?.fqdn ?: appState.sessionPod?.fqdn },
                    )
                }
                // API keys (docs/app-apis.md §3); hidden on a box without them.
                ApiKeysSection(
                    serviceId = serviceId,
                    appName = resp.app.slug.replaceFirstChar { it.uppercase() },
                    restricted = appState.isRestrictedDevice(),
                    fallbackServerDomain = { pagePodState.value?.fqdn ?: appState.sessionPod?.fqdn },
                )
                // The owner's Database section (docs/app-apis.md §6): owner
                // only, hidden on a box without it.
                DatabaseEntrySection(
                    nav = nav,
                    serviceId = serviceId,
                    detail = resp,
                    restricted = appState.isRestrictedDevice(),
                )
                if (resp.editable == true) {
                    Spacer(Modifier.height(FS.space.s4))
                    EditRow(onClick = { nav.navigate("edit-service/$serviceId") })
                }
                resp.adaptedFrom?.let { from ->
                    Spacer(Modifier.height(FS.space.s4))
                    AdapterReportRow(repo = from.repo, onClick = { showAdapterReport = true })
                }
                Spacer(Modifier.height(FS.space.s8))

                // ── RUNS ON (docs/app-placement.md §4) ─────────────────
                RunsOnSection(
                    vm = placementVm,
                    rows = placementRows,
                    leaderPodId = leaderId,
                    message = placementMessage,
                    restricted = appState.isRestrictedDevice(),
                    onCopy = { row -> scope.launch { placementVm.copyTo(row.pod.podId) } },
                    onRemove = { row -> confirmRemoveFrom = row },
                    onDismissMessage = { placementVm.dismissMessage() },
                )

                Spacer(Modifier.height(FS.space.s6))

                // ── WEB DOMAINS (Replace) ──────────────
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

                // ── Browser viewer — only when the daemon reports tabs ──
                if (resp.browserTabs.isNotEmpty()) {
                    Spacer(Modifier.height(FS.space.s6))
                    SectionHeader("Browser")
                    FSCard(
                        padding = PaddingValues(FS.space.s4),
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { nav.navigate("browser-tabs/$serviceId") },
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("Open browser viewer", color = FS.colors.text, style = TextStyle(fontSize = 16.sp))
                                Text(
                                    "${resp.browserTabs.size} tab${if (resp.browserTabs.size == 1) "" else "s"} running server-side",
                                    color = FS.colors.textMuted,
                                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                                )
                            }
                            Text("›", color = FS.colors.textMuted, style = TextStyle(fontSize = 24.sp))
                        }
                    }
                }

                // ── Access control (#92) ───────────────────────────────
                Spacer(Modifier.height(FS.space.s4))
                SectionHeader("Access control")
                FSCard(
                    padding = PaddingValues(FS.space.s4),
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { testTag = "service-detail-access-row" }
                        .clickable { nav.navigate("service-access/$serviceId") },
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.People, contentDescription = null, tint = FS.colors.primary)
                        Spacer(Modifier.width(FS.space.s3))
                        Column(Modifier.weight(1f)) {
                            Text("Access control", color = FS.colors.text, style = TextStyle(fontSize = 16.sp))
                            Text(
                                "Open to all or members only, and each member's rank",
                                color = FS.colors.textMuted,
                                style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                            )
                        }
                        Text("›", color = FS.colors.textMuted, style = TextStyle(fontSize = 24.sp))
                    }
                }

                // ── Configure environment ──────────────────────────────
                Spacer(Modifier.height(FS.space.s4))
                SectionHeader("Environment")
                FSCard(
                    padding = PaddingValues(FS.space.s4),
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { testTag = "service-detail-env-row" }
                        .clickable { nav.navigate("service-env/$serviceId") },
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Configure environment", color = FS.colors.text, style = TextStyle(fontSize = 16.sp))
                            Text(
                                "Set API keys + secrets. Values stay on your server.",
                                color = FS.colors.textMuted,
                                style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                            )
                        }
                        Text("›", color = FS.colors.textMuted, style = TextStyle(fontSize = 24.sp))
                    }
                }

                // ── Recent logs ────────────────────────────────────────
                if (resp.recentLogs.isNotEmpty()) {
                    Spacer(Modifier.height(FS.space.s6))
                    SectionHeader("Recent logs")
                    FSCard(padding = PaddingValues(FS.space.s4)) {
                        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                            resp.recentLogs.forEach { line ->
                                Text(
                                    line,
                                    color = FS.colors.text,
                                    style = TextStyle(fontSize = 13.sp, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace),
                                )
                            }
                        }
                    }
                }

                // ── Backup ─────────────────────────────────────────────
                Spacer(Modifier.height(FS.space.s4))
                SectionHeader("Backup")
                AppBackupCard(
                    serviceId = serviceId,
                    client = client,
                    lastBackup = resp.lastBackup?.let { "Last backup: ${it.bytes / 1024 / 1024} MB · ${relativeTime(it.createdAt)}" },
                )

                // ── Uninstall (this server's copy) ─────────────────────
                Spacer(Modifier.height(FS.space.s8))
                FSDangerButton(
                    label = "Uninstall",
                    onClick = { showUninstallDialog = true },
                    enabled = !uninstalling,
                    block = true,
                    modifier = Modifier.semantics { testTag = "service-detail-uninstall-btn" },
                )
                Spacer(Modifier.height(FS.space.s12))
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
            title = { Text("Remove from ${row.pod.name}?") },
            text = {
                Text(
                    "The copy on ${row.pod.name} and its data are deleted. The other copies keep running with their own data.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmRemoveFrom = null
                        scope.launch { placementVm.removeFrom(row.pod.podId) }
                    },
                    modifier = Modifier.semantics { testTag = "runs-on-remove-confirm" },
                ) { Text("Remove", color = FS.colors.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmRemoveFrom = null }) { Text("Cancel") } },
        )
    }

    if (showUninstallDialog) {
        AlertDialog(
            onDismissRequest = { if (!uninstalling) showUninstallDialog = false },
            title = { Text("Uninstall service?") },
            text = {
                Text(
                    "This removes the service from ${pagePod?.name ?: "your server"} and frees its data there. " +
                        "Links to that copy stop working immediately. This can't be undone.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
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
                                toasts.success("Uninstalled ${detailVm.serviceId}.")
                                nav.popBackStack()
                            } catch (t: kotlinx.coroutines.CancellationException) {
                                throw t
                            } catch (t: IllegalStateException) {
                                toasts.error("Uninstall failed. ${t.message}")
                            } catch (t: Throwable) {
                                toasts.error("Uninstall failed. ${t.boxError() ?: com.flagshipserver.app.core.NetworkErrorHumanizer.humanize(t)}")
                            } finally {
                                uninstalling = false
                            }
                        }
                    },
                ) { Text(if (uninstalling) "Uninstalling…" else "Uninstall", color = FS.colors.danger) }
            },
            dismissButton = {
                TextButton(onClick = { if (!uninstalling) showUninstallDialog = false }) { Text("Cancel") }
            },
        )
    }
}

/** "Report a problem with this adaptation", for a service built from a
 *  shared adaptation. */
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

    if (card.showsPending) {
        Spacer(Modifier.height(FS.space.s4))
        FSCard(
            padding = PaddingValues(FS.space.s4),
            modifier = Modifier.fillMaxWidth().semantics { testTag = "service-detail-egress-pending" },
        ) {
            Column {
                Text(
                    AppEgressViewModel.PENDING_TITLE,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                )
                Spacer(Modifier.height(FS.space.s2))
                card.pending.forEach { host ->
                    Text(host, color = FS.colors.text, style = TextStyle(fontSize = 14.sp, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace))
                }
                Spacer(Modifier.height(FS.space.s2))
                Text(
                    AppEgressViewModel.PENDING_NOTE,
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                )
                if (card.canSign) {
                    Spacer(Modifier.height(FS.space.s3))
                    FSPrimaryButton(
                        label = if (busy) "Allowing…" else AppEgressViewModel.ALLOW,
                        enabled = !busy,
                        block = true,
                        modifier = Modifier.semantics { testTag = "service-detail-egress-allow" },
                        onClick = {
                            scope.launch {
                                if (vm.allow()) toasts.success("The app can reach these hosts now.")
                            }
                        },
                    )
                }
            }
        }
    }
    if (card.showsApproved) {
        Spacer(Modifier.height(FS.space.s4))
        FSCard(
            padding = PaddingValues(FS.space.s4),
            modifier = Modifier.fillMaxWidth().semantics { testTag = "service-detail-egress-approved" },
        ) {
            Column {
                Text(
                    AppEgressViewModel.APPROVED_TITLE,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                )
                Spacer(Modifier.height(FS.space.s1))
                Text(
                    AppEgressViewModel.APPROVED_NOTE,
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                )
                Spacer(Modifier.height(FS.space.s2))
                card.approved.forEach { host ->
                    Text(host, color = FS.colors.text, style = TextStyle(fontSize = 14.sp, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace))
                }
                if (card.canSign) {
                    Spacer(Modifier.height(FS.space.s3))
                    FSDangerButton(
                        label = if (busy) "Stopping…" else AppEgressViewModel.STOP,
                        enabled = !busy,
                        modifier = Modifier.semantics { testTag = "service-detail-egress-stop" },
                        onClick = {
                            scope.launch {
                                if (vm.stopAccess()) toasts.success("The app can't reach the internet now.")
                            }
                        },
                    )
                }
            }
        }
    }
    error?.let {
        Spacer(Modifier.height(FS.space.s2))
        Text(it, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp))
    }
}

@Composable
private fun AdapterReportRow(repo: String, onClick: () -> Unit) {
    FSCard(
        padding = PaddingValues(FS.space.s4),
        modifier = Modifier
            .fillMaxWidth()
            .semantics { testTag = "service-detail-report-adapter" }
            .clickable(onClick = onClick),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Feedback, contentDescription = null, tint = FS.colors.primary)
            Spacer(Modifier.width(FS.space.s3))
            Column(Modifier.weight(1f)) {
                Text(AdapterReport.ROW_TITLE, color = FS.colors.text, style = TextStyle(fontSize = 16.sp))
                Text(
                    AdapterReport.rowCaption(repo),
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                    maxLines = 2,
                )
            }
            Text("›", color = FS.colors.textMuted, style = TextStyle(fontSize = 24.sp))
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
                        style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                    )
                    Text(AdapterReport.SENT_NEXT, color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
                } else {
                    Text(AdapterReport.PROMPT, color = FS.colors.text, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
                    Text(
                        "⚠ ${AdapterReport.WARNING}",
                        color = FS.colors.warning,
                        style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                    )
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
                        style = TextStyle(fontSize = 12.sp),
                    )
                    error?.let { Text(it, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp)) }
                }
            }
        },
        confirmButton = {
            if (sent) {
                TextButton(onClick = onDismiss) { Text("Done") }
            } else {
                TextButton(
                    onClick = { vm.send(detail) },
                    enabled = AdapterReport.canSend(detail, sending),
                    modifier = Modifier.semantics { testTag = "adapter-report-send" },
                ) { Text(if (sending) "Sending…" else "Send report") }
            }
        },
        dismissButton = {
            if (!sent) TextButton(onClick = { if (!sending) onDismiss() }) { Text("Cancel") }
        },
    )
}

private fun LoadingState<AppDetailResponse>.loadedValue(): AppDetailResponse? =
    (this as? LoadingState.Loaded)?.value

/** "Edit this service", shown when the box says it can be edited here. */
@Composable
private fun EditRow(onClick: () -> Unit) {
    FSCard(
        padding = PaddingValues(FS.space.s4),
        modifier = Modifier
            .fillMaxWidth()
            .semantics { testTag = "service-detail-edit" }
            .clickable(onClick = onClick),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.EditNote, contentDescription = null, tint = FS.colors.primary)
            Spacer(Modifier.width(FS.space.s3))
            Column(Modifier.weight(1f)) {
                Text(EditService.ROW_TITLE, color = FS.colors.text, style = TextStyle(fontSize = 16.sp))
                Text(
                    EditService.ROW_CAPTION,
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                )
            }
            Text("›", color = FS.colors.textMuted, style = TextStyle(fontSize = 24.sp))
        }
    }
}

@Composable
private fun Header(app: AppSummary) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = app.slug.replaceFirstChar { it.uppercase() },
            color = FS.colors.text,
            style = TextStyle(fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.Medium),
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
        text = "by ${app.creator}",
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
    )
    // `id:` is the IMMUTABLE composite package id (`<creator>--<slug>`, double
    // dash). It never changes — Replace only rotates the user-facing URL stem.
    Text(
        text = buildString {
            app.version?.let { append("ver: ").append(it).append("  ·  ") }
            append("id: ").append(app.serviceId)
        },
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 12.sp, lineHeight = 16.sp),
        modifier = Modifier.padding(top = FS.space.s1),
    )
    app.summary?.takeIf { it.isNotEmpty() }?.let {
        Spacer(Modifier.height(FS.space.s2))
        Text(it, color = FS.colors.text, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
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
    onCopy: (com.flagshipserver.app.viewmodels.AppPlacementViewModel.Row) -> Unit,
    onRemove: (com.flagshipserver.app.viewmodels.AppPlacementViewModel.Row) -> Unit,
    onDismissMessage: () -> Unit,
) {
    SectionHeader("Runs on")
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            if (rows.isEmpty()) {
                Text("Checking your servers…", color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
            }
            rows.forEach { row ->
                val unknown = row.presence is com.flagshipserver.app.viewmodels.AppPlacementViewModel.Presence.Unknown
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(
                        checked = row.ticked,
                        enabled = !restricted && vm.canChange(row),
                        onCheckedChange = { on -> if (on) onCopy(row) else onRemove(row) },
                        modifier = Modifier.semantics { testTag = "runs-on-toggle-${row.pod.podId}" },
                    )
                    Spacer(Modifier.padding(start = FS.space.s2))
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(row.pod.name, color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
                            if (row.pod.podId == leaderPodId) {
                                Spacer(Modifier.padding(start = FS.space.s2))
                                FSPill(label = "Preferred", kind = FSPillKind.Idle)
                            }
                            if (unknown) {
                                Spacer(Modifier.padding(start = FS.space.s2))
                                FSPill(label = "Unknown", kind = FSPillKind.Idle)
                            }
                        }
                        com.flagshipserver.app.viewmodels.AppPlacementViewModel.rowNote(vm, row)?.let {
                            Text(it, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
                        }
                    }
                    // That server's state of the app (docs/app-placement.md §6).
                    com.flagshipserver.app.viewmodels.AppPlacementViewModel.rowPill(row)?.let { pill ->
                        Spacer(Modifier.padding(start = FS.space.s2))
                        FSPill(
                            label = pill.label,
                            kind = pill.tone.pillKind(),
                            modifier = Modifier.semantics { testTag = "runs-on-status-${row.pod.podId}" },
                        )
                    }
                }
            }
        }
    }
    if (message != null) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(top = FS.space.s2),
        ) {
            Text(
                message,
                color = FS.colors.danger,
                style = TextStyle(fontSize = 13.sp),
                modifier = Modifier.weight(1f).semantics { testTag = "runs-on-message" },
            )
            TextButton(onClick = onDismissMessage) { Text("OK") }
        }
    }
    Text(
        text = "Tick a server to copy the app there with its data as it is now. Each copy then keeps its own data.",
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 12.sp),
        modifier = Modifier.padding(top = FS.space.s2, start = FS.space.s1),
    )
}

private fun relativeTime(ms: Long): String {
    val deltaMs = System.currentTimeMillis() - ms
    val mins = deltaMs / 60_000
    return when {
        mins < 1 -> "just now"
        mins < 60 -> "$mins min ago"
        mins < 60 * 24 -> "${mins / 60} hr ago"
        else -> "${mins / (60 * 24)} d ago"
    }
}

@Composable
private fun SectionHeader(label: String) {
    Text(
        text = label.uppercase(),
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
        modifier = Modifier.padding(bottom = FS.space.s3),
    )
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
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = "WEB DOMAINS",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
            modifier = Modifier.weight(1f),
        )
        FSDangerButton(
            label = "Replace",
            onClick = onReplaceTap,
            block = false,
        )
    }
    Spacer(Modifier.height(FS.space.s3))
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            UrlGroupLabel("SHORT REDIRECT")
            val short = links?.shortUrl
            if (!short.isNullOrEmpty()) {
                UrlRowProminent(url = short)
            } else {
                Text(
                    text = "No short link yet. Tap Replace to mint one.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
            }
            HorizontalRule()

            UrlGroupLabel("CANONICAL (SHARED BY ALL INSTANCES)")
            UrlRowNormal(url = links?.canonicalUrl ?: "https://$stem.$user.${com.flagshipserver.app.core.Endpoints.dataApex}")

            if (selectedPods.isNotEmpty()) {
                HorizontalRule()
                UrlGroupLabel("INDIVIDUAL INSTANCES")
                selectedPods.forEach { pod ->
                    UrlRowMuted(url = "https://$stem.${SlugUtil.slugify(pod.name)}.$user.${com.flagshipserver.app.core.Endpoints.dataApex}")
                }
            }
        }
    }
}

@Composable
private fun UrlGroupLabel(label: String) {
    Text(
        text = label,
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
    )
}

@Composable
private fun HorizontalRule() {
    Box(
        modifier = Modifier.fillMaxWidth()
            .height(1.dp)
            .padding(vertical = 0.dp),
    ) {
        Text("", color = FS.colors.border)
    }
}

@Composable
private fun UrlRowProminent(url: String) {
    val ctx = LocalContext.current
    Row(verticalAlignment = Alignment.Top) {
        Text(
            text = wrapAtDots(stripScheme(url)),
            color = FS.colors.text,
            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
            modifier = Modifier.weight(1f),
        )
        FSGhostButton(label = "Copy", onClick = { copyToClipboard(ctx, url) })
    }
}

@Composable
private fun UrlRowNormal(url: String) {
    val ctx = LocalContext.current
    Row(verticalAlignment = Alignment.Top) {
        Text(
            text = wrapAtDots(stripScheme(url)),
            color = FS.colors.text,
            style = TextStyle(fontSize = 14.sp),
            modifier = Modifier.weight(1f),
        )
        FSGhostButton(label = "Copy", onClick = { copyToClipboard(ctx, url) })
    }
}

@Composable
private fun UrlRowMuted(url: String) {
    Text(
        text = wrapAtDots(stripScheme(url)),
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 13.sp),
        modifier = Modifier.padding(start = FS.space.s2),
    )
}

// Insert a zero-width space after each dot so an FQDN wraps between segments
// instead of mid-label. The clipboard path uses the raw url (no ZWSP) so a
// paste is still clean — mirrors iOS wrapAtDots.
private fun wrapAtDots(s: String): String = s.replace(".", ".​")

// Mirrors the Worker's DNS_LABEL_RE in appRename.ts. Keep in sync — drift
// means the button enables for stems the server then rejects.
private val STEM_RE = Regex("^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$")

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
        title = { Text("Replace access URLs") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    text = "This will update all the links to this service, replacing " +
                        "“$currentStem” with a new stem. All existing links break " +
                        "immediately, including the short link. If you have attached " +
                        "external domains, those stay unaffected.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
                OutlinedTextField(
                    value = draft,
                    onValueChange = onDraftChange,
                    singleLine = true,
                    label = { Text("New stem") },
                )
                Text(
                    text = "Lowercase letters, digits, or hyphens. 1–40 chars. No leading or trailing hyphen.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 11.sp),
                )
                (phase as? RenameServicePhase.Failed)?.let { f ->
                    Text(f.message, color = FS.colors.danger, style = TextStyle(fontSize = 12.sp))
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
                        is RenameServicePhase.Signing -> "Signing…"
                        is RenameServicePhase.Posting -> "Replacing…"
                        else -> "Replace"
                    },
                    color = FS.colors.danger,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = { if (!busy) onCancel() }) { Text("Cancel") }
        },
    )
}

private fun stripScheme(s: String): String =
    s.removePrefix("https://").removePrefix("http://")

private fun copyToClipboard(context: Context, text: String) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    cm?.setPrimaryClip(ClipData.newPlainText("flagship", text))
}
