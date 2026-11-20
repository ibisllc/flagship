// Calls (docs/voici-calls.md §8), inside Social options: calls on/off and who may call (published in the page index by
// an admin device) and the owner's business hours (synced, sealed; never in the page). No Do Not Disturb of the app's
// own: the phone's Do Not Disturb decides (VoiciCallCenter.ensureChannel). Same rules as iOS
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
    var busy by remember { mutableStateOf(false) }
    val v = VoiciCallSettings.viewState(isAdmin = page.canPublish, isPublic = page.isPublic, callsOn = page.callsOn)
    val from = VoiciCallSettings.mode(if (page.callsOn) page.callsFrom else store.lastFrom())

    fun change(on: Boolean, f: String) {
        store.setLastFrom(f)
        busy = true
        scope.launch {
            if (!center.setCalls(on, f, FSStrings.get(R.string.voici_publish_reason))) center.page.value.error?.let { onError(VoiciCopy.publishError(it)) }
            busy = false
        }
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
                // Owner-approved modes (docs/voici-calls.md "Who may call a page"): anyone on the internet, or signed-in
                // callers who allow a call-back (the first-publish default). An older page's "signed-in" or "accepted"
                // shows as call-back, and the next publish writes that.
                for ((value, res) in listOf(
                    VoiciCallSettings.FROM_ANYONE to (R.string.voici_calls_from_anyone to R.string.voici_calls_from_anyone_note),
                    VoiciCallSettings.FROM_CALLBACK to (R.string.voici_calls_from_callback to R.string.voici_calls_from_callback_note),
                )) {
                    FSRow(
                        title = stringResource(res.first),
                        subtitle = stringResource(res.second),
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
    if (v.showsWho && page.callsOn) CallHoursEditor(center, page, true, onError, ::pickTime, ::label)
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
}


/**
 * Call hours (next to who can call): off = calls ring any time; on = only on the picked days between From and Until,
 * in this device's time zone, published in the page index so `.com` honours it for every caller.
 */
@Composable
private fun CallHoursEditor(center: VoiciCenter, page: VoiciPageUi, canEdit: Boolean, onError: (String) -> Unit, pickTime: (Int, (Int) -> Unit) -> Unit, label: (Int) -> String) {
    val scope = rememberCoroutineScope()
    val zone = remember { java.util.TimeZone.getDefault().id }
    val published = VoiciCallSettings.CallHours.from(page.callHours)
    var draft by remember(page.callHours) { mutableStateOf(published ?: VoiciCallSettings.CallHours.default(zone)) }
    var busy by remember { mutableStateOf(false) }
    fun publish(h: VoiciCallSettings.CallHours?) {
        if (h != null && !h.valid) return
        busy = true
        scope.launch {
            if (!center.setCallHours(h?.toHours())) onError(VoiciCopy.publishError(null))
            busy = false
        }
    }
    val enabled = canEdit && !busy
    FSGroup(header = stringResource(R.string.voici_calls_hours)) {
        FSRow(
            title = stringResource(R.string.voici_calls_hours_switch),
            enabled = enabled,
            trailing = {
                Switch(checked = published != null, onCheckedChange = { on -> publish(if (on) draft else null) }, enabled = enabled, modifier = Modifier.testTag("calls-hours"))
            },
        )
        if (published != null) {
            FSDivider(0.dp)
            androidx.compose.foundation.layout.Row(
                Modifier.padding(horizontal = FS.space.s4, vertical = FS.space.s2).testTag("calls-hours-days"),
                horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(FS.space.s1),
            ) {
                for (d in 0..6) {
                    val name = java.time.DayOfWeek.of(d + 1).getDisplayName(java.time.format.TextStyle.NARROW, java.util.Locale.getDefault())
                    androidx.compose.material3.FilterChip(
                        selected = d in draft.days,
                        enabled = enabled,
                        onClick = {
                            val next = draft.copy(days = if (d in draft.days) draft.days - d else draft.days + d)
                            if (next.valid) { draft = next; publish(next) }
                        },
                        label = { Text(name) },
                        modifier = Modifier.testTag("calls-hours-day-$d"),
                    )
                }
            }
            FSRow(title = stringResource(R.string.voici_calls_dnd_from), enabled = enabled, onClick = { pickTime(draft.start) { m -> draft.copy(start = m).takeIf { it.valid }?.let { draft = it; publish(it) } } },
                trailing = { Text(label(draft.start)) }, modifier = Modifier.testTag("calls-hours-from"))
            FSRow(title = stringResource(R.string.voici_calls_dnd_until), enabled = enabled, onClick = { pickTime(draft.end) { m -> draft.copy(end = m).takeIf { it.valid }?.let { draft = it; publish(it) } } },
                trailing = { Text(label(draft.end)) }, modifier = Modifier.testTag("calls-hours-until"))
        }
    }
    Text(
        stringResource(R.string.voici_calls_hours_footer, published?.zone ?: zone),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = FS.space.s4),
    )
}
