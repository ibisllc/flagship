// Phone-side of the create-a-new-server flow. The user picks a name +
// description, then scans the QR shown on flagshipserver.com/dev or
// the homepage hero. The phone derives the AEAD key, ships the signed
// InstallBlob over /qr-pipe, and hands control back to Home with a
// Pending pod in AppState.
//
// MIRRORS: FlagshipUI/Screens/CreateServerStubScreen.swift +
// CreateServerViewModel. Crypto wiring is intentionally light here —
// the real X25519 / AEAD round-trip lives in QrRelay + Keystore.

package com.flagshipserver.app.ui.screens

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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalQrRelayClient
import com.flagshipserver.app.core.SlugUtil
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch
import java.util.Locale
import java.util.UUID

private enum class Phase { Design, Scan, Pending }

@Composable
fun CreateServerScreen(
    onDelivered: (serverDomain: String, serial: String, name: String, description: String) -> Unit,
    onCancel: () -> Unit,
) {
    val app = LocalAppState.current
    val flagshipServer = LocalFlagshipServerClient.current
    val qrRelay = LocalQrRelayClient.current
    val scope = rememberCoroutineScope()

    var phase by remember { mutableStateOf(Phase.Design) }
    var name by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var qrText by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        Text(
            "New server",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s2))

        when (phase) {
            Phase.Design -> {
                Text(
                    "Pick a short name (used as the subdomain) + a one-liner so the card on Home reads well.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                )
                Spacer(Modifier.height(FS.space.s4))
                FSCard(padding = PaddingValues(FS.space.s4)) {
                    Column {
                        FSField(value = name, onValueChange = { name = it }, label = "Name")
                        Spacer(Modifier.height(FS.space.s2))
                        FSField(value = description, onValueChange = { description = it }, label = "Description")
                        Spacer(Modifier.height(FS.space.s2))
                        Text(
                            "Subdomain preview: ${SlugUtil.slugify(name).ifEmpty { "name" }}.${(app.currentUser.value ?: "you")}.flagship.services",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 12.sp),
                        )
                    }
                }
                Spacer(Modifier.height(FS.space.s4))
                FSPrimaryButton(
                    label = "Continue",
                    onClick = {
                        if (name.isBlank()) { error = "Name required."; return@FSPrimaryButton }
                        error = null
                        phase = Phase.Scan
                    },
                    block = true,
                )
                FSGhostButton(label = "Cancel", onClick = onCancel, block = true)
            }
            Phase.Scan -> {
                Text(
                    "Scan or paste the code shown on flagshipserver.com. Both screens stay open until the browser confirms delivery.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                )
                Spacer(Modifier.height(FS.space.s4))
                QRScanner(
                    onScanned = { scanned ->
                        qrText = scanned
                        if (!working) {
                            scope.launch {
                                working = true
                                try {
                                    val parsed = com.flagshipserver.app.core.QrRelay.parseQrUrl(scanned)
                                    val phonePub = "" // X25519 pub bytes; stubbed for now
                                    qrRelay.openAndHello(parsed.sid, phonePub)
                                    // Stub deliver — real impl crafts the AEAD ciphertext
                                    qrRelay.deliver("", "")
                                    val serial = com.flagshipserver.app.core.SerialGen.random()
                                    val slug = SlugUtil.slugify(name)
                                    val username = app.currentUser.value ?: "you"
                                    val fqdn = "$slug.$username.flagship.services"
                                    onDelivered(fqdn, serial, name, description)
                                } catch (t: Throwable) {
                                    error = t.message
                                } finally {
                                    working = false
                                }
                            }
                        }
                    },
                )
                Spacer(Modifier.height(FS.space.s4))
                FSField(value = qrText, onValueChange = { qrText = it }, label = "Or paste code manually")
                if (error != null) {
                    Spacer(Modifier.height(FS.space.s2))
                    Text(
                        error!!,
                        color = FS.colors.danger,
                        style = TextStyle(fontSize = 13.sp),
                    )
                }
                FSGhostButton(label = "Cancel", onClick = onCancel, block = true)
            }
            Phase.Pending -> {
                Text("Delivered. Watch Home for the new pod.", color = FS.colors.text)
            }
        }
        Spacer(Modifier.height(FS.space.s12))
    }
}
