// A live app's API keys (docs/app-apis.md §3): the service page's section,
// the create form, the one-time key dialog and the revoke confirmation. A
// restricted device sees the keys but changes nothing; a box without API keys
// (404) shows no section at all.

package com.flagshipserver.app.ui.screens

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.PersistableBundle
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Key
import com.flagshipserver.app.ui.components.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import com.flagshipserver.app.ui.components.OutlinedTextField
import com.flagshipserver.app.ui.components.RadioButton
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.AppApiKeyInfo
import com.flagshipserver.app.core.AppApiKey
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSCardDivider
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.AppApiKeysViewModel
import kotlinx.coroutines.launch

@Composable
fun ApiKeysSection(
    serviceId: String,
    appName: String,
    restricted: Boolean,
    fallbackServerDomain: () -> String?,
    /** Why keys can't be changed here (a restricted profile, or not an admin device). */
    readOnlyNote: String = AppApiKeysViewModel.READ_ONLY_NOTE,
) {
    val client = LocalScreensClient.current
    val toasts = LocalToastCenter.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val vm = remember(serviceId, client) {
        AppApiKeysViewModel(serviceId, client, appName, fallbackServerDomain)
    }
    LaunchedEffect(vm) { vm.load() }
    val phase by vm.phase.collectAsState()
    val busy by vm.busy.collectAsState()
    val error by vm.error.collectAsState()
    val created by vm.created.collectAsState()

    var creating by remember(vm) { mutableStateOf(false) }
    var revoking by remember(vm) { mutableStateOf<AppApiKeyInfo?>(null) }

    if (phase is AppApiKeysViewModel.Phase.Unsupported) return
    val now = System.currentTimeMillis()

    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
    FSSectionHeader(AppApiKeysViewModel.TITLE)
    FSCard(
        padding = PaddingValues(FS.space.s4),
        modifier = Modifier.fillMaxWidth().testTag("service-detail-api-keys"),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            when (val p = phase) {
                is AppApiKeysViewModel.Phase.Loading, AppApiKeysViewModel.Phase.Unsupported -> {
                    Text("Loading…", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                }
                is AppApiKeysViewModel.Phase.Failed -> {
                    Text(p.message, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                    FSSecondaryButton("Try again", onClick = { scope.launch { vm.load() } })
                }
                is AppApiKeysViewModel.Phase.Loaded -> {
                    if (p.keys.isEmpty()) {
                        Text(
                            AppApiKeysViewModel.EMPTY,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.testTag("service-detail-api-keys-empty"),
                        )
                    }
                    p.keys.forEachIndexed { idx, key ->
                        if (idx > 0) FSCardDivider()
                        ApiKeyRow(
                            key = key,
                            now = now,
                            canRevoke = !restricted,
                            busy = busy,
                            onRevoke = { vm.clearError(); revoking = key },
                        )
                    }
                    if (restricted) {
                        Text(
                            readOnlyNote,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.testTag("service-detail-api-keys-read-only"),
                        )
                    } else {
                        FSSecondaryButton(
                            label = AppApiKeysViewModel.CREATE,
                            block = true,
                            enabled = !busy,
                            modifier = Modifier.testTag("service-detail-api-keys-create"),
                            onClick = { vm.clearError(); creating = true },
                        )
                    }
                }
            }
            if (!creating && revoking == null) {
                error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
    }

    if (creating) {
        CreateApiKeyDialog(
            busy = busy,
            error = error,
            onCancel = { creating = false; vm.clearError() },
            onCreate = { label, keyScope ->
                scope.launch { if (vm.create(label, keyScope)) creating = false }
            },
        )
    }

    revoking?.let { key ->
        AlertDialog(
            onDismissRequest = { if (!busy) revoking = null },
            title = { Text("Revoke ${AppApiKeysViewModel.displayLabel(key)}?") },
            text = {
                Column {
                    Text(vm.revokeConfirmText(key))
                    error?.let {
                        Spacer(Modifier.height(FS.space.s2))
                        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            },
            confirmButton = {
                TextButton(
                    enabled = !busy,
                    onClick = {
                        scope.launch {
                            if (vm.revoke(key.keyId)) {
                                revoking = null
                                toasts.success("Revoked ${AppApiKeysViewModel.displayLabel(key)}.")
                            }
                        }
                    },
                    modifier = Modifier.testTag("api-key-revoke-confirm"),
                ) { Text(if (busy) "Revoking…" else AppApiKeysViewModel.REVOKE, color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(enabled = !busy, onClick = { revoking = null; vm.clearError() }) { Text("Cancel") }
            },
            modifier = Modifier.testTag("api-key-revoke-dialog"),
        )
    }

    created?.let { c ->
        AlertDialog(
            // The key can't be shown again, so only Done closes this.
            onDismissRequest = {},
            title = { Text("Your key for ${c.label}") },
            text = {
                Column {
                    Text(
                        AppApiKeysViewModel.ONCE_WARNING,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Spacer(Modifier.height(FS.space.s3))
                    SelectionContainer {
                        Text(
                            c.key,
                            color = MaterialTheme.colorScheme.onSurface,
                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                            modifier = Modifier.testTag("api-key-created-value"),
                        )
                    }
                    Spacer(Modifier.height(FS.space.s3))
                    Text("Send it with each request:", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                    Text(
                        AppApiKeysViewModel.usageLine("<key>"),
                        color = MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        modifier = Modifier.testTag("api-key-created-usage"),
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = { vm.dismissCreated() },
                    modifier = Modifier.testTag("api-key-created-done"),
                ) { Text(AppApiKeysViewModel.DONE) }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        copySecret(ctx, c.key)
                        toasts.success("Copied.")
                    },
                    modifier = Modifier.testTag("api-key-created-copy"),
                ) { Text(AppApiKeysViewModel.COPY) }
            },
            modifier = Modifier.testTag("api-key-created-dialog"),
        )
    }
}

@Composable
private fun ApiKeyRow(
    key: AppApiKeyInfo,
    now: Long,
    canRevoke: Boolean,
    busy: Boolean,
    onRevoke: () -> Unit,
) {
    val expired = AppApiKeysViewModel.isExpired(key, now)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
        modifier = Modifier.fillMaxWidth().testTag("service-detail-api-key-${key.keyId}"),
    ) {
        Icon(
            Icons.Outlined.Key,
            contentDescription = null,
            tint = if (expired) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary,
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    AppApiKeysViewModel.displayLabel(key),
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f, fill = false),
                )
                FSPill(
                    if (expired) "Expired" else AppApiKeysViewModel.scopeText(key.scope),
                    kind = when {
                        expired -> FSPillKind.Offline
                        key.scope == AppApiKey.SCOPE_WRITE -> FSPillKind.Pending
                        else -> FSPillKind.Idle
                    },
                )
            }
            Text(
                AppApiKeysViewModel.detailText(key, now),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        if (canRevoke) {
            FSDangerButton(
                label = AppApiKeysViewModel.REVOKE,
                onClick = onRevoke,
                enabled = !busy,
                modifier = Modifier.testTag("service-detail-api-key-revoke"),
            )
        }
    }
}

@Composable
private fun CreateApiKeyDialog(
    busy: Boolean,
    error: String?,
    onCancel: () -> Unit,
    onCreate: (label: String, scope: String) -> Unit,
) {
    var label by remember { mutableStateOf("") }
    var keyScope by remember { mutableStateOf(AppApiKeysViewModel.DEFAULT_SCOPE) }
    AlertDialog(
        onDismissRequest = { if (!busy) onCancel() },
        title = { Text(AppApiKeysViewModel.CREATE) },
        text = {
            Column {
                OutlinedTextField(
                    value = label,
                    onValueChange = { label = it },
                    label = { Text("Name") },
                    placeholder = { Text("Garden sensor") },
                    singleLine = true,
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth().testTag("api-key-create-label"),
                )
                Spacer(Modifier.height(FS.space.s3))
                Text("Access", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold))
                AppApiKeysViewModel.SCOPES.forEach { s ->
                    Choice(
                        selected = keyScope == s,
                        enabled = !busy,
                        title = AppApiKeysViewModel.scopeText(s),
                        detail = if (s == AppApiKey.SCOPE_WRITE) AppApiKeysViewModel.WRITE_HELP else AppApiKeysViewModel.READ_HELP,
                        tag = "api-key-create-scope-$s",
                        onSelect = { keyScope = s },
                    )
                }
                error?.let {
                    Spacer(Modifier.height(FS.space.s2))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy && label.isNotBlank(),
                onClick = { onCreate(label, keyScope) },
                modifier = Modifier.testTag("api-key-create-confirm"),
            ) { Text(if (busy) "Creating…" else "Create") }
        },
        dismissButton = {
            TextButton(enabled = !busy, onClick = onCancel) { Text("Cancel") }
        },
        modifier = Modifier.testTag("api-key-create-dialog"),
    )
}

@Composable
private fun Choice(
    selected: Boolean,
    enabled: Boolean,
    title: String,
    detail: String?,
    tag: String,
    onSelect: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onSelect)
            .testTag(tag),
    ) {
        RadioButton(selected = selected, onClick = onSelect, enabled = enabled)
        Column {
            Text(title, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyMedium)
            detail?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

/** Copies the key, flagged sensitive so the system doesn't preview it. */
private fun copySecret(ctx: Context, key: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = ClipData.newPlainText("Flagship API key", key)
    clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
    cm.setPrimaryClip(clip)
}
