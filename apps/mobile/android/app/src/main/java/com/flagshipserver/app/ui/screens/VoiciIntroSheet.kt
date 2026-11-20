// The one-time voi.ci intro after a new account is created (core/voici/VoiciIntro.kt; same sheet as iOS
// VoiciIntroSheet and the webapp's). "Turn on" opens the Social tab's Profile and starts the Public switch's steps
// (rules, the public warning, the first publish); "No thanks" closes.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import com.flagshipserver.app.R
import com.flagshipserver.app.core.voici.VoiciIntro
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.theme.FS

/**
 * [loadPromo] reads `.com`'s promo once; the sheet shows at once and the callout joins when (if) it arrives.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoiciIntroSheet(
    username: String,
    loadPromo: suspend () -> VoiciIntro.Promo?,
    onTurnOn: () -> Unit,
    onNo: () -> Unit,
) {
    var promo by remember { mutableStateOf<VoiciIntro.Promo?>(null) }
    LaunchedEffect(username) { promo = loadPromo() }
    com.flagshipserver.app.ui.components.ModalBottomSheet(
        onDismissRequest = onNo,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.testTag("voici-intro"),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = FS.space.s6).navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(FS.space.s3),
        ) {
            Text(
                stringResource(R.string.voici_intro_on_title),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.semantics { heading() },
            )
            Text(stringResource(R.string.voici_intro_on_body, username), style = MaterialTheme.typography.bodyLarge, color = FS.colors.textMuted)
            promo?.let {
                Text(
                    it.text,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(12))
                        .padding(FS.space.s3)
                        .testTag("voici-intro-promo"),
                )
            }
            FSPrimaryButton(stringResource(R.string.turn_on), onTurnOn, block = true, modifier = Modifier.testTag("voici-intro-turn-on"))
            FSGhostButton(stringResource(R.string.voici_intro_no), onNo, block = true, modifier = Modifier.testTag("voici-intro-no"))
            Spacer(Modifier.size(FS.space.s4))
        }
    }
}
