package com.flagshipserver.app.ui.screens

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
 * Continue (the next step claims the shown name). No typed field — a custom name
 * is the future paid name-change. See docs/username-suggestion-queue.md.
 */
@Composable
fun SuggestUsernameScreen(onContinue: (String) -> Unit) {
    val flagshipServer = LocalFlagshipServerClient.current
    val scope = rememberCoroutineScope()
    val vm = remember {
        SuggestUsernameViewModel(suggest = { key -> flagshipServer.suggestUsername(key) })
    }
    val current by vm.current.collectAsState()
    val cooldown by vm.cooldownRemaining.collectAsState()
    val error by vm.error.collectAsState()

    LaunchedEffect(Unit) { vm.load() }
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
            text = "Your handle",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp),
        )
        Text(
            text = "Here's a free, random username. You can change it later.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        )

        Text(
            text = current ?: " ",
            color = FS.colors.text,
            style = TextStyle(fontSize = 34.sp, lineHeight = 42.sp, textAlign = TextAlign.Center),
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = FS.space.s4),
        )

        FSSecondaryButton(
            label = if (cooldown > 0) "Try again in ${cooldown}s" else "↻ Try another",
            onClick = { scope.launch { vm.regenerate() } },
            block = true,
            enabled = vm.canRegenerate(),
        )

        error?.let {
            Text(text = it, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp))
        }

        Spacer(Modifier.height(FS.space.s8))

        FSPrimaryButton(
            label = "Continue",
            onClick = { current?.let(onContinue) },
            block = true,
            large = true,
            enabled = vm.canContinue(),
        )
    }
}
