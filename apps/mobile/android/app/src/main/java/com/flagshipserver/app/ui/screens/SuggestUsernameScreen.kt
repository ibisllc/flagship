package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.collectAsState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.SuggestUsernameViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * CREATE path — hands the user one random handle. The ONLY affordances are
 * regenerate (rate-limited, with a live "Try again in Ns" countdown) and
 * Continue (the next step claims the shown name). No typed field: a name of one's
 * own is the paid "Choose your own account name" ([onChooseOwn], with the shown
 * name as the one the account opens under). See docs/username-suggestion-queue.md.
 * A name-grant link waiting ([autoChoose]) goes straight there once a name is shown.
 */
@Composable
fun SuggestUsernameScreen(
    onContinue: (String) -> Unit,
    onChooseOwn: ((String) -> Unit)? = null,
    autoChoose: Boolean = false,
) {
    val flagshipServer = LocalFlagshipServerClient.current
    val scope = rememberCoroutineScope()
    val vm = remember {
        SuggestUsernameViewModel(suggest = { key -> flagshipServer.suggestUsername(key) })
    }
    val current by vm.current.collectAsState()
    val cooldown by vm.cooldownRemaining.collectAsState()
    val error by vm.error.collectAsState()

    LaunchedEffect(Unit) { vm.load() }
    LaunchedEffect(current, autoChoose) {
        val shown = current
        if (autoChoose && shown != null && onChooseOwn != null) onChooseOwn(shown)
    }
    // Drive the 1-Hz countdown while a cooldown is active.
    LaunchedEffect(cooldown) {
        if (cooldown > 0) {
            delay(1000)
            vm.tickCooldown()
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6, vertical = FS.space.s12),
        verticalArrangement = Arrangement.spacedBy(FS.space.s6),
    ) {
        Text(
            text = stringResource(R.string.your_handle),
            color = FS.colors.text,
            style = MaterialTheme.typography.headlineMedium,
        )
        Text(
            text = stringResource(R.string.heres_a_free_random_username_you),
            color = FS.colors.textMuted,
            style = MaterialTheme.typography.bodyLarge,
        )

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = FS.space.s4),
            horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(FS.space.s2),
        ) {
            com.flagshipserver.app.ui.components.FSAccountAddress(name = current ?: " ")
            Text(
                text = stringResource(R.string.account_address_hint),
                color = FS.colors.textMuted,
                style = MaterialTheme.typography.bodyMedium.copy(textAlign = TextAlign.Center),
            )
        }

        // "Try another" sits right under the name it replaces; the paid choice gets the bordered button.
        com.flagshipserver.app.ui.components.FSGhostButton(
            label = if (cooldown > 0) fsString(R.string.try_again_in_s, cooldown) else stringResource(R.string.try_another),
            onClick = { scope.launch { vm.regenerate() } },
            block = true,
            enabled = vm.canRegenerate(),
        )

        if (onChooseOwn != null) {
            FSSecondaryButton(
                label = stringResource(R.string.choose_name_action),
                onClick = { current?.let(onChooseOwn) },
                block = true,
                enabled = vm.canContinue(),
            )
        }

        error?.let {
            Text(text = it, color = FS.colors.danger, style = MaterialTheme.typography.bodySmall)
        }

        Spacer(Modifier.height(FS.space.s8))

        FSPrimaryButton(
            label = stringResource(R.string.continue_label),
            onClick = { current?.let(onContinue) },
            block = true,
            large = true,
            enabled = vm.canContinue(),
        )
    }
}
