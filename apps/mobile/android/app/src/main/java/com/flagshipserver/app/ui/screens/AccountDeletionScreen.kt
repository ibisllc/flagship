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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Badge
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import com.flagshipserver.app.ui.components.OutlinedTextField
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
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
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
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

    FSScreen(
        title = "Delete account",
        onBack = { if (!busy) nav.popBackStack() },
        subtitle = "This permanently deletes your account. It can't be undone — there's " +
            "no recovery passkey and no other device to restore from.",
    ) {
        FSCard {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Consequence(Icons.Outlined.Badge, "Your username “$username” is lost and may be claimed by someone else.")
                Consequence(Icons.Outlined.Dns, "Your servers stop being reachable and you can no longer manage them. If you want to keep a server, transfer it to another account FIRST.")
                Consequence(Icons.Outlined.Block, "There is no way back: no passkey, no other device, no reset.")
            }
        }

        FSGroup {
            FSRow(
                title = "Also ask all my servers to delete their content",
                onClick = { alsoDeleteContent = !alsoDeleteContent },
                trailing = {
                    Checkbox(
                        checked = alsoDeleteContent,
                        onCheckedChange = { alsoDeleteContent = it },
                    )
                },
            )
        }

        FSField(
            value = typed,
            onValueChange = { typed = it; error = null },
            label = "Type your username to confirm",
            fieldTag = "account-delete-confirm",
        )

        error?.let {
            Text(it, modifier = Modifier.testTag("account-delete-error"), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }

        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            FSDangerButton(
                label = if (busy) "Deleting…" else "Delete my account forever",
                enabled = typedMatches && !busy,
                modifier = Modifier.testTag("account-delete-go"),
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
                                e.status == 403 && otherDevicesRemain(e.body) ->
                                    "Another device is still on this account. Remove it in Settings, Trusted devices, then delete the account."
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
                block = true,
            )
            FSSecondaryButton(
                label = "Cancel",
                onClick = { if (!busy) nav.popBackStack() },
                block = true,
            )
        }
    }
}

/** `.com` answers 403 with `code: other-devices-remain` (older builds of it said
 *  "not the last device"). */
internal fun otherDevicesRemain(body: String): Boolean {
    val b = body.lowercase()
    return b.contains("other-devices-remain") || b.contains("last device") || b.contains("another device is still")
}

@Composable
private fun Consequence(icon: ImageVector, text: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.error)
        Text(
            text,
            color = MaterialTheme.colorScheme.onSurface,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )
    }
}
