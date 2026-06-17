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
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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

/**
 * Reusable AI-key step. Shown for any build path that uses the BOX's model
 * (scratch always; git only when a non-fit repo needs adapting). Lists saved
 * keys for one-tap recall, pre-selects the active key for a "Confirm" happy
 * path, and offers a "use a different key" form with a "Save on this device"
 * toggle. On confirm yields an in-memory credential to `onConfirm`.
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
            "Which AI builds it?",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s2))
        Text(
            "This build runs on your box's model, so it needs an AI key. $REASSURANCE",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        )
        Spacer(Modifier.height(FS.space.s5))

        // Saved keys — one-tap recall. The active one is the confirm default.
        if (keys.isNotEmpty()) {
            Text(
                "Saved on this device",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
            )
            Spacer(Modifier.height(FS.space.s2))
            keys.forEach { row ->
                SavedKeyRecallRow(
                    slug = row.maskedSlug,
                    isActive = row.id == activeId,
                    onClick = { vm.credentialFor(row.id)?.let(onConfirm) },
                )
                Spacer(Modifier.height(FS.space.s2))
            }

            // "Confirm" — the happy path: hand the box the active key.
            activeId?.let { id ->
                Spacer(Modifier.height(FS.space.s2))
                FSPrimaryButton(
                    label = "Confirm and build",
                    onClick = { vm.credentialFor(id)?.let(onConfirm) },
                    block = true,
                )
            }

            Spacer(Modifier.height(FS.space.s3))
            FSSecondaryButton(
                label = if (showForm) "Hide" else "Use a different key",
                onClick = { showForm = !showForm },
                block = true,
            )
        }

        if (showForm) {
            Spacer(Modifier.height(FS.space.s4))
            AiKeyEntryForm(
                confirmLabel = "Use this key",
                onSubmit = { provider, apiKey, label, baseUrl, save ->
                    vm.useEnteredKey(provider, apiKey, label, baseUrl, save)?.let(onConfirm)
                },
            )
        }

        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun SavedKeyRecallRow(slug: String, isActive: Boolean, onClick: () -> Unit) {
    FSCard(
        modifier = Modifier.clickable(onClick = onClick),
        padding = PaddingValues(FS.space.s4),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                slug,
                color = FS.colors.text,
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
                modifier = Modifier.weight(1f),
            )
            if (isActive) {
                Box(
                    Modifier
                        .clip(RoundedCornerShape(FS.radius.pill))
                        .background(FS.colors.primary.copy(alpha = 0.12f))
                        .padding(horizontal = 10.dp, vertical = 3.dp),
                ) {
                    Text(
                        "Active",
                        color = FS.colors.primary,
                        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium),
                    )
                }
            }
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
                    ProviderPickChip(label = p, selected = p == provider, onClick = { provider = p })
                }
            }

            Spacer(Modifier.height(FS.space.s3))
            FSField(
                value = apiKey,
                onValueChange = { apiKey = it },
                label = "API key",
                placeholder = "sk-…",
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

            Spacer(Modifier.height(FS.space.s4))
            FSPrimaryButton(
                label = confirmLabel,
                onClick = { onSubmit(provider, apiKey, label, baseUrl, save) },
                enabled = apiKey.isNotBlank(),
                block = true,
            )
        }
    }
}

@Composable
private fun ProviderPickChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val bg = if (selected) FS.colors.primary else FS.colors.surfaceSunken
    val fg = if (selected) Color.White else FS.colors.textMuted
    Box(
        Modifier
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
            )
        }

        Spacer(Modifier.height(FS.space.s12))
    }
}
