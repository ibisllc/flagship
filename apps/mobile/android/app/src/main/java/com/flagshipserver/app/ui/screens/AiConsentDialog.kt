// The owner's consent to one AI run that costs money (N12): the box's estimate as it is, then
// Continue (sign and send once) or Cancel (nothing runs). See core/AiConsentFlow.kt.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.R
import com.flagshipserver.app.core.AiConsent
import com.flagshipserver.app.core.AiConsentPrompt
import com.flagshipserver.app.ui.components.AlertDialog
import com.flagshipserver.app.ui.components.TextButton
import com.flagshipserver.app.ui.theme.FS

@Composable
fun AiConsentDialog(prompt: AiConsentPrompt) {
    val ask by prompt.ask.collectAsState()
    val a = ask ?: return
    AlertDialog(
        onDismissRequest = { prompt.answer(false) },
        title = { Text(stringResource(R.string.ai_consent_title), modifier = Modifier.testTag("ai-consent-title")) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                if (a.note.isNotEmpty()) {
                    Text(a.note, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("ai-consent-note"))
                }
                Text(AiConsent.rangeText(a.estimate), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("ai-consent-range"))
                Text(AiConsent.payerText(a.estimate), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("ai-consent-payer"))
                Text(stringResource(R.string.ai_consent_once), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
            }
        },
        confirmButton = {
            TextButton(onClick = { prompt.answer(true) }, modifier = Modifier.testTag("ai-consent-continue")) {
                Text(stringResource(R.string.continue_label))
            }
        },
        dismissButton = {
            TextButton(onClick = { prompt.answer(false) }, modifier = Modifier.testTag("ai-consent-cancel")) {
                Text(stringResource(R.string.cancel))
            }
        },
        modifier = Modifier.testTag("ai-consent"),
    )
}
