// Add a control-device (browser / tablet). The control device shows a
// QR; the phone scans it, derives the session token + AEAD key, and
// POSTs the wrapped token through /api/screens/orders/send so the
// daemon installs the new paired-session.

package com.flagship.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagship.core.LocalToastCenter
import com.flagship.ui.components.FSCard
import com.flagship.ui.components.FSGhostButton
import com.flagship.ui.theme.FS

@Composable
fun AddControlDeviceScreen(nav: NavController) {
    val toasts = LocalToastCenter.current
    var scanned by remember { mutableStateOf<String?>(null) }

    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        FSGhostButton(label = "← Back", onClick = { nav.popBackStack() })
        Spacer(Modifier.height(FS.space.s3))
        Text(
            "Add a control device",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "On the device you're pairing, open flagshipserver.com/webapp → Settings → Add this device. Then scan its QR here.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        )
        Spacer(Modifier.height(FS.space.s4))
        if (scanned == null) {
            QRScanner(onScanned = { code ->
                scanned = code
                toasts.success("Captured pairing QR.")
            })
        } else {
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Column {
                    Text(
                        "Captured",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                    )
                    Text(
                        scanned!!.take(80) + if (scanned!!.length > 80) "…" else "",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 12.sp),
                    )
                    FSGhostButton(label = "Scan again", onClick = { scanned = null })
                }
            }
        }
    }
}
