// The server page's "Direct access" section (docs/direct-access-and-domains.md):
// opt in with the privacy warning, then one direct name per app with its state
// and the outside check. Read-only on a device without the admin root. Hidden
// on a box that doesn't serve direct access. Also the app page's share choice
// once its direct name is published. Mirrors iOS `DirectAccessCard.swift`.

package com.flagshipserver.app.ui.screens

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.R
import com.flagshipserver.app.api.DirectAccessText
import com.flagshipserver.app.api.DirectAccountState
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.core.AdminOrderGate
import com.flagshipserver.app.core.DirectName
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalDirectNamesClient
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.ui.components.AlertDialog
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSCardDivider
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.RadioButton
import com.flagshipserver.app.ui.components.Switch
import com.flagshipserver.app.ui.components.TextButton
import com.flagshipserver.app.ui.components.fsFocusRing
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.DirectAccessViewModel
import kotlinx.coroutines.launch

@Composable
internal fun DirectAccessCard(serverDomain: String, box: ScreensClient) {
    val com = LocalDirectNamesClient.current
    val app = LocalAppState.current
    val username = app.currentUser.collectAsState().value.orEmpty()
    val canManage = AdminOrderGate.allows(app)
    val vm = remember(serverDomain, box, com, username, canManage) {
        DirectAccessViewModel(serverDomain, username, box, com, canManage)
    }
    LaunchedEffect(vm) { vm.load() }
    val state by vm.state.collectAsState()
    if (!state.supported) return
    val scope = rememberCoroutineScope()
    var confirmOff by remember { mutableStateOf(false) }

    Column(Modifier.testTag("sd-direct-access"), verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        FSSectionHeader(stringResource(R.string.da_title))
        FSCard(padding = PaddingValues(FS.space.s4)) {
            if (!state.loaded) {
                CircularProgressIndicator()
                return@FSCard
            }
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                if (vm.isOn) {
                    Text(
                        stringResource(R.string.da_on_line),
                        color = FS.colors.text,
                        style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                        modifier = Modifier.testTag("sd-direct-access-state"),
                    )
                    if (vm.addresses.isNotEmpty()) {
                        Muted(fsString(R.string.da_addresses, vm.addresses.joinToString(", ")), Modifier.testTag("sd-direct-access-addresses"))
                    }
                    if (vm.prefixes.isNotEmpty()) Muted(fsString(R.string.da_ranges, vm.prefixes.joinToString(", ")))
                    if (vm.reported.isNotEmpty()) Muted(fsString(R.string.da_reports, vm.reported.joinToString(", ")))
                } else {
                    Text(
                        stringResource(R.string.da_off_line),
                        color = FS.colors.textMuted,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.testTag("sd-direct-access-state"),
                    )
                }

                if (!vm.canManage) {
                    Muted(DirectAccessViewModel.ADMIN_ONLY, Modifier.testTag("sd-direct-access-admin-only"))
                } else if (state.editing) {
                    Text(
                        DirectAccessViewModel.WARNING,
                        color = FS.colors.danger,
                        style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold),
                        modifier = Modifier.testTag("sd-direct-access-warning"),
                    )
                    FSField(
                        value = state.addressesText,
                        onValueChange = vm::setAddressesText,
                        label = stringResource(R.string.da_addresses_label),
                        placeholder = "81.2.69.142",
                        keyboardType = KeyboardType.Uri,
                        fieldTag = "sd-direct-access-addresses-field",
                    )
                    FSField(
                        value = state.prefixesText,
                        onValueChange = vm::setPrefixesText,
                        label = stringResource(R.string.da_ranges_label),
                        placeholder = "2a02:8010:6400::/48",
                        keyboardType = KeyboardType.Uri,
                        fieldTag = "sd-direct-access-prefixes-field",
                    )
                    FSField(
                        value = state.portText,
                        onValueChange = vm::setPortText,
                        label = stringResource(R.string.port),
                        placeholder = "443",
                        keyboardType = KeyboardType.Number,
                        fieldTag = "sd-direct-access-port-field",
                    )
                    FSPrimaryButton(
                        label = if (state.busy) stringResource(R.string.signing) else if (vm.isOn) stringResource(R.string.save) else stringResource(R.string.turn_on),
                        onClick = { scope.launch { vm.saveAccess() } },
                        enabled = !state.busy,
                        block = true,
                        modifier = Modifier.testTag("sd-direct-access-submit"),
                    )
                    FSSecondaryButton(
                        label = stringResource(R.string.cancel),
                        onClick = vm::cancelEditing,
                        block = true,
                        modifier = Modifier.testTag("sd-direct-access-cancel"),
                    )
                } else {
                    FSPrimaryButton(
                        label = if (vm.isOn) stringResource(R.string.change) else stringResource(R.string.turn_on),
                        onClick = vm::startEditing,
                        enabled = !state.busy,
                        block = true,
                        modifier = Modifier.testTag(if (vm.isOn) "sd-direct-access-change" else "sd-direct-access-on"),
                    )
                    if (vm.isOn) {
                        FSDangerButton(
                            label = stringResource(R.string.turn_off),
                            onClick = { confirmOff = true },
                            enabled = !state.busy,
                            block = true,
                            modifier = Modifier.testTag("sd-direct-access-off"),
                        )
                    }
                }

                val rows = vm.rows
                if (vm.isOn || rows.any { it.state != null }) {
                    FSCardDivider()
                    Names(vm, rows, state.busy, onLaunch = { block -> scope.launch { block() } })
                }

                state.error?.let {
                    Text(it, color = FS.colors.danger, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("sd-direct-access-error"))
                } ?: state.notice?.let {
                    Muted(it, Modifier.testTag("sd-direct-access-notice"))
                }
            }
        }
    }

    if (confirmOff) {
        AlertDialog(
            onDismissRequest = { confirmOff = false },
            title = { Text(stringResource(R.string.da_confirm_off_title)) },
            text = { Text(stringResource(R.string.da_confirm_off_body)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmOff = false
                        scope.launch { vm.turnOff() }
                    },
                    modifier = Modifier.testTag("sd-direct-access-confirm-off"),
                ) { Text(stringResource(R.string.turn_off)) }
            },
            dismissButton = { TextButton(onClick = { confirmOff = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }

    state.nameDraft?.let { DirectNameDialog(vm, it, state.busy, state.error) { scope.launch { vm.saveNameDraft() } } }
}

@Composable
private fun Muted(text: String, modifier: Modifier = Modifier) {
    Text(text, color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall, modifier = modifier)
}

@Composable
private fun Names(
    vm: DirectAccessViewModel,
    rows: List<DirectAccessViewModel.Row>,
    busy: Boolean,
    onLaunch: (suspend () -> Unit) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        Text(stringResource(R.string.da_names_title), color = FS.colors.text, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
        Muted(stringResource(R.string.da_names_body))
        if (rows.isEmpty()) Muted(stringResource(R.string.da_no_apps))
        rows.forEach { row -> NameRow(vm, row, busy, onLaunch) }
    }
}

@Composable
private fun NameRow(
    vm: DirectAccessViewModel,
    row: DirectAccessViewModel.Row,
    busy: Boolean,
    onLaunch: (suspend () -> Unit) -> Unit,
) {
    val id = row.serviceId
    Column(Modifier.fillMaxWidth().testTag("sd-direct-name-$id"), verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
        Text(row.appName, color = FS.colors.text, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
        val fqdn = row.fqdn
        if (fqdn == null) {
            Muted(DirectAccessViewModel.OTHER_CREATOR)
            return@Column
        }
        SelectionContainer {
            Text(
                fqdn,
                color = FS.colors.text,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        val s = row.state
        if (s != null) {
            Text(
                DirectAccessText.state(s),
                color = if (s.isPublished) FS.colors.text else FS.colors.textMuted,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.testTag("sd-direct-name-state-$id"),
            )
            if (s.state == "pending") DirectAccessText.reason(s.reason)?.let { Muted(it) }
            if (s.caa == DirectName.CAA_OFF) Muted(stringResource(R.string.da_caa_off_line))
            if (s.addresses.isNotEmpty()) Muted(fsString(R.string.da_points_at, s.addresses.joinToString(", ")))
            s.probe?.let { p ->
                Text(
                    DirectAccessViewModel.probeLine(p),
                    color = if (p.reachable == false) FS.colors.danger else FS.colors.textMuted,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.testTag("sd-direct-name-probe-$id"),
                )
            }
        } else {
            Muted(stringResource(R.string.da_not_turned_on), Modifier.testTag("sd-direct-name-state-$id"))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            if (vm.canManage) {
                if (row.isOn) {
                    FSGhostButton(
                        label = stringResource(R.string.settings),
                        onClick = { vm.editName(row) },
                        modifier = Modifier.testTag("sd-direct-name-edit-$id"),
                    )
                    FSGhostButton(
                        label = stringResource(R.string.turn_off),
                        onClick = { onLaunch { vm.turnOffName(row) } },
                        enabled = !busy,
                        modifier = Modifier.testTag("sd-direct-name-off-$id"),
                    )
                } else if (vm.isOn) {
                    FSGhostButton(
                        label = stringResource(R.string.turn_on),
                        onClick = { onLaunch { vm.turnOnName(row) } },
                        enabled = !busy,
                        modifier = Modifier.testTag("sd-direct-name-on-$id"),
                    )
                }
            }
            if (s?.isPublished == true) {
                FSGhostButton(
                    label = stringResource(R.string.da_check_outside),
                    onClick = { onLaunch { vm.probe(row) } },
                    enabled = !busy,
                    modifier = Modifier.testTag("sd-direct-name-probe-btn-$id"),
                )
            }
        }
    }
}

/** A direct name's settings: the CAA switch and other addresses. */
@Composable
private fun DirectNameDialog(
    vm: DirectAccessViewModel,
    draft: DirectAccessViewModel.NameDraft,
    busy: Boolean,
    error: String?,
    onSave: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = { vm.updateNameDraft(null) },
        title = { Text(stringResource(R.string.da_name_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Text(draft.fqdn, color = FS.colors.text, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        stringResource(R.string.da_caa_toggle),
                        color = FS.colors.text,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.weight(1f),
                    )
                    Switch(
                        checked = draft.pinCaa,
                        onCheckedChange = { vm.updateNameDraft(draft.copy(pinCaa = it)) },
                        modifier = Modifier.testTag("sd-direct-name-caa"),
                    )
                }
                Muted(stringResource(R.string.da_caa_note))
                FSField(
                    value = draft.addressesText,
                    onValueChange = { vm.updateNameDraft(draft.copy(addressesText = it)) },
                    label = stringResource(R.string.da_name_addresses_label),
                    placeholder = "203.0.114.7",
                    keyboardType = KeyboardType.Uri,
                    fieldTag = "sd-direct-name-addresses",
                )
                error?.let {
                    Text(it, color = FS.colors.danger, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("sd-direct-name-error"))
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onSave, enabled = !busy, modifier = Modifier.testTag("sd-direct-name-save")) {
                Text(if (busy) stringResource(R.string.signing) else stringResource(R.string.save))
            }
        },
        dismissButton = { TextButton(onClick = { vm.updateNameDraft(null) }) { Text(stringResource(R.string.cancel)) } },
    )
}

/** The direct name to offer for an app, when it is this account's and published. */
internal fun directShareName(state: DirectAccountState?, slug: String, creator: String, username: String): String? {
    if (!creator.equals(username, ignoreCase = true) || state == null) return null
    val fqdn = DirectName.derivedName(slug, creator, state.apex) ?: return null
    return fqdn.takeIf { state.name(it)?.isPublished == true }
}

/** On an app's page, once its direct name is published: which link to share,
 *  the direct one (straight to the server) or the relay one. */
@Composable
internal fun DirectLinkShareGroup(username: String, slug: String, creator: String, relayUrl: String?) {
    val com = LocalDirectNamesClient.current
    val ctx = LocalContext.current
    var published by remember(slug, creator) { mutableStateOf<String?>(null) }
    var direct by remember { mutableStateOf(true) }
    LaunchedEffect(slug, creator, username) {
        val s = runCatching { com.state(username) }.getOrNull()
        published = directShareName(s, slug, creator, username)
    }
    val name = published ?: return
    val url = if (direct || relayUrl == null) "https://$name" else relayUrl
    Column(Modifier.testTag("app-direct-link"), verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        FSSectionHeader(stringResource(R.string.da_link_to_share))
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(Modifier.testTag("app-direct-link-choice"), verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                ChoiceRow(stringResource(R.string.da_direct), direct, "app-direct-link-direct") { direct = true }
                ChoiceRow(stringResource(R.string.da_through_relay), !direct, "app-direct-link-relay") { direct = false }
            }
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Muted(stringResource(if (direct) R.string.da_direct_note else R.string.da_relay_note))
                SelectionContainer {
                    Text(
                        url.removePrefix("https://"),
                        color = FS.colors.text,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        modifier = Modifier.testTag("app-direct-link-url"),
                    )
                }
                FSGhostButton(
                    label = stringResource(R.string.share_link),
                    onClick = {
                        val send = Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_TEXT, url)
                        }
                        ctx.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    },
                    modifier = Modifier.testTag("app-direct-link-share"),
                )
            }
        }
    }
}

@Composable
private fun ChoiceRow(label: String, selected: Boolean, tag: String, onClick: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .fsFocusRing(8.dp)
            .selectable(selected = selected, onClick = onClick)
            .testTag(tag),
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Text(label, color = FS.colors.text, style = MaterialTheme.typography.bodyMedium)
    }
}
