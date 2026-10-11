// AI-key surfaces — the reusable build-flow key step + the Settings → AI keys
// manager. Mirrors apps/web/public/webapp/views/build-key.js (reusable step)
// and the providers manager in views/settings.js. Keys are always masked in
// lists (provider · label · last-4); plaintext appears ONLY in the entry
// field.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.TextButton
import androidx.compose.runtime.rememberCoroutineScope
import com.flagshipserver.app.keystore.BiometricAuthority
import com.flagshipserver.app.viewmodels.SavedKeyRow
import kotlinx.coroutines.launch
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavController
import com.flagshipserver.app.core.AiCredential
import com.flagshipserver.app.core.AiKeyStore
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.AiKeysViewModel

private const val REASSURANCE =
    "Your key stays on this device. Your box calls the provider directly — " +
        "flagshipserver.com never sees it."

/** Copy for the build-flow key step. Mirror of iOS BuildKeyScreen. */
object AiKeyStep {
    const val TITLE = "AI Key"
    const val SECURITY_NOTE = "The keys are stored safely in your mobile app and your own servers."
    const val ADD_LABEL = "Add an API key"
    const val DELETE_TITLE = "Delete this key?"

    fun deleteMessage(label: String): String =
        "$label will be removed from this phone. Builds that are already running keep working."
}

/**
 * Reusable AI-key step. Shown for any build path that uses the BOX's model
 * (scratch always; git only when a non-fit repo needs adapting). Adding and
 * choosing are separate: "Add an API key" opens a form that saves the key to
 * the device-local list, and each saved key has "Use this" (which hands its
 * in-memory credential to `onConfirm` and moves the flow on) and a confirmed
 * delete. Mirror of iOS BuildKeyScreen.
 */
@Composable
fun AiKeyStepScreen(
    onConfirm: (AiCredential) -> Unit,
    onBack: () -> Unit,
    vm: AiKeysViewModel = viewModel(),
) {
    val keys by vm.keys.collectAsState()
    val activeId by vm.activeId.collectAsState()
    var showForm by remember { mutableStateOf(keys.isEmpty()) }
    LaunchedEffect(keys.isEmpty()) { if (keys.isEmpty()) showForm = true }
    var confirmDelete by remember { mutableStateOf<SavedKeyRow?>(null) }
    var deleteError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        FSGhostButton(label = "← Back", onClick = onBack)
        Spacer(Modifier.height(FS.space.s3))
        Text(
            AiKeyStep.TITLE,
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s4))

        if (showForm) {
            AiKeyEntryForm(
                confirmLabel = "Add key",
                showSaveToggle = false,
                onCancel = if (keys.isNotEmpty()) ({ showForm = false }) else null,
                onSubmit = { provider, apiKey, label, baseUrl, _ ->
                    if (vm.addAndSelect(provider, apiKey, label, baseUrl)) showForm = false
                },
                confirmTag = "build-key-add-save",
            )
        } else {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                modifier = Modifier
                    .clip(RoundedCornerShape(FS.radius.sm))
                    .clickable { showForm = true }
                    .padding(vertical = FS.space.s2)
                    .testTag("build-key-add"),
            ) {
                Icon(Icons.Filled.Add, contentDescription = null, tint = FS.colors.primary, modifier = Modifier.size(20.dp))
                Text(
                    AiKeyStep.ADD_LABEL,
                    color = FS.colors.primary,
                    style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                )
            }
        }

        if (keys.isNotEmpty()) {
            Spacer(Modifier.height(FS.space.s5))
            Text(
                "Saved keys",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
            )
            Spacer(Modifier.height(FS.space.s2))
            AiKeysViewModel.ordered(keys, activeId).forEach { row ->
                SavedKeyStepRow(
                    row = row,
                    lastUsed = row.id == activeId,
                    onUse = { vm.choose(row.id)?.let(onConfirm) },
                    onDelete = { confirmDelete = row },
                )
                Spacer(Modifier.height(FS.space.s2))
            }
            deleteError?.let {
                Text(it, color = FS.colors.danger, style = TextStyle(fontSize = 14.sp))
            }
        }

        Spacer(Modifier.height(FS.space.s4))
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Icon(
                Icons.Outlined.Lock,
                contentDescription = null,
                tint = FS.colors.primary,
                modifier = Modifier.size(18.dp),
            )
            Text(
                AiKeyStep.SECURITY_NOTE,
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
            )
        }

        Spacer(Modifier.height(FS.space.s12))
    }

    confirmDelete?.let { row ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text(AiKeyStep.DELETE_TITLE) },
            text = { Text(AiKeyStep.deleteMessage(row.label)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDelete = null
                        deleteError = null
                        scope.launch {
                            // Session-scoped like every other biometric gate in
                            // the app: an unlocked session that already
                            // authenticated isn't prompted again.
                            val ok = runCatching {
                                BiometricAuthority.current()?.ensureFresh(
                                    title = AiKeyStep.DELETE_TITLE,
                                    subtitle = "Delete the AI key ${row.label}",
                                )
                            }.isSuccess
                            if (ok) vm.delete(row.id) else deleteError = "The key wasn't deleted."
                        }
                    },
                    modifier = Modifier.testTag("build-key-delete-confirm"),
                ) { Text("Delete key", color = FS.colors.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun SavedKeyStepRow(row: SavedKeyRow, lastUsed: Boolean, onUse: () -> Unit, onDelete: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Column(Modifier.weight(1f)) {
                Text(
                    row.label,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                    maxLines = 1,
                )
                Text(
                    row.maskedSlug,
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                    maxLines = 1,
                )
                if (lastUsed) {
                    Text("Last used", color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp))
                }
            }
            IconButton(onClick = onDelete, modifier = Modifier.testTag("build-key-delete")) {
                Icon(Icons.Outlined.Delete, contentDescription = "Delete ${row.label}", tint = FS.colors.danger)
            }
            FSPrimaryButton(
                label = "Use this",
                onClick = onUse,
                modifier = Modifier.testTag(if (lastUsed) "build-key-confirm-active" else "build-key-use-saved"),
            )
        }
    }
}

/**
 * The "provide a key" form — provider picker + optional baseUrl + masked key
 * field + optional label + a "Save on this device" toggle. `onSubmit` carries
 * (provider, apiKey, label, baseUrl?, save).
 */
@Composable
fun AiKeyEntryForm(
    confirmLabel: String,
    showSaveToggle: Boolean = true,
    onCancel: (() -> Unit)? = null,
    confirmTag: String = "build-key-use",
    onSubmit: (provider: String, apiKey: String, label: String, baseUrl: String?, save: Boolean) -> Unit,
) {
    var provider by remember { mutableStateOf(AiKeyStore.SUPPORTED_PROVIDERS.first()) }
    var apiKey by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var baseUrl by remember { mutableStateOf("") }
    var save by remember { mutableStateOf(true) }

    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column {
            Text(
                "Provider",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
            )
            Spacer(Modifier.height(FS.space.s2))
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                AiKeyStore.SUPPORTED_PROVIDERS.forEach { p ->
                    ProviderPickChip(
                        label = p,
                        selected = p == provider,
                        onClick = { provider = p },
                        // Stable per-provider tag so a UI test can pick e.g.
                        // "openai" (`ai-key-provider-openai`).
                        modifier = Modifier.testTag("ai-key-provider-$p"),
                    )
                }
            }

            Spacer(Modifier.height(FS.space.s3))
            FSField(
                value = apiKey,
                onValueChange = { apiKey = it },
                label = "API key",
                placeholder = "sk-…",
                // Tag the editable field itself (not the Column wrapper) so a UI
                // test's performTextInput finds a focusable node.
                fieldTag = "ai-key-field",
            )
            Spacer(Modifier.height(FS.space.s2))
            FSField(
                value = label,
                onValueChange = { label = it },
                label = "Label (optional)",
                placeholder = "Personal",
            )
            Spacer(Modifier.height(FS.space.s2))
            FSField(
                value = baseUrl,
                onValueChange = { baseUrl = it },
                label = "Custom base URL (optional)",
                placeholder = "https://…",
            )

            if (showSaveToggle) {
                Spacer(Modifier.height(FS.space.s3))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            "Save on this device",
                            color = FS.colors.text,
                            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
                        )
                        Text(
                            "Recall it next time without re-typing. Stored encrypted on this device only.",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 12.sp, lineHeight = 16.sp),
                        )
                    }
                    Switch(checked = save, onCheckedChange = { save = it })
                }
            }

            Spacer(Modifier.height(FS.space.s4))
            FSPrimaryButton(
                label = confirmLabel,
                onClick = { onSubmit(provider, apiKey, label, baseUrl, save) },
                enabled = apiKey.isNotBlank(),
                block = true,
                modifier = Modifier.testTag(confirmTag),
            )
            if (onCancel != null) {
                Spacer(Modifier.height(FS.space.s2))
                FSGhostButton(label = "Cancel", onClick = onCancel, block = true)
            }
        }
    }
}

@Composable
private fun ProviderPickChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val bg = if (selected) FS.colors.primary else FS.colors.surfaceSunken
    val fg = if (selected) FS.colors.onAccent else FS.colors.textMuted
    Box(
        modifier
            .clip(RoundedCornerShape(FS.radius.pill))
            .background(bg)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Text(label, color = fg, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium))
    }
}

/**
 * Settings → AI keys. View saved keys as masked slugs, add, and delete. No
 * full key is ever shown. Reuses the same entry form as the build step.
 */
@Composable
fun AiKeysManagerScreen(nav: NavController, vm: AiKeysViewModel = viewModel()) {
    val keys by vm.keys.collectAsState()
    val activeId by vm.activeId.collectAsState()
    var showForm by remember { mutableStateOf(false) }

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        FSGhostButton(label = "← Back", onClick = { nav.popBackStack() })
        Spacer(Modifier.height(FS.space.s3))
        Text(
            "AI keys",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
            modifier = Modifier.testTag("ai-keys-title"),
        )
        Spacer(Modifier.height(FS.space.s2))
        Text(
            REASSURANCE,
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        )
        Spacer(Modifier.height(FS.space.s5))

        if (keys.isEmpty()) {
            Text(
                "No keys saved yet.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp),
            )
        } else {
            keys.forEach { row ->
                val isActive = row.id == activeId
                FSCard(padding = PaddingValues(FS.space.s4)) {
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    row.maskedSlug,
                                    color = FS.colors.text,
                                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
                                )
                                if (isActive) {
                                    Spacer(Modifier.height(2.dp))
                                    Text(
                                        "Default for new builds",
                                        color = FS.colors.primary,
                                        style = TextStyle(fontSize = 12.sp),
                                    )
                                }
                            }
                            FSDangerButton(label = "Delete", onClick = { vm.delete(row.id) })
                        }
                        // "Make default" on every non-active row — mirrors iOS's
                        // AiKeysScreen + the webapp providers manager.
                        if (!isActive) {
                            Spacer(Modifier.height(FS.space.s2))
                            FSGhostButton(
                                label = "Make default",
                                onClick = { vm.setActive(row.id) },
                            )
                        }
                    }
                }
                Spacer(Modifier.height(FS.space.s2))
            }
        }

        Spacer(Modifier.height(FS.space.s4))
        if (showForm) {
            AiKeyEntryForm(
                confirmLabel = "Save key",
                onSubmit = { provider, apiKey, label, baseUrl, _ ->
                    if (vm.add(provider, apiKey, label, baseUrl)) showForm = false
                },
            )
        } else {
            FSSecondaryButton(
                label = "Add a key",
                onClick = { showForm = true },
                block = true,
                modifier = Modifier.testTag("ai-key-add"),
            )
        }

        Spacer(Modifier.height(FS.space.s12))
    }
}
