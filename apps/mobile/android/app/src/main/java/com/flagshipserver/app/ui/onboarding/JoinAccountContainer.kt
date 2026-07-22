// Username-first "I already have an account" (Join) entry.
//
// The login/join space is access-control EVALUATION, not a fetch. The
// FIRST screen is a bare-username input (handle only — letters/digits,
// no dots). On submit we call `resolveAccount` (GET
// /api/account/resolve/<u>, 200 ALWAYS) and branch on `kind`:
//
//   demo            → attach a fresh device + activate the sandbox via
//                     DemoFixtures.activate(demoServer). No passkey, no
//                     error — the username IS the capability.
//   unknown         → render a clean "No Flagship account by that name"
//                     STATE (not an error / 404).
//   single | multi  → Phase 1 hands off to the existing
//                     RecoverFromWelcomeContainer (the WebAuthn-PRF
//                     flow). Phase 3 replaces that with the real
//                     single/multi state machine.
//
// The win over the old entry: it starts with username → resolve, not
// the local-BlockStore "No recovery passkey on this device" throw.
//
// Mirror of the iOS LoginViewModel demo branch (Phase 1).
// See docs/login-and-account-redesign.md.

package com.flagshipserver.app.ui.onboarding

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.AccountResolution
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.DemoFixtures
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalSessionStore
import com.flagshipserver.app.core.DemoSessionPairer
import com.flagshipserver.app.api.DemoSessionRecord
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

/** Branch the resolved account opens. `Recover` covers the
 *  single/multi hand-off; Phase 3 will split it into the real
 *  state machine. */
sealed interface JoinOutcome {
    /** Demo account — the device was attached + sandbox activated;
     *  the host should finish onboarding straight away. */
    data object DemoOpened : JoinOutcome
    /** A real (single/multi) account — hand off to the WebAuthn-PRF
     *  recovery flow. */
    data class Recover(val resolution: AccountResolution) : JoinOutcome
}

@Composable
fun JoinAccountContainer(
    onRecover: (AccountResolution) -> Unit,
    onDemoOpened: () -> Unit,
    onBack: () -> Unit,
) {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val sessionStore = LocalSessionStore.current
    val scope = rememberCoroutineScope()

    var username by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    // Set when resolve returned kind="unknown": render the clean
    // "no account" STATE rather than an error card.
    var unknownName by remember { mutableStateOf<String?>(null) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    fun submit() {
        val handle = username.trim().lowercase()
        if (handle.isEmpty() || working) return
        scope.launch {
            working = true
            unknownName = null
            errorMessage = null
            try {
                val resolution = server.resolveAccount(handle)
                when (resolution.accountKind) {
                    AccountResolution.AccountKind.Demo -> {
                        // Demo crypto is a no-op — the username is the
                        // capability. Attach a fresh device + activate
                        // the sandbox with the server-supplied
                        // demoServer block. No passkey, no error.
                        resolution.demoServer?.let { demo ->
                            if (demo.lifecycle == com.flagshipserver.app.api.DemoServerBlock.Lifecycle.Up) {
                                try {
                                    DemoSessionPairer.ensurePaired(
                                        username = resolution.username,
                                        server = demo,
                                        client = server,
                                        store = sessionStore,
                                    )
                                } catch (_: Throwable) {
                                    throw IllegalStateException(
                                        "The demo server is online, but this device couldn't create a paired session. Try again.",
                                    )
                                }
                            } else {
                                sessionStore.setDemoSession(DemoSessionRecord(resolution.username, demo))
                            }
                        }
                        DemoFixtures.activate(
                            app,
                            resolution.username,
                            demoServer = resolution.demoServer,
                        )
                        onDemoOpened()
                    }
                    AccountResolution.AccountKind.Unknown ->
                        unknownName = resolution.username
                    AccountResolution.AccountKind.Single,
                    AccountResolution.AccountKind.Multi ->
                        onRecover(resolution)
                }
            } catch (t: Throwable) {
                errorMessage = t.message ?: "Couldn't reach Flagship. Try again."
            } finally {
                working = false
            }
        }
    }

    when {
        working -> ResolvingView()
        unknownName != null -> NoAccountView(
            name = unknownName!!,
            onTryAnother = { unknownName = null },
            onBack = onBack,
        )
        else -> UsernameEntryView(
            username = username,
            onUsernameChange = { username = it.lowercase() },
            error = errorMessage,
            onSubmit = ::submit,
            onBack = onBack,
        )
    }
}

@Composable
private fun UsernameEntryView(
    username: String,
    onUsernameChange: (String) -> Unit,
    error: String?,
    onSubmit: () -> Unit,
    onBack: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6, vertical = FS.space.s12)
            .semantics { contentDescription = "join-username" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s6),
    ) {
        Text(
            text = "What's your username?",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            text = "Enter the account handle you already have. We'll bring this device into that account.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        )
        FSField(
            value = username,
            onValueChange = onUsernameChange,
            label = "Username",
            placeholder = "harry",
            helper = "Letters and digits only. No dots.",
            error = error,
        )
        Spacer(Modifier.height(FS.space.s4))
        FSPrimaryButton(
            label = "Continue",
            onClick = onSubmit,
            block = true,
            large = true,
            enabled = username.isNotBlank(),
        )
        FSGhostButton(label = "Back", onClick = onBack, block = true)
    }
}

@Composable
private fun ResolvingView() {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(FS.space.s6)
            .semantics { contentDescription = "join-resolving" },
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator()
        Spacer(Modifier.height(FS.space.s4))
        Text(
            "Looking up your account…",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp),
        )
    }
}

@Composable
private fun NoAccountView(name: String, onTryAnother: () -> Unit, onBack: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6, vertical = FS.space.s12)
            .semantics { contentDescription = "join-no-account" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            "No Flagship account by that name",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "We couldn't find an account called “$name”. Check the spelling, or create a new account from the welcome screen.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        )
        Box(Modifier.height(FS.space.s4))
        FSPrimaryButton(label = "Try another name", onClick = onTryAnother, block = true, large = true)
        FSGhostButton(label = "Back", onClick = onBack, block = true)
    }
}
