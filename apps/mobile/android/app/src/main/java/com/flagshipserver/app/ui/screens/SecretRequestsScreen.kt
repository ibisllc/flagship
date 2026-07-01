// Phone-as-unlock-endpoint approval surface (the v2 sealed-key RELAY flow).
// Kotlin mirror of FlagshipUI/Screens/SecretRequestsScreen.swift.
//
// Opened by the `secret-request` push ("your box is finishing setup — open to
// approve") and routed via DeepLink.SecretRequests. On open it fetches the
// account's pending mailbox requests, RE-VERIFIES each one against the box's
// STK as independently resolved from the directory, and shows the box's
// device-info for a one-tap "Yes, this is my box" confirm. On confirm the
// coordinator unseals/re-seals the LUKS key and posts the reply through .com;
// for "auto" servers it also deposits a box-sealed self-unlock lease (the
// returned lease id is persisted per-server for the kill switch).

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.DeviceInfoHint
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalSecretMailboxClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.SecretPurpose
import com.flagshipserver.app.core.SecretRequestCoordinator
import com.flagshipserver.app.core.ServerSettingsStore
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.KeystoreIrkAccess
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.LoadingState
import kotlinx.coroutines.launch

@Composable
fun SecretRequestsScreen(nav: NavController) {
    val mailbox = LocalSecretMailboxClient.current
    val app = LocalAppState.current
    val toasts = LocalToastCenter.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val username by app.currentUser.collectAsState()
    val pods by app.pods.collectAsState()

    val store = remember { ServerSettingsStore.from(context) }
    var state by remember {
        mutableStateOf<LoadingState<List<SecretRequestCoordinator.VerifiedRequest>>>(LoadingState.Idle)
    }
    var inFlightId by remember { mutableStateOf<String?>(null) }

    val coordinator = remember(username, mailbox) {
        username?.let {
            // Slice D — the entitlement/lease orders minted in the ceremony sign
            // with the admin master root when this device holds one (transport
            // envelopes stay IRK).
            SecretRequestCoordinator(
                mailbox = mailbox,
                username = it,
                irk = KeystoreIrkAccess(),
                adminSigner = { r -> if (Keystore.hasAdminRoot()) Keystore.adminRootKey(r) else null },
            )
        }
    }

    suspend fun reload() {
        val coord = coordinator
        if (coord == null) {
            state = LoadingState.Failed("Sign in to approve a box.")
            return
        }
        state = LoadingState.Loading
        state = try {
            LoadingState.Loaded(coord.fetchVerifiedRequests())
        } catch (t: Throwable) {
            LoadingState.Failed(t.message ?: "Couldn't load requests")
        }
    }

    LaunchedEffect(coordinator) { reload() }

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        FSGhostButton(label = "← Back", onClick = { nav.popBackStack() })
        Spacer(Modifier.height(FS.space.s3))
        Text(
            "Approve box",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s2))
        Text(
            "Your box is finishing setup. Confirm it's yours to release its boot secret — only your phone can.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        )
        Spacer(Modifier.height(FS.space.s6))

        when (val s = state) {
            LoadingState.Idle, LoadingState.Loading -> ServerCardSkeleton()
            is LoadingState.Failed -> ErrorCard(s.message, onRetry = { scope.launch { reload() } })
            is LoadingState.Loaded -> {
                if (s.value.isEmpty()) {
                    FSCard(padding = PaddingValues(FS.space.s4)) {
                        Text(
                            "No box is waiting for approval right now.",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 14.sp),
                        )
                    }
                } else {
                    s.value.forEach { req ->
                        // First boot vs established reboot: a box that has never
                        // come online (no check-in, no cert) is on its FIRST boot,
                        // where this approval also authorizes serving — show the
                        // full copy. A box that has come online before is just
                        // re-unlocking. Unknown (pod not in the list yet) defaults
                        // to first-boot = the fuller copy (today's wording).
                        val isFirstBoot = pods
                            .firstOrNull { it.fqdn.equals(req.serverDomain, ignoreCase = true) }
                            ?.cameOnline?.not() ?: true
                        SecretRequestCard(
                            req = req,
                            isFirstBoot = isFirstBoot,
                            inFlight = inFlightId == req.id,
                            onApprove = {
                                val coord = coordinator ?: return@SecretRequestCard
                                inFlightId = req.id
                                scope.launch {
                                    try {
                                        // "auto" servers (default; absent ⇒ auto) also get a
                                        // box-sealed self-unlock lease. The returned id is the
                                        // kill-switch handle — persist it per-server.
                                        val deposit = store.effectiveMode(req.serverDomain) ==
                                            ServerSettingsStore.Mode.AUTO
                                        val leaseId = coord.confirmAndRespond(req, depositAutoLease = deposit)
                                        if (leaseId != null) store.setLeaseId(req.serverDomain, leaseId)
                                        toasts.success("Approved ${req.serverDomain}. Your box will pick it up.")
                                        reload()
                                    } catch (t: Throwable) {
                                        toasts.error("Approval failed: ${t.message}")
                                    } finally {
                                        inFlightId = null
                                    }
                                }
                            },
                        )
                        Spacer(Modifier.height(FS.space.s3))
                    }
                }
            }
        }
        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun SecretRequestCard(
    req: SecretRequestCoordinator.VerifiedRequest,
    /** The box behind this request has never come online — its FIRST boot. */
    isFirstBoot: Boolean,
    inFlight: Boolean,
    onApprove: () -> Unit,
) {
    // On a FIRST boot the unlock approval ALSO deposits the box's entitlement
    // (consent to boot ⇒ consent to serve), so it both unlocks AND authorizes the
    // box to join the cloud — the fuller copy. On an established reboot the box is
    // already authorized, so the approval is purely a disk unlock; the "…join your
    // cloud" phrase is just noise. (The deposit still fires on every approval —
    // harmless on reboots — so this is copy only.)
    val purposeLabel = when (req.purpose) {
        SecretPurpose.UNLOCK_KEY ->
            if (isFirstBoot) "Unlock device and authorize it to join your cloud"
            else "Unlock device"
        SecretPurpose.ENTITLEMENT -> "Authorize device to join your cloud"
        null -> "Boot secret"
    }
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                req.serverDomain,
                color = FS.colors.text,
                style = TextStyle(fontSize = 16.sp, fontFamily = FontFamily.Monospace),
            )
            Text(
                purposeLabel,
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            req.deviceInfo?.let { info ->
                DeviceInfoRows(info)
            }
            Text(
                "Is this the machine in front of you? Only approve if you recognise it.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
            )
            Spacer(Modifier.height(FS.space.s1))
            FSPrimaryButton(
                label = if (inFlight) "Signing…" else "Yes, this is my box",
                onClick = onApprove,
                enabled = !inFlight,
                block = true,
                large = true,
            )
        }
    }
}

@Composable
private fun DeviceInfoRows(info: DeviceInfoHint) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
        info.ip?.let { InfoRow("IP", it) }
        info.region?.let { InfoRow("Region", it) }
        info.os?.let { InfoRow("OS", it) }
        info.hostname?.let { InfoRow("Host", it) }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row {
        Text(
            label,
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp),
            modifier = Modifier.width(56.dp),
        )
        Text(
            value,
            color = FS.colors.text,
            style = TextStyle(fontSize = 12.sp, fontFamily = FontFamily.Monospace),
        )
    }
}
