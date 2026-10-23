// Settings → Devices → "Scan a code or enter a link": one place for every
// Flagship code or link, from the camera or pasted. What comes in goes through
// the universal-link parser and the shell's deep-link router, so it opens the
// screen a tapped link opens: a /join code the join flow (which still shows the
// 6-digit match code the admin compares), an /access link the browser sign-in,
// a share, invite, transfer, Studio or Remote link its own screen. Nothing here
// relies on the camera, so pasting is no weaker than scanning. Replaces
// "Process URL". MIRRORS iOS ScanOrLinkScreen and the webapp's openScanOrLink.

package com.flagshipserver.app.ui.screens

import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.navigation.NavController
import com.flagshipserver.app.R
import com.flagshipserver.app.core.Base64URL
import com.flagshipserver.app.core.DeepLink
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.JoinLink
import com.flagshipserver.app.core.LocalDeepLinker
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS

/** What a scanned or pasted text opens: a Flagship link, or a bare pairing
 *  code (`sid=…&pk=…`) read as the /join link it came from. Null otherwise. */
fun scanOrLinkTarget(raw: String): DeepLink? {
    val text = raw.trim()
    if (text.isEmpty()) return null
    JoinLink.parse(text)?.let { return DeepLink.JoinDevice(it.sid, Base64URL.encode(it.adminPubKey)) }
    return runCatching { DeepLink.parse(Uri.parse(text)) }.getOrNull()
}

@Composable
fun ScanOrLinkScreen(nav: NavController) {
    var text by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val deepLinker = LocalDeepLinker.current
    val clipboard = LocalClipboardManager.current
    // The camera reports a code on every frame it sees; open the first one only.
    var opened by remember { mutableStateOf(false) }

    fun open(raw: String) {
        when (val link = scanOrLinkTarget(raw)) {
            null -> error = FSStrings.get(R.string.that_isnt_a_flagship_code_or_link)
            is DeepLink.AuthorizeKnock -> {
                if (opened) return
                opened = true
                error = null
                val srv = java.net.URLEncoder.encode(link.serverId, "UTF-8")
                val svc = java.net.URLEncoder.encode(link.svc, "UTF-8")
                val ref = java.net.URLEncoder.encode(link.serviceRef, "UTF-8")
                val pg = java.net.URLEncoder.encode(link.pageId, "UTF-8")
                nav.navigate("knock-authorize/$srv/$ref/$pg?svc=$svc")
            }
            else -> {
                if (opened) return
                opened = true
                error = null
                // Leave this screen first so the link's screen isn't stacked on it.
                nav.popBackStack()
                deepLinker.enqueue(link)
            }
        }
    }

    FSScreen(
        title = stringResource(R.string.scan_a_code_or_enter_a_link),
        onBack = { nav.popBackStack() },
        titleTag = "scan-or-link-title",
        subtitle = stringResource(R.string.scan_a_flagship_qr_code_or_paste),
    ) {
        QRScanner(onScanned = { raw -> open(raw) })
        FSField(
            value = text,
            onValueChange = { text = it; error = null },
            label = stringResource(R.string.code_or_link),
            placeholder = "https://${com.flagshipserver.app.core.Endpoints.controlHost}/…",
            error = error,
            fieldTag = "scan-or-link-input",
        )
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), verticalAlignment = Alignment.CenterVertically) {
            FSSecondaryButton(
                label = stringResource(R.string.paste),
                onClick = {
                    clipboard.getText()?.text?.let { text = it; error = null }
                },
                modifier = Modifier.testTag("scan-or-link-paste"),
            )
            FSPrimaryButton(
                label = stringResource(R.string.open_2),
                enabled = text.isNotBlank(),
                onClick = { open(text) },
                modifier = Modifier.weight(1f).testTag("scan-or-link-submit"),
            )
        }
    }
}
