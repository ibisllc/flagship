// Local AI on one server (docs/architecture-v2/local-ai.md): the models the server can run, the
// model server and its device, the job queue with who holds each GPU, fine-tuning on an app's
// staged sample data, and which apps may use the server's model. Nothing here costs anything or
// leaves the server. Mirror of iOS LocalAiScreen and the webapp's local-ai view.

package com.flagshipserver.app.ui.screens

import android.text.format.Formatter
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import com.flagshipserver.app.R
import com.flagshipserver.app.api.LocalAiAppRow
import com.flagshipserver.app.api.LocalAiJob
import com.flagshipserver.app.api.LocalAiModelRow
import com.flagshipserver.app.api.LocalAiView
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.core.LocalAiCopy
import com.flagshipserver.app.core.LocalAiOrders
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalPodClients
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.ui.components.AlertDialog
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSChip
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.Switch
import com.flagshipserver.app.ui.components.TextButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.LocalAiViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The route from the server page. */
fun localAiRoute(podId: String): String = "local-ai/$podId"

/** Opened from a server's page: resolves that server's own client. */
@Composable
fun LocalAiRouteScreen(podId: String, onBack: () -> Unit) {
    val app = LocalAppState.current
    val pods by app.pods.collectAsState()
    val pod = pods.firstOrNull { it.podId == podId }
    val podClients = LocalPodClients.current
    val client = remember(pod) { pod?.let { podClients.screens(it) } }
    if (pod == null || client == null) {
        FSScreen(title = stringResource(R.string.local_ai_title), onBack = onBack) {
            Text(stringResource(R.string.local_ai_not_paired), color = FS.colors.textMuted)
        }
        return
    }
    LocalAiScreen(serverDomain = pod.fqdn, client = client, onBack = onBack)
}

@Composable
fun LocalAiScreen(
    serverDomain: String,
    client: ScreensClient,
    onBack: () -> Unit,
    vm: LocalAiViewModel = remember(serverDomain, client) { LocalAiViewModel(serverDomain, client) },
) {
    val state by vm.state.collectAsState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(vm) { vm.load() }
    // While something moves (a download, a starting server, a running job), look again; otherwise the
    // screen waits for a pull or an action, so nothing polls a server that is idle.
    var looks by remember { mutableStateOf(0) }
    LaunchedEffect(state.view, looks) {
        // Bounded: a long fine-tune is refreshed by pulling down after a few minutes.
        if (vm.moving() && looks < 90) {
            delay(2_000)
            vm.load()
            looks++
        }
    }
    FSScreen(
        title = stringResource(R.string.local_ai_title),
        onBack = onBack,
        onRefresh = { scope.launch { vm.load() } },
        refreshing = state.loading && state.view != null,
        modifier = Modifier.testTag("local-ai-screen"),
    ) {
        Text(
            LocalAiCopy.PRIVACY,
            color = FS.colors.textMuted,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.semantics { testTag = "local-ai-privacy" },
        )
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.semantics { testTag = "local-ai-error" }) }
        state.notice?.let { Text(it, color = FS.colors.success, modifier = Modifier.semantics { testTag = "local-ai-notice" }) }
        val v = state.view
        if (v == null) {
            if (state.loading) Text(stringResource(R.string.local_ai_loading), color = FS.colors.textMuted)
            return@FSScreen
        }
        if (!v.available) {
            FSCard { Text(v.reason ?: stringResource(R.string.local_ai_unavailable), modifier = Modifier.semantics { testTag = "local-ai-unavailable" }) }
        }
        HardwareSection(v, state.busy, onGpu = { on -> scope.launch { vm.setUseGpu(on) } })
        ServerSection(
            v, state.busy,
            onServe = { id -> scope.launch { vm.serve(id) } },
            onStart = { scope.launch { vm.startServer(v.settings.serveModel) } },
            onStop = { scope.launch { vm.stopServer() } },
        )
        ModelsSection(
            v, state.busy,
            onDownload = { id -> scope.launch { vm.download(id) } },
            onCancel = { id -> scope.launch { vm.cancelDownload(id) } },
            onDelete = { id -> scope.launch { vm.deleteModel(id) } },
        )
        JobsSection(
            v,
            onCancel = { id -> scope.launch { vm.cancelJob(id) } },
            onResume = { id -> scope.launch { vm.resumeJob(id) } },
            onDelete = { id -> scope.launch { vm.deleteJob(id) } },
            onOpen = { id -> scope.launch { vm.openJob(id) } },
        )
        FineTuneSection(v, state.busy == "train") { app, model, epochs -> scope.launch { vm.startTraining(app, model, epochs) } }
        AppsSection(
            v.apps, state.busy,
            onAllow = { id, r, t, m -> scope.launch { vm.grant(id, r, t, m) } },
            onWithdraw = { id -> scope.launch { vm.withdraw(id) } },
        )
    }
    state.job?.let { detail ->
        AlertDialog(
            onDismissRequest = { vm.closeJob() },
            confirmButton = { TextButton(onClick = { vm.closeJob() }) { Text(stringResource(R.string.local_ai_close)) } },
            title = { Text(LocalAiCopy.jobTitle(detail.job)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.testTag("local-ai-job-detail")) {
                    Text(LocalAiCopy.jobState(detail.job))
                    LocalAiCopy.epochs(detail.job)?.let { Text(it, color = FS.colors.textMuted) }
                    detail.datasetBytes?.let { Text(fsString(R.string.local_ai_dataset_size, Formatter.formatShortFileSize(LocalContext.current, it)), color = FS.colors.textMuted) }
                    if (detail.checkpoints.isEmpty()) {
                        Text(stringResource(R.string.local_ai_no_checkpoints), color = FS.colors.textMuted)
                    } else {
                        Text(stringResource(R.string.local_ai_checkpoints), fontWeight = FontWeight.Medium)
                        detail.checkpoints.sortedBy { it.epoch }.forEach { c ->
                            val size = Formatter.formatShortFileSize(LocalContext.current, c.sizeBytes)
                            val line = c.loss?.let { fsString(R.string.local_ai_checkpoint_line_loss, c.epoch, size, String.format(java.util.Locale.getDefault(), "%.3f", it)) }
                                ?: fsString(R.string.local_ai_checkpoint_line, c.epoch, size)
                            Column(Modifier.testTag("local-ai-checkpoint-${c.epoch}")) {
                                Text(line)
                                Text(c.sha256.take(16), fontFamily = FontFamily.Monospace, color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
            },
        )
    }
}

@Composable
private fun HardwareSection(v: LocalAiView, busy: String?, onGpu: (Boolean) -> Unit) {
    val ctx = LocalContext.current
    FSSectionHeader(stringResource(R.string.local_ai_this_server))
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            val h = v.hardware
            Text(fsString(R.string.local_ai_hardware_line, h.cpus, Formatter.formatShortFileSize(ctx, h.memoryMiB * 1024 * 1024)))
            h.diskFreeBytes?.let { Text(fsString(R.string.local_ai_disk_free, Formatter.formatShortFileSize(ctx, it)), color = FS.colors.textMuted) }
            Text(
                fsString(R.string.local_ai_budget, Formatter.formatShortFileSize(ctx, v.budget.usedBytes), Formatter.formatShortFileSize(ctx, v.budget.budgetBytes)),
                color = FS.colors.textMuted,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.local_ai_use_gpu), modifier = Modifier.weight(1f))
                Switch(checked = v.settings.useGpu, enabled = busy == null, onCheckedChange = onGpu, modifier = Modifier.testTag("local-ai-use-gpu"))
            }
            if (h.gpus.isEmpty()) {
                Text(stringResource(R.string.local_ai_no_gpu), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            }
            h.gpus.forEach { g ->
                Column(Modifier.testTag("local-ai-gpu-${g.id}")) {
                    Text(fsString(R.string.local_ai_gpu_line, g.id, g.model, Formatter.formatShortFileSize(ctx, g.memoryMiB * 1024 * 1024)))
                    Text(LocalAiCopy.gpuHolders(g), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ServerSection(v: LocalAiView, busy: String?, onServe: (String?) -> Unit, onStart: () -> Unit, onStop: () -> Unit) {
    val s = v.service
    FSSectionHeader(stringResource(R.string.local_ai_model_server))
    FSCard(modifier = Modifier.testTag("local-ai-service")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(LocalAiCopy.serviceState(s), fontWeight = FontWeight.Medium)
            s.modelId?.let { id -> Text(fsString(R.string.local_ai_serving, v.models.firstOrNull { it.id == id }?.name ?: id), color = FS.colors.textMuted) }
            LocalAiCopy.device(s.device, s.gpu?.deviceIds)?.let { Text(it, color = FS.colors.textMuted) }
            LocalAiCopy.queue(s.queuePosition)?.let { Text(it, color = FS.colors.textMuted) }
            s.reason?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Text(LocalAiCopy.COST, color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            val installed = v.models.filter { it.state == "installed" }
            if (installed.isNotEmpty()) {
                Text(stringResource(R.string.local_ai_runs_which), style = MaterialTheme.typography.bodySmall)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    FSChip(stringResource(R.string.local_ai_automatic), selected = v.settings.serveModel == null, onClick = { onServe(null) })
                    installed.forEach { m -> FSChip(m.name, selected = v.settings.serveModel == m.id, onClick = { onServe(m.id) }, modifier = Modifier.testTag("local-ai-serve-${m.id}")) }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                if (s.state == "running" || s.state == "starting" || s.state == "queued") {
                    FSSecondaryButton(stringResource(R.string.local_ai_stop), onClick = onStop, enabled = busy == null, modifier = Modifier.testTag("local-ai-stop"))
                } else {
                    FSPrimaryButton(stringResource(R.string.local_ai_start), onClick = onStart, enabled = busy == null && installed.isNotEmpty(), modifier = Modifier.testTag("local-ai-start"))
                }
            }
        }
    }
}

@Composable
private fun ModelsSection(v: LocalAiView, busy: String?, onDownload: (String) -> Unit, onCancel: (String) -> Unit, onDelete: (String) -> Unit) {
    FSSectionHeader(stringResource(R.string.local_ai_models))
    var confirmDelete by remember { mutableStateOf<LocalAiModelRow?>(null) }
    v.models.forEach { m -> ModelRow(m, busy == m.id, onDownload, onCancel, onDelete = { confirmDelete = m }) }
    confirmDelete?.let { m ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            confirmButton = { TextButton(onClick = { confirmDelete = null; onDelete(m.id) }, modifier = Modifier.testTag("local-ai-delete-confirm")) { Text(stringResource(R.string.local_ai_delete)) } },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text(stringResource(R.string.local_ai_cancel)) } },
            title = { Text(fsString(R.string.local_ai_delete_title, m.name)) },
            text = { Text(stringResource(R.string.local_ai_delete_body)) },
        )
    }
}

@Composable
private fun ModelRow(m: LocalAiModelRow, busy: Boolean, onDownload: (String) -> Unit, onCancel: (String) -> Unit, onDelete: () -> Unit) {
    val ctx = LocalContext.current
    FSCard(modifier = Modifier.testTag("local-ai-model-${m.id}")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(m.name, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                Text(LocalAiCopy.modelState(m), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("local-ai-model-state-${m.id}"))
            }
            if (m.descriptor.isNotEmpty()) Text(m.descriptor, color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            Text(fsString(R.string.local_ai_model_facts, m.parameters, m.quantization, Formatter.formatShortFileSize(ctx, m.sizeBytes)), style = MaterialTheme.typography.bodySmall)
            Text(
                if (m.fits) fsString(R.string.local_ai_memory_fits, Formatter.formatShortFileSize(ctx, m.memoryNeededMiB * 1024 * 1024))
                else fsString(R.string.local_ai_memory_too_big, Formatter.formatShortFileSize(ctx, m.memoryNeededMiB * 1024 * 1024)),
                color = if (m.fits) FS.colors.textMuted else MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
            )
            Text(LocalAiCopy.speed(m), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            Text(fsString(R.string.local_ai_license, m.license.id), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            if (m.tools) Text(stringResource(R.string.local_ai_can_build), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            if (m.trainable) Text(stringResource(R.string.local_ai_trainable), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            m.reason?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            LocalAiCopy.progress(m)?.let { p ->
                LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth().testTag("local-ai-progress-${m.id}"))
                m.progress?.let { Text(fsString(R.string.local_ai_progress, Formatter.formatShortFileSize(ctx, it.receivedBytes), Formatter.formatShortFileSize(ctx, it.totalBytes)), style = MaterialTheme.typography.bodySmall) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                when (m.state) {
                    "installed" -> FSDangerButton(stringResource(R.string.local_ai_delete), onClick = onDelete, enabled = !busy, modifier = Modifier.testTag("local-ai-delete-${m.id}"))
                    in LocalAiViewModel.MOVING_MODEL -> FSSecondaryButton(stringResource(R.string.local_ai_cancel), onClick = { onCancel(m.id) }, enabled = !busy, modifier = Modifier.testTag("local-ai-cancel-${m.id}"))
                    else -> FSPrimaryButton(stringResource(R.string.local_ai_download), onClick = { onDownload(m.id) }, enabled = !busy, modifier = Modifier.testTag("local-ai-download-${m.id}"))
                }
            }
        }
    }
}

@Composable
private fun JobsSection(v: LocalAiView, onCancel: (String) -> Unit, onResume: (String) -> Unit, onDelete: (String) -> Unit, onOpen: (String) -> Unit) {
    FSSectionHeader(stringResource(R.string.local_ai_queue))
    if (v.jobs.isEmpty()) {
        FSCard { Text(stringResource(R.string.local_ai_queue_empty), color = FS.colors.textMuted, modifier = Modifier.testTag("local-ai-queue-empty")) }
        return
    }
    v.jobs.forEach { j -> JobRow(j, onCancel, onResume, onDelete, onOpen) }
}

@Composable
private fun JobRow(j: LocalAiJob, onCancel: (String) -> Unit, onResume: (String) -> Unit, onDelete: (String) -> Unit, onOpen: (String) -> Unit) {
    FSCard(modifier = Modifier.testTag("local-ai-job-${j.id}")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
            Text(LocalAiCopy.jobTitle(j), fontWeight = FontWeight.Medium)
            Text(LocalAiCopy.jobState(j), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            LocalAiCopy.device(j.device, j.gpu?.deviceIds)?.let { Text(it, color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("local-ai-job-device-${j.id}")) }
            LocalAiCopy.queue(j.queuePosition)?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("local-ai-job-queue-${j.id}")) }
            LocalAiCopy.epochs(j)?.let { Text(it, color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall) }
            j.reason?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            Text(LocalAiCopy.COST, color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            if (j.kind == "training") {
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    FSSecondaryButton(stringResource(R.string.local_ai_checkpoints), onClick = { onOpen(j.id) }, modifier = Modifier.testTag("local-ai-job-open-${j.id}"))
                    when (j.state) {
                        "queued", "preparing", "running" -> FSDangerButton(stringResource(R.string.local_ai_stop), onClick = { onCancel(j.id) }, modifier = Modifier.testTag("local-ai-job-cancel-${j.id}"))
                        "cancelled", "failed" -> FSPrimaryButton(stringResource(R.string.local_ai_resume), onClick = { onResume(j.id) }, modifier = Modifier.testTag("local-ai-job-resume-${j.id}"))
                    }
                    if (j.state in setOf("completed", "cancelled", "failed")) {
                        TextButton(onClick = { onDelete(j.id) }, modifier = Modifier.testTag("local-ai-job-delete-${j.id}")) { Text(stringResource(R.string.local_ai_delete)) }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FineTuneSection(v: LocalAiView, busy: Boolean, onStart: (String, String, Int) -> Unit) {
    FSSectionHeader(stringResource(R.string.local_ai_fine_tune))
    val apps = v.datasets.filter { it.hasSampleData }
    val models = v.trainableModels.filter { it.installed }
    var app by remember(apps) { mutableStateOf(apps.firstOrNull()?.serviceId) }
    var model by remember(models) { mutableStateOf(models.firstOrNull()?.id) }
    var epochs by remember { mutableStateOf("3") }
    FSCard(modifier = Modifier.testTag("local-ai-fine-tune")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(stringResource(R.string.local_ai_fine_tune_body), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            if (apps.isEmpty()) Text(stringResource(R.string.local_ai_no_sample_data), color = FS.colors.textMuted)
            if (models.isEmpty()) Text(stringResource(R.string.local_ai_no_trainable), color = FS.colors.textMuted)
            if (apps.isNotEmpty()) {
                Text(stringResource(R.string.local_ai_app), style = MaterialTheme.typography.bodySmall)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    apps.forEach { a -> FSChip(a.name.ifEmpty { a.serviceId }, selected = app == a.serviceId, onClick = { app = a.serviceId }, modifier = Modifier.testTag("local-ai-train-app-${a.serviceId}")) }
                }
            }
            if (models.isNotEmpty()) {
                Text(stringResource(R.string.local_ai_base_model), style = MaterialTheme.typography.bodySmall)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    models.forEach { m -> FSChip(m.name, selected = model == m.id, onClick = { model = m.id }, modifier = Modifier.testTag("local-ai-train-model-${m.id}")) }
                }
            }
            val n = epochs.toIntOrNull()
            FSField(
                value = epochs,
                onValueChange = { epochs = it.filter(Char::isDigit).take(2) },
                label = stringResource(R.string.local_ai_epochs),
                keyboardType = KeyboardType.Number,
                error = if (n == null || n !in 1..LocalAiOrders.MAX_EPOCHS) fsString(R.string.local_ai_epochs_range, LocalAiOrders.MAX_EPOCHS) else null,
                fieldTag = "local-ai-train-epochs",
            )
            FSPrimaryButton(
                stringResource(R.string.local_ai_start_fine_tune),
                onClick = { onStart(app!!, model!!, n!!) },
                enabled = !busy && app != null && model != null && n != null && n in 1..LocalAiOrders.MAX_EPOCHS,
                modifier = Modifier.testTag("local-ai-train-start"),
            )
        }
    }
}

@Composable
private fun AppsSection(apps: List<LocalAiAppRow>, busy: String?, onAllow: (String, Long, Long, Long) -> Unit, onWithdraw: (String) -> Unit) {
    FSSectionHeader(stringResource(R.string.local_ai_apps))
    if (apps.isEmpty()) {
        FSCard { Text(stringResource(R.string.local_ai_no_apps), color = FS.colors.textMuted, modifier = Modifier.testTag("local-ai-apps-empty")) }
        return
    }
    var editing by remember { mutableStateOf<LocalAiAppRow?>(null) }
    apps.forEach { a ->
        FSCard(modifier = Modifier.testTag("local-ai-app-${a.serviceId}")) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                Text(a.name.ifEmpty { a.serviceId }, fontWeight = FontWeight.Medium)
                val g = a.grant
                if (g == null) {
                    Text(stringResource(R.string.local_ai_app_not_allowed), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
                } else {
                    Text(
                        fsString(R.string.local_ai_app_quota, LocalAiCopy.number(g.requestsPerDay), LocalAiCopy.number(g.tokensPerDay), LocalAiCopy.number(g.maxTokensPerRequest)),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Text(
                        fsString(R.string.local_ai_app_usage, LocalAiCopy.number(a.usage.requests), LocalAiCopy.number(a.usage.tokens)),
                        color = FS.colors.textMuted,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    FSPrimaryButton(
                        if (g == null) stringResource(R.string.local_ai_allow) else stringResource(R.string.local_ai_change_limits),
                        onClick = { editing = a },
                        enabled = busy == null,
                        modifier = Modifier.testTag("local-ai-allow-${a.serviceId}"),
                    )
                    if (g != null) FSDangerButton(stringResource(R.string.local_ai_withdraw), onClick = { onWithdraw(a.serviceId) }, enabled = busy == null, modifier = Modifier.testTag("local-ai-withdraw-${a.serviceId}"))
                }
            }
        }
    }
    editing?.let { a ->
        var req by remember(a) { mutableStateOf((a.grant?.requestsPerDay ?: LocalAiOrders.DEFAULT_REQUESTS_PER_DAY).toString()) }
        var tok by remember(a) { mutableStateOf((a.grant?.tokensPerDay ?: LocalAiOrders.DEFAULT_TOKENS_PER_DAY).toString()) }
        var max by remember(a) { mutableStateOf((a.grant?.maxTokensPerRequest ?: LocalAiOrders.DEFAULT_MAX_TOKENS_PER_REQUEST).toString()) }
        val r = req.toLongOrNull()
        val t = tok.toLongOrNull()
        val m = max.toLongOrNull()
        val ok = r != null && t != null && m != null && r in 1..LocalAiOrders.MAX_REQUESTS_PER_DAY && t in 1..LocalAiOrders.MAX_TOKENS_PER_DAY && m in 1..LocalAiOrders.MAX_TOKENS_PER_REQUEST
        AlertDialog(
            onDismissRequest = { editing = null },
            confirmButton = {
                TextButton(onClick = { editing = null; onAllow(a.serviceId, r!!, t!!, m!!) }, enabled = ok, modifier = Modifier.testTag("local-ai-allow-confirm")) {
                    Text(stringResource(R.string.local_ai_allow))
                }
            },
            dismissButton = { TextButton(onClick = { editing = null }) { Text(stringResource(R.string.local_ai_cancel)) } },
            title = { Text(fsString(R.string.local_ai_allow_title, a.name.ifEmpty { a.serviceId })) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Text(stringResource(R.string.local_ai_allow_body), style = MaterialTheme.typography.bodySmall)
                    FSField(req, { req = it.filter(Char::isDigit).take(6) }, stringResource(R.string.local_ai_requests_per_day), keyboardType = KeyboardType.Number, fieldTag = "local-ai-quota-requests")
                    FSField(tok, { tok = it.filter(Char::isDigit).take(9) }, stringResource(R.string.local_ai_tokens_per_day), keyboardType = KeyboardType.Number, fieldTag = "local-ai-quota-tokens")
                    FSField(max, { max = it.filter(Char::isDigit).take(5) }, stringResource(R.string.local_ai_max_tokens_per_request), keyboardType = KeyboardType.Number, fieldTag = "local-ai-quota-max")
                    if (!ok) Text(stringResource(R.string.local_ai_quota_invalid), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            },
        )
    }
}

/** The server page's entry to Local AI. */
@Composable
internal fun LocalAiCard(onOpen: () -> Unit) {
    FSSectionHeader(stringResource(R.string.local_ai_title))
    FSCard(modifier = Modifier.testTag("sd-local-ai")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(stringResource(R.string.local_ai_card_body), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            FSSecondaryButton(stringResource(R.string.local_ai_open), onClick = onOpen, modifier = Modifier.testTag("sd-local-ai-open"))
        }
    }
}
