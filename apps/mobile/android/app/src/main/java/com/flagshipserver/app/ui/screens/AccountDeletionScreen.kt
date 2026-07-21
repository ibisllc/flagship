// Full-page IRREVERSIBLE-deletion warning — step 2 of the last-device deletion
// ceremony (docs/account-deletion-and-name-reclaim.md §2). Mirror of iOS
// AccountDeletionScreen.swift / AccountDeletionViewModel.swift.
//
// Reached ONLY when the action is account DEATH (no cloud recovery AND this is
// the last device, i.e. SignOutPolicy.evaluate(...) == DELETION_CEREMONY), after
// the existing confirm. It is a SCREEN, not a dialog: a stray tap can't delete.
// The affirmative gate is typing the exact username PLUS a biometric (the
// biometric rides Keystore.deriveIRK). The opt-in checkbox controls whether the
// servers-self-delete order is bundled in (default OFF, §5 — never standalone).
// On a 200 the account row is hard-deleted on .com (the name is already free);
// only THEN do we wipe local key material and drop to Welcome.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.AccountSelfDeleteBundleRequest
import com.flagshipserver.app.core.AccountSelfDeleteOrder
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.ServersSelfDeleteOrder
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout
import kotlinx.coroutines.launch

@Composable
fun AccountDeletionScreen(nav: NavController) {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val scope = rememberCoroutineScope()
    val username = app.currentUser.collectAsState().value ?: ""

    var typed by remember { mutableStateOf("") }
    var alsoDeleteContent by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val typedMatches = username.isNotEmpty() &&
        typed.trim().lowercase() == username.lowercase()

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(
            Modifier
                .widthIn(max = FSLayout.readingMaxWidth)
                .fillMaxWidth()
                .padding(horizontal = FS.space.s6),
        ) {
            Spacer(Modifier.height(FS.space.s8))
            Text(
                "Delete account",
                color = FS.colors.danger,
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(FS.space.s4))
            Text(
                "This permanently deletes your account. It can't be undone — there's " +
                    "no recovery passkey and no other device to restore from.",
                color = FS.colors.text,
            )
            Spacer(Modifier.height(FS.space.s5))
            Text("• Your username “$username” is lost and may be claimed by someone else.", color = FS.colors.textMuted)
            Spacer(Modifier.height(FS.space.s2))
            Text("• Your servers stop being reachable and you can no longer manage them. If you want to keep a server, transfer it to another account FIRST.", color = FS.colors.textMuted)
            Spacer(Modifier.height(FS.space.s2))
            Text("• There is no way back: no passkey, no other device, no reset.", color = FS.colors.textMuted)

            Spacer(Modifier.height(FS.space.s6))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(
                    checked = alsoDeleteContent,
                    onCheckedChange = { alsoDeleteContent = it },
                )
                Text(
                    "Also ask all my servers to delete their content",
                    color = FS.colors.text,
                )
            }

            Spacer(Modifier.height(FS.space.s6))
            Text("Type your username to confirm", color = FS.colors.textMuted)
            Spacer(Modifier.height(FS.space.s2))
            OutlinedTextField(
                value = typed,
                onValueChange = { typed = it; error = null },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            error?.let {
                Spacer(Modifier.height(FS.space.s3))
                Text(it, color = FS.colors.danger)
            }

            Spacer(Modifier.height(FS.space.s6))
            FSDangerButton(
                label = if (busy) "Deleting…" else "Delete my account forever",
                enabled = typedMatches && !busy,
                onClick = {
                    busy = true
                    error = null
                    scope.launch {
                        try {
                            // Slice D — account/servers self-delete are SENSITIVE
                            // (accountDeletion.ts gates both on the admin master
                            // root): sign with the admin root when this device
                            // holds one, else the owner IRK (legacy). Canonical
                            // bytes unchanged. Biometric rides the derivation.
                            val irk = Keystore.adminSigningKey(reason = "Delete your account")
                            val issuedAt = System.currentTimeMillis()
                            val u = username.lowercase()
                            val accountSig = HexUtil.encode(
                                irk.sign(AccountSelfDeleteOrder.canonicalBytes(username, issuedAt)),
                            )
                            val serversOrder = if (alsoDeleteContent) {
                                AccountSelfDeleteBundleRequest.Order(
                                    request = AccountSelfDeleteBundleRequest.Inner(u, issuedAt),
                                    signature = HexUtil.encode(
                                        irk.sign(ServersSelfDeleteOrder.canonicalBytes(username, issuedAt)),
                                    ),
                                )
                            } else {
                                null
                            }
                            server.selfDeleteAccount(
                                AccountSelfDeleteBundleRequest(
                                    accountSelfDelete = AccountSelfDeleteBundleRequest.Order(
                                        request = AccountSelfDeleteBundleRequest.Inner(u, issuedAt),
                                        signature = accountSig,
                                    ),
                                    serversSelfDelete = serversOrder,
                                ),
                            )
                            // 200 only: the row is hard-deleted on .com and the
                            // name is free. Now — and only now — erase the local
                            // key material; signOut drops the shell to Welcome.
                            Keystore.wipeAllProfiles()
                            app.signOut()
                        } catch (e: HttpException) {
                            error = when {
                                e.status == 403 && e.body.lowercase().contains("last device") ->
                                    "Another device is still on this account, so it can't be deleted from here. Remove the other devices first."
                                e.status == 404 -> "That account no longer exists."
                                e.status == 403 -> "The server rejected the request. Sign in again and retry."
                                else -> "That didn't work (HTTP ${e.status}). Try again in a moment."
                            }
                            busy = false
                        } catch (e: Exception) {
                            error = "Couldn't reach the server. Check your connection and try again."
                            busy = false
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(FS.space.s3))
            FSGhostButton(
                label = "Cancel",
                onClick = { if (!busy) nav.popBackStack() },
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(FS.space.s12))
        }
    }
}
