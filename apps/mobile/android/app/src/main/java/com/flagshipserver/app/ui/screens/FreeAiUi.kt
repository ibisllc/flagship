// Flagship Inference: the built-in provider entry listed first in Settings →
// AI keys and in the key step. Mirrors the webapp settings.js / build-key.js
// and iOS FlagshipInferenceRow.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.FlagshipInferenceEntry
import com.flagshipserver.app.core.FreeAiCopy
import com.flagshipserver.app.core.FreeAiService
import com.flagshipserver.app.core.FreeAiState
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalDeveloperSettings
import com.flagshipserver.app.core.MockFreeAiClient
import com.flagshipserver.app.core.LocalPodScope
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS

/** The free-AI service for the signed-in account. */
@Composable
fun rememberFreeAiService(): FreeAiService {
    val appState = LocalAppState.current
    val live = LocalDeveloperSettings.current?.useLiveClient?.collectAsState()?.value ?: true
    return remember(appState, live) { freeAiServiceFor(appState, live) }
}

/** The live `.com` client, or the mock one when the app runs on mock clients. */
fun freeAiServiceFor(appState: AppState, live: Boolean = true): FreeAiService =
    if (live) FreeAiService(username = { appState.currentUser.value })
    else FreeAiService(client = MockFreeAiClient(), username = { appState.currentUser.value })

/** The box a build on this screen runs on: the chosen server, else the session's. */
@Composable
fun currentBuildServerFqdn(): String {
    val appState = LocalAppState.current
    return LocalPodScope.current?.pod?.fqdn
        ?: (appState.sessionPod ?: appState.leaderPod)?.fqdn
        ?: ""
}

/** The entry's title, subtitle and muted status line, read out as one
 *  built-in provider that can't be removed. */
@Composable
private fun FlagshipInferenceText(
    entry: FlagshipInferenceEntry,
    default: String?,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier.semantics(mergeDescendants = true) {
            contentDescription = listOfNotNull(
                FreeAiCopy.A11Y_LABEL,
                FreeAiCopy.PROVIDER_SUBTITLE,
                entry.status,
                default,
            ).joinToString(" ")
        },
    ) {
        Text(
            FreeAiCopy.PROVIDER_TITLE,
            color = MaterialTheme.colorScheme.onSurface,
            style = MaterialTheme.typography.titleMedium,
        )
        Text(
            FreeAiCopy.PROVIDER_SUBTITLE,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(FS.space.s1))
        Text(
            entry.status,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.testTag(
                when {
                    entry.loading -> "free-ai-checking"
                    entry.usable -> "free-ai-left"
                    else -> "free-ai-blocked"
                },
            ),
        )
        if (default != null) {
            Text(default, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
        }
    }
}

/**
 * Settings → AI keys: the built-in Flagship Inference entry, always first.
 * It has no Delete; "Make default" when it can be used and isn't the default,
 * "Add your own key" when it can't be used and a key would help.
 */
@Composable
fun FlagshipInferenceSettingsRow(
    state: FreeAiState,
    isDefault: Boolean,
    onMakeDefault: () -> Unit,
    onAddOwnKey: () -> Unit,
    defaultModel: (@Composable () -> Unit)? = null,
) {
    val entry = FreeAiCopy.entry(state)
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.testTag("free-ai-card")) {
        Column {
            FlagshipInferenceText(entry, if (isDefault && entry.usable) "Default for new builds" else null)
            if (defaultModel != null && !entry.loading) {
                Spacer(Modifier.height(FS.space.s3))
                defaultModel()
            }
            if (entry.usable && !isDefault) {
                Spacer(Modifier.height(FS.space.s3))
                FSSecondaryButton(
                    label = "Make default",
                    onClick = onMakeDefault,
                    modifier = Modifier.testTag("free-ai-make-default"),
                )
            }
            if (!entry.usable && entry.offerOwnKey) {
                Spacer(Modifier.height(FS.space.s3))
                FSSecondaryButton(
                    label = FreeAiCopy.ADD_OWN_KEY,
                    onClick = onAddOwnKey,
                    block = true,
                    modifier = Modifier.testTag("free-ai-add-own-key"),
                )
            }
        }
    }
}

/** The key step's first entry: use Flagship Inference for this build, or why not. */
@Composable
fun FlagshipInferenceStepRow(state: FreeAiState, busy: Boolean, lastUsed: Boolean, onUse: () -> Unit) {
    val entry = FreeAiCopy.entry(state)
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.testTag("build-key-free-ai")) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            FlagshipInferenceText(entry, if (lastUsed && entry.usable) "Last used" else null, Modifier.weight(1f))
            if (entry.usable) {
                FSPrimaryButton(
                    label = if (busy) "…" else "Use this",
                    onClick = { if (!busy) onUse() },
                    modifier = Modifier.testTag("build-key-use-free-ai"),
                )
            }
        }
    }
}
