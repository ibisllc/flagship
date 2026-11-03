// "This phone can't open your account key": a full-screen overlay (like AccountGoneScreen) shown
// after an unlock finds the sealed account seed unreadable (SeedVault). That happens when Android
// invalidated the Keystore key behind it, i.e. the screen lock was removed or reset. No key exists
// that could open the old record, so the only way back is the account's recovery; nothing is
// deleted until the person chooses "Restore my account", which forgets the unreadable copy and
// signs this phone out to the welcome screen, where "Connect to an existing account" restores it
// (recovery passkey, saved account key file, or a join from another device).

package com.flagshipserver.app.ui.shell

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalSessionStore
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.SeedVault
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS

@Composable
fun AccountKeyLostScreen() {
    val ctx = LocalContext.current
    val app = LocalAppState.current
    val sessions = LocalSessionStore.current
    val title = stringResource(R.string.account_key_lost_title)
    BackHandler(enabled = true) { (ctx as? Activity)?.moveTaskToBack(true) }
    Box(
        Modifier
            .fillMaxSize()
            .background(FS.colors.bg)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .pointerInput(Unit) { detectTapGestures { } }
            .semantics { paneTitle = FSStrings.get(R.string.account_key_lost_title) }
            .testTag("account-key-lost")
            .padding(horizontal = FS.space.s6),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier
                .widthIn(max = 440.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(vertical = FS.space.s6),
            verticalArrangement = Arrangement.spacedBy(FS.space.s3),
        ) {
            Text(
                title,
                color = FS.colors.text,
                style = MaterialTheme.typography.headlineMedium.copy(fontSize = 28.sp, fontWeight = FontWeight.Medium),
                modifier = Modifier.semantics { heading() }.testTag("account-key-lost-title"),
            )
            Text(
                stringResource(R.string.account_key_lost_body),
                color = FS.colors.text,
                style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
                modifier = Modifier.testTag("account-key-lost-body"),
            )
            Text(
                stringResource(R.string.account_key_lost_hint),
                color = FS.colors.text,
                style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
            )
            FSPrimaryButton(
                label = stringResource(R.string.account_key_lost_restore),
                onClick = {
                    // Only the records no key can open go; the account itself is untouched.
                    val activeLost = runCatching { Keystore.forgetUnreadableSeeds() }.getOrDefault(true)
                    if (activeLost) removeGoneAccountFromDevice(ctx, app, sessions)
                },
                block = true,
                large = true,
                modifier = Modifier.testTag("account-key-lost-restore"),
            )
            FSGhostButton(
                label = stringResource(R.string.not_now),
                // Shown again at the next unlock; signing stays unavailable until then.
                onClick = { SeedVault.markLost(false) },
                block = true,
                modifier = Modifier.testTag("account-key-lost-later"),
            )
        }
    }
}
