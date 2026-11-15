// "Set up a box from a store" (docs/retail-box-setup.md §4): renders [RetailClaimViewModel] and
// builds its live dependencies from the create flow. Android twin of iOS RetailClaimScreen +
// RetailClaimContainer.

package com.flagshipserver.app.ui.screens

import android.content.Intent
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.outlined.Report
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.R
import com.flagshipserver.app.api.BoxClaimKeyRequest
import com.flagshipserver.app.core.AddServerGate
import com.flagshipserver.app.core.AndroidBleClaimRadio
import com.flagshipserver.app.core.BoxKeyPins
import com.flagshipserver.app.core.CertPinRegistry
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpClientFactory
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalSecretMailboxClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.MailboxClaimLink
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.RetailBlePermissions
import com.flagshipserver.app.core.RetailClaimCopy
import com.flagshipserver.app.core.RetailClaimDeps
import com.flagshipserver.app.core.RetailClaimKeyException
import com.flagshipserver.app.core.RetailClaimRecipe
import com.flagshipserver.app.core.RetailClaimViewModel
import com.flagshipserver.app.core.RetailClaimViewModel.Phase
import com.flagshipserver.app.core.UntrustedServers
import com.flagshipserver.app.core.Variant
import com.flagshipserver.app.core.decommissionServer
import com.flagshipserver.app.core.deleteServer
import com.flagshipserver.app.core.pq.BoxClaim
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.net.ssl.SSLPeerUnverifiedException

/** Builds the claim's live dependencies: the recipe the create flow mints (with the key that
 *  signed it), `.com`'s directory, and the pinned TLS check. */
@Composable
fun RetailClaimContainer(
    mintRecipe: suspend () -> RetailClaimRecipe,
    onClaimed: (serverDomain: String, serial: String) -> Unit,
    onClose: () -> Unit,
    onOpenServer: (String) -> Unit,
) {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val mailbox = LocalSecretMailboxClient.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val username = app.currentUser.collectAsState().value ?: ""
    val gym = remember { Variant.retailClaimGym() }
    val vm = remember {
        val deps = RetailClaimDeps(
            username = username,
            radio = gym?.radio ?: AndroidBleClaimRadio(context),
            mailboxLink = { MailboxClaimLink(server, it) },
            mintRecipe = mintRecipe,
            registerKey = { key, sig ->
                try {
                    server.registerBoxClaimKey(
                        BoxClaimKeyRequest(
                            BoxClaimKeyRequest.Key(key.username, key.serial, key.serverDomain, key.stkPubHex, key.issuedAt),
                            HexUtil.encode(sig),
                        ),
                    )
                } catch (e: HttpException) {
                    if (e.status == 409) throw RetailClaimKeyException(RetailClaimKeyException.Kind.TAKEN)
                    if (AddServerGate.isServerRefusal(e)) throw RetailClaimKeyException(RetailClaimKeyException.Kind.NOT_ADMIN)
                    throw e
                }
            },
            pinStk = { domain, stk -> BoxKeyPins.shared.repin(username, domain, stk) },
            registeredStk = gym?.registeredStk ?: { domain ->
                runCatching { mailbox.fetchPods(username) }.getOrNull()?.let { r ->
                    CertPinRegistry.shared.update(r.pods)
                    r.pods.firstOrNull { it.serverDomain.equals(domain, ignoreCase = true) && it.revokedAt == null }?.identityPubKey?.lowercase()
                }
            },
            tlsCheck = gym?.tlsCheck ?: { domain -> pinnedTlsCheck(domain) },
            onClaimed = onClaimed,
            markUntrusted = { UntrustedServers.shared.mark(it) },
            region = java.util.Locale.getDefault().country.takeIf { Regex("^[A-Z]{2}$").matches(it) } ?: "",
            pauseMs = if (gym != null) ({ 2_000L }) else ({ BoxClaim.instructionPauseMs() }),
            pollMs = if (gym != null) 500 else 5_000,
            certificateSlowMs = if (gym != null) 3_000 else 300_000,
        )
        RetailClaimViewModel(deps, scope)
    }
    DisposableEffect(Unit) { onDispose { vm.cancel() } }
    RetailClaimScreen(vm = vm, needsPermission = gym == null, onClose = onClose, onOpenServer = onOpenServer)
}

/** Opens the box over the relay with the certificate pin its signed status gave: true when the
 *  handshake holds, false when the pin refused it, null before the box has reported one. */
private suspend fun pinnedTlsCheck(domain: String): Boolean? = withContext(Dispatchers.IO) {
    if (CertPinRegistry.shared.pinFor(domain) == null) return@withContext null
    val req = okhttp3.Request.Builder().url("https://$domain/").get().build()
    try {
        HttpClientFactory.build().newCall(req).execute().close()
        true
    } catch (_: SSLPeerUnverifiedException) {
        false
    } catch (_: Throwable) {
        null
    }
}

@Composable
fun RetailClaimScreen(
    vm: RetailClaimViewModel,
    needsPermission: Boolean,
    onClose: () -> Unit,
    onOpenServer: (String) -> Unit,
) {
    val phase by vm.phase.collectAsState()
    val p = phase
    if (p is Phase.Alarm) {
        AlarmPage(vm, p, onClose)
        return
    }
    FSScreen(
        title = stringResource(R.string.retail_set_up_a_box_from_a_store),
        onBack = { vm.cancel(); onClose() },
        titleTag = "rc-screen",
    ) {
        Page(vm, p, needsPermission, onClose, onOpenServer)
    }
}

@Composable
private fun Header(title: String, body: String?) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        Text(title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.testTag("rc-title"))
        if (body != null) {
            Text(body, style = MaterialTheme.typography.bodyLarge, color = FS.colors.textMuted, modifier = Modifier.testTag("rc-body"))
        }
    }
}

@Composable
private fun Progress() {
    FSCard { LinearProgressIndicator(Modifier.fillMaxWidth()) }
}

@Composable
private fun Page(vm: RetailClaimViewModel, phase: Phase, needsPermission: Boolean, onClose: () -> Unit, onOpenServer: (String) -> Unit) {
    val context = LocalContext.current
    var password by remember { mutableStateOf("") }
    var passwordRefused by remember { mutableStateOf(false) }
    var typed by remember { mutableStateOf("") }
    var explain by remember { mutableStateOf(false) }
    val askPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        explain = false
        vm.startBluetooth()
    }
    fun start() {
        if (needsPermission && (!RetailBlePermissions.granted(context) || !RetailBlePermissions.locationOn(context))) explain = true
        else vm.startBluetooth()
    }

    if (explain) {
        Header(stringResource(R.string.retail_permission_title), stringResource(
            if (RetailBlePermissions.needsLocation) R.string.retail_permission_body_location else R.string.retail_permission_body,
        ))
        if (RetailBlePermissions.needsLocation && !RetailBlePermissions.locationOn(context)) {
            FSPrimaryButton(stringResource(R.string.retail_turn_on_location), {
                context.startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }, block = true, modifier = Modifier.testTag("rc-location"))
        }
        FSPrimaryButton(stringResource(R.string.retail_continue), {
            if (RetailBlePermissions.granted(context)) { explain = false; vm.startBluetooth() }
            else askPermission.launch(RetailBlePermissions.needed)
        }, block = true, large = true, modifier = Modifier.testTag("rc-permission-continue"))
        FSGhostButton(stringResource(R.string.cancel), { explain = false }, block = true)
        return
    }

    when (phase) {
        Phase.Intro -> {
            Header(stringResource(R.string.retail_intro_title), stringResource(R.string.retail_intro_body))
            FSCard {
                Text(stringResource(R.string.retail_cable_tip_title), style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(FS.space.s2))
                Text(stringResource(R.string.retail_cable_tip_body), style = MaterialTheme.typography.bodyMedium, color = FS.colors.textMuted)
            }
            FSPrimaryButton(stringResource(R.string.retail_start), { start() }, block = true, large = true, modifier = Modifier.testTag("rc-start"))
            FSGhostButton(stringResource(R.string.retail_have_setup_code), { vm.showCodeScanner() }, block = true, modifier = Modifier.testTag("rc-code"))
        }
        Phase.ScanCode -> {
            Header(stringResource(R.string.retail_scan_title), stringResource(R.string.retail_scan_body))
            QRScanner(onScanned = { if (BoxClaim.parseSetupCodeLink(it) != null) vm.startWithCode(it) })
            FSField(
                value = typed,
                onValueChange = { typed = it.uppercase() },
                label = stringResource(R.string.retail_type_code),
                fieldTag = "rc-code-field",
            )
            FSPrimaryButton(stringResource(R.string.retail_continue), { vm.startWithCode(typed) },
                enabled = BoxClaim.normalizeSetupCode(typed) != null, block = true, modifier = Modifier.testTag("rc-code-continue"))
        }
        Phase.CheckingNearby -> {
            Header(stringResource(R.string.retail_checking_title), stringResource(R.string.retail_checking_body))
            Progress()
        }
        is Phase.PlugIn -> {
            Header(stringResource(R.string.retail_plug_in_title), stringResource(R.string.retail_plug_in_body))
            Progress()
            if (phase.hint == RetailClaimViewModel.PlugHint.PRESS_ONCE) {
                Text(stringResource(R.string.retail_press_once_hint), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("rc-press-once"))
            }
            if (phase.hint == RetailClaimViewModel.PlugHint.NO_BOX) {
                FSCard(Modifier.testTag("rc-no-box")) {
                    Text(stringResource(R.string.retail_no_new_box), style = MaterialTheme.typography.titleSmall)
                    Spacer(Modifier.height(FS.space.s2))
                    Text(RetailClaimCopy.resetInstructions, style = MaterialTheme.typography.bodyMedium, color = FS.colors.textMuted)
                }
                FSPrimaryButton(stringResource(R.string.retail_try_again), { vm.startBluetooth() }, block = true)
            }
        }
        Phase.Connecting -> { Header(stringResource(R.string.retail_found_title), stringResource(R.string.retail_found_body)); Progress() }
        Phase.GetReady -> { Header(stringResource(R.string.retail_get_ready_title), stringResource(R.string.retail_get_ready_body)); Progress() }
        Phase.PressNow -> {
            Header(stringResource(R.string.retail_press_now_title), stringResource(R.string.retail_press_now_body))
            androidx.compose.foundation.layout.Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Icon(
                    Icons.Filled.PowerSettingsNew, contentDescription = null, tint = FS.colors.accent,
                    modifier = Modifier.size(96.dp).testTag("rc-press-now"),
                )
            }
        }
        Phase.Signing -> { Header(stringResource(R.string.retail_signing_title), stringResource(R.string.retail_signing_body)); Progress() }
        Phase.RegisteringKey -> { Header(stringResource(R.string.retail_registering_title), stringResource(R.string.retail_registering_body)); Progress() }
        Phase.ChooseNetwork -> {
            Header(stringResource(R.string.retail_network_title), null)
            FSPrimaryButton(stringResource(R.string.retail_on_cable), { vm.useCable() }, block = true, large = true, modifier = Modifier.testTag("rc-cable"))
            FSGhostButton(stringResource(R.string.retail_use_wifi), { vm.useWifi() }, block = true, modifier = Modifier.testTag("rc-wifi"))
        }
        Phase.ScanningWifi -> { Header(stringResource(R.string.retail_wifi_scanning_title), stringResource(R.string.retail_wifi_scanning_body)); Progress() }
        is Phase.WifiList -> {
            Header(stringResource(R.string.retail_choose_wifi), if (phase.networks.isEmpty()) stringResource(R.string.retail_no_wifi) else null)
            for (n in phase.networks) {
                FSCard(
                    Modifier
                        .then(if (n.supported) Modifier.clickable { vm.pickNetwork(n.ssid) } else Modifier)
                        .testTag("rc-net-${n.ssid}"),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.Wifi, contentDescription = null)
                        Spacer(Modifier.size(FS.space.s3))
                        Text(n.ssid, color = if (n.supported) MaterialTheme.colorScheme.onSurface else FS.colors.textMuted, modifier = Modifier.weight(1f))
                        if (!n.supported) Text(stringResource(R.string.retail_not_supported), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            FSGhostButton(stringResource(R.string.retail_use_cable_instead), { vm.useCable() }, block = true)
        }
        is Phase.WifiPassword -> {
            Header(stringResource(R.string.retail_wifi_password), phase.ssid)
            FSField(
                value = password,
                onValueChange = { password = it },
                label = stringResource(R.string.retail_password),
                visualTransformation = PasswordVisualTransformation(),
                error = if (passwordRefused) stringResource(R.string.retail_password_length) else null,
                fieldTag = "rc-password",
            )
            FSPrimaryButton(stringResource(R.string.retail_continue), {
                passwordRefused = !vm.submitPassword(phase.ssid, password)
            }, block = true, modifier = Modifier.testTag("rc-password-continue"))
        }
        is Phase.WifiWarning -> {
            Header(stringResource(R.string.retail_before_you_send), RetailClaimCopy.wifiWarning)
            FSPrimaryButton(stringResource(R.string.retail_use_cable_instead), { password = ""; vm.useCable() }, block = true, modifier = Modifier.testTag("rc-warning-cable"))
            FSGhostButton(stringResource(R.string.retail_send_it), { password = ""; vm.sendWifi() }, block = true, modifier = Modifier.testTag("rc-warning-send"))
        }
        Phase.ConnectingNetwork -> { Header(stringResource(R.string.retail_connecting_title), stringResource(R.string.retail_connecting_body)); Progress() }
        is Phase.NetworkFailed -> {
            Header(stringResource(R.string.retail_net_failed_title), RetailClaimCopy.networkFailure(phase.failure))
            FSPrimaryButton(stringResource(R.string.retail_try_again), { vm.retryNetwork() }, block = true, modifier = Modifier.testTag("rc-network-retry"))
        }
        is Phase.CheckingInternet -> {
            Header(stringResource(R.string.retail_checking_online_title), stringResource(R.string.retail_checking_online_body))
            Progress()
        }
        is Phase.GettingCertificate -> {
            Header(stringResource(R.string.retail_certificate_title), stringResource(R.string.retail_certificate_body))
            Box(Modifier.testTag("rc-certificate")) { Progress() }
        }
        is Phase.CertificateSlow -> {
            Header(stringResource(R.string.retail_certificate_slow_title), RetailClaimCopy.certificateSlow)
            FSPrimaryButton(stringResource(R.string.retail_check_again), { vm.checkCertificateAgain() }, block = true, modifier = Modifier.testTag("rc-certificate-again"))
            FSGhostButton(stringResource(R.string.close), onClose, block = true)
        }
        is Phase.Done -> {
            Header(stringResource(R.string.retail_done_title), stringResource(R.string.retail_done_body))
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.testTag("rc-done")) {
                Icon(Icons.Filled.Lock, contentDescription = null)
                Spacer(Modifier.size(FS.space.s2))
                Text(phase.serverDomain)
            }
            FSPrimaryButton(stringResource(R.string.retail_open_server), { onOpenServer(phase.serverDomain) }, block = true, large = true)
        }
        is Phase.Stopped -> {
            Box(Modifier.testTag("rc-stopped")) { Header(phase.stop.title, phase.stop.message) }
            FSPrimaryButton(stringResource(R.string.retail_try_again), { vm.tryAgain() }, block = true, modifier = Modifier.testTag("rc-try-again"))
        }
        is Phase.Failed -> {
            Header(stringResource(R.string.retail_title_stopped), phase.message)
            FSPrimaryButton(stringResource(R.string.retail_try_again), { vm.tryAgain() }, block = true)
        }
        is Phase.Alarm -> Unit
    }
}

@Composable
private fun Box(modifier: Modifier, content: @Composable () -> Unit) = androidx.compose.foundation.layout.Box(modifier) { content() }

/** The full-screen alarm (§7.7): the server is marked untrusted; delete it, then reset the box. */
@Composable
private fun AlarmPage(vm: RetailClaimViewModel, alarm: Phase.Alarm, onClose: () -> Unit) {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val mailbox = LocalSecretMailboxClient.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    var confirm by remember { mutableStateOf<PodInfo?>(null) }
    val onDanger = Color.White
    Column(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.error)
            .verticalScroll(rememberScrollState())
            .padding(FS.space.s6),
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Icon(Icons.Outlined.Report, contentDescription = null, tint = onDanger, modifier = Modifier.size(64.dp))
        Text(stringResource(R.string.retail_alarm_title), style = MaterialTheme.typography.headlineMedium, color = onDanger)
        Text(alarm.alarm.message, style = MaterialTheme.typography.bodyLarge, color = onDanger, modifier = Modifier.testTag("rc-alarm"))
        Text(alarm.serverDomain, style = MaterialTheme.typography.bodyMedium, color = onDanger.copy(alpha = 0.85f))
        Text(RetailClaimCopy.alarmResetInstructions, style = MaterialTheme.typography.bodyMedium, color = onDanger, modifier = Modifier.testTag("rc-alarm-reset"))
        Spacer(Modifier.height(FS.space.s4))
        FSDangerButton(stringResource(R.string.retail_delete_this_server), {
            val domain = alarm.serverDomain.lowercase()
            confirm = app.pods.value.firstOrNull { it.fqdn.lowercase() == domain }
                ?: PodInfo(
                    podId = domain,
                    name = domain.substringBefore('.'),
                    fqdn = domain,
                    identityPubKeyHex = vm.alarmStk.orEmpty(),
                )
        }, block = true, large = true, modifier = Modifier.background(Color.White, MaterialTheme.shapes.extraLarge).testTag("rc-alarm-delete"))
        FSGhostButton(stringResource(R.string.close), onClose, block = true, modifier = Modifier.testTag("rc-alarm-close"))
    }
    confirm?.let { pod ->
        DeleteServerDialog(
            pod = pod,
            onConfirm = {
                confirm = null
                scope.launch {
                    if (pod.status == PodInfo.Status.PENDING) {
                        decommissionServer(pod, app, server, toasts)
                        if (app.pods.value.none { it.podId == pod.podId }) onClose()
                    } else if (deleteServer(pod, app, server, mailbox, toasts)) {
                        onClose()
                    }
                }
            },
            onDismiss = { confirm = null },
        )
    }
}
