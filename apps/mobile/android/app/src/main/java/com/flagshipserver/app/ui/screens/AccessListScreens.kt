// A live app's internet access (docs/ai-privacy-and-staging.md §3a): the
// service page's section (with a suggested list's card), the access-list
// editor, and the request dialog the alerts raise. Every change is a list signed with the sensitive-order key; a
// restricted device sees everything but changes nothing.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Assignment
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Public
import com.flagshipserver.app.ui.components.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import com.flagshipserver.app.ui.components.OutlinedTextField
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
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
import com.flagshipserver.app.ui.components.FSCardDivider
import com.flagshipserver.app.ui.components.FSEmptyState
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSectionHeader
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
    /** Why the requests can't be answered here (a restricted profile, or not an admin device). */
    readOnlyNote: String = AppAccessViewModel.READ_ONLY_NOTE,
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

    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
    FSSectionHeader(AppAccessViewModel.TITLE)
    FSCard(
        padding = PaddingValues(FS.space.s4),
        modifier = Modifier.fillMaxWidth().testTag("service-detail-access"),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            state?.draft?.let { d ->
                DraftCard(
                    draft = d,
                    canSign = !restricted,
                    busy = busy,
                    onReview = { nav.navigate(accessListRoute(serviceId, draft = true)) },
                    onDismiss = { scope.launch { vm.dismissDraft() } },
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Icon(
                    Icons.Outlined.Public,
                    contentDescription = null,
                    tint = if (pending.isEmpty()) MaterialTheme.colorScheme.primary else FS.colors.warning,
                )
                Text(
                    AppAccessViewModel.ruleCountText(rules),
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.testTag("service-detail-access-rules"),
                )
            }
            pending.forEach { p ->
                FSCardDivider()
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
                Text(
                    readOnlyNote,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.testTag("service-detail-access-read-only"),
                )
            }
            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
            FSSecondaryButton(
                label = AppAccessViewModel.VIEW_LIST,
                block = true,
                modifier = Modifier.testTag("service-detail-access-view"),
                onClick = { nav.navigate(accessListRoute(serviceId)) },
            )
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
    Column(
        verticalArrangement = Arrangement.spacedBy(FS.space.s2),
        modifier = Modifier.fillMaxWidth().testTag("service-detail-access-draft"),
    ) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Icon(Icons.Outlined.Assignment, contentDescription = null, tint = FS.colors.warning)
            Text(
                AppAccessViewModel.DRAFT_TITLE,
                color = MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.titleSmall,
            )
        }
        draft.hosts.forEach { h ->
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    h.host,
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                    modifier = Modifier.testTag("service-detail-access-draft-host"),
                )
                h.why?.takeIf { it.isNotBlank() }?.let {
                    Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        Text(AppAccessViewModel.DRAFT_NOTE, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        if (canSign) {
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                FSPrimaryButton(
                    AppAccessViewModel.REVIEW, onReview, enabled = !busy,
                    modifier = Modifier.testTag("service-detail-access-draft-review"),
                )
                FSSecondaryButton(
                    AppAccessViewModel.DISMISS, onDismiss, enabled = !busy,
                    modifier = Modifier.testTag("service-detail-access-draft-dismiss"),
                )
            }
        }
        FSCardDivider()
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
    Column(
        verticalArrangement = Arrangement.spacedBy(FS.space.s1),
        modifier = Modifier.fillMaxWidth().testTag("service-detail-access-pending"),
    ) {
        Text(
            AppAccessViewModel.asksText(appName, pending.host),
            color = MaterialTheme.colorScheme.onSurface,
            style = MaterialTheme.typography.titleSmall,
        )
        Text(
            AppAccessViewModel.sourceText(pending.source, pending.attempts),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
        )
        if (canSign) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(top = FS.space.s1),
            ) {
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
    val restricted = appState.isRestrictedDevice() || !com.flagshipserver.app.core.AdminOrderGate.allows(appState)
    val readOnlyNote = if (appState.isRestrictedDevice()) AppAccessViewModel.READ_ONLY_NOTE
    else com.flagshipserver.app.core.AdminOrderGate.ACCESS_LIST
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

    FSScreen(
        title = stringResource(R.string.access_list),
        onBack = { nav.popBackStack() },
        titleTag = "access-list-title",
        subtitle = "$appName · ${AppAccessViewModel.ruleCountText(parsed.rules.size)}",
    ) {
        Text(
            AppAccessViewModel.EDITOR_HELP,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
        )
        if (reviewing) {
            Text(
                AppAccessViewModel.DRAFT_EDITOR_NOTE,
                color = MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.testTag("access-list-draft-note"),
            )
        }
        if (draft == null) {
            if (loadError != null) {
                FSEmptyState(
                    title = stringResource(R.string.couldnt_load_the_access_list),
                    message = loadError,
                    icon = Icons.Outlined.ErrorOutline,
                    iconTint = MaterialTheme.colorScheme.error,
                    action = { FSSecondaryButton(stringResource(R.string.try_again), onClick = { scope.launch { vm.load() } }) },
                )
            } else {
                Text(stringResource(R.string.loading), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                OutlinedTextField(
                    value = text,
                    onValueChange = { draft = it },
                    readOnly = restricted,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurface),
                    isError = errors.isNotEmpty(),
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 220.dp).testTag("access-list-editor"),
                )
                errors.forEach { e ->
                    Text(
                        fsString(R.string.line, e.line, e.message),
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.testTag("access-list-error"),
                    )
                }
            }
            if (restricted) {
                Text(
                    readOnlyNote,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.testTag("access-list-read-only"),
                )
            } else {
                FSPrimaryButton(
                    label = if (busy) stringResource(R.string.saving) else stringResource(R.string.save),
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
                                toasts.success(FSStrings.get(R.string.saved_follows_the_new_list_now, appName))
                            }
                        }
                    },
                )
            }
            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
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
            title = { Text(alert.asks, modifier = Modifier.testTag("access-alert-draft-title")) },
            text = {
                Column {
                    alert.request.hosts.forEach { h ->
                        Text(AppAccessViewModel.suggestionText(h), style = MaterialTheme.typography.bodyMedium)
                    }
                    Spacer(Modifier.height(FS.space.s2))
                    Text(
                        fsString(R.string.on, alert.box.fqdn, AppAccessViewModel.DRAFT_NOTE),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
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
                    if (phase.allowed) stringResource(R.string.you_can_change_this_any_time_2)
                    else stringResource(R.string.the_apps_other_hosts_are_unchanged),
                )
            },
            confirmButton = {
                TextButton(onClick = { scope.launch { center.close() } }, modifier = Modifier.testTag("access-alert-close")) {
                    Text(stringResource(R.string.close))
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
                title = { Text(alert.asks, modifier = Modifier.testTag("access-alert-title")) },
                text = {
                    Column {
                        Text(alert.detail)
                        Text(
                            fsString(R.string.on_only_allow_hosts_you_expect, alert.box.fqdn),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        (phase as? AccessRequestCenter.Phase.Failed)?.let {
                            Spacer(Modifier.height(FS.space.s2))
                            Text(it.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                },
                confirmButton = {
                    Row {
                        TextButton(
                            enabled = sending == null,
                            onClick = { scope.launch { center.answer(allow = false) } },
                            modifier = Modifier.testTag("access-alert-deny"),
                        ) { Text(if (sending?.allow == false) stringResource(R.string.denying) else AppAccessViewModel.DENY) }
                        TextButton(
                            enabled = sending == null,
                            onClick = { scope.launch { center.answer(allow = true) } },
                            modifier = Modifier.testTag("access-alert-allow"),
                        ) { Text(if (sending?.allow == true) stringResource(R.string.allowing) else AppAccessViewModel.ALLOW) }
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
