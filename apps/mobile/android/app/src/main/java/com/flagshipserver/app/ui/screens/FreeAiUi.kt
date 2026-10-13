// Free AI credits UI: the Settings card and the key step's first row. Mirrors
// the webapp settings.js / build-key.js and iOS FreeAiCreditsCard.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.FreeAiCopy
import com.flagshipserver.app.core.FreeAiService
import com.flagshipserver.app.core.FreeAiState
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalPodScope
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS

/** The free-AI service for the signed-in account. */
@Composable
fun rememberFreeAiService(): FreeAiService {
    val appState = LocalAppState.current
    return remember(appState) { freeAiServiceFor(appState) }
}

fun freeAiServiceFor(appState: AppState): FreeAiService =
    FreeAiService(username = { appState.currentUser.value })

/** The box a build on this screen runs on: the chosen server, else the session's. */
@Composable
fun currentBuildServerFqdn(): String {
    val appState = LocalAppState.current
    return LocalPodScope.current?.pod?.fqdn
        ?: (appState.sessionPod ?: appState.leaderPod)?.fqdn
        ?: ""
}

/** Settings → AI keys: this week's top-up and the starter reserve, or why
 *  free AI can't be used now. Nothing on a failed read or once it has ended. */
@Composable
fun FreeAiCreditsCard(state: FreeAiState, onAddOwnKey: () -> Unit) {
    val view = FreeAiCopy.view(state) ?: return
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.testTag("free-ai-card")) {
        Column {
            Text(
                FreeAiCopy.TITLE,
                color = FS.colors.text,
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
            )
            Spacer(Modifier.height(FS.space.s2))
            Text(
                view.text,
                color = FS.colors.text,
                style = TextStyle(
                    fontSize = 14.sp,
                    lineHeight = 20.sp,
                    fontWeight = if (view.usable) FontWeight.Medium else FontWeight.Normal,
                ),
                modifier = Modifier.testTag(if (view.usable) "free-ai-left" else "free-ai-blocked"),
            )
            if (view.usable) {
                Spacer(Modifier.height(FS.space.s1))
                Text(
                    FreeAiCopy.NOTE,
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                )
            }
            if (view.offerOwnKey) {
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

/** The key step's first row: use free AI credits for this build, or why not. */
@Composable
fun FreeAiKeyStepRow(state: FreeAiState, busy: Boolean, onUse: () -> Unit) {
    val view = FreeAiCopy.view(state) ?: return
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.testTag("build-key-free-ai")) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Column(Modifier.weight(1f)) {
                Text(
                    FreeAiCopy.TITLE,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                )
                Text(
                    if (view.usable && state is FreeAiState.Available) FreeAiCopy.rowSubtitle(state.credits) else view.text,
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                )
            }
            if (view.usable) {
                FSPrimaryButton(
                    label = if (busy) "…" else "Use this",
                    onClick = { if (!busy) onUse() },
                    modifier = Modifier.testTag("build-key-use-free-ai"),
                )
            }
        }
    }
}
