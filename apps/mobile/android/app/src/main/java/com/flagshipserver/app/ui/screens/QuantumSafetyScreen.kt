package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavController
import com.flagshipserver.app.core.HttpClientFactory
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.OkHttpJsonTransport
import com.flagshipserver.app.core.pq.QuantumSafety
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.QuantumSafetyService
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.QuantumSafetyViewModel

/**
 * Settings → Quantum-safe protection (the port in spirit of iOS's screen). Strict is opt-in per
 * server and signed by the admin root, or by an admin-granted device with its own hybrid key; on
 * a strict server each app's browser answer is its own signed scope. At opt-in the owner answers whether browsers may
 * still reach the server and, per classical connector, whether it stays usable. No defaults.
 */
@Composable
fun QuantumSafetyScreen(nav: NavController) {
    val app = LocalAppState.current
    val podClients = com.flagshipserver.app.core.LocalPodClients.current
    val vm: QuantumSafetyViewModel = viewModel(
        factory = viewModelFactory {
            initializer {
                QuantumSafetyViewModel(
                    transport = OkHttpJsonTransport(HttpClientFactory.build()),
                    username = { app.currentUser.value },
                    deviceId = { app.activeProfile?.deviceId },
                    servers = { app.pods.value.filter { !it.isRevoked && it.fqdn.isNotEmpty() }.map { it.fqdn to it.name } },
                    adminKey = { reason -> Keystore.adminSigningKey(reason) },
                    appsFor = { fqdn ->
                        val pod = app.pods.value.firstOrNull { it.fqdn.equals(fqdn, ignoreCase = true) }
                        val client = pod?.let { podClients.screens(it) }
                        client?.appsList()?.apps?.map { it.serviceId to it.urlLabel.ifEmpty { it.slug } } ?: emptyList()
                    },
                    deviceKey = { _ ->
                        val user = app.currentUser.value?.lowercase()
                        val dev = app.activeProfile?.deviceId?.lowercase()
                        if (user == null || dev == null || !com.flagshipserver.app.keystore.SessionIrkAccess.isSessionUnlocked() || !Keystore.hasUmkSeed()) null
                        else Keystore.accountDeviceSigner(Keystore.currentUmkSeed(), user, dev)
                    },
                )
            }
        },
    )
    val phase by vm.phase.collectAsState()
    val rows by vm.rows.collectAsState()
    val message by vm.message.collectAsState()
    val busy by vm.busy.collectAsState()
    val browser = remember { mutableStateMapOf<String, Boolean>() }
    val blocked = remember { mutableStateMapOf<String, Boolean>() }
    var confirmLeave by remember { mutableStateOf<String?>(null) }
    val custody = remember(app.activeProfile?.deviceId) {
        app.activeProfile?.deviceId?.lowercase()?.let { QuantumSafetyService.pqKeys?.entry("device", it)?.label?.text }
    }

    LaunchedEffect(Unit) { vm.load() }

    FSScreen(
        title = "Quantum-safe protection",
        onBack = { nav.popBackStack() },
        subtitle = "Strict quantum-resistant protection makes a server refuse anything signed or sent with today's classical cryptography alone. It is off until you turn it on, one server at a time.",
    ) {
        Text("These protections are new and pending an external review.", style = MaterialTheme.typography.bodySmall, color = FS.colors.textMuted)
        custody?.let { Text("This device's key: $it", style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("qs-custody")) }
        message?.let { FSCard { Text(it, style = MaterialTheme.typography.bodyMedium) } }
        when (val p = phase) {
            is QuantumSafetyViewModel.Phase.Failed -> Text(p.message, color = FS.colors.danger)
            QuantumSafetyViewModel.Phase.Loaded -> {
                if (rows.isEmpty()) Text("You have no servers yet.", color = FS.colors.textMuted)
                for (r in rows) {
                    FSCard {
                        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text(r.name, style = MaterialTheme.typography.titleMedium)
                                Text(if (r.strict) "Strict" else "Compatibility", color = if (r.strict) FS.colors.success else FS.colors.textMuted,
                                    modifier = Modifier.testTag("qs-status-${r.fqdn}"))
                            }
                            if (r.strict) {
                                Text(
                                    if (r.replayed?.browsersAllowed == true) "Browsers can still reach it. A browser uses post-quantum key exchange, but the server's identity is proven with a classical certificate."
                                    else "Only the Flagship app reaches it. Browsers are refused.",
                                    style = MaterialTheme.typography.bodySmall, color = FS.colors.textMuted,
                                )
                                if (r.apps.isNotEmpty()) {
                                    Text("Apps on this server", style = MaterialTheme.typography.bodyMedium)
                                    Text("Choose for each app whether browsers may reach it. A browser's connection is quantum-safe, but the server's identity is proven with a classical certificate.",
                                        style = MaterialTheme.typography.bodySmall, color = FS.colors.textMuted)
                                    for (a in r.apps) {
                                        Text(a.name, style = MaterialTheme.typography.bodySmall)
                                        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                                            FilterChip(selected = a.appOnly, onClick = { vm.setAppBrowsers(r.fqdn, a.serviceId, false) }, enabled = !busy,
                                                label = { Text("Only the Flagship app") }, modifier = Modifier.testTag("qs-app-only-${r.fqdn}-${a.serviceId}"))
                                            FilterChip(selected = !a.appOnly, onClick = { vm.setAppBrowsers(r.fqdn, a.serviceId, true) }, enabled = !busy,
                                                label = { Text("Also browsers") }, modifier = Modifier.testTag("qs-app-browsers-${r.fqdn}-${a.serviceId}"))
                                        }
                                    }
                                }
                                FSDangerButton("Turn off…", onClick = { confirmLeave = r.fqdn }, enabled = !busy)
                            } else if (r.readiness?.ready != true) {
                                Text("Not ready yet", style = MaterialTheme.typography.bodyMedium)
                                r.readiness?.missing?.forEach { Text("• $it", style = MaterialTheme.typography.bodySmall, color = FS.colors.textMuted) }
                            } else {
                                Text("Can browsers still reach this server?", style = MaterialTheme.typography.bodyMedium)
                                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                                    FilterChip(selected = browser[r.fqdn] == false, onClick = { browser[r.fqdn] = false }, label = { Text("Only the Flagship app") },
                                        modifier = Modifier.testTag("qs-browsers-app-${r.fqdn}"))
                                    FilterChip(selected = browser[r.fqdn] == true, onClick = { browser[r.fqdn] = true }, label = { Text("Also browsers") },
                                        modifier = Modifier.testTag("qs-browsers-yes-${r.fqdn}"))
                                }
                                if (browser[r.fqdn] == true) Text(QuantumSafety.lossText(QuantumSafety.BROWSER_LOSS), style = MaterialTheme.typography.bodySmall, color = FS.colors.textMuted)
                                Text("Services this server sends things to", style = MaterialTheme.typography.bodyMedium)
                                for (k in vm.connectors) {
                                    val key = "${r.fqdn}|${k.id}"
                                    Text("${k.name} · ${k.protection.label}", style = MaterialTheme.typography.bodySmall)
                                    Text(k.detail, style = MaterialTheme.typography.bodySmall, color = FS.colors.textMuted)
                                    if (k.needsChoice) {
                                        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                                            FilterChip(selected = blocked[key] == false, onClick = { blocked[key] = false }, label = { Text("Keep using it (classical)") })
                                            FilterChip(selected = blocked[key] == true, onClick = { blocked[key] = true }, label = { Text("Block it in strict") })
                                        }
                                    } else {
                                        Text("Allowed in strict: it carries no content.", style = MaterialTheme.typography.bodySmall, color = FS.colors.textMuted)
                                    }
                                }
                                val answered = browser[r.fqdn] != null && vm.connectors.filter { it.needsChoice }.all { blocked["${r.fqdn}|${it.id}"] != null }
                                FSPrimaryButton(
                                    "Turn on strict protection",
                                    onClick = {
                                        val b = vm.connectors.filter { blocked["${r.fqdn}|${it.id}"] == true }.map { it.id }.toSet()
                                        vm.turnOn(r.fqdn, browser[r.fqdn] == true, b)
                                    },
                                    enabled = answered && !busy,
                                    modifier = Modifier.testTag("qs-turn-on-${r.fqdn}"),
                                )
                            }
                        }
                    }
                }
            }
            else -> Text("Loading…", color = FS.colors.textMuted)
        }
    }

    confirmLeave?.let { fqdn ->
        AlertDialog(
            onDismissRequest = { confirmLeave = null },
            title = { Text("Turn off quantum-safe protection?") },
            text = { Text(QuantumSafety.LEAVING_STRICT_LOSS.joinToString("\n\n") { QuantumSafety.lossText(it) }) },
            confirmButton = { TextButton(onClick = { vm.turnOff(fqdn); confirmLeave = null }) { Text("Turn off and accept these losses") } },
            dismissButton = { TextButton(onClick = { confirmLeave = null }) { Text("Cancel") } },
        )
    }
}
