// Activity tab landing: pending unlock-approvals, install timelines,
// post-recovery progress. Tapping a row opens the relevant detail.

package com.flagship.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagship.core.LocalScreensClient
import com.flagship.ui.components.FSCard
import com.flagship.ui.components.FSGhostButton
import com.flagship.ui.components.FSPill
import com.flagship.ui.components.FSPillKind
import com.flagship.ui.theme.FS

@Composable
fun ActivityScreen(nav: NavController) {
    val client = LocalScreensClient.current
    var pendingCount by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        try {
            pendingCount = client.unlockApprovalsPending().pending.size
        } catch (t: Throwable) {
            error = t.message
        }
    }

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        Text(
            "Activity",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "Pending approvals, install timelines, and recovery progress.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp),
        )

        Spacer(Modifier.height(FS.space.s6))

        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    "Unlock requests",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                )
                if (pendingCount == 0) {
                    Text("No pending requests.", color = FS.colors.textMuted)
                } else {
                    FSPill("$pendingCount waiting", kind = FSPillKind.Provisioning)
                }
                FSGhostButton(label = "Open queue", onClick = { nav.navigate("unlock-approvals") })
            }
        }

        Spacer(Modifier.height(FS.space.s3))

        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    "Post-recovery",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                )
                Text(
                    "Membership re-attach snapshot from the most recent IRK swap.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
                FSGhostButton(label = "View report", onClick = { nav.navigate("post-recovery") })
            }
        }

        if (error != null) {
            Spacer(Modifier.height(FS.space.s4))
            ErrorCard(message = error!!)
        }
        Spacer(Modifier.height(FS.space.s12))
    }
}
