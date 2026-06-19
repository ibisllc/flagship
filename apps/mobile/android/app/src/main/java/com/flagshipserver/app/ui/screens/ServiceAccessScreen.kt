// Admin "Who can open this" screen for per-service access gating
// (docs/service-access-gating.md §v2 hardening). Mirror of iOS ServiceAccessScreen
// + the webapp views/service-access.js: an open <-> restricted toggle (reads the
// TRUE mode from the box; sets it with an owner-IRK envelope) and, when
// restricted, the allow-list manager — add a person across THREE tiers (personal
// auto / personal manual / group multi-use) -> mint a capability invite via .com
// -> copyable/shareable link + inline QR; list w/ locally-decrypted bundle (a
// group is ONE "label — k/N" entry); remove -> AID revoke + owner-IRK box prune;
// and CONFIRM a manual-approve reply a friend sent back.

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
import androidx.compose.material3.FilterChip
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.QrImage
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.AccessPerson
import com.flagshipserver.app.viewmodels.InviteTier
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
    val busyFinalize by vm.busyFinalize.collectAsState()

    var name by remember { mutableStateOf("") }
    var photoDataUri by remember { mutableStateOf<String?>(null) }
    var tier by remember { mutableStateOf(InviteTier.PERSONAL_AUTO) }
    var maxRedemptionsText by remember { mutableStateOf("0") }
    var expiryDaysText by remember { mutableStateOf("") }
    var confirmRemove by remember { mutableStateOf<AccessPerson?>(null) }
    var replyText by remember { mutableStateOf("") }

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

                    // ── invite tier picker ──
                    Text("How should this invite work?", color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
                    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        TierChip("Auto", tier == InviteTier.PERSONAL_AUTO, "service-access-tier-auto") { tier = InviteTier.PERSONAL_AUTO }
                        TierChip("Approve", tier == InviteTier.PERSONAL_MANUAL, "service-access-tier-manual") { tier = InviteTier.PERSONAL_MANUAL }
                        TierChip("Group", tier == InviteTier.GROUP, "service-access-tier-group") { tier = InviteTier.GROUP }
                    }
                    Text(
                        when (tier) {
                            InviteTier.PERSONAL_AUTO -> "Personal link. The first account that opens it gets access. Send it privately."
                            InviteTier.PERSONAL_MANUAL -> "Personal, with your approval. They open it, then send you back a confirmation you finalize below — closes the link-theft window without revealing who they are."
                            InviteTier.GROUP -> "One link for several people (lower-trust — a leaked link admits up to the limit). Set a redemption limit and an optional expiry."
                        },
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 12.sp, lineHeight = 17.sp),
                    )

                    Text(
                        "Names & photos stay encrypted to your account — flagshipserver.com stores only ciphertext and never sees them. The consumer's username is never shown to you.",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                    )
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text(if (tier == InviteTier.GROUP) "Group label (only you + your servers see it)" else "Name (only you + your servers see it)") },
                        singleLine = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .semantics { testTag = "service-access-name-field" },
                    )

                    if (tier == InviteTier.GROUP) {
                        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                            OutlinedTextField(
                                value = maxRedemptionsText,
                                onValueChange = { maxRedemptionsText = it.filter { c -> c.isDigit() } },
                                label = { Text("Limit (0 = unlimited)") },
                                singleLine = true,
                                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Number),
                                modifier = Modifier
                                    .weight(1f)
                                    .semantics { testTag = "service-access-group-max" },
                            )
                            OutlinedTextField(
                                value = expiryDaysText,
                                onValueChange = { expiryDaysText = it.filter { c -> c.isDigit() } },
                                label = { Text("Expires in days (optional)") },
                                singleLine = true,
                                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Number),
                                modifier = Modifier
                                    .weight(1f)
                                    .semantics { testTag = "service-access-group-expiry" },
                            )
                        }
                    }

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
                                val maxN = maxRedemptionsText.toIntOrNull() ?: 0
                                val expiryDays = expiryDaysText.toLongOrNull()
                                val expiresAt = expiryDays?.takeIf { it > 0 }?.let { System.currentTimeMillis() + it * 86_400_000L }
                                val link = vm.addPerson(name, photoDataUri, tier, maxN, expiresAt)
                                if (link != null) {
                                    toasts.success(if (tier == InviteTier.GROUP) "Group invite created." else "Invite for ${name.trim()} created.")
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

            // confirm a manual-approve reply (the author finalizes the loop)
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Text("Confirm someone you approved", color = FS.colors.text, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold))
                    Text(
                        "For an Approve-tier invite: paste the confirmation your contact sent back to grant them access.",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 12.sp, lineHeight = 17.sp),
                    )
                    OutlinedTextField(
                        value = replyText,
                        onValueChange = { replyText = it },
                        label = { Text("Paste the confirmation reply") },
                        singleLine = false,
                        modifier = Modifier
                            .fillMaxWidth()
                            .semantics { testTag = "service-access-accept-reply-field" },
                    )
                    FSPrimaryButton(
                        label = if (busyFinalize) "Confirming…" else "Confirm access",
                        enabled = !busyFinalize && replyText.trim().isNotEmpty(),
                        block = true,
                        onClick = {
                            scope.launch {
                                val ok = vm.finalizeAcceptance(replyText.trim())
                                if (ok) { toasts.success("Access confirmed."); replyText = "" }
                                else toasts.error("Couldn't confirm them. Check the reply and try again.")
                            }
                        },
                        modifier = Modifier.semantics { testTag = "service-access-accept-finalize" },
                    )
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
                    PersonRow(
                        person = person,
                        onRemove = { confirmRemove = person },
                        onRemoveMember = { aid -> scope.launch { vm.removeGroupMember(aid); toasts.success("Member removed.") } },
                    )
                }
            }
        }

        Spacer(Modifier.height(FS.space.s12))
    }

    confirmRemove?.let { person ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmRemove = null },
            title = { Text(if (person.isGroup) "Remove the group \"${person.name}\"?" else "Remove ${person.name}?") },
            text = {
                Text(
                    if (person.isGroup) "Everyone in this group loses access the next time they try to open it."
                    else "They'll lose access the next time they try to open it. You can re-add them later with a new link.",
                )
            },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = {
                    val p = person
                    confirmRemove = null
                    scope.launch {
                        vm.remove(p.inviteId, p.boundAidHex, p.memberAids)
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
private fun TierChip(label: String, selected: Boolean, tag: String, onClick: () -> Unit) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label) },
        modifier = Modifier.semantics { testTag = tag },
    )
}

@Composable
private fun PersonRow(person: AccessPerson, onRemove: () -> Unit, onRemoveMember: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(person.name, color = FS.colors.text, style = TextStyle(fontSize = 16.sp))
                    val sub = if (person.isGroup) {
                        val cap = if (person.maxRedemptions == 0) "∞" else person.maxRedemptions.toString()
                        "group · ${person.redemptions}/$cap"
                    } else if (person.bound) "active" else "invite sent — not opened yet"
                    Text(
                        sub,
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 13.sp),
                        modifier = Modifier.semantics { testTag = if (person.isGroup) "service-access-group-row" else "service-access-person-row" },
                    )
                }
                FSDangerButton(label = if (person.isGroup) "Remove group" else "Remove", onClick = onRemove)
            }
            if (person.isGroup && person.memberAids.isNotEmpty()) {
                androidx.compose.material3.TextButton(
                    onClick = { expanded = !expanded },
                    modifier = Modifier.semantics { testTag = "service-access-group-members-toggle" },
                ) { Text(if (expanded) "Hide members" else "Manage members (${person.memberAids.size})") }
                if (expanded) {
                    person.memberAids.forEach { aid ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                "member ${aid.take(8)}…",
                                color = FS.colors.textMuted,
                                style = TextStyle(fontSize = 12.sp, fontFamily = FontFamily.Monospace),
                                modifier = Modifier.weight(1f),
                            )
                            androidx.compose.material3.TextButton(onClick = { onRemoveMember(aid) }) { Text("Remove") }
                        }
                    }
                }
            }
        }
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
        // Inline QR (the rich-channel artifact; the link text below is the fallback).
        QrImage(
            payload = link,
            size = 180.dp,
            contentDescription = "Invite QR",
            modifier = Modifier.semantics { testTag = "service-access-share-qr" },
        )
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
