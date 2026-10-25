// The server page's "Container stack" (admin devices only): which stack the box runs, Move to the new
// stack (a signed dry run shows the box's plan or why it can't, then Move now sends it), and how the
// move goes. Mirror of iOS StackSwitchCard.swift and the webapp views/stack-switch.js.

package com.flagshipserver.app.ui.screens

import android.text.format.DateUtils
import android.text.format.Formatter
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import com.flagshipserver.app.R
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.StackSwitchRecord
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.StackSwitchViewModel
import kotlinx.coroutines.launch

@Composable
private fun recordLine(r: StackSwitchRecord?): String? {
    val ctx = LocalContext.current
    fun at(ms: Long) = DateUtils.formatDateTime(ctx, ms, DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_TIME or DateUtils.FORMAT_ABBREV_MONTH)
    return when (r?.state) {
        "installing" -> stringResource(R.string.stack_installing)
        "trial" -> fsString(R.string.stack_trial, at(r.trialUntil ?: r.startedAt))
        "done" -> fsString(R.string.stack_done, at(r.finishedAt ?: r.startedAt))
        "reverted" -> fsString(R.string.stack_reverted, r.reason ?: "")
        else -> null
    }
}

@Composable
internal fun StackSwitchCard(serverDomain: String, client: ScreensClient) {
    val vm = remember(serverDomain, client) { StackSwitchViewModel(client, serverDomain) }
    val s by vm.state.collectAsState()
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    LaunchedEffect(vm) { vm.load(); vm.follow() }
    LaunchedEffect(s.restarting) { if (s.restarting) vm.follow() }
    val status = s.status
    if (!s.shows || status == null) return

    Column(Modifier.testTag("stack-card"), verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        FSSectionHeader(stringResource(R.string.stack_title))
        FSCard {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Text(
                    stringResource(if (status.stack == "arch-v2") R.string.stack_current_arch else R.string.stack_current_classic),
                    fontWeight = FontWeight.Medium, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("stack-current"),
                )
                recordLine(status.switchRecord)?.let {
                    Text(it, color = if (status.switchRecord?.state == "reverted") FS.colors.warning else FS.colors.textMuted,
                        style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("stack-record"))
                }
                if (s.moving) LinearProgressIndicator(modifier = Modifier.testTag("stack-moving"))
                val plan = s.review
                if (plan == null) {
                    if (!s.moving) {
                        FSSecondaryButton(
                            stringResource(if (status.plan.target == "classic") R.string.stack_move_back else R.string.stack_move_new),
                            onClick = { scope.launch { vm.prepare() } }, enabled = !s.busy, block = true,
                            modifier = Modifier.testTag("stack-move"),
                        )
                    }
                } else {
                    Column(Modifier.testTag("stack-plan"), verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        Text(stringResource(R.string.stack_plan_title), fontWeight = FontWeight.Medium, style = MaterialTheme.typography.bodySmall)
                        plan.steps.forEachIndexed { i, step ->
                            Text("${i + 1}. $step", style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("stack-step-$i"))
                        }
                        if (plan.needBytes > 0) {
                            Text(
                                fsString(R.string.stack_room, Formatter.formatShortFileSize(ctx, plan.needBytes), Formatter.formatShortFileSize(ctx, plan.freeBytes)),
                                color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("stack-room"),
                            )
                        }
                        plan.blockers.forEachIndexed { i, b ->
                            Text(b.error, color = FS.colors.danger, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("stack-blocker-$i"))
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                            FSPrimaryButton(stringResource(R.string.stack_move_now), onClick = { scope.launch { vm.confirmMove() } },
                                enabled = plan.blockers.isEmpty() && !s.busy, modifier = Modifier.testTag("stack-move-now"))
                            FSSecondaryButton(stringResource(R.string.cancel), onClick = { vm.cancel() }, modifier = Modifier.testTag("stack-cancel"))
                        }
                    }
                }
                s.notice?.let { Text(it, color = FS.colors.success, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("stack-notice")) }
                s.error?.let { Text(it, color = FS.colors.danger, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("stack-error")) }
            }
        }
    }
}
