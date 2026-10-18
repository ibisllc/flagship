// "Connect to an existing account" — one page, both ways back in. Mirror of
// iOS FlagshipUI/Screens/ConnectAccountScreen.swift.
//
//   Sign in with your account name: the username-first Join. On submit we
//   call `resolveAccount` (GET /api/account/resolve/<u>, 200 ALWAYS) and
//   branch on `kind`:
//     demo            → attach a fresh device + activate the sandbox via
//                       DemoAccount.activate(demoServer). The username IS
//                       the capability.
//     unknown         → an inline "No Flagship account by that name" state.
//     single | multi  → the single/multi recovery state machine.
//
//   Join with a pairing code: Scan a code (the in-app scanner) or paste the
//   code or link the other device shows; either opens the incoming join.
//
// A pairing link pasted into the name field goes to join, with a note.
// See docs/login-and-account-redesign.md.

package com.flagshipserver.app.ui.onboarding

import com.flagshipserver.app.core.UserErrorText
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.background
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.AccountResolution
import com.flagshipserver.app.api.DemoSessionRecord
import com.flagshipserver.app.core.ConnectInput
import com.flagshipserver.app.core.DemoAccount
import com.flagshipserver.app.core.DemoSessionPairer
import com.flagshipserver.app.core.JoinLink
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalSessionStore
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout
import kotlinx.coroutines.launch

/**
 * @param onRecover   a real (single/multi) account resolved: run the login state machine.
 * @param onDemoOpened the demo sandbox is open: finish onboarding.
 * @param onJoin      open the incoming join: a parsed link, or null for the scanner.
 */
@Composable
fun ConnectAccountScreen(
    onRecover: (AccountResolution) -> Unit,
    onDemoOpened: () -> Unit,
    onJoin: (JoinLink?) -> Unit,
    onBack: () -> Unit,
) {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val sessionStore = LocalSessionStore.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()

    var username by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    var unknownName by remember { mutableStateOf<String?>(null) }
    var nameError by remember { mutableStateOf<String?>(null) }
    var codeError by remember { mutableStateOf<String?>(null) }

    fun resolve(handle: String) {
        if (working) return
        scope.launch {
            working = true
            unknownName = null
            nameError = null
            try {
                val resolution = server.resolveAccount(handle)
                when (resolution.accountKind) {
                    AccountResolution.AccountKind.Demo -> {
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
                        DemoAccount.activate(app, resolution.username, demoServer = resolution.demoServer)
                        onDemoOpened()
                    }
                    AccountResolution.AccountKind.Unknown -> unknownName = resolution.username
                    AccountResolution.AccountKind.Single,
                    AccountResolution.AccountKind.Multi -> onRecover(resolution)
                }
            } catch (t: Throwable) {
                nameError = UserErrorText.of(t, "Couldn't reach Flagship. Try again.")
            } finally {
                working = false
            }
        }
    }

    ConnectAccountContent(
        username = username,
        onUsernameChange = {
            username = it
            nameError = null
            unknownName = null
        },
        code = code,
        onCodeChange = {
            code = it
            codeError = null
        },
        working = working,
        unknownName = unknownName,
        nameError = nameError,
        codeError = codeError,
        onSubmitName = {
            when (val r = ConnectInput.readNameField(username)) {
                ConnectInput.NameField.None -> Unit
                is ConnectInput.NameField.Error -> nameError = r.message
                is ConnectInput.NameField.Join -> {
                    nameError = null
                    toasts.info(r.note)
                    onJoin(r.link)
                }
                is ConnectInput.NameField.SignIn -> {
                    username = r.name
                    resolve(r.name)
                }
            }
        },
        onScan = { onJoin(null) },
        onSubmitCode = {
            when (val r = ConnectInput.readPairingField(code)) {
                ConnectInput.PairingField.None -> codeError = ConnectInput.EMPTY_CODE
                is ConnectInput.PairingField.Error -> codeError = r.message
                is ConnectInput.PairingField.Join -> {
                    codeError = null
                    onJoin(r.link)
                }
            }
        },
        onBack = onBack,
    )
}

/** The page itself, stateless so a compose test can drive it. */
@Composable
fun ConnectAccountContent(
    username: String,
    onUsernameChange: (String) -> Unit,
    code: String,
    onCodeChange: (String) -> Unit,
    working: Boolean,
    unknownName: String?,
    nameError: String?,
    codeError: String?,
    onSubmitName: () -> Unit,
    onScan: () -> Unit,
    onSubmitCode: () -> Unit,
    onBack: () -> Unit,
) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(
            modifier = Modifier
                .widthIn(max = FSLayout.readingMaxWidth)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = FS.space.s6, vertical = FS.space.s8)
                .testTag("connect-account"),
            verticalArrangement = Arrangement.spacedBy(FS.space.s6),
        ) {
            Text(
                text = "Connect to an existing account",
                color = FS.colors.text,
                style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Medium),
                modifier = Modifier.semantics { heading() },
            )

            // ── Sign in with your account name ──
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                SectionTitle("Sign in with your account name")
                FSField(
                    value = username,
                    onValueChange = onUsernameChange,
                    label = "Account name",
                    placeholder = "account-name",
                    helper = "The name you picked when you made the account.",
                    error = nameError,
                    fieldTag = "connect-name-field",
                )
                if (unknownName != null) NoAccountCard(unknownName)
                FSPrimaryButton(
                    label = if (working) "Checking…" else "Continue",
                    onClick = onSubmitName,
                    block = true,
                    large = true,
                    enabled = username.isNotBlank() && !working,
                    modifier = Modifier
                        .testTag("connect-name-continue")
                        .semantics { contentDescription = "Continue, signs in with this account name" },
                )
            }

            OrDivider()

            // ── Join with a pairing code ──
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                SectionTitle("Join with a pairing code")
                Text(
                    "On a device of that account, open Settings → Trusted devices → Add device.",
                    color = FS.colors.textMuted,
                    style = MaterialTheme.typography.bodyMedium,
                )
                FSSecondaryButton(
                    label = "Scan a code",
                    onClick = onScan,
                    block = true,
                    large = true,
                    modifier = Modifier
                        .testTag("connect-scan")
                        .semantics { contentDescription = "Scan a code with the camera" },
                )
                FSField(
                    value = code,
                    onValueChange = onCodeChange,
                    label = "Code or link",
                    placeholder = "https://flagshipserver.com/join?…",
                    error = codeError,
                    fieldTag = "connect-pair-field",
                )
                FSSecondaryButton(
                    label = "Join",
                    onClick = onSubmitCode,
                    block = true,
                    large = true,
                    modifier = Modifier
                        .testTag("connect-pair-continue")
                        .semantics { contentDescription = "Join with this code or link" },
                )
            }

            FSGhostButton(
                label = "Back",
                onClick = onBack,
                block = true,
                modifier = Modifier.testTag("connect-back"),
            )
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text = text,
        color = FS.colors.text,
        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        modifier = Modifier.semantics { heading() },
    )
}

@Composable
private fun OrDivider() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .testTag("connect-or")
            .clearAndSetSemantics { contentDescription = "or" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
    ) {
        Box(Modifier.weight(1f).height(1.dp).background(FS.colors.border))
        Text("or", color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
        Box(Modifier.weight(1f).height(1.dp).background(FS.colors.border))
    }
}

@Composable
private fun NoAccountCard(name: String) {
    FSCard(modifier = Modifier.fillMaxWidth().testTag("join-unknown")) {
        Text(
            "No Flagship account by that name",
            color = FS.colors.text,
            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(4.dp))
        Text(
            "We couldn't find an account called “$name”. Check the spelling, or go back and create a new account.",
            color = FS.colors.textMuted,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}
