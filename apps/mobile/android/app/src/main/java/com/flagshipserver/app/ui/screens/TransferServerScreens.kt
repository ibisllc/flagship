// Transfer-a-box Compose screens (Layer C, Android). Mirror of iOS
// FlagshipUI/Screens/TransferServerScreens.swift + the webapp giver/acquirer UX.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.qrImageBitmap
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.TransferAcquirerPhase
import com.flagshipserver.app.viewmodels.TransferAcquirerViewModel
import com.flagshipserver.app.viewmodels.TransferGiverPhase
import com.flagshipserver.app.viewmodels.TransferGiverViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
private fun TransferCallout(text: String, color: androidx.compose.ui.graphics.Color) {
    Text(
        text,
        color = FS.colors.text,
        style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(FS.radius.sm))
            .padding(FS.space.s3),
    )
}

/** GIVER: irreversible "Transfer to another account" → type-confirm + biometric
 *  → QR. */
@Composable
fun TransferGiverScreen(vm: TransferGiverViewModel, serverDomain: String) {
    val phase by vm.phase.collectAsState()
    val scope = rememberCoroutineScopeForTransfer()
    var typed by remember { mutableStateOf("") }
    val confirmed = typed.lowercase() == serverDomain.lowercase()
    val scroll = rememberScrollState()

    Column(
        Modifier.fillMaxSize().verticalScroll(scroll).padding(FS.space.s6),
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        when (val p = phase) {
            is TransferGiverPhase.AwaitingClaim, is TransferGiverPhase.Resealing -> {
                Text("Have the new owner scan this", color = FS.colors.text, style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold))
                Text(
                    "On their phone: Add a server → Take over a transferred box. Keep this screen open until it completes — your phone hands off the disk key after they claim it.",
                    color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                )
                vm.qrText?.let { Image(qrImageBitmap(it), contentDescription = "Transfer QR", modifier = Modifier.size(240.dp)) }
                if (p is TransferGiverPhase.Resealing) {
                    TransferCallout("They claimed it — handing off the disk key…", FS.colors.primary)
                } else {
                    Text("Waiting for the new owner…", color = FS.colors.textMuted)
                }
                LaunchedEffect(Unit) {
                    while (vm.phase.value is TransferGiverPhase.AwaitingClaim) {
                        if (vm.pollOnce()) break
                        delay(3000)
                    }
                }
            }
            is TransferGiverPhase.Completed -> {
                TransferCallout("Transfer complete. $serverDomain now belongs to the new owner${p.newServerDomain?.let { " (now $it)" } ?: ""}.", FS.colors.success)
                Text("It's no longer in your fleet.", color = FS.colors.textMuted)
            }
            else -> {
                if (p is TransferGiverPhase.Failed) TransferCallout(p.message, FS.colors.danger)
                Text("Transfer to another account", color = FS.colors.text, style = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.Medium))
                Text(
                    "This hands $serverDomain and ALL its contents to another account. You will lose control of it. This cannot be undone.",
                    color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                )
                FSField(value = typed, onValueChange = { typed = it }, label = "Type the server's address to confirm", placeholder = serverDomain, fieldTag = "transfer-confirm-field")
                val working = p is TransferGiverPhase.Signing || p is TransferGiverPhase.Posting
                FSDangerButton(
                    label = if (working) "Working…" else "Transfer this box",
                    onClick = { if (confirmed && !working) scope.launch { vm.start() } },
                    enabled = confirmed && !working,
                    block = true,
                )
            }
        }
    }
}

/** ACQUIRER: "Take over a transferred box" — scan the giver's QR, confirm to claim. */
@Composable
fun TransferAcquirerScreen(vm: TransferAcquirerViewModel) {
    val phase by vm.phase.collectAsState()
    val scope = rememberCoroutineScopeForTransfer()
    var scanning by remember { mutableStateOf(true) }
    val scroll = rememberScrollState()

    Column(
        Modifier.fillMaxSize().verticalScroll(scroll).padding(FS.space.s6),
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        when (val p = phase) {
            is TransferAcquirerPhase.Idle -> {
                Text("Point your camera at the transfer code", color = FS.colors.text, style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold))
                Text("The current owner shows it from their box's page (Transfer to another account).", color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp))
                Column(Modifier.fillMaxWidth().height(320.dp).clip(RoundedCornerShape(FS.radius.md))) {
                    QRScanner(onScanned = { text -> if (scanning) { scanning = false; vm.ingest(text) } })
                }
            }
            is TransferAcquirerPhase.Scanned -> {
                Text("Take over this box?", color = FS.colors.text, style = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.Medium))
                Text("You'll become the owner of ${p.serverDomain} and all its contents. The current owner loses control of it.", color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
                FSPrimaryButton(label = "Take ownership", onClick = { scope.launch { vm.confirm() } }, block = true)
            }
            is TransferAcquirerPhase.Signing, is TransferAcquirerPhase.Posting -> {
                CircularProgressIndicator()
                Text("Claiming the box…", color = FS.colors.textMuted)
            }
            is TransferAcquirerPhase.Claimed -> {
                TransferCallout("You now own ${p.newServerDomain ?: "this box"}. It will come online under your account shortly.", FS.colors.success)
            }
            is TransferAcquirerPhase.Failed -> {
                TransferCallout(p.message, FS.colors.danger)
                FSSecondaryButton(label = "Scan again", onClick = { vm.resetForRescan(); scanning = true })
            }
        }
    }
}

@Composable
private fun rememberCoroutineScopeForTransfer() = androidx.compose.runtime.rememberCoroutineScope()
