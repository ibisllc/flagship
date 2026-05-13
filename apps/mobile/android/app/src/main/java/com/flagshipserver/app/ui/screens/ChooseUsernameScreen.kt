package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.delay

private val usernameRegex = Regex("^[a-z0-9]{1,32}$")

/**
 * D.2.2 — ChooseUsernameScreen.
 *
 * Live availability check (debounced 350ms). Username is permanent;
 * surfaced clearly in the helper text.
 */
@Composable
fun ChooseUsernameScreen(nav: NavController) {
    var username by remember { mutableStateOf("") }
    var status by remember { mutableStateOf<UsernameCheck>(UsernameCheck.Empty) }

    LaunchedEffect(username) {
        if (username.isEmpty()) {
            status = UsernameCheck.Empty
            return@LaunchedEffect
        }
        if (!usernameRegex.matches(username)) {
            status = UsernameCheck.Invalid
            return@LaunchedEffect
        }
        status = UsernameCheck.Checking
        delay(350)
        // TODO: GET /api/users/check?u=<name>; for now optimistically Available.
        status = UsernameCheck.Available
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6, vertical = FS.space.s12),
        verticalArrangement = Arrangement.spacedBy(FS.space.s6),
    ) {
        Text(
            text = "Pick a username.",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            text = "This is permanent. It becomes the middle of your server's domain (e.g. home.<username>.flagship.services).",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        )

        FSField(
            value = username,
            onValueChange = { username = it.lowercase() },
            label = "Username",
            placeholder = "harry",
            helper = when (status) {
                UsernameCheck.Empty -> "Letters and digits only. 1–32 characters."
                UsernameCheck.Invalid -> null
                UsernameCheck.Checking -> "Checking…"
                UsernameCheck.Available -> "Available."
                UsernameCheck.Taken -> null
            },
            error = when (status) {
                UsernameCheck.Invalid -> "Letters and digits only. No spaces or punctuation."
                UsernameCheck.Taken -> "Already taken."
                else -> null
            },
        )

        Spacer(Modifier.height(FS.space.s8))

        FSPrimaryButton(
            label = "Continue",
            onClick = { nav.navigate("biometric") },
            block = true,
            large = true,
            enabled = status == UsernameCheck.Available,
        )
    }
}

private enum class UsernameCheck { Empty, Invalid, Checking, Available, Taken }
