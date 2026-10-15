// The outbound proxy form (create flow's Advanced options and the server
// page's Change sheet) and the server page's "Outbound proxy" section
// (docs/outbound-proxy.md).

package com.flagshipserver.app.ui.screens

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
                    label = { Text(if (k == "none") "None" else BoxProxyProtocol.kindLabel(k)) },
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
                label = "Proxy address",
                placeholder = "proxy.example.net or 192.168.1.20",
                error = hostError,
                keyboardType = KeyboardType.Uri,
                fieldTag = "proxy-host",
            )
            val portError = draft.port.takeIf { it.isNotBlank() }?.let {
                val p = it.trim().toIntOrNull()
                if (p == null || p !in 1..65535) "Enter a port from 1 to 65535." else null
            }
            FSField(
                value = draft.port,
                onValueChange = { v -> onDraft(draft.copy(port = v.filter(Char::isDigit).take(5))) },
                label = "Port",
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
                label = "Username (optional)",
                placeholder = passwordPlaceholder,
                fieldTag = "proxy-username",
            )
            FSField(
                value = draft.password,
                onValueChange = { onDraft(draft.copy(password = it)) },
                label = "Password (optional)",
                placeholder = passwordPlaceholder,
                error = credError,
                keyboardType = KeyboardType.Password,
                visualTransformation = PasswordVisualTransformation(),
                fieldTag = "proxy-password",
            )
            if (showSetupFileWarning && draft.hasCredentials) {
                Text(
                    "The username and password are saved in the setup file. Only give the file to people you trust.",
                    color = FS.colors.warning,
                    style = TextStyle(fontSize = 12.sp),
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "If the proxy stops working, connect directly",
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
                "If this is off and the proxy stops working, the server goes offline until the proxy is back or you change it from the same network.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 12.sp),
            )
        }
    }
}

/** The create flow's block inside Advanced options. */
@Composable
internal fun OutboundProxyCreateBlock(draft: BoxProxyDraft, onDraft: (BoxProxyDraft) -> Unit) {
    Text(
        "Outbound proxy",
        color = FS.colors.text,
        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
    )
    Text(
        "Send this server's internet traffic through a proxy, so Flagship and the sites it reaches see the proxy's address instead of yours.",
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 12.sp),
    )
    Spacer(Modifier.height(FS.space.s2))
    OutboundProxyFields(draft = draft, onDraft = onDraft, showSetupFileWarning = true)
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
        "Outbound proxy",
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
            if (canChange) {
                FSPrimaryButton(
                    label = "Change",
                    onClick = {
                        draft = BoxProxyDraft.from(summary)
                        error = null
                        editing = true
                    },
                    enabled = !working,
                    block = true,
                    modifier = Modifier.testTag("sd-proxy-change"),
                )
                if (summary.proxy != null) {
                    FSSecondaryButton(
                        label = if (working && !editing) "Saving…" else "Turn off",
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
                    "Outbound proxy",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
                )
                OutboundProxyFields(
                    draft = draft,
                    onDraft = { draft = it },
                    passwordPlaceholder = if (summary.hasCredentials) "Unchanged" else "",
                )
                error?.let { Text(it, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp)) }
                FSPrimaryButton(
                    label = if (working) "Saving…" else "Save",
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
