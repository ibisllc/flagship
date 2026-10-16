// "Access control" screen (docs/service-access-gating.md, "Open mode + members"
// and "Account members, ranks and who may change them"). Mirror of iOS
// ServiceAccessScreen + the webapp views/service-access.js: an Open to all |
// Members only toggle (admin devices only; never changes the list), the
// Account members (this account's devices, names decrypted on the phone, and
// the co-managing accounts, each with its rank; on an admin device a rank menu
// with Refuse), and the invited people and groups with their ranks, "Invited
// by <device>", + Add person / + Add group (any rank on an admin device, Member
// on a Manager-class device, and on a device below Manager the line saying
// why), Revoke (admins any invite, other devices their own), and CONFIRM a
// reply from someone you approve.

package com.flagshipserver.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.AppAccountMember
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.core.AppMemberRole
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.QrImage
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.AccessPerson
import com.flagshipserver.app.viewmodels.InviteTier
import com.flagshipserver.app.viewmodels.ServiceAccessPhase
import com.flagshipserver.app.viewmodels.ServiceAccessViewModel
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServiceAccessScreen(nav: NavController, serviceId: String) {
    val appState = LocalAppState.current
    val toasts = LocalToastCenter.current
    val screens = LocalScreensClient.current
    val ctx = LocalContext.current

    val pods = appState.pods.collectAsState().value
    val leaderId = appState.leaderPodId.collectAsState().value
    val username = appState.currentUser.collectAsState().value ?: "you"
    val serverDomain = pods.firstOrNull { it.podId == leaderId }?.fqdn
        ?: pods.firstOrNull()?.fqdn
        ?: "unknown"
    val serviceLabel = remember(serviceId) {
        // serviceId = "<creator>--<slug>"; show the slug half (split on `--`,
        // docs/service-addressing-double-dash.md).
        val delim = serviceId.indexOf("--")
        if (delim > 0) serviceId.substring(delim + 2).replaceFirstChar { it.uppercase() } else serviceId
    }

    val live = com.flagshipserver.app.core.LocalDeveloperSettings.current?.useLiveClient?.collectAsState()?.value ?: true
    val server = com.flagshipserver.app.core.LocalFlagshipServerClient.current
    val vm = remember(serviceId, serverDomain, live) {
        val mockBox = screens is MockScreensClient
        val profileDevice = { appState.activeProfile?.deviceId?.takeIf { it.length == 32 } }
        // The mock box's device book names this phone by a fixed key; a real
        // box by the account device key derived on this phone.
        val deviceId = if (mockBox) ({ profileDevice() ?: MockScreensClient.SELF_DEVICE_ID }) else profileDevice
        if (mockBox) {
            ServiceAccessViewModel(
                serverDomain = serverDomain, serviceRef = serviceId, username = username, screens = screens,
                client = if (live) com.flagshipserver.app.api.ServiceAccessClient()
                else com.flagshipserver.app.api.MockServiceAccessClient.shared,
                deviceId = deviceId,
                deviceSigner = { _ -> Keystore.accountDeviceSigner(Keystore.currentUmkSeed(), username, deviceId() ?: MockScreensClient.SELF_DEVICE_ID) },
                ownDevicePubHex = { MockScreensClient.SELF_DEVICE_PUB },
                deviceNames = { MockScreensClient.DEVICE_NAMES },
                isAdminDevice = { com.flagshipserver.app.core.AdminOrderGate.allows(appState) },
            )
        } else {
            ServiceAccessViewModel(
                serverDomain = serverDomain, serviceRef = serviceId, username = username, screens = screens,
                client = if (live) com.flagshipserver.app.api.ServiceAccessClient()
                else com.flagshipserver.app.api.MockServiceAccessClient.shared,
                deviceId = deviceId,
                deviceNames = {
                    val id = deviceId()
                    if (id == null) null
                    else com.flagshipserver.app.viewmodels.AccountDeviceNames.load(server, username, id)
                },
                // A demo account's device stands in for its owner (its box pins no root).
                isAdminDevice = { com.flagshipserver.app.core.AdminOrderGate.allows(appState) },
            )
        }
    }
    ServiceAccessContent(
        vm = vm,
        serviceId = serviceId,
        serviceLabel = serviceLabel,
        onShare = { link -> shareViaSystemSheet(ctx, link) },
        onCopy = { link -> copyToClipboard(ctx, link); toasts.success("Link copied.") },
        pickPhoto = null,
    )
}

/** Open to all | Members only, then the members list (docs/service-access-gating.md, "Open mode + members"). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ServiceAccessContent(
    vm: ServiceAccessViewModel,
    serviceId: String,
    serviceLabel: String,
    onShare: (String) -> Unit,
    onCopy: (String) -> Unit,
    pickPhoto: (() -> Unit)?,
    loadOnStart: Boolean = true,
) {
    val toasts = LocalToastCenter.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val phase by vm.phase.collectAsState()
    val restricted by vm.restricted.collectAsState()
    val people by vm.people.collectAsState()
    val members by vm.members.collectAsState()
    // Read here so the invite line recomposes once the box has been asked.
    vm.membersRead.collectAsState().value
    val busyRoles by vm.busyRoles.collectAsState()
    val roleNotice by vm.roleNotice.collectAsState()
    val lastLink by vm.lastInviteLink.collectAsState()
    val busyMode by vm.busyMode.collectAsState()
    val busyAdd by vm.busyAdd.collectAsState()
    val busyFinalize by vm.busyFinalize.collectAsState()
    val deviceNames by vm.deviceNamesState.collectAsState()

    var adding by remember { mutableStateOf<InviteTier?>(null) }
    var name by remember { mutableStateOf("") }
    var newRole by remember { mutableStateOf(AppMemberRole.MEMBER) }
    var approveFirst by remember { mutableStateOf(false) }
    var photoDataUri by remember { mutableStateOf<String?>(null) }
    var maxRedemptionsText by remember { mutableStateOf("10") }
    var expiryDaysText by remember { mutableStateOf("7") }
    var removing by remember { mutableStateOf<Set<String>>(emptySet()) }
    var confirmRemove by remember { mutableStateOf<AccessPerson?>(null) }
    var confirmMembersOnly by remember { mutableStateOf(false) }
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

    if (loadOnStart) {
        androidx.compose.runtime.LaunchedEffect(vm) {
            vm.load()
            (vm.phase.value as? ServiceAccessPhase.Failed)?.let { toasts.error(it.message) }
        }
    }

    fun applyMode(membersOnly: Boolean) {
        scope.launch {
            val ok = vm.setMode(membersOnly)
            if (ok) toasts.success(if (membersOnly) "Now members only." else "Now open to all.")
            else toasts.error("Couldn't change access. Try again in a moment.")
        }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(FS.space.s4),
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            "Access control",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
            modifier = Modifier.semantics { testTag = "service-access-title" },
        )
        // header
        FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth()) {
            Column {
                Text(serviceLabel, color = FS.colors.text, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold))
                Text("id: $serviceId", color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp))
            }
        }

        // Open to all | Members only. The members list never changes with it.
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                SingleChoiceSegmentedButtonRow(
                    Modifier
                        .fillMaxWidth()
                        .semantics { testTag = "service-access-restrict-toggle" },
                ) {
                    val enabled = vm.isAdmin && !busyMode && phase !is ServiceAccessPhase.Loading
                    val colors = SegmentedButtonDefaults.colors(
                        activeContainerColor = FS.colors.primary.copy(alpha = 0.14f),
                        activeContentColor = FS.colors.text,
                        activeBorderColor = FS.colors.primary,
                        inactiveContainerColor = FS.colors.surface,
                        inactiveContentColor = FS.colors.textMuted,
                        inactiveBorderColor = FS.colors.border,
                    )
                    SegmentedButton(
                        selected = !restricted,
                        onClick = { if (restricted) applyMode(false) },
                        enabled = enabled,
                        colors = colors,
                        shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
                        modifier = Modifier.semantics { testTag = "service-access-mode-open" },
                    ) { Text("Open to all") }
                    SegmentedButton(
                        selected = restricted,
                        onClick = { if (!restricted) confirmMembersOnly = true },
                        enabled = enabled,
                        colors = colors,
                        shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
                        modifier = Modifier.semantics { testTag = "service-access-mode-members" },
                    ) { Text("Members only") }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    if (busyMode) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = FS.colors.primary)
                    val failed = phase as? ServiceAccessPhase.Failed
                    Text(
                        when {
                            phase is ServiceAccessPhase.Loading -> "Loading…"
                            busyMode -> "Saving…"
                            failed != null -> failed.message
                            restricted -> "Only members and you can open it. Anyone else is asked to sign in."
                            else -> "Anyone can open it. Members who sign in get their rank."
                        },
                        color = if (failed != null && !busyMode) FS.colors.danger else FS.colors.textMuted,
                        style = TextStyle(fontSize = 12.sp, lineHeight = 17.sp),
                        modifier = Modifier.semantics { testTag = "service-access-mode-status" },
                    )
                }
                if (!vm.isAdmin) {
                    Text(
                        MODE_ADMIN_ONLY_LINE,
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 12.sp),
                        modifier = Modifier.semantics { testTag = "service-access-mode-admin-only" },
                    )
                }
            }
        }

        // Account members: this account's devices and the co-managing accounts.
        val accountMembers = members?.accountMembers.orEmpty()
        if (accountMembers.isNotEmpty()) {
            Text(
                "ACCOUNT MEMBERS (${accountMembers.size})",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp),
                modifier = Modifier.semantics { testTag = "service-access-account-members-title" },
            )
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    accountMembers.forEach { m ->
                        AccountMemberRow(
                            member = m,
                            name = vm.accountMemberName(m, deviceNames),
                            detail = vm.accountMemberDetail(m),
                            canChange = vm.isAdmin && m.rankTarget != null,
                            descriptions = members?.descriptions.orEmpty(),
                            busy = m.rowKey in busyRoles,
                            onRank = { r ->
                                scope.launch {
                                    val name = vm.accountMemberName(m, deviceNames)
                                    if (vm.setAccountRank(m, r)) toasts.success(if (r == null) "$name is refused." else "$name is now ${r.label}.")
                                    else (vm.phase.value as? ServiceAccessPhase.Failed)?.let { toasts.error(it.message) }
                                }
                            },
                        )
                    }
                }
            }
        }

        // Members (n) — in both modes.
        Text(
            "MEMBERS (${people.size})",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp),
            modifier = Modifier.semantics { testTag = "service-access-members-title" },
        )
        vm.inviteBlockedLine?.let { line ->
            Text(
                line,
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                modifier = Modifier.semantics { testTag = "service-access-cant-invite" },
            )
        }
        if (vm.canInvite) Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            FSSecondaryButton(
                label = "+ Add person",
                onClick = {
                    adding = InviteTier.PERSONAL_AUTO; vm.clearLink(); name = ""; approveFirst = false; photoDataUri = null
                    newRole = AppMemberRole.fromWire(members?.defaultRole) ?: AppMemberRole.MEMBER
                },
                modifier = Modifier.weight(1f).semantics { testTag = "service-access-add-person" },
                block = true,
            )
            FSSecondaryButton(
                label = "+ Add group",
                onClick = {
                    adding = InviteTier.GROUP; vm.clearLink(); name = ""
                    newRole = AppMemberRole.fromWire(members?.defaultRole) ?: AppMemberRole.MEMBER
                },
                modifier = Modifier.weight(1f).semantics { testTag = "service-access-add-group" },
                block = true,
            )
        }

        adding?.let { kind ->
            val isGroup = kind == InviteTier.GROUP
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            if (isGroup) "Add a group" else "Add a person",
                            color = FS.colors.text,
                            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                            modifier = Modifier.weight(1f),
                        )
                        androidx.compose.material3.TextButton(onClick = { adding = null; vm.clearLink() }) { Text("Close") }
                    }
                    Text(
                        "Names & photos stay encrypted to your account — flagshipserver.com stores only ciphertext. Send the link over a private channel.",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                    )
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text(if (isGroup) "Group name (only you + your servers see it)" else "Name (only you + your servers see it)") },
                        singleLine = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .semantics { testTag = "service-access-name-field" },
                    )
                    val pickedRole = if (vm.isAdmin) newRole else AppMemberRole.MEMBER
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Rank", color = FS.colors.text, modifier = Modifier.weight(1f))
                        RolePicker(
                            selected = pickedRole,
                            tag = "service-access-new-role",
                            enabled = vm.isAdmin,
                            descriptions = members?.descriptions.orEmpty(),
                        ) { newRole = it }
                    }
                    if (!vm.isAdmin) {
                        Text(
                            RANK_LOCKED_LINE,
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 12.sp),
                            modifier = Modifier.semantics { testTag = "service-access-rank-locked" },
                        )
                    }
                    members?.description(pickedRole.wire)?.let {
                        Text(it, color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp))
                    }
                    if (isGroup) {
                        Text(
                            "Everyone who joins through the link gets this rank.",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 12.sp),
                        )
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
                                label = { Text("Expires in days") },
                                singleLine = true,
                                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Number),
                                modifier = Modifier
                                    .weight(1f)
                                    .semantics { testTag = "service-access-group-expiry" },
                            )
                        }
                    } else {
                        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3), verticalAlignment = Alignment.CenterVertically) {
                            OutlinedButton(onClick = {
                                pickPhoto?.invoke()
                                    ?: photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                            }) {
                                Text(if (photoDataUri == null) "Add photo (optional)" else "Change photo")
                            }
                            if (photoDataUri != null) TextButtonClear { photoDataUri = null }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("I approve them before they get in", color = FS.colors.text, modifier = Modifier.weight(1f))
                            Switch(
                                checked = approveFirst,
                                onCheckedChange = { approveFirst = it },
                                modifier = Modifier.semantics { testTag = "service-access-approve-toggle" },
                            )
                        }
                    }
                    FSPrimaryButton(
                        label = if (busyAdd) "Creating…" else "Create invite link",
                        enabled = !busyAdd && name.trim().isNotEmpty(),
                        block = true,
                        large = true,
                        onClick = {
                            scope.launch {
                                val tier = if (isGroup) InviteTier.GROUP else if (approveFirst) InviteTier.PERSONAL_MANUAL else InviteTier.PERSONAL_AUTO
                                val maxN = maxRedemptionsText.toIntOrNull() ?: 0
                                val expiresAt = expiryDaysText.toLongOrNull()?.takeIf { it > 0 }
                                    ?.let { System.currentTimeMillis() + it * 86_400_000L }
                                val link = vm.addPerson(name, if (isGroup) null else photoDataUri, tier, maxN, expiresAt, pickedRole)
                                if (link != null) {
                                    toasts.success(if (isGroup) "Group invite created." else "Invite for ${name.trim()} created.")
                                    name = ""
                                    photoDataUri = null
                                } else {
                                    toasts.error("Couldn't create the invite. Try again in a moment.")
                                }
                            }
                        },
                        modifier = Modifier.semantics { testTag = "service-access-create-invite" },
                    )
                    roleNotice?.let { Text(it, color = FS.colors.danger, style = TextStyle(fontSize = 12.sp)) }
                    lastLink?.let { link -> ResultBlock(link = link, onShare = { onShare(link) }, onCopy = { onCopy(link) }) }
                }
            }
        }

        if (people.isEmpty()) {
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Text("No members yet. Add a person or a group.", color = FS.colors.textMuted)
            }
        } else {
            people.forEach { person ->
                PersonRow(
                    person = person,
                    role = members?.let { vm.roleFor(person) },
                    canChangeRank = vm.isAdmin,
                    descriptions = members?.descriptions.orEmpty(),
                    alsoIn = vm.alsoIn(person),
                    invitedBy = vm.invitedBy(person, deviceNames),
                    canRemove = vm.canRemove(person),
                    busyRole = person.inviteId in busyRoles,
                    busyRemove = person.inviteId in removing,
                    onRole = { r ->
                        scope.launch {
                            if (vm.setRole(r, person)) toasts.success("${person.name} is now ${r.label}.")
                            else (vm.phase.value as? ServiceAccessPhase.Failed)?.let { toasts.error(it.message) }
                        }
                    },
                    canRemoveMembers = vm.isAdmin,
                    onRemove = { confirmRemove = person },
                    onRemoveMember = { aid ->
                        scope.launch {
                            if (vm.removeGroupMember(aid)) toasts.success("Member removed.")
                            else (vm.phase.value as? ServiceAccessPhase.Failed)?.let { toasts.error(it.message) }
                        }
                    },
                )
            }
        }

        // confirm a manual-approve reply (the author finalizes the loop)
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text("Confirm someone you approve", color = FS.colors.text, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold))
                Text(
                    "For a person you approve first: paste the confirmation they sent back to let them in.",
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

        Spacer(Modifier.height(FS.space.s12))
    }

    confirmRemove?.let { person ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmRemove = null },
            title = { Text(if (person.isGroup) "Revoke the group \"${person.name}\"?" else "Remove ${person.name}?") },
            text = {
                Text(
                    when {
                        person.isGroup && restricted -> "Everyone who joined through this link loses access, unless they were also invited another way."
                        person.isGroup -> "Everyone who joined through this link loses their rank and can still visit as anyone can."
                        restricted -> "They're signed out and kept out. You can invite them again later."
                        else -> "They lose their rank and can still visit as anyone can. You can invite them again later."
                    },
                )
            },
            confirmButton = {
                androidx.compose.material3.TextButton(
                    onClick = {
                        val p = person
                        confirmRemove = null
                        removing = removing + p.inviteId
                        scope.launch {
                            val ok = vm.remove(p.inviteId)
                            removing = removing - p.inviteId
                            if (ok) toasts.success(if (p.isGroup) "Group revoked." else "Removed.")
                            else (vm.phase.value as? ServiceAccessPhase.Failed)?.let { toasts.error(it.message) }
                        }
                    },
                    modifier = Modifier.semantics { testTag = "service-access-remove-confirm" },
                ) { Text(if (person.isGroup) "Revoke" else "Remove") }
            },
            dismissButton = {
                androidx.compose.material3.TextButton(onClick = { confirmRemove = null }) { Text("Cancel") }
            },
        )
    }

    if (confirmMembersOnly) {
        val n = vm.memberPeopleCount
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmMembersOnly = false },
            title = { Text("Members only?") },
            text = { Text(if (n == 1) "Only this 1 person will be able to open it." else "Only these $n people will be able to open it.") },
            confirmButton = {
                androidx.compose.material3.TextButton(
                    onClick = { confirmMembersOnly = false; applyMode(true) },
                    modifier = Modifier.semantics { testTag = "service-access-members-only-confirm" },
                ) { Text("Members only") }
            },
            dismissButton = {
                androidx.compose.material3.TextButton(onClick = { confirmMembersOnly = false }) { Text("Cancel") }
            },
        )
    }
}

internal const val RANK_LOCKED_LINE = "Only an admin device can give a higher rank"
internal const val MODE_ADMIN_ONLY_LINE = "Only an admin device can change who may open this app."
internal const val REFUSED_LABEL = "Refused"

/** A rank menu; the display names come from [AppMemberRole.label] only, each
 *  item carries the app's one line for that rank, and Master its crown. Not
 *  [enabled]: the rank, read-only (a device that isn't an admin). With
 *  [onRefuse] (an account member on an admin device) it also offers Refuse; a
 *  null [selected] reads "Refused". */
@Composable
private fun RolePicker(
    selected: AppMemberRole?,
    tag: String,
    busy: Boolean = false,
    enabled: Boolean = true,
    descriptions: Map<String, String> = emptyMap(),
    onRefuse: (() -> Unit)? = null,
    onPick: (AppMemberRole) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val label = selected?.label ?: REFUSED_LABEL
    Box {
        androidx.compose.material3.AssistChip(
            onClick = { if (!busy && enabled) open = true },
            enabled = enabled,
            label = { Text(label, color = if (selected == null) FS.colors.danger else androidx.compose.ui.graphics.Color.Unspecified) },
            leadingIcon = if (selected?.crowned == true) {
                { Icon(CrownIcon, contentDescription = null, tint = CROWN_GOLD, modifier = Modifier.size(16.dp)) }
            } else null,
            trailingIcon = when {
                busy -> { { CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp, color = FS.colors.primary) } }
                enabled -> { { Icon(Icons.Filled.ArrowDropDown, contentDescription = null) } }
                else -> null
            },
            modifier = Modifier.semantics { testTag = tag; contentDescription = "Rank: $label" },
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            AppMemberRole.entries.forEach { r ->
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(r.label)
                            descriptions[r.wire]?.takeIf { it.isNotEmpty() }?.let {
                                Text(it, color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp))
                            }
                        }
                    },
                    onClick = { open = false; if (r != selected) onPick(r) },
                    leadingIcon = when {
                        r == selected -> { { Icon(Icons.Filled.Check, contentDescription = null) } }
                        r.crowned -> { { Icon(CrownIcon, contentDescription = null, tint = CROWN_GOLD) } }
                        else -> null
                    },
                    modifier = Modifier.semantics { testTag = "$tag-${r.wire}" },
                )
            }
            if (onRefuse != null) {
                androidx.compose.material3.HorizontalDivider()
                DropdownMenuItem(
                    text = { Text("Refuse", color = FS.colors.danger) },
                    onClick = { open = false; if (selected != null) onRefuse() },
                    leadingIcon = if (selected == null) { { Icon(Icons.Filled.Check, contentDescription = null) } } else null,
                    modifier = Modifier.semantics { testTag = "$tag-refuse" },
                )
            }
        }
    }
}

/** One of the account's devices or a co-managing account, with its rank in this app. */
@Composable
private fun AccountMemberRow(
    member: AppAccountMember,
    name: String,
    detail: String,
    canChange: Boolean,
    descriptions: Map<String, String>,
    busy: Boolean,
    onRank: (AppMemberRole?) -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
        modifier = Modifier.semantics { testTag = "service-access-account-${member.rowKey}" },
    ) {
        Box(
            Modifier
                .size(36.dp)
                .background(FS.colors.surfaceSunken, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                if (member.isDevice) Icons.Filled.Smartphone else Icons.Filled.Groups,
                contentDescription = null,
                tint = FS.colors.textMuted,
                modifier = Modifier.size(18.dp),
            )
        }
        Column(Modifier.weight(1f)) {
            Text(name, color = FS.colors.text, style = TextStyle(fontSize = 16.sp), maxLines = 1)
            if (detail.isNotEmpty()) {
                Text(detail, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
            }
        }
        RolePicker(
            selected = member.appRank,
            tag = "service-access-account-rank-${member.rowKey}",
            busy = busy,
            enabled = canChange,
            descriptions = descriptions,
            onRefuse = if (canChange) ({ onRank(null) }) else null,
            onPick = { onRank(it) },
        )
    }
}

@Composable
private fun PersonRow(
    person: AccessPerson,
    role: AppMemberRole?,
    canChangeRank: Boolean,
    descriptions: Map<String, String>,
    alsoIn: String,
    invitedBy: String?,
    canRemove: Boolean,
    canRemoveMembers: Boolean,
    busyRole: Boolean,
    busyRemove: Boolean,
    onRole: (AppMemberRole) -> Unit,
    onRemove: () -> Unit,
    onRemoveMember: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Box(
                    Modifier
                        .size(36.dp)
                        .background(FS.colors.surfaceSunken, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    if (person.isGroup) {
                        Icon(Icons.Filled.Groups, contentDescription = null, tint = FS.colors.textMuted, modifier = Modifier.size(18.dp))
                    } else {
                        Text(person.name.firstOrNull()?.uppercase() ?: "?", color = FS.colors.text, style = TextStyle(fontSize = 13.sp))
                    }
                }
                Column(Modifier.weight(1f)) {
                    Text(person.name, color = FS.colors.text, style = TextStyle(fontSize = 16.sp), maxLines = 1)
                    val sub = if (person.isGroup) {
                        if (person.maxRedemptions == 0) "${person.redemptions} joined"
                        else "${person.redemptions} of ${person.maxRedemptions} joined"
                    } else if (person.bound) "active" else "invite sent — not opened yet"
                    Text(
                        sub,
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 13.sp),
                        modifier = Modifier.semantics { testTag = if (person.isGroup) "service-access-group-row" else "service-access-person-row" },
                    )
                    if (alsoIn.isNotEmpty()) {
                        Text(alsoIn, color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp))
                    }
                }
                role?.let {
                    RolePicker(
                        selected = it,
                        tag = "service-access-role-${person.inviteId}",
                        busy = busyRole,
                        enabled = canChangeRank,
                        descriptions = descriptions,
                        onPick = onRole,
                    )
                }
            }
            if (invitedBy != null || canRemove) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        invitedBy.orEmpty(),
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 12.sp),
                        modifier = Modifier
                            .weight(1f)
                            .semantics { testTag = "service-access-invited-by-${person.inviteId}" },
                    )
                    if (canRemove) {
                        androidx.compose.material3.TextButton(
                            onClick = onRemove,
                            enabled = !busyRemove,
                            modifier = Modifier.semantics {
                                testTag = "service-access-remove-${person.inviteId}"
                                contentDescription = "Revoke ${person.name}"
                            },
                        ) {
                            if (busyRemove) CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp, color = FS.colors.danger)
                            else Text("Revoke", color = FS.colors.danger)
                        }
                    }
                }
            }
            if (person.isGroup && person.memberAids.isNotEmpty() && canRemoveMembers) {
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

private val CROWN_GOLD = Color(0xFFC9A227)

/** Master's crown (Material Icons has none): the same glyph as iOS `crown.fill` and the webapp. */
private val CrownIcon: ImageVector by lazy {
    ImageVector.Builder(name = "Crown", defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
        .path(fill = SolidColor(Color.Black)) {
            moveTo(3f, 7.5f)
            lineTo(7.5f, 11.5f)
            lineTo(12f, 5f)
            lineTo(16.5f, 11.5f)
            lineTo(21f, 7.5f)
            lineTo(19.2f, 18f)
            lineTo(4.8f, 18f)
            close()
            moveTo(4.8f, 19f)
            lineTo(19.2f, 19f)
            lineTo(19.2f, 21f)
            lineTo(4.8f, 21f)
            close()
        }
        .build()
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
