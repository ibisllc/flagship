// Transfer-a-box Compose screens (Layer C, Android). Mirror of iOS
// FlagshipUI/Screens/TransferServerScreens.swift + the webapp giver/acquirer UX.

package com.flagshipserver.app.ui.screens

import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSScreen
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.qrImageBitmap
import com.flagshipserver.app.ui.components.ConfirmTier
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.TieredConfirm
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.TransferAcquirerPhase
import com.flagshipserver.app.viewmodels.TransferAcquirerViewModel
import com.flagshipserver.app.viewmodels.TransferGiverPhase
import com.flagshipserver.app.viewmodels.TransferGiverViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** A tinted callout: an icon and a line on the tone's soft fill. */
@Composable
private fun TransferCallout(text: String, color: androidx.compose.ui.graphics.Color) {
    val palette = FS.colors
    val icon = when (color) {
        palette.success -> Icons.Outlined.CheckCircle
        palette.danger -> Icons.Outlined.ErrorOutline
        else -> Icons.Outlined.Info
    }
    Row(
        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
        verticalAlignment = Alignment.Top,
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(color.copy(alpha = 0.12f))
            .padding(FS.space.s3),
    ) {
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(20.dp))
        Text(text, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyMedium)
    }
}

/** GIVER: irreversible "Transfer to another account" → type-confirm + biometric
 *  → QR. Shown in a full-screen sheet under the server page's
 *  "Transfer server" bar. */
@Composable
fun TransferGiverScreen(vm: TransferGiverViewModel, serverDomain: String) {
    val phase by vm.phase.collectAsState()
    val scope = rememberCoroutineScopeForTransfer()
    var typed by remember { mutableStateOf("") }
    val confirmed = typed.lowercase() == serverDomain.lowercase()
    val scroll = rememberScrollState()

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s4, vertical = FS.space.s2),
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        when (val p = phase) {
            is TransferGiverPhase.AwaitingClaim, is TransferGiverPhase.Resealing -> {
                Text(
                    "Have the new owner scan this",
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.titleLarge,
                )
                Text(
                    "On their phone: Add a server → Take over a transferred server. Keep this screen open until it completes: your phone hands off the disk key after they claim it.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
                vm.qrText?.let {
                    FSCard(modifier = Modifier.fillMaxWidth()) {
                        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                            Image(qrImageBitmap(it), contentDescription = "Transfer QR", modifier = Modifier.size(240.dp))
                        }
                    }
                }
                if (p is TransferGiverPhase.Resealing) {
                    TransferCallout("They claimed it. Handing off the disk key…", FS.colors.primary)
                } else {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        Text(
                            "Waiting for the new owner…",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
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
                Text(
                    "It's no longer in your fleet.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
            else -> {
                if (p is TransferGiverPhase.Failed) TransferCallout(p.message, FS.colors.danger)
                Text(
                    "Transfer to another account",
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.titleLarge,
                )
                Text(
                    "This hands $serverDomain and ALL its contents to another account. You will lose control of it. This cannot be undone.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
                FSField(value = typed, onValueChange = { typed = it }, label = "Type the server's address to confirm", placeholder = serverDomain, fieldTag = "transfer-confirm-field")
                val working = p is TransferGiverPhase.Signing || p is TransferGiverPhase.Posting
                FSDangerButton(
                    label = if (working) "Working…" else "Transfer this server",
                    onClick = { if (confirmed && !working) scope.launch { vm.start() } },
                    enabled = confirmed && !working,
                    block = true,
                    // Parity handle with iOS "transfer-start" (the gym asserts
                    // the ceremony's confirm stage; it never fires the transfer).
                    modifier = Modifier.semantics { contentDescription = "transfer-start" },
                )
            }
        }
    }
}

/** ACQUIRER: "Take over a transferred box" — scan the giver's QR (or open a
 *  pre-ingested `/transfer?o=…` deep link), then a SEVERE tiered confirm
 *  (type-the-domain + biometric) to claim.
 *
 *  [preIngestedOffer] — when non-null (a deep-linked / pasted offer), the offer
 *  is ingested (verified: signature + expiry) on first composition and the
 *  camera is skipped; on a verification failure the Failed state renders with a
 *  "Scan again" fallback. [onBack] defaults to the system back. */
@Composable
fun TransferAcquirerScreen(
    vm: TransferAcquirerViewModel,
    preIngestedOffer: String? = null,
    onBack: (() -> Unit)? = null,
) {
    val phase by vm.phase.collectAsState()
    val scope = rememberCoroutineScopeForTransfer()
    var scanning by remember { mutableStateOf(true) }
    val backDispatcher = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher

    LaunchedEffect(preIngestedOffer) {
        if (!preIngestedOffer.isNullOrEmpty()) {
            scanning = false
            vm.ingest(preIngestedOffer)
        }
    }

    FSScreen(
        title = "Take over a server",
        onBack = onBack ?: { backDispatcher?.onBackPressed() },
    ) {
        when (val p = phase) {
            is TransferAcquirerPhase.Idle -> {
                Text(
                    "Point your camera at the transfer code",
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    "The current owner shows it from their server's page (Transfer to another account).",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
                Column(Modifier.fillMaxWidth().height(320.dp).clip(MaterialTheme.shapes.medium)) {
                    QRScanner(onScanned = { text -> if (scanning) { scanning = false; vm.ingest(text) } })
                }
            }
            is TransferAcquirerPhase.Scanned -> {
                // SEVERE tiered confirm — taking over someone else's box is
                // irreversible, so it demands type-the-domain + biometric. The
                // domain shown is the VERIFIED offer's serverDomain (same bytes
                // the claim signs): what you see is what you sign.
                TieredConfirm(
                    tier = ConfirmTier.SEVERE,
                    title = "Take over this server?",
                    body = "You'll become the owner of ${p.serverDomain} and all its contents. " +
                        "The current owner loses control of it. This can't be undone.",
                    confirmWord = p.serverDomain,
                    confirmLabel = "Take ownership",
                    onConfirm = { scope.launch { vm.confirm() } },
                    fieldTag = "takeover-confirm-field",
                    buttonTag = "takeover-confirm-button",
                )
            }
            is TransferAcquirerPhase.Signing, is TransferAcquirerPhase.Posting -> {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                    Text(
                        "Claiming the server…",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
            }
            is TransferAcquirerPhase.Claimed -> {
                TransferCallout("You now own ${p.newServerDomain ?: "this server"}. It will come online under your account shortly.", FS.colors.success)
            }
            is TransferAcquirerPhase.Failed -> {
                TransferCallout(p.message, FS.colors.danger)
                FSSecondaryButton(label = "Scan again", onClick = { vm.resetForRescan(); scanning = true }, block = true)
            }
        }
    }
}

@Composable
private fun rememberCoroutineScopeForTransfer() = androidx.compose.runtime.rememberCoroutineScope()
