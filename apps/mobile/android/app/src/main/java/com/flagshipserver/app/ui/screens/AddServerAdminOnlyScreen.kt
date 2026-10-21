// Where a link or button into a flow that adds a server (create, co-manage,
// take over, import a backup) lands on a device that isn't an admin device of
// the account (core/AddServerGate.kt). Twin of iOS AddServerAdminOnlyScreen.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.R
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AdminPanelSettings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.core.AddServerGate
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.theme.FS

@Composable
fun AddServerAdminOnlyScreen(onBack: () -> Unit, message: String = AddServerGate.ADMIN_ONLY) {
    FSScreen(title = stringResource(R.string.add_a_server), onBack = onBack, scrollable = false) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(FS.space.s6)
                    .semantics(mergeDescendants = true) {}
                    .testTag("add-server-admin-only"),
                verticalArrangement = Arrangement.spacedBy(FS.space.s3),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(
                    Icons.Outlined.AdminPanelSettings,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(40.dp),
                )
                Text(
                    stringResource(R.string.admin_devices_only),
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.titleLarge,
                    textAlign = TextAlign.Center,
                )
                Text(
                    message,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyLarge,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}
