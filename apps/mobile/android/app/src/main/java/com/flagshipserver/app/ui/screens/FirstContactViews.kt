// First contact (docs/first-contact.md): the small box directly above Approve at a server's first
// blessing, with the six-digit code computed on this phone from the key the box named (or "Confirmed
// by Studio" when Studio read that very key on the VM's console), and the refusal notices.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.R
import com.flagshipserver.app.core.FirstLook
import com.flagshipserver.app.ui.theme.FS

/** The code box shown directly above Approve on a first sight. */
@Composable
fun ServerCodeBox(look: FirstLook, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(10.dp)
    Column(
        modifier
            .fillMaxWidth()
            .border(1.dp, FS.colors.border, shape)
            .background(FS.colors.surfaceSunken, shape)
            .padding(FS.space.s3)
            .testTag("server-code-box"),
    ) {
        if (look.studioConfirmed) {
            Text(
                stringResource(R.string.server_code_confirmed_by_studio),
                color = FS.colors.text,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.testTag("server-code-studio"),
            )
        } else {
            Text(
                stringResource(R.string.server_code_on_monitor, look.spacedCode),
                color = FS.colors.text,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.testTag("server-code"),
            )
        }
    }
}

/** A refusal: the server's key changed, or it wasn't built from this phone's recipe. */
@Composable
fun FirstContactRefusalNotice(message: String, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(10.dp)
    Text(
        message,
        color = FS.colors.danger,
        style = MaterialTheme.typography.bodyMedium,
        fontWeight = FontWeight.SemiBold,
        modifier = modifier
            .fillMaxWidth()
            .background(FS.colors.dangerWash, shape)
            .padding(FS.space.s3)
            .testTag("first-contact-refusal"),
    )
}
