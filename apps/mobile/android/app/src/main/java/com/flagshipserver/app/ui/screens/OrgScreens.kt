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
import androidx.compose.runtime.remember
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

/** Settings → Organizations: the organizations this phone holds a seat in. */
@Composable
fun OrgListScreen(onOpen: (OrgSeatRecord) -> Unit) {
    val rt = LocalOrgs.current
    OrgPage(stringResource(R.string.orgs_title)) {
        Body(stringResource(R.string.orgs_intro), muted = true)
        val seats = remember(rt) { rt?.keys?.seats() ?: emptyList() }
        if (seats.isEmpty()) {
            Body(stringResource(R.string.orgs_none), muted = true, tag = "orgs-none")
        } else {
            FSSectionHeader(stringResource(R.string.orgs_yours))
            seats.forEach { s ->
                FSCard(Modifier.clickable { onOpen(s) }.testTag("org-row-${s.orgName}")) { Body(s.orgName) }
            }
        }
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
    val scope = rememberCoroutineScope()
    LaunchedEffect(seat.id) { vm.load(seat) }
    fun label(id: String) = if (id == seat.seatId) com.flagshipserver.app.core.FSStrings.get(R.string.org_you)
        else com.flagshipserver.app.core.FSStrings.get(R.string.org_seat, id.take(6))
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
                }
            }
        }
        message?.let { Body(it) }
    }
}
