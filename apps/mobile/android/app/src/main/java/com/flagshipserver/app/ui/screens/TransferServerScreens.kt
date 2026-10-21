// Transfer-a-box Compose screens (Layer C, Android). Mirror of iOS
// FlagshipUI/Screens/TransferServerScreens.swift + the webapp giver/acquirer UX.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
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
                    stringResource(R.string.have_the_new_owner_scan_this),
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.titleLarge,
                )
                Text(
                    stringResource(R.string.on_their_phone_add_a_server),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
                vm.qrText?.let {
                    FSCard(modifier = Modifier.fillMaxWidth()) {
                        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                            Image(qrImageBitmap(it), contentDescription = stringResource(R.string.transfer_qr), modifier = Modifier.size(240.dp))
                        }
                    }
                }
                if (p is TransferGiverPhase.Resealing) {
                    TransferCallout(stringResource(R.string.they_claimed_it_handing_off_the), FS.colors.primary)
                } else {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        Text(
                            stringResource(R.string.waiting_for_the_new_owner),
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
                TransferCallout(fsString(R.string.transfer_complete_now_belongs_to_the, serverDomain, p.newServerDomain?.let { " (now $it)" } ?: ""), FS.colors.success)
                Text(
                    stringResource(R.string.its_no_longer_in_your_fleet),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
            else -> {
                if (p is TransferGiverPhase.Failed) TransferCallout(p.message, FS.colors.danger)
                Text(
                    stringResource(R.string.transfer_to_another_account),
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.titleLarge,
                )
                Text(
                    fsString(R.string.this_hands_and_all_its_contents, serverDomain),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
                FSField(value = typed, onValueChange = { typed = it }, label = stringResource(R.string.type_the_servers_address_to_confirm), placeholder = serverDomain, fieldTag = "transfer-confirm-field")
                val working = p is TransferGiverPhase.Signing || p is TransferGiverPhase.Posting
                FSDangerButton(
                    label = if (working) stringResource(R.string.working) else stringResource(R.string.transfer_this_server),
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
        title = stringResource(R.string.take_over_a_server),
        onBack = onBack ?: { backDispatcher?.onBackPressed(); Unit },
    ) {
        when (val p = phase) {
            is TransferAcquirerPhase.Idle -> {
                Text(
                    stringResource(R.string.point_your_camera_at_the_transfer),
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    stringResource(R.string.the_current_owner_shows_it_from),
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
                    title = stringResource(R.string.take_over_this_server),
                    body = fsString(R.string.youll_become_the_owner_of_and, p.serverDomain),
                    confirmWord = p.serverDomain,
                    confirmLabel = stringResource(R.string.take_ownership),
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
                        stringResource(R.string.claiming_the_server),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
            }
            is TransferAcquirerPhase.Claimed -> {
                TransferCallout(fsString(R.string.you_now_own_it_will_come, p.newServerDomain ?: stringResource(R.string.this_server_2)), FS.colors.success)
            }
            is TransferAcquirerPhase.Failed -> {
                TransferCallout(p.message, FS.colors.danger)
                FSSecondaryButton(label = stringResource(R.string.scan_again), onClick = { vm.resetForRescan(); scanning = true }, block = true)
            }
        }
    }
}

@Composable
private fun rememberCoroutineScopeForTransfer() = androidx.compose.runtime.rememberCoroutineScope()
