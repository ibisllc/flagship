// Organizations (docs/enterprise-accounts.md §7, E4): joining from an /org-join link, the list of
// this phone's organizations, and one organization's waiting people and approvals. Mirrors iOS
// OrgJoinScreen / OrgScreens.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.R
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.keystore.OrgSeatRecord
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.OutlinedTextField
import com.flagshipserver.app.core.QrImage
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.LocalOrgs
import com.flagshipserver.app.viewmodels.OrgJoinViewModel
import com.flagshipserver.app.viewmodels.OrgViewModel
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

@Composable
private fun OrgPage(title: String, content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = FS.space.s6),
        verticalArrangement = Arrangement.spacedBy(FS.space.s3),
    ) {
        Spacer(Modifier.height(FS.space.s6))
        Text(title, color = FS.colors.text, style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium))
        content()
        Spacer(Modifier.height(FS.space.s8))
    }
}

@Composable
private fun Body(text: String, muted: Boolean = false, danger: Boolean = false, tag: String? = null) {
    Text(
        text,
        color = when { danger -> FS.colors.danger; muted -> FS.colors.textMuted; else -> FS.colors.text },
        style = TextStyle(fontSize = if (muted) 14.sp else 16.sp),
        modifier = if (tag != null) Modifier.testTag(tag) else Modifier,
    )
}

/** An organization's invitation: who invited the person and under which name, Join, then the code. */
@Composable
fun OrgJoinScreen(orgId: String, seatId: String, keyHex: String, onDone: () -> Unit) {
    val rt = LocalOrgs.current
    OrgPage(stringResource(R.string.org_join_title)) {
        if (rt == null) { Body(stringResource(R.string.org_join_bad_link), danger = true); return@OrgPage }
        val vm = remember(orgId, seatId, keyHex) { OrgJoinViewModel(orgId, seatId, keyHex, rt.client, rt.keys, rt.umk) }
        val phase by vm.phase.collectAsState()
        val busy by vm.busy.collectAsState()
        val scope = rememberCoroutineScope()
        LaunchedEffect(vm) { vm.load() }
        when (val p = phase) {
            OrgJoinViewModel.Phase.Loading -> CircularProgressIndicator()
            is OrgJoinViewModel.Phase.Failed -> Body(p.message, danger = true, tag = "org-join-failed")
            is OrgJoinViewModel.Phase.Ready -> {
                Body(fsString(R.string.org_join_invited_as, p.orgName, p.pseudonym))
                Body(stringResource(R.string.org_join_only_pseudonym), muted = true)
                if (p.isAdminRole) Body(stringResource(R.string.org_join_admin_note), muted = true)
                FSPrimaryButton(stringResource(R.string.org_join_button), onClick = { scope.launch { vm.accept() } },
                    enabled = !busy, block = true, modifier = Modifier.testTag("org-join-accept"))
            }
            is OrgJoinViewModel.Phase.Accepted -> {
                Text(p.code, color = FS.colors.text, textAlign = TextAlign.Center,
                    style = TextStyle(fontSize = 40.sp, fontFamily = FontFamily.Monospace),
                    modifier = Modifier.fillMaxWidth().testTag("org-join-code"))
                Body(stringResource(R.string.org_join_read_code), muted = true)
            }
        }
        FSSecondaryButton(stringResource(R.string.org_done), onClick = onDone, block = true)
    }
}

/** Settings → Organizations: the organizations this phone holds a seat in, and Create (as iOS). */
@Composable
fun OrgListScreen(onOpen: (OrgSeatRecord) -> Unit) {
    val rt = LocalOrgs.current
    OrgPage(stringResource(R.string.orgs_title)) {
        Body(stringResource(R.string.orgs_intro), muted = true)
        if (rt == null) return@OrgPage
        val vm = remember(rt) { OrgViewModel(rt.client, rt.keys, rt.umk) }
        val seats by vm.seats.collectAsState()
        val busy by vm.busy.collectAsState()
        val message by vm.message.collectAsState()
        val scope = rememberCoroutineScope()
        var creating by remember { mutableStateOf(false) }
        var name by remember { mutableStateOf("") }
        if (seats.isEmpty()) {
            Body(stringResource(R.string.orgs_none), muted = true, tag = "orgs-none")
        } else {
            FSSectionHeader(stringResource(R.string.orgs_yours))
            seats.forEach { s ->
                FSCard(Modifier.clickable { onOpen(s) }.testTag("org-row-${s.orgName}")) { Body(s.orgName) }
            }
        }
        if (!creating) {
            FSSecondaryButton(stringResource(R.string.org_create), onClick = { creating = true }, block = true, modifier = Modifier.testTag("org-create"))
        } else {
            FSCard {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Body(stringResource(R.string.org_create_title))
                    OutlinedTextField(value = name, onValueChange = { name = it }, singleLine = true,
                        label = { Text(stringResource(R.string.org_create_name)) }, modifier = Modifier.fillMaxWidth().testTag("org-create-name"))
                    Body(stringResource(R.string.org_create_note), muted = true)
                    FSPrimaryButton(stringResource(R.string.org_create_button), onClick = {
                        scope.launch { if (vm.create(name)) { name = ""; creating = false } }
                    }, enabled = !busy && name.isNotBlank(), block = true, modifier = Modifier.testTag("org-create-confirm"))
                }
            }
        }
        message?.let { Body(it) }
    }
}

/** One organization: people waiting to join and approvals waiting. */
@Composable
fun OrgDetailScreen(seat: OrgSeatRecord) {
    val rt = LocalOrgs.current ?: return
    val vm = remember(seat.id) { OrgViewModel(rt.client, rt.keys, rt.umk) }
    val phase by vm.phase.collectAsState()
    val joins by vm.pendingJoins.collectAsState()
    val snap by vm.snapshot.collectAsState()
    val busy by vm.busy.collectAsState()
    val message by vm.message.collectAsState()
    val rotations by vm.rotations.collectAsState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(seat.id) { vm.load(seat) }
    val names by vm.names.collectAsState()
    val inviteLink by vm.inviteLink.collectAsState()
    var inviting by remember { mutableStateOf(false) }
    var freezeTarget by remember { mutableStateOf<String?>(null) }
    fun label(id: String) = names.let { vm.name(seat, id) }
    OrgPage(seat.orgName) {
        when (val p = phase) {
            OrgViewModel.Phase.Idle, OrgViewModel.Phase.Loading -> CircularProgressIndicator()
            is OrgViewModel.Phase.Failed -> Body(p.message, danger = true)
            OrgViewModel.Phase.Loaded -> {
                val frozen = vm.myFreeze(seat)
                if (frozen != null) {
                    Body(fsString(R.string.org_frozen_until, DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(frozen.untilMs))), danger = true)
                }
                if (joins.isNotEmpty() && !seat.memberOnly) {
                    FSSectionHeader(stringResource(R.string.org_waiting_join))
                    joins.forEach { j ->
                        FSCard {
                            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                                Body(label(j.seatId))
                                j.sas?.let { Body(fsString(R.string.org_their_code, it.take(3), it.takeLast(3)), muted = true) }
                                FSPrimaryButton(stringResource(R.string.org_admit), onClick = { scope.launch { vm.admit(seat, j) } },
                                    enabled = !busy && frozen == null, modifier = Modifier.testTag("org-admit-${j.seatId.take(8)}"))
                            }
                        }
                    }
                }
                if (rotations.isNotEmpty() && !seat.memberOnly) {
                    FSSectionHeader(stringResource(R.string.org_keys_to_rotate))
                    rotations.forEach { r ->
                        FSCard {
                            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                                Body(fsString(R.string.org_left_rotate, label(r.seatId)))
                                r.keys.forEach { (kind, sc) ->
                                    Body(OrgViewModel.keyText(kind, sc), muted = true)
                                    if (kind == com.flagshipserver.app.core.pq.OrgKeyKind.DISK_KEY) Body(stringResource(R.string.org_disk_key_later), muted = true)
                                }
                                if (vm.rotatable(r).isNotEmpty()) {
                                    FSPrimaryButton(stringResource(R.string.org_rotate_keys), onClick = { scope.launch { vm.rotate(seat, r) } },
                                        enabled = !busy && frozen == null, modifier = Modifier.testTag("org-rotate-${r.seatId.take(8)}"))
                                }
                            }
                        }
                    }
                }
                if (!seat.memberOnly) {
                    FSSectionHeader(stringResource(R.string.org_waiting_approval))
                    val list = snap?.ceremonies ?: emptyList()
                    if (list.isEmpty()) Body(stringResource(R.string.org_nothing_to_approve), muted = true)
                    list.forEach { c ->
                        FSCard {
                            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                                Body(OrgViewModel.purposeText(c.purpose))
                                Body(fsString(R.string.org_approved_by, c.approvals.size), muted = true)
                                if (vm.hasApproved(seat, c)) {
                                    Body(stringResource(R.string.org_you_approved), muted = true)
                                } else {
                                    FSPrimaryButton(stringResource(R.string.org_approve), onClick = { scope.launch { vm.approve(seat, c) } },
                                        enabled = !busy && frozen == null, modifier = Modifier.testTag("org-approve-${c.sha256.take(8)}"))
                                }
                            }
                        }
                    }
                    OrgDirectorySections(vm, seat, busy, frozen == null)
                    FSSectionHeader(stringResource(R.string.org_people_approve))
                    vm.admins(seat).forEach { a ->
                        FSCard {
                            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                                Body(label(a.seatId))
                                Body(OrgViewModel.kindText(a.kind, a.isFounder), muted = true)
                                a.frozenUntil?.let { Body(fsString(R.string.org_frozen_until_short, DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(it))), danger = true) }
                                if (!a.isMe && a.kind == com.flagshipserver.app.core.pq.OrgAdminKind.ADMIN && a.frozenUntil == null && frozen == null) {
                                    if (freezeTarget == a.seatId) {
                                        Body(stringResource(R.string.org_freeze_explain), muted = true)
                                        FSPrimaryButton(stringResource(R.string.org_freeze_confirm), onClick = { scope.launch { vm.freeze(seat, a.seatId); freezeTarget = null } },
                                            enabled = !busy, modifier = Modifier.testTag("org-freeze-confirm-${a.seatId.take(8)}"))
                                    } else {
                                        FSSecondaryButton(stringResource(R.string.org_freeze), onClick = { freezeTarget = a.seatId },
                                            modifier = Modifier.testTag("org-freeze-${a.seatId.take(8)}"))
                                    }
                                }
                            }
                        }
                    }
                    FSSectionHeader(stringResource(R.string.org_invite_title))
                    if (!inviting && inviteLink == null) {
                        FSSecondaryButton(stringResource(R.string.org_invite), onClick = { inviting = true }, block = true, modifier = Modifier.testTag("org-invite"))
                    } else {
                        OrgInviteCard(vm, seat, inviteLink, busy) { inviting = false; vm.clearInvite() }
                    }
                }
            }
        }
        message?.let { Body(it) }
    }
}

/** Invite: the pseudonym comes first, then the role; only then is the QR and link made (as iOS). */
@Composable
private fun OrgInviteCard(vm: OrgViewModel, seat: OrgSeatRecord, link: String?, busy: Boolean, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var pseudonym by remember { mutableStateOf("") }
    var role by remember { mutableStateOf(OrgViewModel.InviteRole.MEMBER) }
    var target by remember { mutableStateOf("") }
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            if (link != null) {
                QrImage(link, 220.dp, modifier = Modifier.fillMaxWidth().testTag("org-invite-qr"))
                val share = stringResource(R.string.org_invite_share)
                FSSecondaryButton(share, onClick = {
                    val send = android.content.Intent(android.content.Intent.ACTION_SEND).setType("text/plain").putExtra(android.content.Intent.EXTRA_TEXT, link)
                    context.startActivity(android.content.Intent.createChooser(send, share))
                }, block = true, modifier = Modifier.testTag("org-invite-share"))
                Body(stringResource(R.string.org_invite_after), muted = true)
                FSSecondaryButton(stringResource(R.string.org_done), onClick = onDone, block = true)
            } else {
                Body(stringResource(R.string.org_invite_who))
                OutlinedTextField(value = pseudonym, onValueChange = { pseudonym = it }, singleLine = true,
                    label = { Text(stringResource(R.string.org_invite_pseudonym)) }, modifier = Modifier.fillMaxWidth().testTag("org-invite-pseudonym"))
                Body(stringResource(R.string.org_invite_pseudonym_note), muted = true)
                Body(stringResource(R.string.org_invite_what))
                listOf(
                    OrgViewModel.InviteRole.MEMBER to R.string.org_role_member,
                    OrgViewModel.InviteRole.SERVER_ADMIN to R.string.org_role_server_admin,
                    OrgViewModel.InviteRole.APP_ADMIN to R.string.org_role_app_admin,
                ).forEach { (r, label) ->
                    val chosen = r == role
                    Text((if (chosen) "● " else "○ ") + stringResource(label), color = FS.colors.text,
                        modifier = Modifier.fillMaxWidth().clickable { role = r }.padding(vertical = FS.space.s2).testTag("org-invite-role-${r.name.lowercase()}"))
                }
                if (role != OrgViewModel.InviteRole.MEMBER) {
                    OutlinedTextField(value = target, onValueChange = { target = it }, singleLine = true,
                        label = { Text(stringResource(if (role == OrgViewModel.InviteRole.SERVER_ADMIN) R.string.org_invite_server else R.string.org_invite_app)) },
                        modifier = Modifier.fillMaxWidth().testTag("org-invite-target"))
                }
                FSPrimaryButton(stringResource(R.string.org_invite_make), onClick = { scope.launch { vm.invite(seat, pseudonym, role, target) } },
                    enabled = !busy && pseudonym.isNotBlank() && (role == OrgViewModel.InviteRole.MEMBER || target.isNotBlank()),
                    block = true, modifier = Modifier.testTag("org-invite-make"))
                FSSecondaryButton(stringResource(R.string.org_cancel), onClick = onDone, block = true)
            }
        }
    }
}

/** The admin console's Directory (docs/org-directory.md §6): proposals with Approve, people, connectors (as iOS). */
@Composable
private fun OrgDirectorySections(vm: OrgViewModel, seat: OrgSeatRecord, busy: Boolean, canAct: Boolean) {
    val scope = rememberCoroutineScope()
    val proposals by vm.proposals.collectAsState()
    val people by vm.people.collectAsState()
    val connectors by vm.connectors.collectAsState()
    val fresh by vm.newConnector.collectAsState()
    var picking by remember { mutableStateOf(false) }
    if (proposals.isNotEmpty()) {
        FSSectionHeader(stringResource(R.string.org_directory_proposals))
        proposals.forEach { p ->
            FSCard {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Body(p.entry.pseudonym)
                    if (p.entry.email.isNotEmpty()) Body(p.entry.email, muted = true)
                    Body(OrgViewModel.proposalText(p.kind), muted = true)
                    FSPrimaryButton(stringResource(R.string.org_approve), onClick = { scope.launch { vm.approveProposal(seat, p) } },
                        enabled = !busy && canAct, modifier = Modifier.testTag("org-proposal-approve-${p.id.take(8)}"))
                    FSSecondaryButton(stringResource(R.string.org_decline), onClick = { scope.launch { vm.declineProposal(seat, p) } },
                        enabled = !busy, modifier = Modifier.testTag("org-proposal-decline-${p.id.take(8)}"))
                }
            }
        }
    }
    if (people.isNotEmpty()) {
        FSSectionHeader(stringResource(R.string.org_directory_people))
        people.values.sortedBy { it.pseudonym }.forEach { e ->
            FSCard {
                Column {
                    Body(e.pseudonym)
                    val sub = (listOf(e.email) + e.groups).filter { it.isNotEmpty() }.joinToString(" · ")
                    if (sub.isNotEmpty()) Body(sub, muted = true)
                }
            }
        }
    }
    FSSectionHeader(stringResource(R.string.org_directory_connectors))
    Body(stringResource(R.string.org_directory_connectors_note), muted = true)
    connectors.forEach { k ->
        FSCard { Column { Body(OrgViewModel.connectorText(k.kind)); Body("${k.serverDomain} · ${OrgViewModel.statusText(k.status)}", muted = true) } }
    }
    val f = fresh
    if (f != null) {
        FSCard {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Body(stringResource(R.string.org_connector_token_once))
                Text(f.first, color = FS.colors.text, style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp))
                Text(f.second, color = FS.colors.text, style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp), modifier = Modifier.testTag("org-connector-token"))
                FSSecondaryButton(stringResource(R.string.org_done), onClick = { vm.clearNewConnector() }, block = true)
            }
        }
    } else if (picking) {
        FSCard {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Body(stringResource(R.string.org_connector_which_server))
                vm.servers().forEach { d ->
                    FSSecondaryButton(d, onClick = { picking = false; scope.launch { vm.addScimConnector(seat, d) } }, block = true)
                }
                FSSecondaryButton(stringResource(R.string.org_cancel), onClick = { picking = false }, block = true)
            }
        }
    } else {
        FSSecondaryButton(stringResource(R.string.org_connector_add), onClick = { picking = true }, enabled = !busy && vm.servers().isNotEmpty(),
            block = true, modifier = Modifier.testTag("org-connector-add"))
    }
}
