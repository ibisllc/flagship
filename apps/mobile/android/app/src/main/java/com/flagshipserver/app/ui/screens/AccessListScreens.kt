// A live app's internet access (docs/ai-privacy-and-staging.md §3a): the
// service page's section (with a suggested list's card), the access-list
// editor, and the request dialog the alerts raise. Every change is a list signed with the sensitive-order key; a
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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
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
import com.flagshipserver.app.core.AppOrderSigning
import com.flagshipserver.app.core.LocalAppOrderSigning
import com.flagshipserver.app.viewmodels.AppAccessOrder
import com.flagshipserver.app.viewmodels.AppAccessViewModel
import kotlinx.coroutines.launch

fun accessListRoute(serviceId: String, draft: Boolean = false) =
    if (draft) "service-access-list/$serviceId?draft=true" else "service-access-list/$serviceId"

private fun appVm(
    serviceId: String,
    client: ScreensClient,
    appName: String,
    signing: AppOrderSigning?,
    fallbackServerDomain: () -> String?,
) = AppAccessViewModel(
    serviceId = serviceId,
    client = client,
    order = if (signing != null) {
        AppAccessOrder(client, { signing.serverDomain }, signing.signer)
    } else {
        AppAccessOrder(client, fallbackServerDomain)
    },
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
    val signing = LocalAppOrderSigning.current
    val vm = remember(serviceId, client, signing) { appVm(serviceId, client, appName, signing, fallbackServerDomain) }
    LaunchedEffect(vm, summary) { vm.load() }
    // Back from the editor (a reviewed draft saved, a list changed): reload.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, vm) {
        var first = true
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                if (first) first = false else scope.launch { vm.load() }
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
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
            state?.draft?.let { d ->
                Spacer(Modifier.height(FS.space.s3))
                DraftCard(
                    draft = d,
                    canSign = !restricted,
                    busy = busy,
                    onReview = { nav.navigate(accessListRoute(serviceId, draft = true)) },
                    onDismiss = { scope.launch { vm.dismissDraft() } },
                )
            }
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

/** "This app suggests letting it reach these hosts": each host with its
 *  reason, Review (the editor, prefilled) and Dismiss. */
@Composable
private fun DraftCard(
    draft: com.flagshipserver.app.api.AppAccessDraft,
    canSign: Boolean,
    busy: Boolean,
    onReview: () -> Unit,
    onDismiss: () -> Unit,
) {
    FSCard(
        padding = PaddingValues(FS.space.s3),
        modifier = Modifier.fillMaxWidth().testTag("service-detail-access-draft"),
    ) {
        Column {
            Text(
                AppAccessViewModel.DRAFT_TITLE,
                color = FS.colors.text,
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
            )
            draft.hosts.forEach { h ->
                Spacer(Modifier.height(FS.space.s1))
                Text(
                    h.host,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 14.sp, fontFamily = FontFamily.Monospace),
                    modifier = Modifier.testTag("service-detail-access-draft-host"),
                )
                h.why?.takeIf { it.isNotBlank() }?.let {
                    Text(it, color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp, lineHeight = 16.sp))
                }
            }
            Spacer(Modifier.height(FS.space.s1))
            Text(AppAccessViewModel.DRAFT_NOTE, color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp, lineHeight = 16.sp))
            if (canSign) {
                Spacer(Modifier.height(FS.space.s2))
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    FSPrimaryButton(
                        AppAccessViewModel.REVIEW, onReview, enabled = !busy,
                        modifier = Modifier.testTag("service-detail-access-draft-review"),
                    )
                    FSGhostButton(
                        AppAccessViewModel.DISMISS, onDismiss, enabled = !busy,
                        modifier = Modifier.testTag("service-detail-access-draft-dismiss"),
                    )
                }
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
fun AccessListScreen(nav: NavController, serviceId: String, fromDraft: Boolean = false) {
    val appState = LocalAppState.current
    val client = LocalScreensClient.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    val appName = remember(serviceId) {
        serviceId.substringAfter("--").replaceFirstChar { it.uppercase() }
    }
    // An alert from another box switches the current pod first; rebuild on it.
    val podId by appState.currentPodId.collectAsState()
    val signing = LocalAppOrderSigning.current
    val vm = remember(serviceId, client, podId, signing) {
        appVm(serviceId, client, appName, signing) { (appState.sessionPod ?: appState.leaderPod)?.fqdn }
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
    // Review opens on the suggested list; with no draft left it's the list itself.
    val reviewing = fromDraft && state?.draft != null
    LaunchedEffect(state) {
        if (draft == null) state?.let { draft = if (fromDraft) it.draft?.list ?: it.list else it.list }
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
            if (reviewing) {
                Spacer(Modifier.height(FS.space.s2))
                Text(
                    AppAccessViewModel.DRAFT_EDITOR_NOTE,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                    modifier = Modifier.testTag("access-list-draft-note"),
                )
            }
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
                                val ok = if (reviewing) vm.save(toSave, vm.approveDraftReason) else vm.save(toSave)
                                if (ok) {
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

/** One dialog per pending request, raised by [AccessRequestCenter]. A draft's
 *  Review and a confirmation's View access list both open the app's editor
 *  ([AccessAlert.isDraft] says which list it starts from). */
@Composable
fun AccessRequestDialogHost(center: AccessRequestCenter, onViewList: (AccessAlert) -> Unit) {
    val shown by center.shown.collectAsState()
    val scope = rememberCoroutineScope()
    val s = shown ?: return
    val alert = s.alert
    if (alert.isDraft) {
        AlertDialog(
            onDismissRequest = { scope.launch { center.notNow() } },
            title = { Text(alert.asks) },
            text = {
                Column {
                    alert.request.hosts.forEach { h ->
                        Text(AppAccessViewModel.suggestionText(h), style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
                    }
                    Spacer(Modifier.height(FS.space.s2))
                    Text(
                        "On ${alert.box.fqdn}. ${AppAccessViewModel.DRAFT_NOTE}",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = { scope.launch { center.review()?.let(onViewList) } },
                    modifier = Modifier.testTag("access-alert-review"),
                ) { Text(AppAccessViewModel.REVIEW) }
            },
            dismissButton = {
                TextButton(
                    onClick = { scope.launch { center.notNow() } },
                    modifier = Modifier.testTag("access-alert-not-now"),
                ) { Text(AppAccessViewModel.NOT_NOW) }
            },
            modifier = Modifier.testTag("access-alert-draft"),
        )
        return
    }
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
