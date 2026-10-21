// The Server approvals list, drawn inside Activity's accordion section.
// Kotlin mirror of the iPhone's inline approvals: pending boot/unlock requests
// with their one-tap confirm (the existing biometric flow), "Nothing waiting for
// you", a loading skeleton, "Try again" on a failed load, and a bounded scroll
// area so a long list never pushes the other titles off screen.
//
// Each request is RE-VERIFIED against the box's STK as independently resolved
// from the directory before it shows (SecretRequestCoordinator), so what is
// listed is what the box really asked. For "auto" servers an approval also
// deposits a box-sealed self-unlock lease (its id is kept per server for the
// kill switch).

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.api.DeviceInfoHint
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalSecretMailboxClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.BootLockStateStore
import com.flagshipserver.app.core.PendingLeaseStore
import com.flagshipserver.app.core.SecretPurpose
import com.flagshipserver.app.core.SecretRequestCoordinator
import com.flagshipserver.app.core.ServerSettingsStore
import com.flagshipserver.app.core.UserErrorText
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.KeystoreIrkAccess
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.ApprovalsModel
import com.flagshipserver.app.viewmodels.LoadingState

/** The words for an empty list. */
internal val APPROVALS_EMPTY get() = FSStrings.get(R.string.nothing_waiting_for_you)

/** The model for this phone's pending approvals; null until an account is signed in. */
@Composable
internal fun rememberApprovals(): ApprovalsModel<SecretRequestCoordinator.VerifiedRequest> {
    val mailbox = LocalSecretMailboxClient.current
    val app = LocalAppState.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val username by app.currentUser.collectAsState()
    val toasts = LocalToastCenter.current
    val store = remember { ServerSettingsStore.from(context) }
    return remember(username, mailbox) {
        // Slice D — the entitlement/lease orders minted in the ceremony sign
        // with the admin master root when this device holds one (transport
        // envelopes stay IRK).
        val coordinator = username?.let {
            SecretRequestCoordinator(
                mailbox = mailbox,
                username = it,
                irk = KeystoreIrkAccess(),
                adminSigner = { r -> if (Keystore.hasAdminRoot()) Keystore.adminRootKey(r) else null },
                pendingLeases = PendingLeaseStore.from(context),
                deadManBound = store::deadManBound,
                lockedServer = BootLockStateStore.from(context)::lastKnownSuspended,
            )
        }
        ApprovalsModel(
            scope = scope,
            idOf = { it.id },
            fetch = {
                val coord = coordinator ?: error(FSStrings.get(R.string.sign_in_to_approve_a_server))
                // Opening the list is the next foreground: send again any lease the
                // worker could not take earlier, so a restart self-unlocks.
                runCatching { coord.retryPendingLeases().forEach { (server, id) -> store.setLeaseId(server, id) } }
                coord.fetchVerifiedRequests()
            },
            respond = { req ->
                // "auto" servers (default; absent ⇒ auto) also get a box-sealed
                // self-unlock lease. The returned id is the kill-switch handle.
                val deposit = store.effectiveMode(req.serverDomain) == ServerSettingsStore.Mode.AUTO
                val leaseId = (coordinator ?: error(FSStrings.get(R.string.sign_in_to_approve_a_server)))
                    .confirmAndRespond(req, depositAutoLease = deposit)
                if (leaseId != null) store.setLeaseId(req.serverDomain, leaseId)
                // Approved, but the worker did not take the lease: it will be sent again.
                else if (deposit && req.purpose == SecretPurpose.UNLOCK_KEY) {
                    toasts.warning(FSStrings.get(R.string.approved_automatic_unlock_couldnt_be_set))
                }
            },
            loadFailure = { UserErrorText.of(it, FSStrings.get(R.string.couldnt_load_requests)) },
            answerFailure = { req, t -> FSStrings.get(R.string.couldnt_approve, req.serverDomain, UserErrorText.of(t)) },
        )
    }
}

@Composable
internal fun ApprovalsList(model: ApprovalsModel<SecretRequestCoordinator.VerifiedRequest>) {
    val app = LocalAppState.current
    val toasts = LocalToastCenter.current
    val pods by app.pods.collectAsState()
    val state by model.state.collectAsState()
    val inFlightId by model.inFlightId.collectAsState()

    Column(Modifier.fillMaxWidth().testTag("activity-approvals-list")) {
        when (val s = state) {
            LoadingState.Idle, LoadingState.Loading -> {
                ServerCardSkeleton()
            }
            is LoadingState.Failed -> ErrorCard(s.message, onRetry = { model.reload() })
            is LoadingState.Loaded -> {
                if (s.value.isEmpty()) {
                    Text(
                        APPROVALS_EMPTY,
                        color = FS.colors.textMuted,
                        modifier = Modifier.testTag("activity-approvals-empty"),
                    )
                } else {
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(max = ACTIVITY_LIST_MAX_HEIGHT)
                            .verticalScroll(rememberScrollState())
                            .testTag("activity-approvals-scroll"),
                        verticalArrangement = Arrangement.spacedBy(FS.space.s3),
                    ) {
                        s.value.forEach { req ->
                            // First boot vs established reboot: a box that has never
                            // come online is on its FIRST boot, where this approval
                            // also authorizes serving, so it gets the fuller copy.
                            // Unknown (pod not in the list yet) = first boot.
                            val isFirstBoot = pods
                                .firstOrNull { it.fqdn.equals(req.serverDomain, ignoreCase = true) }
                                ?.cameOnline?.not() ?: true
                            SecretRequestCard(
                                req = req,
                                isFirstBoot = isFirstBoot,
                                inFlight = inFlightId == req.id,
                                onApprove = {
                                    model.approve(req) { out ->
                                        when (out) {
                                            ApprovalsModel.Outcome.Approved ->
                                                toasts.success(FSStrings.get(R.string.approved_your_server_will_pick_it, req.serverDomain))
                                            // Answered already: the card just goes.
                                            ApprovalsModel.Outcome.AlreadyAnswered -> Unit
                                            is ApprovalsModel.Outcome.Failed -> toasts.error(out.message)
                                        }
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }
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
    // (consent to boot ⇒ consent to serve); on an established reboot it is purely
    // a disk unlock. (The deposit still fires on every approval; this is copy only.)
    val purposeLabel = when (req.purpose) {
        SecretPurpose.UNLOCK_KEY ->
            if (isFirstBoot) stringResource(R.string.unlock_device_and_authorize_it_to)
            else stringResource(R.string.unlock_device)
        SecretPurpose.ENTITLEMENT -> stringResource(R.string.authorize_device_to_join_your_cloud)
        null -> stringResource(R.string.boot_secret)
    }
    FSCard(modifier = Modifier.testTag("secret-request-card")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                req.serverDomain,
                style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Monospace),
            )
            Text(
                purposeLabel,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
            req.deviceInfo?.let { info -> DeviceInfoRows(info) }
            Text(
                stringResource(R.string.is_this_the_machine_in_front),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.height(FS.space.s1))
            FSPrimaryButton(
                label = if (inFlight) stringResource(R.string.signing) else stringResource(R.string.yes_this_is_my_server),
                onClick = onApprove,
                enabled = !inFlight,
                block = true,
                large = true,
                modifier = Modifier.testTag("secret-request-approve"),
            )
        }
    }
}

@Composable
private fun DeviceInfoRows(info: DeviceInfoHint) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1), modifier = Modifier.padding(top = FS.space.s1)) {
        info.ip?.let { InfoRow("IP", it) }
        info.region?.let { InfoRow(stringResource(R.string.region), it) }
        info.os?.let { InfoRow("OS", it) }
        info.hostname?.let { InfoRow("Host", it) }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row {
        Text(
            label,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.width(56.dp),
        )
        Text(
            value,
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
        )
    }
}
