// Admin "Who can open this" screen for per-service access gating
// (docs/service-access-gating.md). Mirror of iOS ServiceAccessScreen + the
// webapp views/service-access.js: an open <-> restricted toggle (reads the TRUE
// mode from the box; sets it with an owner-IRK envelope) and, when restricted,
// the allow-list manager (add a person -> mint a capability invite via .com ->
// copyable/shareable link; list w/ locally-decrypted bundle; remove -> revoke).

package com.flagshipserver.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.ServiceAccessPhase
import com.flagshipserver.app.viewmodels.ServiceAccessViewModel
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream

@Composable
fun ServiceAccessScreen(nav: NavController, serviceId: String) {
    val appState = LocalAppState.current
    val toasts = LocalToastCenter.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    val pods = appState.pods.collectAsState().value
    val leaderId = appState.leaderPodId.collectAsState().value
    val username = appState.currentUser.collectAsState().value ?: "you"
    val serverDomain = pods.firstOrNull { it.podId == leaderId }?.fqdn
        ?: pods.firstOrNull()?.fqdn
        ?: "unknown"
    val serviceLabel = remember(serviceId) {
        val dash = serviceId.indexOf('-')
        if (dash > 0) serviceId.substring(dash + 1).replaceFirstChar { it.uppercase() } else serviceId
    }

    val vm = remember(serviceId, serverDomain) {
        ServiceAccessViewModel(serverDomain = serverDomain, serviceRef = serviceId, username = username)
    }
    val phase by vm.phase.collectAsState()
    val restricted by vm.restricted.collectAsState()
    val allowCount by vm.allowCount.collectAsState()
    val people by vm.people.collectAsState()
    val lastLink by vm.lastInviteLink.collectAsState()
    val busyMode by vm.busyMode.collectAsState()
    val busyAdd by vm.busyAdd.collectAsState()

    var name by remember { mutableStateOf("") }
    var photoDataUri by remember { mutableStateOf<String?>(null) }
    var confirmRemove by remember { mutableStateOf<com.flagshipserver.app.viewmodels.AccessPerson?>(null) }

    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) {
            val dataUri = readImageAsDataUri(ctx, uri)
            if (dataUri == null) {
                toasts.error("Photo is too large (max 256 KB) or couldn't be read.")
            } else {
                photoDataUri = dataUri
            }
        }
    }

    androidx.compose.runtime.LaunchedEffect(serviceId, serverDomain) {
        vm.load()
        (vm.phase.value as? ServiceAccessPhase.Failed)?.let { toasts.error(it.message) }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(FS.space.s4),
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        // header
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column {
                Text(serviceLabel, color = FS.colors.text, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold))
                Text("id: $serviceId", color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp))
            }
        }

        // toggle
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    "Open — anyone with the link can open it. Restricted — only people you add below.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Restrict to an allow-list", color = FS.colors.text, modifier = Modifier.weight(1f))
                    Switch(
                        checked = restricted,
                        enabled = !busyMode,
                        onCheckedChange = { want ->
                            scope.launch {
                                val ok = vm.setMode(want)
                                if (ok) {
                                    toasts.success(if (want) "Now restricted to your allow-list." else "Now open to anyone with the link.")
                                } else {
                                    toasts.error("Couldn't change who can open this. Try again in a moment.")
                                }
                            }
                        },
                        modifier = Modifier.semantics { testTag = "service-access-restrict-toggle" },
                    )
                }
                val statusText = when (phase) {
                    is ServiceAccessPhase.Loading -> "Loading…"
                    else -> if (restricted) {
                        "Restricted — " + (if (allowCount == 1) "1 person added" else "$allowCount people added")
                    } else {
                        "Open to anyone with the link"
                    }
                }
                Text(
                    statusText,
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 12.sp),
                    modifier = Modifier.semantics { testTag = "service-access-mode-status" },
                )
            }
        }

        if (restricted) {
            // add a person
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    Text("Add a person", color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
                    Text(
                        "Names & photos stay encrypted to your account — flagshipserver.com stores only ciphertext and never sees them. The link is a bearer capability: send it over a private channel. It locks to the first account that opens it.",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                    )
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text("Name (only you + your servers see it)") },
                        singleLine = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .semantics { testTag = "service-access-name-field" },
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3), verticalAlignment = Alignment.CenterVertically) {
                        OutlinedButton(onClick = {
                            photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                        }) {
                            Text(if (photoDataUri == null) "Add photo (optional)" else "Change photo")
                        }
                        if (photoDataUri != null) {
                            TextButtonClear { photoDataUri = null }
                        }
                    }
                    FSPrimaryButton(
                        label = if (busyAdd) "Creating…" else "Create invite link",
                        enabled = !busyAdd && name.trim().isNotEmpty(),
                        block = true,
                        large = true,
                        onClick = {
                            scope.launch {
                                val link = vm.addPerson(name, photoDataUri)
                                if (link != null) {
                                    toasts.success("Invite for ${name.trim()} created.")
                                    name = ""
                                    photoDataUri = null
                                } else {
                                    toasts.error("Couldn't create the invite. Try again in a moment.")
                                }
                            }
                        },
                        modifier = Modifier.semantics { testTag = "service-access-create-invite" },
                    )
                    lastLink?.let { link ->
                        ResultBlock(link = link, onShare = { shareViaSystemSheet(ctx, link) }, onCopy = {
                            copyToClipboard(ctx, link); toasts.success("Link copied.")
                        })
                    }
                }
            }

            // people list
            Text("People with access", color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
            if (people.isEmpty()) {
                FSCard(padding = PaddingValues(FS.space.s4)) {
                    Text("No one added yet. Create an invite link above.", color = FS.colors.textMuted)
                }
            } else {
                people.forEach { person ->
                    FSCard(padding = PaddingValues(FS.space.s4)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(person.name, color = FS.colors.text, style = TextStyle(fontSize = 16.sp))
                                Text(
                                    if (person.bound) "active" else "invite sent — not opened yet",
                                    color = FS.colors.textMuted,
                                    style = TextStyle(fontSize = 13.sp),
                                )
                            }
                            FSDangerButton(label = "Remove", onClick = { confirmRemove = person })
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(FS.space.s12))
    }

    confirmRemove?.let { person ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmRemove = null },
            title = { Text("Remove ${person.name}?") },
            text = { Text("They'll lose access the next time they try to open it. You can re-add them later with a new link.") },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = {
                    val p = person
                    confirmRemove = null
                    scope.launch {
                        vm.remove(p.inviteId)
                        toasts.success("Removed.")
                    }
                }) { Text("Remove") }
            },
            dismissButton = {
                androidx.compose.material3.TextButton(onClick = { confirmRemove = null }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun TextButtonClear(onClick: () -> Unit) {
    androidx.compose.material3.TextButton(onClick = onClick) { Text("Remove photo") }
}

@Composable
private fun ResultBlock(link: String, onShare: () -> Unit, onCopy: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        Text("Shareable link", color = FS.colors.text, style = TextStyle(fontSize = 13.sp))
        Text(
            link,
            color = FS.colors.text,
            style = TextStyle(fontSize = 13.sp, fontFamily = FontFamily.Monospace),
            modifier = Modifier
                .fillMaxWidth()
                .semantics { testTag = "service-access-share-url" },
        )
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            OutlinedButton(onClick = onShare, modifier = Modifier.semantics { testTag = "service-access-share-sheet" }) {
                Text("Share…")
            }
            OutlinedButton(onClick = onCopy, modifier = Modifier.semantics { testTag = "service-access-copy-btn" }) {
                Text("Copy link")
            }
        }
    }
}

private fun shareViaSystemSheet(ctx: Context, url: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, url)
    }
    val chooser = Intent.createChooser(send, "Share invite")
    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    ctx.startActivity(chooser)
}

private fun copyToClipboard(ctx: Context, url: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("Flagship invite", url))
}

/** Read a picked image, cap at ~256 KB encoded, return a data: URI (or null). */
private fun readImageAsDataUri(ctx: Context, uri: Uri): String? {
    return try {
        val bytes = ctx.contentResolver.openInputStream(uri)?.use { input ->
            val out = ByteArrayOutputStream()
            input.copyTo(out)
            out.toByteArray()
        } ?: return null
        if (bytes.size > 256 * 1024) return null
        val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        val mime = ctx.contentResolver.getType(uri) ?: "image/jpeg"
        "data:$mime;base64,$b64"
    } catch (e: Throwable) {
        null
    }
}
