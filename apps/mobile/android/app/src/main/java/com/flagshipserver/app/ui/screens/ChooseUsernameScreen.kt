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
import com.flagshipserver.app.api.DemoServerBlock
import com.flagshipserver.app.api.DeviceCapabilityBlock
import com.flagshipserver.app.api.DeviceScope
import com.flagshipserver.app.api.TestAccountMeta
import com.flagshipserver.app.core.DemoFixtures
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.delay

// Mirrors the Worker's USERNAME_RE (packages/control-plane/src/labels.ts):
// lowercase alphanumerics only, no hyphens, 1–63 chars. Hyphen-free
// usernames keep the composite app id `<creator>-<slug>` unambiguous.
private val usernameRegex = Regex("^[a-z0-9]{1,63}$")

/**
 * D.2.2 — ChooseUsernameScreen.
 *
 * Live availability check (debounced 350ms) against the Worker's
 * /api/users/check. The response carries an optional `testAccount`
 * block; when present the typed username unlocks a sandboxed demo
 * flow without hitting the real claim path. The list of test-account
 * usernames LIVES OFF THE OPEN SOURCE (Worker env secret); mobile
 * never bakes them in.
 */
@Composable
fun ChooseUsernameScreen(nav: NavController) {
    val app = LocalAppState.current
    val toasts = LocalToastCenter.current
    val flagshipServer = LocalFlagshipServerClient.current
    var username by remember { mutableStateOf("") }
    var status by remember { mutableStateOf<UsernameCheck>(UsernameCheck.Empty) }
    var testHit by remember { mutableStateOf<TestAccountMeta?>(null) }
    var demoServerHit by remember { mutableStateOf<DemoServerBlock?>(null) }
    var capabilityHit by remember { mutableStateOf<DeviceCapabilityBlock?>(null) }

    LaunchedEffect(username) {
        testHit = null
        demoServerHit = null
        capabilityHit = null
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
            status = if (usernameRegex.matches(username)) UsernameCheck.Available else UsernameCheck.Invalid
            return@LaunchedEffect
        }
        // v2 device-addressing — `<u>.<label>` with a matching grant
        // takes priority over every other branch. The Worker returns
        // `deviceCapability` + `demoServer` together; both are needed
        // to activate (the demoServer is the underlying pod the
        // device observes).
        if (resp.deviceCapability != null && resp.demoServer != null) {
            capabilityHit = resp.deviceCapability
            demoServerHit = resp.demoServer
            status = UsernameCheck.DeviceCapability
            return@LaunchedEffect
        }
        if (resp.testAccount != null) {
            testHit = resp.testAccount
            // Plan A — capture the optional `demoServer` block so the
            // CTA can hand it to DemoFixtures.activate. When present,
            // the demo renders ONE live device; when null, the legacy
            // 3-fixture path runs.
            demoServerHit = resp.demoServer
            status = UsernameCheck.TestAccount
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
                UsernameCheck.DeviceCapability -> capabilityHit?.let { cap ->
                    // v2 — show the device label + a short scope
                    // summary so a reviewer knows what the "Enter as
                    // <label>" CTA will unlock. `browse-only` is the
                    // canonical reviewer state; anything else
                    // summarises as "N scopes".
                    val summary = if (cap.scopeSet == setOf(DeviceScope.BROWSE)) {
                        "browse-only"
                    } else {
                        "${cap.scopes.size} scopes"
                    }
                    "Device ${cap.label} — $summary."
                }
                UsernameCheck.TestAccount -> testHit?.let { meta ->
                    val demo = demoServerHit
                    if (demo != null) {
                        when (demo.lifecycle) {
                            DemoServerBlock.Lifecycle.Up ->
                                "Live demo (${meta.display}) — server is up. Idle reset every ${demo.ttlIdleMinutes} min."
                            DemoServerBlock.Lifecycle.Provisioning ->
                                "Live demo (${meta.display}) — server is starting. Idle reset every ${demo.ttlIdleMinutes} min."
                            DemoServerBlock.Lifecycle.None ->
                                "Live demo (${meta.display}) — connect spins up a real server. Idle reset every ${demo.ttlIdleMinutes} min."
                        }
                    } else {
                        "Sandboxed test mode (${meta.display}). State resets every ${meta.ttlHours} h."
                    }
                }
            },
            error = when (status) {
                UsernameCheck.Invalid -> "Letters and digits only. No spaces or punctuation."
                UsernameCheck.Taken -> "Already taken."
                else -> null
            },
        )

        Spacer(Modifier.height(FS.space.s8))

        val isTest = status == UsernameCheck.TestAccount
        val isCap = status == UsernameCheck.DeviceCapability
        FSPrimaryButton(
            label = when {
                isCap -> "Enter as ${capabilityHit?.label ?: "device"}"
                isTest -> "Enter ${testHit?.display ?: "test mode"}"
                else -> "Continue"
            },
            onClick = {
                when {
                    isCap -> {
                        // v2 device-addressing — materialise the
                        // underlying demo VPS PLUS the device's
                        // capability so the home screen renders the
                        // chip + greys out actions absent from scopes.
                        DemoFixtures.activate(
                            app,
                            username,
                            demoServer = demoServerHit,
                            deviceCapability = capabilityHit,
                        )
                        toasts.info("Device-restricted demo. Sign out to leave.")
                    }
                    isTest -> {
                        // Plan A — pass the optional demoServer block
                        // so DemoFixtures renders ONE live device when
                        // the Worker reported one; otherwise the
                        // legacy 3-fixture sandbox.
                        DemoFixtures.activate(app, username, demoServer = demoServerHit)
                        if (demoServerHit != null) {
                            toasts.info("Live demo mode. Sign out to leave.")
                        } else {
                            toasts.info("Sandboxed test mode. Sign out to leave.")
                        }
                    }
                    else -> nav.navigate("biometric")
                }
            },
            block = true,
            large = true,
            enabled = status == UsernameCheck.Available || isTest || isCap,
        )
    }
}

private enum class UsernameCheck { Empty, Invalid, Checking, Available, Taken, TestAccount, DeviceCapability }
