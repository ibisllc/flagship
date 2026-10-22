// The outbound proxy form (create flow's Advanced options and the server
// page's Change sheet) and the server page's "Outbound proxy" section
// (docs/outbound-proxy.md).

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.R
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.OutboundProxySummary
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.core.BoxProxyDraft
import com.flagshipserver.app.core.BoxProxyProtocol
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.OutboundProxyOrder
import kotlinx.coroutines.launch

/** The proxy fields. [passwordPlaceholder] is "Unchanged" when the box already holds credentials. */
@Composable
internal fun OutboundProxyFields(
    draft: BoxProxyDraft,
    onDraft: (BoxProxyDraft) -> Unit,
    passwordPlaceholder: String = "",
    showSetupFileWarning: Boolean = false,
) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            for (k in BoxProxyProtocol.KINDS) {
                FilterChip(
                    selected = draft.kind == k,
                    onClick = { onDraft(draft.withKind(k)) },
                    label = { Text(if (k == "none") stringResource(R.string.none) else BoxProxyProtocol.kindLabel(k)) },
                    modifier = Modifier.testTag("proxy-kind-$k"),
                )
            }
        }
        if (draft.kind != "none") {
            val hostError = draft.host.takeIf { it.isNotBlank() }
                ?.let { BoxProxyProtocol.hostError(BoxProxyProtocol.normalizeHost(it)) }
            FSField(
                value = draft.host,
                onValueChange = { onDraft(draft.copy(host = it)) },
                label = stringResource(R.string.proxy_address),
                placeholder = stringResource(R.string.proxy_example_net_or_192_168),
                error = hostError,
                keyboardType = KeyboardType.Uri,
                fieldTag = "proxy-host",
            )
            val portError = draft.port.takeIf { it.isNotBlank() }?.let {
                val p = it.trim().toIntOrNull()
                if (p == null || p !in 1..65535) stringResource(R.string.enter_a_port_from_1_to) else null
            }
            FSField(
                value = draft.port,
                onValueChange = { v -> onDraft(draft.copy(port = v.filter(Char::isDigit).take(5))) },
                label = stringResource(R.string.port),
                error = portError,
                keyboardType = KeyboardType.Number,
                fieldTag = "proxy-port",
            )
            val credError = if (draft.hasCredentials) {
                BoxProxyProtocol.credentialsError(draft.username, draft.password)
            } else null
            FSField(
                value = draft.username,
                onValueChange = { onDraft(draft.copy(username = it)) },
                label = stringResource(R.string.username_optional),
                placeholder = passwordPlaceholder,
                fieldTag = "proxy-username",
            )
            FSField(
                value = draft.password,
                onValueChange = { onDraft(draft.copy(password = it)) },
                label = stringResource(R.string.password_optional),
                placeholder = passwordPlaceholder,
                error = credError,
                keyboardType = KeyboardType.Password,
                visualTransformation = PasswordVisualTransformation(),
                fieldTag = "proxy-password",
            )
            if (showSetupFileWarning && draft.hasCredentials) {
                Text(
                    stringResource(R.string.the_username_and_password_are_saved),
                    color = FS.colors.warning,
                    style = TextStyle(fontSize = 12.sp),
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.if_the_proxy_stops_working_connect),
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
                    modifier = Modifier.weight(1f),
                )
                Switch(
                    checked = draft.fallbackDirect,
                    onCheckedChange = { onDraft(draft.copy(fallbackDirect = it)) },
                    modifier = Modifier.testTag("proxy-fallback"),
                )
            }
            Text(
                stringResource(R.string.if_this_is_off_and_the),
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 12.sp),
            )
        }
    }
}

/** "An outbound proxy is part of Pro." with a link to the Pro page, shown to
 *  Free accounts instead of the fields. */
@Composable
internal fun OutboundProxyProNote() {
    val uri = LocalUriHandler.current
    Column(Modifier.testTag("proxy-pro")) {
        Text(BoxProxyProtocol.PRO_NOTE, color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp))
        Text(
            stringResource(R.string.see_pro),
            color = FS.colors.primary,
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium),
            modifier = Modifier.clickable { uri.openUri("${Endpoints.controlBaseUrl}/pro") },
        )
    }
}

/** The create flow's block inside Advanced options; [allowed] is false on a Free account. */
@Composable
internal fun OutboundProxyCreateBlock(draft: BoxProxyDraft, onDraft: (BoxProxyDraft) -> Unit, allowed: Boolean = true) {
    Text(
        stringResource(R.string.outbound_proxy),
        color = FS.colors.text,
        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
    )
    Text(
        stringResource(R.string.send_this_servers_internet_traffic_through),
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 12.sp),
    )
    Spacer(Modifier.height(FS.space.s2))
    if (allowed) {
        OutboundProxyFields(draft = draft, onDraft = onDraft, showSetupFileWarning = true)
    } else {
        OutboundProxyProNote()
    }
}

/** The server page's section. Hidden when the box doesn't report a proxy summary (older daemons). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun OutboundProxyCard(
    serverDomain: String,
    summary: OutboundProxySummary,
    client: ScreensClient?,
    onSaved: () -> Unit,
) {
    val app = LocalAppState.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    val canChange = client != null && !app.isDemoAccountNow()
    // The box says `available = false` once .com has told it the account is on
    // Free: no new proxy, but one already set can still be turned off.
    val pro = summary.available != false
    var editing by remember(serverDomain) { mutableStateOf(false) }
    var working by remember(serverDomain) { mutableStateOf(false) }
    var error by remember(serverDomain) { mutableStateOf<String?>(null) }
    var draft by remember(serverDomain, summary) { mutableStateOf(BoxProxyDraft.from(summary)) }

    fun send(d: BoxProxyDraft) {
        val c = client ?: return
        if (working) return
        working = true
        error = null
        scope.launch {
            when (val r = OutboundProxyOrder(c).save(serverDomain, d, summary)) {
                is OutboundProxyOrder.Outcome.Saved -> {
                    toasts.success(r.message)
                    editing = false
                    onSaved()
                }
                is OutboundProxyOrder.Outcome.Failed -> error = r.message
            }
            working = false
        }
    }

    Text(
        stringResource(R.string.outbound_proxy),
        color = FS.colors.text,
        style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
    )
    Spacer(Modifier.height(FS.space.s2))
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                summary.label,
                color = FS.colors.text,
                style = TextStyle(fontSize = 14.sp),
                modifier = Modifier.testTag("sd-proxy-label"),
            )
            summary.statusLine?.let {
                Text(
                    it,
                    color = if (summary.status.state == "ok") FS.colors.textMuted else FS.colors.warning,
                    style = TextStyle(fontSize = 13.sp),
                    modifier = Modifier.testTag("sd-proxy-status"),
                )
            }
            if (!editing) error?.let { Text(it, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp)) }
            if (!pro) OutboundProxyProNote()
            if (canChange) {
                if (pro) {
                    FSPrimaryButton(
                        label = stringResource(R.string.change),
                        onClick = {
                            draft = BoxProxyDraft.from(summary)
                            error = null
                            editing = true
                        },
                        enabled = !working,
                        block = true,
                        modifier = Modifier.testTag("sd-proxy-change"),
                    )
                }
                if (summary.proxy != null) {
                    FSSecondaryButton(
                        label = if (working && !editing) stringResource(R.string.saving) else stringResource(R.string.turn_off),
                        onClick = { send(BoxProxyDraft()) },
                        enabled = !working,
                        block = true,
                        modifier = Modifier.testTag("sd-proxy-off"),
                    )
                }
            }
        }
    }

    if (editing) {
        ModalBottomSheet(
            onDismissRequest = { if (!working) editing = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        ) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = FS.space.s6, vertical = FS.space.s4),
                verticalArrangement = Arrangement.spacedBy(FS.space.s3),
            ) {
                Text(
                    stringResource(R.string.outbound_proxy),
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
                )
                OutboundProxyFields(
                    draft = draft,
                    onDraft = { draft = it },
                    passwordPlaceholder = if (summary.hasCredentials) stringResource(R.string.unchanged_2) else "",
                )
                error?.let { Text(it, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp)) }
                FSPrimaryButton(
                    label = if (working) stringResource(R.string.saving) else stringResource(R.string.save),
                    onClick = { send(draft) },
                    enabled = !working && draft.error() == null,
                    block = true,
                    modifier = Modifier.testTag("sd-proxy-save"),
                )
                Spacer(Modifier.height(FS.space.s4))
            }
        }
    }
}
