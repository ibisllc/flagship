// AI-key surfaces — the reusable build-flow key step + the Settings → AI keys
// manager. Mirrors apps/web/public/webapp/views/build-key.js (reusable step)
// and the providers manager in views/settings.js. Keys are always masked in
// lists (provider · label · last-4); plaintext appears ONLY in the entry
// field.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavController
import com.flagshipserver.app.core.AiCredential
import com.flagshipserver.app.core.AiKeyStore
import com.flagshipserver.app.core.AiRelay
import com.flagshipserver.app.core.FreeAiMint
import com.flagshipserver.app.core.FreeAiService
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.keystore.BiometricAuthority
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSChip
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSNote
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.AiKeysViewModel
import com.flagshipserver.app.viewmodels.SavedKeyRow
import kotlinx.coroutines.launch

private const val REASSURANCE =
    "AI keys power app builds but stay on this phone. Your server sends them only to the provider; Flagship never sees them."

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
    freeAiService: FreeAiService = rememberFreeAiService(),
) {
    val keys by vm.keys.collectAsState()
    val activeId by vm.activeId.collectAsState()
    val freeAi by vm.freeAi.collectAsState()
    // Free AI credits come first, so the form waits for the balance read.
    var freeAiLoaded by remember { mutableStateOf(false) }
    var showForm by remember { mutableStateOf(false) }
    LaunchedEffect(keys.isEmpty(), freeAiLoaded, freeAi) {
        if (freeAiLoaded && keys.isEmpty() && !FreeAiService.shouldAutoUse(0, freeAi)) showForm = true
    }
    var confirmDelete by remember { mutableStateOf<SavedKeyRow?>(null) }
    var deleteError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val server = currentBuildServerFqdn()
    val toasts = LocalToastCenter.current
    var minting by remember { mutableStateOf(false) }

    suspend fun useFreeAi() {
        if (minting) return
        minting = true
        try {
            when (val r = runCatching { vm.useFreeAi(freeAiService, server) }
                .getOrElse { FreeAiMint.Unavailable(com.flagshipserver.app.core.FreeAiCopy.UNAVAILABLE) }) {
                is FreeAiMint.Ok -> onConfirm(r.credential)
                is FreeAiMint.UsedUp -> {
                    toasts.error(r.message)
                    showForm = true
                }
                is FreeAiMint.Refused -> {
                    toasts.error(r.message)
                    showForm = true
                }
                is FreeAiMint.Unavailable -> {
                    toasts.error(r.message)
                    showForm = true
                }
            }
        } finally {
            minting = false
        }
    }

    // On by default: with no key of their own, a build uses free credits.
    LaunchedEffect(Unit) {
        vm.loadFreeAi(freeAiService)
        freeAiLoaded = true
        if (vm.shouldAutoUseFreeAi()) useFreeAi()
    }

    FSScreen(title = AiKeyStep.TITLE, onBack = onBack) {
        FlagshipInferenceStepRow(
            state = freeAi,
            busy = minting,
            lastUsed = activeId == AiKeyStore.FLAGSHIP_INFERENCE_ID,
            onUse = { scope.launch { useFreeAi() } },
        )

        if (showForm) {
            AiKeyEntryForm(
                confirmLabel = "Add key",
                showSaveToggle = false,
                onCancel = if (keys.isNotEmpty()) ({ showForm = false }) else null,
                onSubmit = { provider, apiKey, label, baseUrl, _, relay ->
                    if (vm.addAndSelect(provider, apiKey, label, baseUrl, relay)) showForm = false
                },
                confirmTag = "build-key-add-save",
            )
        } else {
            FSGroup {
                FSRow(
                    title = AiKeyStep.ADD_LABEL,
                    icon = Icons.Filled.Add,
                    iconTint = FS.colors.accent,
                    titleColor = FS.colors.accentText,
                    onClick = { showForm = true },
                    modifier = Modifier.testTag("build-key-add"),
                )
            }
        }

        if (keys.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                FSSectionHeader("Saved keys")
                AiKeysViewModel.ordered(keys, activeId).forEach { row ->
                    SavedKeyStepRow(
                        row = row,
                        lastUsed = row.id == activeId,
                        onUse = { vm.choose(row.id)?.let(onConfirm) },
                        onDelete = { confirmDelete = row },
                    )
                }
                deleteError?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }

        Row(
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
            modifier = Modifier.padding(horizontal = FS.space.s1),
        ) {
            Icon(
                Icons.Outlined.Lock,
                contentDescription = null,
                tint = FS.colors.accent,
                modifier = Modifier.size(18.dp),
            )
            Text(
                AiKeyStep.SECURITY_NOTE,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
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
                ) { Text("Delete key", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun SavedKeyStepRow(row: SavedKeyRow, lastUsed: Boolean, onUse: () -> Unit, onDelete: () -> Unit) {
    FSCard {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(row.label, style = MaterialTheme.typography.titleMedium, maxLines = 1)
                Text(
                    row.maskedSlug,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                )
                Text(
                    AiRelay.caption(row.relay),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.testTag("build-key-relay-caption"),
                )
                if (lastUsed) {
                    Text("Last used", color = FS.colors.accentText, style = MaterialTheme.typography.bodySmall)
                }
            }
            IconButton(onClick = onDelete, modifier = Modifier.testTag("build-key-delete")) {
                Icon(Icons.Outlined.Delete, contentDescription = "Delete ${row.label}", tint = MaterialTheme.colorScheme.error)
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
 * field + optional label + a "Save on this device" toggle + the relay toggle
 * (on by default). `onSubmit` carries (provider, apiKey, label, baseUrl?,
 * save, relay).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AiKeyEntryForm(
    confirmLabel: String,
    showSaveToggle: Boolean = true,
    onCancel: (() -> Unit)? = null,
    confirmTag: String = "build-key-use",
    onSubmit: (provider: String, apiKey: String, label: String, baseUrl: String?, save: Boolean, relay: Boolean) -> Unit,
) {
    var provider by remember { mutableStateOf(AiKeyStore.SUPPORTED_PROVIDERS.first()) }
    var apiKey by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var baseUrl by remember { mutableStateOf("") }
    var save by remember { mutableStateOf(true) }
    var relay by remember { mutableStateOf(true) }

    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                Text(
                    "Provider",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelLarge,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    AiKeyStore.SUPPORTED_PROVIDERS.forEach { p ->
                        FSChip(
                            label = p,
                            selected = p == provider,
                            onClick = { provider = p },
                            // Stable per-provider tag so a UI test can pick e.g.
                            // "openai" (`ai-key-provider-openai`).
                            modifier = Modifier.testTag("ai-key-provider-$p"),
                        )
                    }
                }
            }

            FSField(
                value = apiKey,
                onValueChange = { apiKey = it },
                label = "API key",
                placeholder = "sk-…",
                // Tag the editable field itself (not the Column wrapper) so a UI
                // test's performTextInput finds a focusable node.
                fieldTag = "ai-key-field",
            )
            FSField(
                value = label,
                onValueChange = { label = it },
                label = "Label (optional)",
                placeholder = "Personal",
            )
            FSField(
                value = baseUrl,
                onValueChange = { baseUrl = it },
                label = "Custom base URL (optional)",
                placeholder = "https://…",
            )

            if (showSaveToggle) {
                ToggleRow(
                    title = "Save on this device",
                    note = "Recall it next time without re-typing. Stored encrypted on this device only.",
                    checked = save,
                    onCheckedChange = { save = it },
                )
            }

            RelayToggleRow(checked = relay, onCheckedChange = { relay = it }, tag = "ai-key-relay")

            FSPrimaryButton(
                label = confirmLabel,
                onClick = { onSubmit(provider, apiKey, label, baseUrl, save, relay) },
                enabled = apiKey.isNotBlank(),
                block = true,
                modifier = Modifier.testTag(confirmTag),
            )
            if (onCancel != null) {
                FSSecondaryButton(label = "Cancel", onClick = onCancel, block = true)
            }
        }
    }
}

@Composable
private fun ToggleRow(
    title: String,
    note: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    switchModifier: Modifier = Modifier,
) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(
                note,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Switch(checked = checked, onCheckedChange = onCheckedChange, modifier = switchModifier)
    }
}

@Composable
private fun RelayToggleRow(checked: Boolean, onCheckedChange: (Boolean) -> Unit, tag: String) {
    ToggleRow(
        title = AiRelay.TOGGLE_LABEL,
        note = AiRelay.TOGGLE_NOTE,
        checked = checked,
        onCheckedChange = onCheckedChange,
        switchModifier = Modifier.testTag(tag),
    )
}

/**
 * Under a failed AI call: when the box says the Flagship relay couldn't carry
 * it, offer to turn the relay off for the key that was used. The message
 * itself is shown by the caller, as the box wrote it.
 */
@Composable
fun RelayFailureAction(message: String?) {
    var keyId by remember(message) { mutableStateOf(AiRelay.keyToTurnOff(message)) }
    var turnedOff by remember(message) { mutableStateOf(false) }
    if (turnedOff) {
        Text(
            AiRelay.TURNED_OFF,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(top = FS.space.s2),
        )
        return
    }
    val id = keyId ?: return
    FSSecondaryButton(
        AiRelay.TURN_OFF_ACTION,
        onClick = {
            AiKeyStore.setRelay(id, false)
            keyId = null
            turnedOff = true
        },
        block = true,
        modifier = Modifier.padding(top = FS.space.s2).testTag("ai-relay-turn-off"),
    )
}

/**
 * Settings → AI keys. View saved keys as masked slugs, add, and delete. No
 * full key is ever shown. Reuses the same entry form as the build step.
 */
@Composable
fun AiKeysManagerScreen(
    nav: NavController,
    vm: AiKeysViewModel = viewModel(),
    freeAiService: FreeAiService = rememberFreeAiService(),
) {
    val keys by vm.keys.collectAsState()
    val activeId by vm.activeId.collectAsState()
    val freeAi by vm.freeAi.collectAsState()
    var showForm by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { vm.loadFreeAi(freeAiService) }

    FSScreen(
        title = "AI keys",
        titleTag = "ai-keys-title",
        onBack = { nav.popBackStack() },
        subtitle = REASSURANCE,
    ) {
        FlagshipInferenceSettingsRow(
            state = freeAi,
            isDefault = activeId == AiKeyStore.FLAGSHIP_INFERENCE_ID,
            onMakeDefault = { vm.setActive(AiKeyStore.FLAGSHIP_INFERENCE_ID) },
            onAddOwnKey = { showForm = true },
            defaultModel = { DefaultModelRow(AiKeyStore.FLAGSHIP_INFERENCE_ID, null) },
        )

        if (keys.isEmpty()) {
            FSNote("No keys saved yet.")
        } else {
            keys.forEach { row ->
                val isActive = row.id == activeId
                FSCard {
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(row.maskedSlug, style = MaterialTheme.typography.titleMedium, maxLines = 1)
                                Text(
                                    AiRelay.caption(row.relay),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    style = MaterialTheme.typography.bodySmall,
                                )
                                if (isActive) {
                                    Text(
                                        "Default for new builds",
                                        color = FS.colors.accentText,
                                        style = MaterialTheme.typography.bodySmall,
                                    )
                                }
                            }
                            FSDangerButton(label = "Delete", onClick = { vm.delete(row.id) })
                        }
                        RelayToggleRow(
                            checked = row.relay,
                            onCheckedChange = { vm.setRelay(row.id, it) },
                            tag = "ai-key-relay-${row.id}",
                        )
                        DefaultModelRow(row.id, remember(row.id) { vm.credentialFor(row.id) })
                        // "Make default" on every non-active row — mirrors iOS's
                        // AiKeysScreen + the webapp providers manager.
                        if (!isActive) {
                            FSSecondaryButton(
                                label = "Make default",
                                onClick = { vm.setActive(row.id) },
                            )
                        }
                    }
                }
            }
        }

        if (showForm) {
            AiKeyEntryForm(
                confirmLabel = "Save key",
                // Settings always saves the key on this device, so no toggle.
                showSaveToggle = false,
                onCancel = { showForm = false },
                onSubmit = { provider, apiKey, label, baseUrl, _, relay ->
                    if (vm.add(provider, apiKey, label, baseUrl, relay)) showForm = false
                },
            )
        } else {
            FSPrimaryButton(
                label = "Add an AI key",
                onClick = { showForm = true },
                block = true,
                modifier = Modifier.testTag("ai-key-add"),
            )
        }
    }
}

/**
 * "Default model" for one AI entry: the model (and effort) a chat on it
 * starts with. Saved on this phone; an own key's list comes from the box.
 */
@Composable
fun DefaultModelRow(keyId: String, credential: AiCredential?) {
    val screens = com.flagshipserver.app.core.LocalScreensClient.current
    var menu by remember(keyId) { mutableStateOf<com.flagshipserver.app.core.ModelMenu?>(null) }
    var choice by remember(keyId) { mutableStateOf(runCatching { AiKeyStore.defaultModel(keyId) }.getOrNull()) }
    LaunchedEffect(keyId) {
        val m = com.flagshipserver.app.core.ModelCatalogs.menuFor(credential, screens)
        choice = com.flagshipserver.app.core.ModelMenus.initial(m, choice)
        menu = m
    }
    fun save(c: com.flagshipserver.app.core.ModelChoice?) {
        choice = c
        AiKeyStore.setDefaultModel(keyId, c)
    }
    Column(Modifier.testTag("default-model-$keyId"), verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
        Text("Default model", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelLarge)
        val m = menu
        if (m == null) {
            Text(com.flagshipserver.app.core.FreeAiCopy.CHECKING, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        } else {
            ChatModelBar(m, choice, onChoice = ::save)
        }
    }
}
