package com.flagshipserver.app.ui.screens

import android.content.Intent
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.TrademarkClaim
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.delay

// Mirrors the Worker's USERNAME_RE (packages/control-plane/src/labels.ts):
// 3–30 lowercase chars, interior single dashes OK (no leading/trailing dash),
// and NO `--` (the `<slug>--<creator>` app-id delimiter — keep in sync with
// docs/service-addressing-double-dash.md). The `--` ban is checked separately.
private val usernameRegex = Regex("^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$")
private fun usernameShapeOk(name: String): Boolean =
    usernameRegex.matches(name) && !name.contains("--")

/**
 * D.2.2 — ChooseUsernameScreen.
 *
 * The CREATE path only — reserve a fresh handle for a new account.
 * Identity-first: picking a username opens the *account*, not a server.
 * A server (pod) is a separate, later, repeatable resource added from
 * Home once the account is open (Phase 2 of the login redesign).
 *
 * Demo / test-account / device-capability (dot-form) entry has moved
 * to the username-first Join flow (JoinAccountContainer); typing a
 * bare demo username under "I already have an account" is the only
 * demo entry now. This screen does a live availability check
 * (debounced 350 ms) against the Worker's /api/users/check and only
 * branches on real-account availability.
 *
 * On Continue the chosen handle is threaded forward through the
 * navigation arg (NOT yet written to AppState.currentUser — the claim
 * + completeOnboarding happen in the open-account step that follows).
 */
@Composable
fun ChooseUsernameScreen(onContinue: (String) -> Unit) {
    val flagshipServer = LocalFlagshipServerClient.current
    val context = LocalContext.current
    var username by remember { mutableStateOf("") }
    var status by remember { mutableStateOf<UsernameCheck>(UsernameCheck.Empty) }

    LaunchedEffect(username) {
        if (username.isEmpty()) {
            status = UsernameCheck.Empty
            return@LaunchedEffect
        }
        status = UsernameCheck.Checking
        delay(350)
        // Worker round-trip. If it fails, fall back to a regex check so
        // the screen still moves; the real claim will retry with a
        // proper error once the network recovers.
        val resp = try {
            flagshipServer.usernameAvailable(username)
        } catch (_: Throwable) { null }
        if (resp == null) {
            status = if (usernameShapeOk(username)) UsernameCheck.Available else UsernameCheck.Invalid
            return@LaunchedEffect
        }
        status = when {
            resp.available -> UsernameCheck.Available
            resp.reason == "already claimed" -> UsernameCheck.Taken
            else -> UsernameCheck.Invalid
        }
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
            text = "This is permanent. It's your account handle — your identity on Flagship. You can add servers later, whenever you're ready.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        )

        FSField(
            value = username,
            onValueChange = { username = it.lowercase() },
            label = "Username",
            placeholder = "harry",
            helper = when (status) {
                UsernameCheck.Empty -> "Letters and digits only. 3–30 characters."
                UsernameCheck.Invalid -> null
                UsernameCheck.Checking -> "Checking…"
                UsernameCheck.Available -> "Available."
                UsernameCheck.Taken -> null
            },
            error = when (status) {
                UsernameCheck.Invalid -> "3–30 letters and digits. No spaces, hyphens, or punctuation."
                UsernameCheck.Taken -> "Already taken."
                else -> null
            },
        )

        // Shown only in the Taken state: a subtle "I hold a trademark"
        // affordance that opens a prefilled mailto to the trademarks
        // desk (TrademarkClaim mirrors the canonical webapp message).
        if (status == UsernameCheck.Taken) {
            Text(
                text = "I hold a trademark to this name",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp, textDecoration = TextDecoration.Underline),
                modifier = Modifier.clickable {
                    val intent = Intent(Intent.ACTION_SENDTO, TrademarkClaim.mailtoUri(username))
                    runCatching { context.startActivity(intent) }
                },
            )
        }

        Spacer(Modifier.height(FS.space.s8))

        FSPrimaryButton(
            label = "Continue",
            onClick = { onContinue(username) },
            block = true,
            large = true,
            enabled = status == UsernameCheck.Available,
        )
    }
}

private enum class UsernameCheck { Empty, Invalid, Checking, Available, Taken }
