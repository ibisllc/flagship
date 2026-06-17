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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
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
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.CustomDomainCooldownStore
import com.flagshipserver.app.viewmodels.CustomDomainPrompt
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
 *   2. WHERE IT RUNS — per-pod run toggle + a "Lead" radio designating the
 *      pod that holds the canonical short domain.
 *   3. WEB DOMAINS — canonical FQDN + per-pod aliases + custom domain +
 *      Replace stem (RenameServiceViewModel, unchanged).
 *   4. Browser viewer (conditional), Collaborators, recent logs, last backup.
 *   5. Save (run-policy) + Uninstall, both real orders/send client calls.
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
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    val pods = appState.pods.collectAsState().value
    val leaderId = appState.leaderPodId.collectAsState().value

    val detailVm: ServiceDetailViewModel = viewModel(
        key = "service-detail-$serviceId",
        factory = viewModelFactory {
            initializer {
                ServiceDetailViewModel(
                    serviceId = serviceId,
                    client = client,
                    allPods = pods,
                    globalLeaderPodId = leaderId,
                )
            }
        },
    )
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
                    cooldownStore = CustomDomainCooldownStore.fromContext(ctx),
                )
            }
        },
    )

    val detail by detailVm.detail.collectAsState()
    val certMismatch by detailVm.certMismatch.collectAsState()
    val runOnPodIds by detailVm.runOnPodIds.collectAsState()
    val leadPodId by detailVm.leadPodId.collectAsState()
    val phase by renameVm.phase.collectAsState()
    val appLinks by renameVm.links.collectAsState()

    var showReplaceDialog by remember { mutableStateOf(false) }
    var replaceDraft by remember { mutableStateOf("") }
    var showUninstallDialog by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var uninstalling by remember { mutableStateOf(false) }

    LaunchedEffect(serviceId) {
        detailVm.load()
        renameVm.loadLinks()
    }

    val scroll = rememberScrollState()
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
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
                Spacer(Modifier.height(FS.space.s8))

                // ── WHERE IT RUNS ──────────────────────────────────────
                WhereItRunsSection(
                    pods = pods,
                    runOnPodIds = runOnPodIds,
                    effectiveLeadPodId = leadPodId ?: leaderId,
                    globalLeaderPodId = leaderId,
                    onToggle = { detailVm.togglePod(it) },
                    onSetLead = { detailVm.setLead(it) },
                )

                Spacer(Modifier.height(FS.space.s6))

                // ── WEB DOMAINS (Replace + custom-domain) ──────────────
                val selectedPods = pods.filter { runOnPodIds.contains(it.podId) }
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

                Spacer(Modifier.height(FS.space.s3))
                SetCustomDomainSection(
                    rootDomain = "${appState.currentUser.value ?: "you"}.flagship.services",
                    cooldownUntilMs = renameVm.customDomainCooldownUntilMs.collectAsState().value,
                    onSubmit = { draft -> scope.launch { renameVm.submitCustomDomain(draft) } },
                )

                val cdPrompt by renameVm.customDomainPrompt.collectAsState()
                cdPrompt?.let { p ->
                    CustomDomainPromptDialog(
                        prompt = p,
                        onConfirm = {
                            scope.launch {
                                renameVm.dismissCustomDomainPrompt()
                                p.onConfirm?.invoke()
                            }
                        },
                        onDismiss = { renameVm.dismissCustomDomainPrompt() },
                    )
                }

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

                // ── Collaborators (unconditional) ──────────────────────
                Spacer(Modifier.height(FS.space.s4))
                SectionHeader("Collaborators")
                FSCard(
                    padding = PaddingValues(FS.space.s4),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { nav.navigate("invite-manage/$serviceId") },
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Manage collaborators", color = FS.colors.text, style = TextStyle(fontSize = 16.sp))
                            Text(
                                "Issue invites + revoke active access",
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

                // ── Last backup ────────────────────────────────────────
                resp.lastBackup?.let { backup ->
                    Spacer(Modifier.height(FS.space.s4))
                    SectionHeader("Backup")
                    FSCard(padding = PaddingValues(FS.space.s4)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("Last backup", color = FS.colors.text, style = TextStyle(fontSize = 16.sp))
                                Text(
                                    "${backup.bytes / 1024 / 1024} MB · ${relativeTime(backup.createdAt)}",
                                    color = FS.colors.textMuted,
                                    style = TextStyle(fontSize = 13.sp),
                                )
                            }
                            FSGhostButton(label = "Back up now", onClick = { /* P1.19 — wired separately */ })
                        }
                    }
                }

                // ── Save + Uninstall ───────────────────────────────────
                Spacer(Modifier.height(FS.space.s8))
                FSPrimaryButton(
                    label = if (saving) "Saving…" else "Save changes",
                    onClick = {
                        scope.launch {
                            saving = true
                            try {
                                detailVm.save()
                                toasts.success("Saved ${detailVm.serviceId}.")
                            } catch (t: Throwable) {
                                toasts.error("Save failed. ${com.flagshipserver.app.core.NetworkErrorHumanizer.humanize(t)}")
                            } finally {
                                saving = false
                            }
                        }
                    },
                    enabled = !saving && !uninstalling,
                    block = true,
                    modifier = Modifier.semantics { testTag = "service-detail-save-btn" },
                )
                Spacer(Modifier.height(FS.space.s4))
                FSDangerButton(
                    label = "Uninstall",
                    onClick = { showUninstallDialog = true },
                    enabled = !saving && !uninstalling,
                    block = true,
                    modifier = Modifier.semantics { testTag = "service-detail-uninstall-btn" },
                )
                Spacer(Modifier.height(FS.space.s12))
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

    if (showUninstallDialog) {
        AlertDialog(
            onDismissRequest = { if (!uninstalling) showUninstallDialog = false },
            title = { Text("Uninstall service?") },
            text = {
                Text(
                    "This removes the service from your server and frees its data layer. " +
                        "Existing links stop working immediately. This can't be undone.",
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
                            } catch (t: Throwable) {
                                toasts.error("Uninstall failed. ${com.flagshipserver.app.core.NetworkErrorHumanizer.humanize(t)}")
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

private fun LoadingState<AppDetailResponse>.loadedValue(): AppDetailResponse? =
    (this as? LoadingState.Loaded)?.value

@Composable
private fun Header(app: AppSummary) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = app.slug.replaceFirstChar { it.uppercase() },
            color = FS.colors.text,
            style = TextStyle(fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.Medium),
            modifier = Modifier.weight(1f),
        )
        FSPill(
            label = if (app.status == "running") "Running" else "Stopped",
            kind = if (app.status == "running") FSPillKind.Online else FSPillKind.Idle,
        )
    }
    Text(
        text = "by ${app.creator}",
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
    )
    // `id:` is the IMMUTABLE composite package id (`<creator>-<slug>`, single
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

@Composable
private fun WhereItRunsSection(
    pods: List<PodInfo>,
    runOnPodIds: Set<String>,
    effectiveLeadPodId: String?,
    globalLeaderPodId: String?,
    onToggle: (String) -> Unit,
    onSetLead: (String) -> Unit,
) {
    SectionHeader("Where it runs")
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            pods.forEach { pod ->
                val isOn = runOnPodIds.contains(pod.podId)
                val isLead = effectiveLeadPodId == pod.podId
                val isGlobalLeader = globalLeaderPodId == pod.podId
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(
                        checked = isOn,
                        onCheckedChange = { onToggle(pod.podId) },
                        modifier = Modifier.semantics { testTag = "where-it-runs-toggle-${pod.podId}" },
                    )
                    Spacer(Modifier.padding(start = FS.space.s2))
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(pod.name, color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
                            if (isGlobalLeader) {
                                Spacer(Modifier.padding(start = FS.space.s2))
                                FSPill(label = "Leader", kind = FSPillKind.Idle)
                            }
                        }
                        pod.description?.takeIf { it.isNotEmpty() }?.let {
                            Text(it, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
                        }
                    }
                    if (isOn) {
                        // The radio designates the pod that owns the canonical
                        // short domain (mirrors iOS's circle + house "Lead").
                        RadioButton(
                            selected = isLead,
                            onClick = { onSetLead(pod.podId) },
                            modifier = Modifier.semantics { testTag = "where-it-runs-lead-${pod.podId}" },
                        )
                    }
                }
            }
        }
    }
    Text(
        text = leadHint(pods, effectiveLeadPodId, globalLeaderPodId),
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 12.sp),
        modifier = Modifier.padding(top = FS.space.s2, start = FS.space.s1),
    )
}

private fun leadHint(pods: List<PodInfo>, leadPodId: String?, globalLeaderPodId: String?): String {
    pods.firstOrNull { it.podId == leadPodId }?.let {
        return "Canonical short domain points to ${it.name}."
    }
    pods.firstOrNull { it.podId == globalLeaderPodId }?.let {
        return "Following the account leader (${it.name})."
    }
    return "Pick which pod owns the canonical short domain."
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
            val cd = links?.customDomain
            if (!cd.isNullOrEmpty()) {
                UrlGroupLabel("CUSTOM DOMAIN")
                UrlRowProminent(url = "https://$cd")
                HorizontalRule()
            }
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
            UrlRowNormal(url = links?.canonicalUrl ?: "https://$stem.$user.flagship.services")

            if (selectedPods.isNotEmpty()) {
                HorizontalRule()
                UrlGroupLabel("INDIVIDUAL INSTANCES")
                selectedPods.forEach { pod ->
                    UrlRowMuted(url = "https://$stem.${SlugUtil.slugify(pod.name)}.$user.flagship.services")
                }
            }
        }
    }
}

/** SET CUSTOM DOMAIN — section label + right-floated M:SS countdown while
 *  cooling, input + Add (disabled during the 300s on-device cooldown), and
 *  the CNAME guidance line. The decoupled request / apex→www /
 *  destructive-replace logic lives in the VM (submitCustomDomain). */
@Composable
private fun SetCustomDomainSection(
    rootDomain: String,
    cooldownUntilMs: Long?,
    onSubmit: (String) -> Unit,
) {
    var draft by remember { mutableStateOf("") }
    var nowMs by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(cooldownUntilMs) {
        while (cooldownUntilMs != null && cooldownUntilMs > System.currentTimeMillis()) {
            nowMs = System.currentTimeMillis()
            delay(1000)
        }
        nowMs = System.currentTimeMillis()
    }
    val remainingMs = (cooldownUntilMs ?: 0L) - nowMs
    val cooling = remainingMs > 0
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                UrlGroupLabel("SET CUSTOM DOMAIN")
                Spacer(Modifier.weight(1f))
                if (cooling) {
                    Text(
                        text = cooldownLabel(remainingMs),
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
                    )
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    singleLine = true,
                    label = { Text("www.mydomain.com") },
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.padding(start = FS.space.s2))
                FSGhostButton(
                    label = "Add",
                    enabled = !cooling,
                    onClick = {
                        val v = draft
                        draft = ""
                        onSubmit(v)
                    },
                )
            }
            Text(
                text = "Prior to claiming a FQDN, you must set a CNAME record targeting $rootDomain.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 11.sp),
            )
        }
    }
}

/** M:SS — ceil seconds, matching the iOS cooldownLabel + the webapp. */
private fun cooldownLabel(remainingMs: Long): String {
    val s = ((remainingMs + 999) / 1000).coerceAtLeast(0)
    return "%d:%02d".format(s / 60, s % 60)
}

/** One-at-a-time alert mirroring the iOS .alert(presenting:). A confirm+Cancel
 *  when [CustomDomainPrompt.confirmLabel] is set, else an informational
 *  single-dismiss alert. */
@Composable
private fun CustomDomainPromptDialog(
    prompt: CustomDomainPrompt,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(prompt.title) },
        text = {
            Text(
                text = prompt.message,
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
        },
        confirmButton = {
            if (prompt.confirmLabel != null) {
                TextButton(onClick = onConfirm) {
                    Text(
                        prompt.confirmLabel,
                        color = if (prompt.destructive) FS.colors.danger else FS.colors.text,
                    )
                }
            } else {
                TextButton(onClick = onDismiss) { Text("OK") }
            }
        },
        dismissButton = {
            if (prompt.confirmLabel != null) {
                TextButton(onClick = onDismiss) { Text("Cancel") }
            }
        },
    )
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
