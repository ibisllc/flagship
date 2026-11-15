// Settings → Messages → Calls (docs/voici-calls.md §8), inside Page options: calls on/off and who may call (published
// in the page index by an admin device) and this device's Do Not Disturb hours. Same rules as iOS
// VoiciCallsSettingsSection.swift; Android has no storefront rule, so no regional note.

package com.flagshipserver.app.ui.screens

import android.app.TimePickerDialog
import android.text.format.DateFormat
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.R
import com.flagshipserver.app.calls.CallQuietHours
import com.flagshipserver.app.calls.CallSettingsStore
import com.flagshipserver.app.calls.VoiciCallSettings
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.voici.VoiciCenter
import com.flagshipserver.app.core.voici.VoiciCopy
import com.flagshipserver.app.core.voici.VoiciPageUi
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.Switch
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch
import java.util.Calendar

@Composable
internal fun VoiciCallsSettings(center: VoiciCenter, page: VoiciPageUi, onError: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val store = remember { CallSettingsStore(context) }
    var quiet by remember { mutableStateOf(store.quietHours()) }
    var busy by remember { mutableStateOf(false) }
    val v = VoiciCallSettings.viewState(isAdmin = page.canPublish, isPublic = page.isPublic, callsOn = page.callsOn)
    val from = if (page.callsOn) page.callsFrom else store.lastFrom()

    fun change(on: Boolean, f: String) {
        store.setLastFrom(f)
        busy = true
        scope.launch {
            if (!center.setCalls(on, f, FSStrings.get(R.string.voici_publish_reason))) center.page.value.error?.let { onError(VoiciCopy.publishError(it)) }
            busy = false
        }
    }

    fun setQuiet(q: CallQuietHours) {
        quiet = q.normalized()
        store.setQuietHours(quiet)
    }

    fun pickTime(minute: Int, set: (Int) -> Unit) {
        TimePickerDialog(context, { _, h, m -> set(h * 60 + m) }, minute / 60, minute % 60, DateFormat.is24HourFormat(context)).show()
    }

    fun label(minute: Int): String {
        val c = Calendar.getInstance().apply { set(Calendar.HOUR_OF_DAY, minute / 60); set(Calendar.MINUTE, minute % 60) }
        return DateFormat.getTimeFormat(context).format(c.time)
    }

    FSGroup(header = stringResource(R.string.voici_calls_header)) {
        FSRow(
            title = stringResource(R.string.voici_calls_accept),
            enabled = v.canEdit && !busy,
            trailing = {
                Switch(
                    checked = page.callsOn,
                    onCheckedChange = { on -> change(on, from) },
                    enabled = v.canEdit && !busy,
                    modifier = Modifier.testTag("page-accept-calls"),
                )
            },
        )
        if (v.showsWho) {
            FSDivider(0.dp)
            Column(Modifier.testTag("page-calls-from")) {
                Text(stringResource(R.string.voici_calls_who), style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = FS.space.s4, vertical = FS.space.s2))
                for ((value, res) in listOf(VoiciCallSettings.FROM_ACCEPTED to R.string.voici_calls_from_accepted, VoiciCallSettings.FROM_SIGNED_IN to R.string.voici_calls_from_signed_in)) {
                    FSRow(
                        title = stringResource(res),
                        enabled = v.canEdit && !busy,
                        modifier = Modifier
                            .selectable(selected = from == value, enabled = v.canEdit && !busy, onClick = { change(true, value) })
                            .testTag("page-calls-from-$value"),
                        trailing = { RadioButton(selected = from == value, onClick = null, enabled = v.canEdit && !busy) },
                    )
                }
            }
        }
    }
    Text(
        stringResource(
            when (v.note) {
                VoiciCallSettings.Note.PublishFirst -> R.string.voici_calls_publish_first
                VoiciCallSettings.Note.AdminOnly -> R.string.voici_calls_admin_only
                null -> R.string.voici_calls_footer
            },
        ),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = FS.space.s4),
    )
    if (v.showsWho && page.canPublish) {
        var lockedBusy by remember { mutableStateOf(false) }
        FSGroup {
            FSRow(
                title = stringResource(R.string.voici_calls_answer_locked),
                enabled = !lockedBusy,
                trailing = {
                    Switch(
                        checked = page.answersWhileLocked,
                        onCheckedChange = { on ->
                            lockedBusy = true
                            scope.launch {
                                center.setAnswerWhileLocked(on)?.let { onError(VoiciCopy.callKeyError(it)) }
                                lockedBusy = false
                            }
                        },
                        enabled = !lockedBusy,
                        modifier = Modifier.testTag("calls-answer-locked"),
                    )
                },
            )
        }
        Text(
            stringResource(R.string.voici_calls_answer_locked_footer),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = FS.space.s4),
        )
    }
    FSGroup {
        FSRow(
            title = stringResource(R.string.voici_calls_dnd),
            trailing = { Switch(checked = quiet.on, onCheckedChange = { setQuiet(quiet.copy(on = it)) }, modifier = Modifier.testTag("calls-dnd")) },
        )
        if (quiet.on) {
            FSDivider(0.dp)
            FSRow(
                title = stringResource(R.string.voici_calls_dnd_from),
                onClick = { pickTime(quiet.startMinute) { setQuiet(quiet.copy(startMinute = it)) } },
                modifier = Modifier.testTag("calls-dnd-from"),
                trailing = { Text(label(quiet.startMinute)) },
            )
            FSDivider(0.dp)
            FSRow(
                title = stringResource(R.string.voici_calls_dnd_until),
                onClick = { pickTime(quiet.endMinute) { setQuiet(quiet.copy(endMinute = it)) } },
                modifier = Modifier.testTag("calls-dnd-until"),
                trailing = { Text(label(quiet.endMinute)) },
            )
        }
    }
    Text(
        stringResource(R.string.voici_calls_dnd_footer),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = FS.space.s4),
    )
}

