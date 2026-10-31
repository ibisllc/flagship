// The server page's dead-man line (issuance-and-lease-records.md section 5): when the server stops
// serving its apps (or locks) if no admin opens Flagship. Admins tap it (biometric) to change it.
// Mirror of iOS ServingLineCard / ServingEditorSheet.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import com.flagshipserver.app.R
import com.flagshipserver.app.api.AccountServingEntry
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ServingView
import com.flagshipserver.app.core.BootLock
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalSecretMailboxClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.ServerSettingsStore
import com.flagshipserver.app.core.ServingGrace
import com.flagshipserver.app.core.ServingLineKind
import com.flagshipserver.app.core.ServingOnLapse
import com.flagshipserver.app.core.ServingPolicyEditor
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.ServingRenewal
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch
import java.util.Date

internal object ServingLineText {
    fun date(ms: Long): String {
        val skeleton = android.text.format.DateFormat.getBestDateTimePattern(java.util.Locale.getDefault(), "dMMM")
        return java.text.SimpleDateFormat(skeleton, java.util.Locale.getDefault()).format(Date(ms))
    }

    fun graceLabel(g: ServingGrace): String = when (g) {
        ServingGrace.SEVEN_DAYS -> FSStrings.get(R.string.serving_7_days)
        ServingGrace.THIRTY_DAYS -> FSStrings.get(R.string.serving_30_days)
        ServingGrace.INDEFINITE -> FSStrings.get(R.string.serving_never)
    }

    /** The bold head, the rest, and the grace (null for "No time limit"). */
    fun parts(v: ServingView, date: (Long) -> String = ::date): Triple<String, String?, String?> =
        when (val k = ServingLineKind.of(v.graceValue, v.onLapseValue, v.until)) {
            ServingLineKind.NoLimit -> Triple(FSStrings.get(R.string.serving_no_time_limit), null, null)
            is ServingLineKind.StaysOnline -> Triple(FSStrings.get(R.string.serving_stays_online_until, date(k.until)),
                FSStrings.get(R.string.serving_if_no_admin_opens), graceLabel(v.graceValue))
            is ServingLineKind.Locks -> Triple(FSStrings.get(R.string.serving_locks_on, date(k.until)),
                FSStrings.get(R.string.serving_if_no_admin_opens), graceLabel(v.graceValue))
            is ServingLineKind.NoLease -> Triple(FSStrings.get(R.string.serving_waiting_for_an_admin), null, graceLabel(v.graceValue))
        }

    fun plain(v: ServingView, date: (Long) -> String = ::date): String {
        val (head, rest, grace) = parts(v, date)
        return listOfNotNull(listOfNotNull(head, rest).joinToString(" "), grace).joinToString(" · ")
    }
}

@Composable
internal fun ServingCard(
    serverDomain: String,
    serving: ServingView?,
    identityPubKeyHex: String,
    box: ScreensClient?,
    onChanged: () -> Unit,
) {
    val app = LocalAppState.current
    val mailbox = LocalSecretMailboxClient.current
    val toasts = LocalToastCenter.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val readOnly = LocalServerReadOnly.current
    val isAdmin = !readOnly && !app.isDemoAccountNow() && Keystore.hasAdminRoot()
    var comEntry by remember(serverDomain) { mutableStateOf<AccountServingEntry?>(null) }
    var editor by remember { mutableStateOf<ServingPolicyEditor?>(null) }
    var opening by remember { mutableStateOf(false) }

    LaunchedEffect(serverDomain, serving == null) {
        if (serving != null && serving.boxPub?.length == 64) return@LaunchedEffect
        val user = app.currentUser.value ?: return@LaunchedEffect
        if (!isAdmin) return@LaunchedEffect
        comEntry = runCatching { mailbox.fetchServing(user).servers }.getOrNull()
            ?.firstOrNull { it.serverDomain.equals(serverDomain, ignoreCase = true) }
    }

    val view: ServingView = serving ?: comEntry?.let { e ->
        ServingView(
            grace = e.policy?.record?.grace ?: e.grace ?: "indefinite",
            onLapse = e.policy?.record?.onLapse ?: e.onLapse ?: "stop-apps",
            until = e.until, policyGen = e.policy?.record?.policyGen ?: 0, regGen = e.regGen,
            scopeSha256 = e.policy?.record?.scopeSha256 ?: "", boxPub = e.boxPub,
        )
    } ?: return
    val boxPub = (view.boxPub ?: comEntry?.boxPub ?: identityPubKeyHex).lowercase()
    val canEdit = isAdmin && view.scopeSha256.length == 64 && boxPub.length == 64 && view.regGen >= 1
    val (head, rest, grace) = ServingLineText.parts(view)
    val serverName = serverDomain.substringBefore('.')

    FSCard(
        modifier = Modifier
            .semantics { contentDescription = "sd-serving-line" }
            .clickable(enabled = canEdit && !opening, role = Role.Button) {
                scope.launch {
                    opening = true
                    try {
                        val user = app.currentUser.value ?: return@launch
                        val key = runCatching {
                            Keystore.adminRootKey(FSStrings.get(R.string.serving_change_when_stops, serverName))
                        }.getOrNull() ?: return@launch
                        val renewer = ServingRenewal.renewer() ?: return@launch
                        val settings = ServerSettingsStore.from(context)
                        editor = ServingPolicyEditor(
                            current = view, username = user, serverDomain = serverDomain, boxPub = boxPub,
                            adminRoot = key, mailbox = mailbox, box = box, renewer = renewer,
                            revokeAutoUnlock = {
                                val irk = Keystore.deriveIRK(FSStrings.get(R.string.serving_change_when_stops, serverName))
                                BootLock(mailbox).revokeAllLeases(serverDomain, irk, Keystore.irkPubHex())
                            },
                            record = { d, o, g, u -> settings.recordServing(d, o, g, u) },
                        )
                    } finally {
                        opening = false
                    }
                }
            },
    ) {
        Text(
            buildAnnotatedString {
                withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(head) }
                rest?.let { append(" "); append(it) }
                grace?.let {
                    append(" · ")
                    withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(it) }
                }
            },
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }

    editor?.let { ed -> ServingEditorDialog(ed, onDone = { saved ->
        editor = null
        if (saved) {
            toasts.success(FSStrings.get(R.string.saved))
            onChanged()
        }
    }) }
}

@Composable
private fun ServingEditorDialog(editor: ServingPolicyEditor, onDone: (Boolean) -> Unit) {
    val scope = rememberCoroutineScope()
    var grace by remember { mutableStateOf(editor.grace) }
    var lapse by remember { mutableStateOf(editor.onLapse) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val canLock = grace != ServingGrace.INDEFINITE

    AlertDialog(
        onDismissRequest = { if (!saving) onDone(false) },
        confirmButton = {
            TextButton(
                enabled = !saving && editor.changed,
                onClick = {
                    saving = true
                    scope.launch {
                        when (val r = editor.save()) {
                            ServingPolicyEditor.Result.Saved -> onDone(true)
                            is ServingPolicyEditor.Result.Failed -> { error = r.message; saving = false }
                        }
                    }
                },
                modifier = Modifier.semantics { contentDescription = "serving-save" },
            ) { Text(stringResource(R.string.save)) }
        },
        dismissButton = {
            TextButton(onClick = { onDone(false) }, enabled = !saving, modifier = Modifier.semantics { contentDescription = "serving-cancel" }) {
                Text(stringResource(R.string.cancel))
            }
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Text(stringResource(R.string.serving_if_no_admin_opens_for), style = MaterialTheme.typography.titleSmall)
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    ServingGrace.entries.forEachIndexed { i, g ->
                        SegmentedButton(
                            selected = grace == g,
                            onClick = { editor.setGrace(g); grace = editor.grace; lapse = editor.onLapse },
                            shape = SegmentedButtonDefaults.itemShape(i, ServingGrace.entries.size),
                            modifier = Modifier.semantics { contentDescription = "serving-grace-${g.wire}" },
                        ) { Text(ServingLineText.graceLabel(g)) }
                    }
                }
                Text(stringResource(R.string.serving_then), style = MaterialTheme.typography.titleSmall)
                LapseRow(stringResource(R.string.serving_stop_serving_its_apps), lapse == ServingOnLapse.STOP_APPS, true, "serving-lapse-stop") {
                    editor.onLapse = ServingOnLapse.STOP_APPS; lapse = editor.onLapse
                }
                LapseRow(stringResource(R.string.serving_stop_its_apps_and_lock), lapse == ServingOnLapse.LOCK_SERVER, canLock, "serving-lapse-lock") {
                    editor.onLapse = ServingOnLapse.LOCK_SERVER; lapse = editor.onLapse
                }
                Text(
                    stringResource(R.string.serving_locking_restarts_the_server),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                error?.let {
                    Text(it, color = FS.colors.danger, style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.semantics { contentDescription = "serving-error" })
                }
            }
        },
    )
}

@Composable
private fun LapseRow(label: String, selected: Boolean, enabled: Boolean, tag: String, onSelect: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onSelect)
            .semantics { contentDescription = tag },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null, enabled = enabled)
        Text(
            label,
            color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
        )
    }
}
