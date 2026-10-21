// The Wear OS app, the twin of the Apple Watch app: an install in flight on
// top, then the boxes waiting for a boot approval, the servers and their
// state, and recent account security events. Tapping a waiting box opens its
// Approve page; Approve asks the phone, which signs the approval itself.

package com.flagshipserver.wear

import androidx.compose.ui.res.stringResource
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.ListHeader
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import com.flagshipserver.companion.PendingApproval
import com.flagshipserver.companion.PodStatusText
import com.flagshipserver.companion.WatchContext
import com.flagshipserver.companion.WatchProjection
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class WearMainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WatchStore.read(this)
        setContent { MaterialTheme { WearApp() } }
    }
}

/** [sync] and [approve] reach the phone; a test hands in its own. */
@Composable
internal fun WearApp(
    sync: suspend (android.content.Context) -> Unit = { WatchStore.sync(it) },
    approve: suspend (android.content.Context, PendingApproval) -> com.flagshipserver.companion.ApproveReply =
        { c, a -> PhoneApprover.approve(c, a) },
) {
    val ctx = LocalContext.current
    val nav = rememberSwipeDismissableNavController()
    val context by WatchStore.context.collectAsState()
    LaunchedEffect(Unit) { sync(ctx) }
    val data = context ?: WatchContext.EMPTY
    SwipeDismissableNavHost(navController = nav, startDestination = "home") {
        composable("home") { Home(data) { nav.navigate("approve/${android.net.Uri.encode(it.id)}") } }
        composable("approve/{id}") { entry ->
            val id = entry.arguments?.getString("id")
            // Keep the page once approved, when the box leaves the waiting list.
            var shown by remember { mutableStateOf<PendingApproval?>(null) }
            WatchProjection.approvals(data).firstOrNull { it.id == id }?.let { shown = it }
            val approval = shown
            if (approval == null) Gone() else Approve(approval, approve) { nav.popBackStack() }
        }
    }
}

@Composable
private fun Home(data: WatchContext, onApproval: (PendingApproval) -> Unit) {
    val listState = rememberScalingLazyListState()
    val approvals = WatchProjection.approvals(data)
    val events = WatchProjection.events(data)
    Scaffold(
        timeText = { TimeText() },
        positionIndicator = { PositionIndicator(scalingLazyListState = listState) },
    ) {
        ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
            item { ListHeader { Text("Flagship") } }
            data.provision?.let { p ->
                item {
                    Chip(
                        onClick = {},
                        label = { Text(p.podName ?: stringResource(R.string.new_server), maxLines = 1) },
                        secondaryLabel = { Text(p.detail?.takeIf { p.phase == "error" } ?: WatchProjection.phaseTitle(p.phase), maxLines = 2) },
                        colors = ChipDefaults.secondaryChipColors(),
                        modifier = Modifier.fillMaxWidth().testTag("watch-provision"),
                    )
                }
            }
            if (approvals.isNotEmpty()) {
                item { ListHeader { Text(stringResource(R.string.waiting_for_you)) } }
                items(approvals) { a ->
                    Chip(
                        onClick = { onApproval(a) },
                        label = { Text(a.serverName ?: a.serverFqdn, maxLines = 1) },
                        secondaryLabel = { Text(stringResource(R.string.waiting_to_unlock), maxLines = 1) },
                        colors = ChipDefaults.primaryChipColors(),
                        modifier = Modifier.fillMaxWidth().testTag("watch-approval-${a.serverFqdn}"),
                    )
                }
            }
            if (data.status.pods.isNotEmpty()) {
                item { ListHeader { Text(stringResource(R.string.servers)) } }
                items(data.status.pods) { pod ->
                    Chip(
                        onClick = {},
                        label = { Text(pod.name, maxLines = 1) },
                        secondaryLabel = {
                            Text(PodStatusText.label(pod.statusRaw) + if (pod.isLeader) " · Leader" else "", maxLines = 1)
                        },
                        icon = { StatusDot(pod.statusRaw) },
                        colors = ChipDefaults.secondaryChipColors(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            if (events.isNotEmpty()) {
                item { ListHeader { Text(stringResource(R.string.recent_activity)) } }
                items(events) { e ->
                    Text(
                        WatchProjection.eventLabel(e.kind),
                        style = MaterialTheme.typography.caption1,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                    )
                }
            }
            if (data.status.pods.isEmpty() && approvals.isEmpty() && data.provision == null) {
                item {
                    Text(
                        stringResource(R.string.open_flagship_on_your_phone_to),
                        textAlign = TextAlign.Center,
                        style = MaterialTheme.typography.caption2,
                        modifier = Modifier.padding(8.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun StatusDot(statusRaw: String) {
    val color = Color(com.flagshipserver.companion.StatusPalette.dark(PodStatusText.tone(statusRaw)))
    Box(Modifier.size(10.dp).background(color, CircleShape))
}

@Composable
private fun Approve(
    approval: PendingApproval,
    approve: suspend (android.content.Context, PendingApproval) -> com.flagshipserver.companion.ApproveReply,
    onDone: () -> Unit,
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var approved by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    Scaffold(timeText = { TimeText() }) {
        Column(
            modifier = Modifier.fillMaxSize().padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(approval.serverName ?: approval.serverFqdn, style = MaterialTheme.typography.title3, textAlign = TextAlign.Center)
            Text(
                approval.serverFqdn,
                style = MaterialTheme.typography.caption3.copy(fontFamily = FontFamily.Monospace),
                textAlign = TextAlign.Center,
                maxLines = 2,
            )
            Spacer(Modifier.height(10.dp))
            when {
                busy -> CircularProgressIndicator()
                approved -> Text(stringResource(R.string.approved), color = Color(com.flagshipserver.companion.StatusPalette.DARK_OK), modifier = Modifier.testTag("watch-approved"))
                else -> Button(
                    onClick = {
                        busy = true
                        error = null
                        scope.launch {
                            val reply = approve(ctx, approval)
                            busy = false
                            if (reply.ok) approved = true else error = reply.errorMessage ?: FSStrings.get(R.string.approval_failed)
                        }
                    },
                    modifier = Modifier.testTag("watch-approve"),
                ) { Text(stringResource(R.string.approve)) }
            }
            error?.let {
                Spacer(Modifier.height(6.dp))
                Text(it, color = Color(com.flagshipserver.companion.StatusPalette.DARK_ERR), style = MaterialTheme.typography.caption3, textAlign = TextAlign.Center)
            }
        }
    }
    if (approved) LaunchedEffect(Unit) { delay(1_200); onDone() }
}

@Composable
private fun Gone() {
    Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.Center) {
        Text(stringResource(R.string.this_server_isnt_waiting_any_more), textAlign = TextAlign.Center)
    }
}
