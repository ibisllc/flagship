// Where a link or button into a flow that adds a server (create, co-manage,
// take over, import a backup) lands on a device that isn't an admin device of
// the account (core/AddServerGate.kt). Twin of iOS AddServerAdminOnlyScreen.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.AddServerGate
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout

@Composable
fun AddServerAdminOnlyScreen(onBack: () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            Modifier
                .widthIn(max = FSLayout.readingMaxWidth)
                .padding(FS.space.s6)
                .testTag("add-server-admin-only"),
            verticalArrangement = Arrangement.spacedBy(FS.space.s3),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                "Admin devices only",
                color = FS.colors.text,
                style = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                AddServerGate.ADMIN_ONLY,
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
                textAlign = TextAlign.Center,
            )
            FSGhostButton(label = "Back", onClick = onBack)
        }
    }
}
