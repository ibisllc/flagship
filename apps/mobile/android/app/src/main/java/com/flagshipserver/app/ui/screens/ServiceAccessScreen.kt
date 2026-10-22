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

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
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
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import com.flagshipserver.app.ui.components.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import com.flagshipserver.app.ui.components.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import com.flagshipserver.app.ui.components.Switch
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
import com.flagshipserver.app.core.AppMemberRole
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.QrImage
import com.flagshipserver.app.ui.components.fsTick
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSCardDivider
import com.flagshipserver.app.ui.components.FSMonogram
import com.flagshipserver.app.ui.components.FSNote
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSectionHeader
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

    val server = com.flagshipserver.app.core.LocalFlagshipServerClient.current
    val podClients = com.flagshipserver.app.core.LocalPodClients.current
    val vm = remember(serviceId, serverDomain, screens) {
        val mockBox = com.flagshipserver.app.core.Variant.usesMockClients
        // A server of the account by fqdn; the mock box names the demo's
        // servers under its own account, so it matches by first label.
        val podFor = { fqdn: String ->
            val all = appState.pods.value
            all.firstOrNull { it.fqdn.equals(fqdn, ignoreCase = true) }
                ?: if (mockBox) all.firstOrNull { it.fqdn.substringBefore('.').equals(fqdn.substringBefore('.'), ignoreCase = true) } else null
        }
        val screensFor = { fqdn: String -> podFor(fqdn)?.let { podClients.screens(it) } }
        val serverName = { fqdn: String ->
            podFor(fqdn)?.name?.takeIf { it.isNotBlank() } ?: com.flagshipserver.app.core.AppListScope.firstLabel(fqdn)
        }
        val profileDevice = { appState.activeProfile?.deviceId?.takeIf { it.length == 32 } }
        // A debug gym run's mock box names this phone by a fixed key; a real
        // box by the account device key derived on this phone.
        val fixture = com.flagshipserver.app.core.Variant.serviceAccessFixture(screens)
        if (fixture != null) {
            val deviceId = { profileDevice() ?: fixture.selfDeviceId }
            ServiceAccessViewModel(
                serverDomain = serverDomain, serviceRef = serviceId, username = username, screens = screens,
                client = fixture.client,
                deviceId = deviceId,
                deviceSigner = { _ -> Keystore.accountDeviceSigner(Keystore.currentUmkSeed(), username, deviceId()) },
                ownDevicePubHex = { fixture.selfDevicePub },
                deviceNames = { fixture.deviceNames },
                isAdminDevice = { com.flagshipserver.app.core.AdminOrderGate.allows(appState) },
                screensFor = screensFor,
                serverName = serverName,
            )
        } else {
            ServiceAccessViewModel(
                serverDomain = serverDomain, serviceRef = serviceId, username = username, screens = screens,
                client = com.flagshipserver.app.api.ServiceAccessClient(),
                deviceId = profileDevice,
                deviceNames = {
                    val id = profileDevice()
                    if (id == null) null
                    else com.flagshipserver.app.viewmodels.AccountDeviceNames.load(server, username, id)
                },
                // A demo account's device stands in for its owner (its box pins no root).
                isAdminDevice = { com.flagshipserver.app.core.AdminOrderGate.allows(appState) },
                screensFor = screensFor,
                serverName = serverName,
            )
        }
    }
    ServiceAccessContent(
        vm = vm,
        serviceId = serviceId,
        serviceLabel = serviceLabel,
        onShare = { link -> shareViaSystemSheet(ctx, link) },
        onCopy = { link -> copyToClipboard(ctx, link); toasts.success(FSStrings.get(R.string.link_copied_2)) },
        pickPhoto = null,
        onBack = { nav.popBackStack() },
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
    onBack: (() -> Unit)? = null,
) {
    val toasts = LocalToastCenter.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val phase by vm.phase.collectAsState()
    val restricted by vm.restricted.collectAsState()
    val allPeople by vm.people.collectAsState()
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
    val listScope by vm.listScope.collectAsState()
    val busyScope by vm.busyScope.collectAsState()
    val scopeNeedsPro by vm.scopeNeedsPro.collectAsState()
    val shownServer by vm.shownServer.collectAsState()
    val people = vm.peopleOnShownServer(allPeople, members, listScope)

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
    var confirmScope by remember { mutableStateOf<Boolean?>(null) }
    var replyText by remember { mutableStateOf("") }

    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) {
            val dataUri = readImageAsDataUri(ctx, uri)
            if (dataUri == null) {
                toasts.error(FSStrings.get(R.string.photo_is_too_large_max_256))
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
            if (ok) toasts.success(if (membersOnly) FSStrings.get(R.string.now_members_only) else FSStrings.get(R.string.now_open_to_all))
            else toasts.error(FSStrings.get(R.string.couldnt_change_access_try_again_in))
        }
    }

    FSScreen(
        title = stringResource(R.string.access_control),
        onBack = onBack,
        largeTitle = false,
        titleTag = "service-access-title",
    ) {
        // header
        FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth()) {
            Text(serviceLabel, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleMedium)
        }

        // Open to all | Members only. The members list never changes with it.
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                val view = androidx.compose.ui.platform.LocalView.current
                SingleChoiceSegmentedButtonRow(
                    Modifier
                        .fillMaxWidth()
                        .semantics { testTag = "service-access-restrict-toggle" },
                ) {
                    val enabled = vm.isAdmin && !busyMode && phase !is ServiceAccessPhase.Loading
                    val colors = SegmentedButtonDefaults.colors()
                    SegmentedButton(
                        selected = !restricted,
                        onClick = { if (restricted) { view.fsTick(); applyMode(false) } },
                        enabled = enabled,
                        colors = colors,
                        shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
                        modifier = Modifier.semantics { testTag = "service-access-mode-open" },
                    ) { Text(stringResource(R.string.open_to_all)) }
                    SegmentedButton(
                        selected = restricted,
                        onClick = { if (!restricted) { view.fsTick(); confirmMembersOnly = true } },
                        enabled = enabled,
                        colors = colors,
                        shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
                        modifier = Modifier.semantics { testTag = "service-access-mode-members" },
                    ) { Text(stringResource(R.string.members_only)) }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    if (busyMode) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = FS.colors.primary)
                    val failed = phase as? ServiceAccessPhase.Failed
                    Text(
                        when {
                            phase is ServiceAccessPhase.Loading -> stringResource(R.string.loading)
                            busyMode -> stringResource(R.string.saving)
                            failed != null -> failed.message
                            restricted -> stringResource(R.string.only_members_and_you_can_open)
                            else -> stringResource(R.string.anyone_can_open_it_members_who)
                        },
                        color = if (failed != null && !busyMode) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.semantics { testTag = "service-access-mode-status" },
                    )
                }
                if (!vm.isAdmin) {
                    Text(
                        MODE_ADMIN_ONLY_LINE,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.semantics { testTag = "service-access-mode-admin-only" },
                    )
                }
            }
        }

        // A separate list on each server (a Pro option): the switch on admin
        // devices, and while it's on the picker that retargets the whole screen.
        if (listScope != null && (vm.showsListScopeToggle || vm.listScopeReadOnlyLine != null || vm.showsServerPicker)) {
            ListScopeCard(
                vm = vm,
                busy = busyScope,
                needsPro = scopeNeedsPro,
                shownServer = shownServer,
                onToggle = { on -> confirmScope = on },
                onPick = { fqdn ->
                    scope.launch {
                        vm.selectServer(fqdn)
                        (vm.phase.value as? ServiceAccessPhase.Failed)?.let { toasts.error(it.message) }
                    }
                },
            )
        }

        // Account members: this account's devices and the co-managing accounts.
        val accountMembers = members?.accountMembers.orEmpty()
        if (accountMembers.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSSectionHeader(
                fsString(R.string.account_members, accountMembers.size),
                modifier = Modifier.semantics { testTag = "service-access-account-members-title" },
            )
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    accountMembers.forEachIndexed { idx, m ->
                        if (idx > 0) FSCardDivider()
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
                                    if (vm.setAccountRank(m, r)) toasts.success(if (r == null) FSStrings.get(R.string.is_refused, name) else FSStrings.get(R.string.is_now, name, r.label))
                                    else (vm.phase.value as? ServiceAccessPhase.Failed)?.let { toasts.error(it.message) }
                                }
                            },
                        )
                    }
                }
            }
        }

        // Members (n) — in both modes.
        FSSectionHeader(
            fsString(R.string.members, people.size),
            modifier = Modifier.semantics { testTag = "service-access-members-title" },
        )
        vm.inviteBlockedLine?.let { line ->
            Text(
                line,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = FS.space.s1).semantics { testTag = "service-access-cant-invite" },
            )
        }
        if (vm.canInvite) Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            FSSecondaryButton(
                label = stringResource(R.string.add_person),
                onClick = {
                    adding = InviteTier.PERSONAL_AUTO; vm.clearLink(); name = ""; approveFirst = false; photoDataUri = null
                    newRole = AppMemberRole.fromWire(members?.defaultRole) ?: AppMemberRole.MEMBER
                },
                modifier = Modifier.weight(1f).semantics { testTag = "service-access-add-person" },
                block = true,
            )
            FSSecondaryButton(
                label = stringResource(R.string.add_group),
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
                            if (isGroup) stringResource(R.string.add_a_group) else stringResource(R.string.add_a_person),
                            color = MaterialTheme.colorScheme.onSurface,
                            style = MaterialTheme.typography.titleMedium,
                            modifier = Modifier.weight(1f),
                        )
                        androidx.compose.material3.IconButton(onClick = { adding = null; vm.clearLink() }) {
                            Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.close))
                        }
                    }
                    Text(
                        stringResource(R.string.names_photos_stay_encrypted_to_your),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text(if (isGroup) stringResource(R.string.group_name_only_you_your_servers) else stringResource(R.string.name_only_you_your_servers_see)) },
                        singleLine = true,
                        shape = MaterialTheme.shapes.small,
                        modifier = Modifier
                            .fillMaxWidth()
                            .semantics { testTag = "service-access-name-field" },
                    )
                    val pickedRole = if (vm.isAdmin) newRole else AppMemberRole.MEMBER
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(stringResource(R.string.rank), color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
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
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.semantics { testTag = "service-access-rank-locked" },
                        )
                    }
                    members?.description(pickedRole.wire)?.let {
                        Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                    }
                    if (isGroup) {
                        Text(
                            stringResource(R.string.everyone_who_joins_through_the_link),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                            OutlinedTextField(
                                value = maxRedemptionsText,
                                onValueChange = { maxRedemptionsText = it.filter { c -> c.isDigit() } },
                                label = { Text(stringResource(R.string.limit_0_unlimited)) },
                                singleLine = true,
                                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Number),
                                modifier = Modifier
                                    .weight(1f)
                                    .semantics { testTag = "service-access-group-max" },
                            )
                            OutlinedTextField(
                                value = expiryDaysText,
                                onValueChange = { expiryDaysText = it.filter { c -> c.isDigit() } },
                                label = { Text(stringResource(R.string.expires_in_days)) },
                                singleLine = true,
                                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Number),
                                modifier = Modifier
                                    .weight(1f)
                                    .semantics { testTag = "service-access-group-expiry" },
                            )
                        }
                    } else {
                        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3), verticalAlignment = Alignment.CenterVertically) {
                            FSSecondaryButton(
                                label = if (photoDataUri == null) stringResource(R.string.add_photo_optional) else stringResource(R.string.change_photo),
                                onClick = {
                                    pickPhoto?.invoke()
                                        ?: photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                                },
                            )
                            if (photoDataUri != null) TextButtonClear { photoDataUri = null }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(stringResource(R.string.i_approve_them_before_they_get), color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                            Switch(
                                checked = approveFirst,
                                onCheckedChange = { approveFirst = it },
                                modifier = Modifier.semantics { testTag = "service-access-approve-toggle" },
                            )
                        }
                    }
                    FSPrimaryButton(
                        label = if (busyAdd) stringResource(R.string.creating) else stringResource(R.string.create_invite_link),
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
                                    toasts.success(if (isGroup) FSStrings.get(R.string.group_invite_created) else FSStrings.get(R.string.invite_for_created, name.trim()))
                                    name = ""
                                    photoDataUri = null
                                } else {
                                    toasts.error(FSStrings.get(R.string.couldnt_create_the_invite_try_again_2))
                                }
                            }
                        },
                        modifier = Modifier.semantics { testTag = "service-access-create-invite" },
                    )
                    roleNotice?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                    lastLink?.let { link -> ResultBlock(link = link, onShare = { onShare(link) }, onCopy = { onCopy(link) }) }
                }
            }
        }

        if (people.isEmpty()) {
            FSNote(stringResource(R.string.no_members_yet_add_a_person))
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
                            if (vm.setRole(r, person)) toasts.success(FSStrings.get(R.string.is_now, person.name, r.label))
                            else (vm.phase.value as? ServiceAccessPhase.Failed)?.let { toasts.error(it.message) }
                        }
                    },
                    canRemoveMembers = vm.isAdmin,
                    onRemove = { confirmRemove = person },
                    onRemoveMember = { aid ->
                        scope.launch {
                            if (vm.removeGroupMember(aid)) toasts.success(FSStrings.get(R.string.member_removed))
                            else (vm.phase.value as? ServiceAccessPhase.Failed)?.let { toasts.error(it.message) }
                        }
                    },
                )
            }
        }

        // confirm a manual-approve reply (the author finalizes the loop)
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(stringResource(R.string.confirm_someone_you_approve), color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleMedium)
                Text(
                    stringResource(R.string.for_a_person_you_approve_first),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                )
                OutlinedTextField(
                    value = replyText,
                    onValueChange = { replyText = it },
                    label = { Text(stringResource(R.string.paste_the_confirmation_reply)) },
                    singleLine = false,
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { testTag = "service-access-accept-reply-field" },
                )
                FSPrimaryButton(
                    label = if (busyFinalize) stringResource(R.string.confirming) else stringResource(R.string.confirm_access),
                    enabled = !busyFinalize && replyText.trim().isNotEmpty(),
                    block = true,
                    onClick = {
                        scope.launch {
                            val ok = vm.finalizeAcceptance(replyText.trim())
                            if (ok) { toasts.success(FSStrings.get(R.string.access_confirmed)); replyText = "" }
                            else toasts.error(FSStrings.get(R.string.couldnt_confirm_them_check_the_reply))
                        }
                    },
                    modifier = Modifier.semantics { testTag = "service-access-accept-finalize" },
                )
            }
        }
    }

    confirmRemove?.let { person ->
        com.flagshipserver.app.ui.components.AlertDialog(
            onDismissRequest = { confirmRemove = null },
            title = { Text(if (person.isGroup) fsString(R.string.revoke_the_group, person.name) else fsString(R.string.remove_2, person.name)) },
            text = {
                Text(
                    when {
                        person.isGroup && restricted -> stringResource(R.string.everyone_who_joined_through_this_link)
                        person.isGroup -> stringResource(R.string.everyone_who_joined_through_this_link_2)
                        restricted -> stringResource(R.string.theyre_signed_out_and_kept_out)
                        else -> stringResource(R.string.they_lose_their_rank_and_can)
                    },
                )
            },
            confirmButton = {
                com.flagshipserver.app.ui.components.TextButton(
                    onClick = {
                        val p = person
                        confirmRemove = null
                        removing = removing + p.inviteId
                        scope.launch {
                            val ok = vm.remove(p.inviteId)
                            removing = removing - p.inviteId
                            if (ok) toasts.success(if (p.isGroup) FSStrings.get(R.string.group_revoked) else FSStrings.get(R.string.removed_2))
                            else (vm.phase.value as? ServiceAccessPhase.Failed)?.let { toasts.error(it.message) }
                        }
                    },
                    modifier = Modifier.semantics { testTag = "service-access-remove-confirm" },
                ) { Text(if (person.isGroup) stringResource(R.string.revoke_2) else stringResource(R.string.remove_3)) }
            },
            dismissButton = {
                com.flagshipserver.app.ui.components.TextButton(onClick = { confirmRemove = null }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }

    confirmScope?.let { on ->
        val (title, text) = vm.listScopeConfirm(on)
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmScope = null },
            title = { Text(title) },
            text = { Text(text) },
            confirmButton = {
                androidx.compose.material3.TextButton(
                    onClick = {
                        confirmScope = null
                        scope.launch {
                            if (vm.setListScope(on)) toasts.success(if (on) "Each server now keeps its own list." else "Every server now uses one list.")
                            else (vm.phase.value as? ServiceAccessPhase.Failed)?.let { toasts.error(it.message) }
                        }
                    },
                    modifier = Modifier.semantics { testTag = "service-access-list-scope-confirm" },
                ) { Text(if (on) "Separate lists" else "One list") }
            },
            dismissButton = {
                androidx.compose.material3.TextButton(onClick = { confirmScope = null }) { Text("Cancel") }
            },
        )
    }

    if (confirmMembersOnly) {
        val n = vm.memberPeopleCount
        com.flagshipserver.app.ui.components.AlertDialog(
            onDismissRequest = { confirmMembersOnly = false },
            title = { Text(stringResource(R.string.members_only_2)) },
            text = { Text(if (n == 1) stringResource(R.string.only_this_1_person_will_be) else fsString(R.string.only_these_people_will_be_able, n)) },
            confirmButton = {
                com.flagshipserver.app.ui.components.TextButton(
                    onClick = { confirmMembersOnly = false; applyMode(true) },
                    modifier = Modifier.semantics { testTag = "service-access-members-only-confirm" },
                ) { Text(stringResource(R.string.members_only)) }
            },
            dismissButton = {
                com.flagshipserver.app.ui.components.TextButton(onClick = { confirmMembersOnly = false }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}

/** The "Separate list on each server" switch (admin devices; a Pro option),
 *  its Pro / pending lines, and the server picker while each server keeps its
 *  own list. No purchase link here (store anti-steering). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ListScopeCard(
    vm: ServiceAccessViewModel,
    busy: Boolean,
    needsPro: Boolean,
    shownServer: String,
    onToggle: (Boolean) -> Unit,
    onPick: (String) -> Unit,
) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            if (vm.showsListScopeToggle) {
                val on = vm.listScopeOn
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(com.flagshipserver.app.core.AppListScope.TITLE, color = FS.colors.text, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold))
                        Text(com.flagshipserver.app.core.AppListScope.NOTE, color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp, lineHeight = 17.sp))
                    }
                    if (busy) CircularProgressIndicator(Modifier.size(14.dp).padding(end = FS.space.s2), strokeWidth = 2.dp, color = FS.colors.primary)
                    Switch(
                        checked = on,
                        onCheckedChange = { want -> if (want != on) onToggle(want) },
                        enabled = !busy && (on || !vm.listScopeLocked),
                        modifier = Modifier.semantics { testTag = "service-access-list-scope-toggle" },
                    )
                }
                if (vm.showsListScopeProLine || (needsPro && !on)) {
                    Text(
                        com.flagshipserver.app.core.AppListScope.PRO_LINE,
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 12.sp),
                        modifier = Modifier.semantics { testTag = "service-access-list-scope-pro" },
                    )
                }
            }
            vm.listScopeReadOnlyLine?.let {
                Text(
                    it,
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                    modifier = Modifier.semantics { testTag = "service-access-list-scope-readonly" },
                )
            }
            if (vm.showsListScopePending) {
                Text(
                    com.flagshipserver.app.core.AppListScope.PENDING_LINE,
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 12.sp),
                    modifier = Modifier.semantics { testTag = "service-access-list-scope-pending" },
                )
            }
            if (vm.showsServerPicker) {
                val servers = vm.pickerServers
                SingleChoiceSegmentedButtonRow(
                    Modifier
                        .fillMaxWidth()
                        .semantics { testTag = "service-access-server-picker" },
                ) {
                    servers.forEachIndexed { i, fqdn ->
                        val label = vm.serverLabel(fqdn)
                        SegmentedButton(
                            selected = fqdn == shownServer,
                            onClick = { if (fqdn != shownServer) onPick(fqdn) },
                            enabled = !busy,
                            shape = SegmentedButtonDefaults.itemShape(index = i, count = servers.size),
                            modifier = Modifier.semantics { testTag = "service-access-server-picker-${fqdn.substringBefore('.')}" },
                        ) { Text(label, maxLines = 1) }
                    }
                }
            }
        }
    }
}

internal val RANK_LOCKED_LINE get() = FSStrings.get(R.string.only_an_admin_device_can_give)
internal val MODE_ADMIN_ONLY_LINE get() = FSStrings.get(R.string.only_an_admin_device_can_change_6)
internal val REFUSED_LABEL get() = FSStrings.get(R.string.refused)

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
            modifier = Modifier.semantics { testTag = tag; contentDescription = FSStrings.get(R.string.rank_2, label) },
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            AppMemberRole.entries.forEach { r ->
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(r.label)
                            descriptions[r.wire]?.takeIf { it.isNotEmpty() }?.let {
                                Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
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
                    text = { Text(stringResource(R.string.refuse), color = MaterialTheme.colorScheme.error) },
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
                .size(40.dp)
                .background(MaterialTheme.colorScheme.surfaceContainerHigh, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                if (member.isDevice) Icons.Filled.Smartphone else Icons.Filled.Groups,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
        }
        Column(Modifier.weight(1f)) {
            Text(name, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge, maxLines = 1)
            if (detail.isNotEmpty()) {
                Text(detail, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
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
                if (person.isGroup) {
                    Box(
                        Modifier
                            .size(40.dp)
                            .background(MaterialTheme.colorScheme.surfaceContainerHigh, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Filled.Groups, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
                    }
                } else {
                    FSMonogram(name = person.name, size = 40.dp)
                }
                Column(Modifier.weight(1f)) {
                    Text(person.name, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge, maxLines = 1)
                    val sub = if (person.isGroup) {
                        if (person.maxRedemptions == 0) fsString(R.string.joined, person.redemptions)
                        else fsString(R.string.of_joined, person.redemptions, person.maxRedemptions)
                    } else if (person.bound) "active" else "invite sent — not opened yet"
                    Text(
                        sub,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.semantics { testTag = if (person.isGroup) "service-access-group-row" else "service-access-person-row" },
                    )
                    if (alsoIn.isNotEmpty()) {
                        Text(alsoIn, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
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
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier
                            .weight(1f)
                            .semantics { testTag = "service-access-invited-by-${person.inviteId}" },
                    )
                    if (canRemove) {
                        com.flagshipserver.app.ui.components.TextButton(
                            onClick = onRemove,
                            enabled = !busyRemove,
                            modifier = Modifier.semantics {
                                testTag = "service-access-remove-${person.inviteId}"
                                contentDescription = FSStrings.get(R.string.revoke_3, person.name)
                            },
                        ) {
                            if (busyRemove) CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.error)
                            else Text(stringResource(R.string.revoke_2), color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
            if (person.isGroup && person.memberAids.isNotEmpty() && canRemoveMembers) {
                com.flagshipserver.app.ui.components.TextButton(
                    onClick = { expanded = !expanded },
                    modifier = Modifier.semantics { testTag = "service-access-group-members-toggle" },
                ) {
                    Text(if (expanded) stringResource(R.string.hide_members) else fsString(R.string.manage_members, person.memberAids.size))
                    Icon(
                        if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                        contentDescription = null,
                        modifier = Modifier.padding(start = FS.space.s1).size(18.dp),
                    )
                }
                if (expanded) {
                    person.memberAids.forEach { aid ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                fsString(R.string.member, aid.take(8)),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                modifier = Modifier.weight(1f),
                            )
                            com.flagshipserver.app.ui.components.TextButton(onClick = { onRemoveMember(aid) }) { Text(stringResource(R.string.remove_3)) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TextButtonClear(onClick: () -> Unit) {
    com.flagshipserver.app.ui.components.TextButton(onClick = onClick) { Text(stringResource(R.string.remove_photo)) }
}

@Composable
private fun ResultBlock(link: String, onShare: () -> Unit, onCopy: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        Text(stringResource(R.string.shareable_link), color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleSmall)
        // Inline QR (the rich-channel artifact; the link text below is the fallback).
        QrImage(
            payload = link,
            size = 180.dp,
            contentDescription = stringResource(R.string.invite_qr),
            modifier = Modifier.semantics { testTag = "service-access-share-qr" },
        )
        Text(
            link,
            color = MaterialTheme.colorScheme.onSurface,
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier
                .fillMaxWidth()
                .semantics { testTag = "service-access-share-url" },
        )
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            FSPrimaryButton(
                label = stringResource(R.string.share_3),
                onClick = onShare,
                modifier = Modifier.weight(1f).semantics { testTag = "service-access-share-sheet" },
            )
            FSSecondaryButton(
                label = stringResource(R.string.copy_link),
                onClick = onCopy,
                modifier = Modifier.weight(1f).semantics { testTag = "service-access-copy-btn" },
            )
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
    val chooser = Intent.createChooser(send, FSStrings.get(R.string.share_invite))
    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    ctx.startActivity(chooser)
}

private fun copyToClipboard(ctx: Context, url: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText(FSStrings.get(R.string.flagship_invite), url))
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
