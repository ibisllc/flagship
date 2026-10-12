// A live app's internet access (docs/ai-privacy-and-staging.md §3a): the
// service page's section, the access-list editor, and the request dialog the
// alerts raise. Every change is a list signed with the sensitive-order key; a
// restricted device sees everything but changes nothing.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.AppAccessPending
import com.flagshipserver.app.api.AppAccessSummary
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.core.AccessAlert
import com.flagshipserver.app.core.AccessRequestCenter
import com.flagshipserver.app.core.AppAccessList
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout
import com.flagshipserver.app.viewmodels.AppAccessOrder
import com.flagshipserver.app.viewmodels.AppAccessViewModel
import kotlinx.coroutines.launch

fun accessListRoute(serviceId: String) = "service-access-list/$serviceId"

private fun appVm(
    serviceId: String,
    client: ScreensClient,
    appName: String,
    fallbackServerDomain: () -> String?,
) = AppAccessViewModel(
    serviceId = serviceId,
    client = client,
    order = AppAccessOrder(client, fallbackServerDomain),
    appName = appName,
)

/** The service page's "Internet access" section: rule count, the pending
 *  requests (Allow / Deny / Ignore), and View access list. */
@Composable
fun InternetAccessSection(
    nav: NavController,
    serviceId: String,
    appName: String,
    summary: AppAccessSummary,
    restricted: Boolean,
    fallbackServerDomain: () -> String?,
) {
    val client = LocalScreensClient.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    val vm = remember(serviceId, client) { appVm(serviceId, client, appName, fallbackServerDomain) }
    LaunchedEffect(vm, summary) { vm.load() }
    val state by vm.state.collectAsState()
    val busy by vm.busy.collectAsState()
    val error by vm.error.collectAsState()
    val rules = state?.let { AppAccessList.parse(it.list).rules.size } ?: summary.rules
    val pending = state?.pending.orEmpty()

    Spacer(Modifier.height(FS.space.s4))
    FSCard(
        padding = PaddingValues(FS.space.s4),
        modifier = Modifier.fillMaxWidth().testTag("service-detail-access"),
    ) {
        Column {
            Text(
                AppAccessViewModel.TITLE,
                color = FS.colors.text,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
            )
            Spacer(Modifier.height(FS.space.s1))
            Text(
                AppAccessViewModel.ruleCountText(rules),
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                modifier = Modifier.testTag("service-detail-access-rules"),
            )
            pending.forEach { p ->
                Spacer(Modifier.height(FS.space.s3))
                PendingRequestRow(
                    pending = p,
                    appName = appName,
                    canSign = !restricted,
                    busy = busy,
                    onAllow = {
                        scope.launch {
                            if (vm.answer(p.host, allow = true)) toasts.success(AppAccessViewModel.allowedText(appName, p.host))
                        }
                    },
                    onDeny = {
                        scope.launch {
                            if (vm.answer(p.host, allow = false)) toasts.success(AppAccessViewModel.deniedText(appName, p.host))
                        }
                    },
                    onIgnore = { scope.launch { vm.dismiss(p.host) } },
                )
            }
            if (restricted) {
                Spacer(Modifier.height(FS.space.s2))
                Text(AppAccessViewModel.READ_ONLY_NOTE, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
            }
            Spacer(Modifier.height(FS.space.s3))
            FSSecondaryButton(
                label = AppAccessViewModel.VIEW_LIST,
                block = true,
                modifier = Modifier.testTag("service-detail-access-view"),
                onClick = { nav.navigate(accessListRoute(serviceId)) },
            )
            error?.let {
                Spacer(Modifier.height(FS.space.s2))
                Text(it, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp))
            }
        }
    }
}

@Composable
private fun PendingRequestRow(
    pending: AppAccessPending,
    appName: String,
    canSign: Boolean,
    busy: Boolean,
    onAllow: () -> Unit,
    onDeny: () -> Unit,
    onIgnore: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().testTag("service-detail-access-pending")) {
        Text(
            AppAccessViewModel.asksText(appName, pending.host),
            color = FS.colors.text,
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            AppAccessViewModel.sourceText(pending.source, pending.attempts),
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp),
        )
        if (canSign) {
            Spacer(Modifier.height(FS.space.s2))
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                FSPrimaryButton(
                    AppAccessViewModel.ALLOW, onAllow, enabled = !busy,
                    modifier = Modifier.testTag("service-detail-access-allow"),
                )
                FSSecondaryButton(
                    AppAccessViewModel.DENY, onDeny, enabled = !busy,
                    modifier = Modifier.testTag("service-detail-access-deny"),
                )
                FSGhostButton(
                    AppAccessViewModel.IGNORE, onIgnore, enabled = !busy,
                    modifier = Modifier.testTag("service-detail-access-ignore"),
                )
            }
        }
    }
}

/** The access list editor: parses as you type, shows each error by line,
 *  and keeps Save off while there are errors. */
@Composable
fun AccessListScreen(nav: NavController, serviceId: String) {
    val appState = LocalAppState.current
    val client = LocalScreensClient.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    val appName = remember(serviceId) {
        serviceId.substringAfter("--").replaceFirstChar { it.uppercase() }
    }
    // An alert from another box switches the current pod first; rebuild on it.
    val podId by appState.currentPodId.collectAsState()
    val vm = remember(serviceId, client, podId) {
        appVm(serviceId, client, appName) { (appState.sessionPod ?: appState.leaderPod)?.fqdn }
    }
    val restricted = appState.isRestrictedDevice()
    val state by vm.state.collectAsState()
    val loadError by vm.loadError.collectAsState()
    val busy by vm.busy.collectAsState()
    val error by vm.error.collectAsState()
    val boxErrors by vm.boxErrors.collectAsState()

    var draft by remember(vm) { mutableStateOf<String?>(null) }
    var savedDraft by remember(vm) { mutableStateOf<String?>(null) }
    LaunchedEffect(vm) { vm.load() }
    LaunchedEffect(state) {
        if (draft == null) state?.let { draft = it.list }
    }

    val text = draft ?: ""
    val parsed = remember(text) { AppAccessList.parse(text) }
    val errors = if (parsed.ok && text == savedDraft) boxErrors else parsed.errors.map {
        com.flagshipserver.app.api.AppAccessLineError(it.line, it.message)
    }
    val unchanged = state?.let { AppAccessList.normalize(it.list) == AppAccessList.normalize(text) } ?: true

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(
            Modifier
                .widthIn(max = FSLayout.readingMaxWidth)
                .fillMaxWidth()
                .padding(horizontal = FS.space.s6),
        ) {
            Spacer(Modifier.height(FS.space.s8))
            FSGhostButton(label = "← Back", onClick = { nav.popBackStack() })
            Spacer(Modifier.height(FS.space.s3))
            Text(
                "Access list",
                color = FS.colors.text,
                style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
                modifier = Modifier.testTag("access-list-title"),
            )
            Spacer(Modifier.height(FS.space.s1))
            Text(
                "$appName · ${AppAccessViewModel.ruleCountText(parsed.rules.size)}",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            Spacer(Modifier.height(FS.space.s3))
            Text(
                AppAccessViewModel.EDITOR_HELP,
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
            )
            Spacer(Modifier.height(FS.space.s4))
            if (draft == null) {
                Text(
                    loadError ?: "Loading…",
                    color = if (loadError != null) FS.colors.danger else FS.colors.textMuted,
                    style = TextStyle(fontSize = 14.sp),
                )
                if (loadError != null) {
                    Spacer(Modifier.height(FS.space.s2))
                    FSSecondaryButton("Try again", onClick = { scope.launch { vm.load() } })
                }
            } else {
                OutlinedTextField(
                    value = text,
                    onValueChange = { draft = it },
                    readOnly = restricted,
                    textStyle = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontFamily = FontFamily.Monospace, color = FS.colors.text),
                    isError = errors.isNotEmpty(),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 220.dp).testTag("access-list-editor"),
                )
                errors.forEach { e ->
                    Spacer(Modifier.height(FS.space.s1))
                    Text(
                        "Line ${e.line}: ${e.message}",
                        color = FS.colors.danger,
                        style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                        modifier = Modifier.testTag("access-list-error"),
                    )
                }
                Spacer(Modifier.height(FS.space.s4))
                if (restricted) {
                    Text(AppAccessViewModel.READ_ONLY_NOTE, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
                } else {
                    FSPrimaryButton(
                        label = if (busy) "Saving…" else "Save",
                        enabled = !busy && parsed.ok && !unchanged,
                        block = true,
                        modifier = Modifier.testTag("access-list-save"),
                        onClick = {
                            val toSave = text
                            scope.launch {
                                savedDraft = toSave
                                if (vm.save(toSave)) {
                                    draft = vm.state.value?.list ?: AppAccessList.normalize(toSave)
                                    toasts.success("Saved. $appName follows the new list now.")
                                }
                            }
                        },
                    )
                }
                error?.let {
                    Spacer(Modifier.height(FS.space.s2))
                    Text(it, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp))
                }
            }
            Spacer(Modifier.height(FS.space.s10))
        }
    }
}

/** One dialog per pending request, raised by [AccessRequestCenter]. */
@Composable
fun AccessRequestDialogHost(center: AccessRequestCenter, onViewList: (AccessAlert) -> Unit) {
    val shown by center.shown.collectAsState()
    val scope = rememberCoroutineScope()
    val s = shown ?: return
    val alert = s.alert
    when (val phase = s.phase) {
        is AccessRequestCenter.Phase.Done -> AlertDialog(
            onDismissRequest = { scope.launch { center.close() } },
            title = { Text(phase.message) },
            text = {
                Text(
                    if (phase.allowed) "You can change this any time in the app's access list."
                    else "The app's other hosts are unchanged. You can change this any time in its access list.",
                )
            },
            confirmButton = {
                TextButton(onClick = { scope.launch { center.close() } }, modifier = Modifier.testTag("access-alert-close")) {
                    Text("Close")
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { scope.launch { center.viewList()?.let(onViewList) } },
                    modifier = Modifier.testTag("access-alert-view-list"),
                ) { Text(AppAccessViewModel.VIEW_LIST) }
            },
            modifier = Modifier.testTag("access-alert-done"),
        )
        else -> {
            val sending = phase as? AccessRequestCenter.Phase.Sending
            AlertDialog(
                onDismissRequest = { if (sending == null) scope.launch { center.notNow() } },
                title = { Text(alert.asks) },
                text = {
                    Column {
                        Text(alert.detail)
                        Text(
                            "On ${alert.box.fqdn}. Only allow hosts you expect this app to need.",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                        )
                        (phase as? AccessRequestCenter.Phase.Failed)?.let {
                            Spacer(Modifier.height(FS.space.s2))
                            Text(it.message, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp))
                        }
                    }
                },
                confirmButton = {
                    Row {
                        TextButton(
                            enabled = sending == null,
                            onClick = { scope.launch { center.answer(allow = false) } },
                            modifier = Modifier.testTag("access-alert-deny"),
                        ) { Text(if (sending?.allow == false) "Denying…" else AppAccessViewModel.DENY) }
                        TextButton(
                            enabled = sending == null,
                            onClick = { scope.launch { center.answer(allow = true) } },
                            modifier = Modifier.testTag("access-alert-allow"),
                        ) { Text(if (sending?.allow == true) "Allowing…" else AppAccessViewModel.ALLOW) }
                    }
                },
                dismissButton = {
                    TextButton(
                        enabled = sending == null,
                        onClick = { scope.launch { center.notNow() } },
                        modifier = Modifier.testTag("access-alert-not-now"),
                    ) { Text(AppAccessViewModel.NOT_NOW) }
                },
                modifier = Modifier.testTag("access-alert"),
            )
        }
    }
}
