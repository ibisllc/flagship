// The security notice's banner (docs/security-notices.md section 6.4): one
// dismissible card above the main content, below the status bar. A maintenance
// notice has a teal left rule; the update banner (an advisory, or the grace
// window of an update-required) has a warning tint and rule and an Update
// button that opens the store listing. A status region, not an alert; every
// button is at least 48 dp.

package com.flagshipserver.app.ui.components

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.SecurityNoticeCenter
import com.flagshipserver.app.core.SecurityNoticeCopy
import com.flagshipserver.app.core.SecurityNoticeModels
import com.flagshipserver.app.ui.theme.FS

/** Opens the app's own store listing; false when nothing on the phone can show it. */
fun openStoreListing(context: android.content.Context): Boolean = try {
    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(SecurityNoticeCopy.STORE_URL)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    true
} catch (_: Throwable) {
    false
}

@Composable
fun NoticeBanner(center: SecurityNoticeCenter?) {
    if (center == null) return
    val banner by center.banner.collectAsState()
    val b = banner ?: return
    val model = remember(b) { SecurityNoticeModels.banner(b) }
    val ctx = LocalContext.current
    val toasts = LocalToastCenter.current
    val rule = if (model.update) FS.colors.warning else FS.colors.accent
    val wash = if (model.update) FS.colors.warnWash else FS.colors.surface
    Surface(
        color = wash,
        contentColor = FS.colors.text,
        modifier = Modifier
            .fillMaxWidth()
            .testTag("notice-banner")
            .semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        Row(Modifier.height(IntrinsicSize.Min)) {
            Box(Modifier.width(4.dp).fillMaxHeight().background(rule))
            Column(
                Modifier.weight(1f).padding(horizontal = FS.space.s4, vertical = FS.space.s3),
                verticalArrangement = Arrangement.spacedBy(FS.space.s2),
            ) {
                Text(model.text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("notice-banner-text"))
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), verticalAlignment = Alignment.CenterVertically) {
                    model.action?.let { label ->
                        FSPrimaryButton(
                            label = label,
                            onClick = {
                                if (!openStoreListing(ctx)) toasts.error(SecurityNoticeCopy.UPDATE_FAILED)
                            },
                            modifier = Modifier.heightIn(min = 48.dp).testTag("notice-banner-update"),
                        )
                    }
                    FSGhostButton(
                        label = model.dismiss,
                        onClick = { center.dismiss(b) },
                        modifier = Modifier.heightIn(min = 48.dp).testTag("notice-banner-dismiss"),
                    )
                }
            }
        }
    }
}
