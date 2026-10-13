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

/** Settings → AI keys: the free-credits balance. Nothing on a failed read. */
@Composable
fun FreeAiCreditsCard(state: FreeAiState, onAddOwnKey: () -> Unit) {
    if (state is FreeAiState.Hidden) return
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.testTag("free-ai-card")) {
        Column {
            Text(
                FreeAiCopy.TITLE,
                color = FS.colors.text,
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
            )
            Spacer(Modifier.height(FS.space.s2))
            when (state) {
                is FreeAiState.Available -> {
                    if (state.usedUp) {
                        Text(
                            FreeAiCopy.USED_UP,
                            color = FS.colors.text,
                            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                            modifier = Modifier.testTag("free-ai-used-up"),
                        )
                        Spacer(Modifier.height(FS.space.s3))
                        FSSecondaryButton(
                            label = FreeAiCopy.ADD_OWN_KEY,
                            onClick = onAddOwnKey,
                            block = true,
                            modifier = Modifier.testTag("free-ai-add-own-key"),
                        )
                    } else {
                        Text(
                            FreeAiCopy.leftLine(state.credits),
                            color = FS.colors.text,
                            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
                            modifier = Modifier.testTag("free-ai-left"),
                        )
                        Spacer(Modifier.height(FS.space.s1))
                        Text(
                            FreeAiCopy.NOTE,
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                        )
                    }
                }
                else -> Text(
                    FreeAiCopy.UNAVAILABLE,
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                )
            }
        }
    }
}

/** The key step's first row: use free AI credits for this build. */
@Composable
fun FreeAiKeyStepRow(state: FreeAiState.Available, busy: Boolean, onUse: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.testTag("build-key-free-ai")) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Column(Modifier.weight(1f)) {
                Text(
                    FreeAiCopy.TITLE,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                )
                Text(
                    if (state.usedUp) FreeAiCopy.USED_UP else FreeAiCopy.rowSubtitle(state.credits),
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                )
            }
            if (!state.usedUp) {
                FSPrimaryButton(
                    label = if (busy) "…" else "Use this",
                    onClick = { if (!busy) onUse() },
                    modifier = Modifier.testTag("build-key-use-free-ai"),
                )
            }
        }
    }
}
