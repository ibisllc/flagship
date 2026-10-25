// Browser access requests (SEC-BROWSER-002): the dialog raised for each ask, Activity's list and the
// "Browser access" section of an app's page (the sites approved with its manifest, what it asks for
// now, and what the owner allowed, with Withdraw). Allow is offered once per duration the owner may
// grant, shortest first (the ask's own or shorter). Driven by [BrowserGrantCenter].

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import com.flagshipserver.app.R
import com.flagshipserver.app.core.BrowserGrantCenter
import com.flagshipserver.app.core.BrowserGrantItem
import com.flagshipserver.app.core.BrowserGrantText
import com.flagshipserver.app.core.LocalBrowserGrantCenter
import com.flagshipserver.app.core.OwnerGrantItem
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.ui.components.AlertDialog
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.TextButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private fun tagOf(item: BrowserGrantItem) = item.request.requestId.replace(Regex("[^A-Za-z0-9_-]"), "")
private fun tagOf(item: OwnerGrantItem) = item.grant.grantId.replace(Regex("[^A-Za-z0-9_-]"), "")

/** The ask's own duration keeps the plain tag; a shorter choice adds its duration. */
private fun allowTag(base: String, item: BrowserGrantItem, d: String) =
    if (d == item.request.duration) base else base.replace("allow", "allow-$d")

/** What the owner is asked about: the verified app, the exact sites and network, what it can do, how long. */
@Composable
private fun BrowserGrantDetails(item: BrowserGrantItem, muted: Boolean) {
    val t = tagOf(item)
    val sub = if (muted) FS.colors.textMuted else MaterialTheme.colorScheme.onSurface
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        Text(BrowserGrantText.wants(item), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("browser-grant-wants-$t"))
        if (item.request.origins.isNotEmpty()) {
            Text(stringResource(R.string.browser_grant_sites), style = MaterialTheme.typography.titleSmall)
            item.request.origins.forEach { o ->
                val (host, note) = BrowserGrantText.site(o)
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Text(host, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), modifier = Modifier.testTag("browser-grant-site-$t"))
                    note?.let { Text(it, color = FS.colors.textMuted, style = MaterialTheme.typography.bodyMedium) }
                }
            }
        }
        BrowserGrantText.localNetwork(item)?.let {
            Text(it, color = sub, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("browser-grant-lan-$t"))
        }
        Text(stringResource(R.string.browser_grant_it_can), style = MaterialTheme.typography.titleSmall)
        Text(
            item.request.capabilities.joinToString(", ") { BrowserGrantText.capability(it) },
            color = sub,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.testTag("browser-grant-caps-$t"),
        )
        Text(BrowserGrantText.duration(item.request.duration), color = sub, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("browser-grant-duration-$t"))
        if (item.request.explanation.isNotBlank()) {
            Text(stringResource(R.string.browser_grant_app_says), style = MaterialTheme.typography.titleSmall)
            Text("“${item.request.explanation}”", color = FS.colors.textMuted, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("browser-grant-explanation-$t"))
        }
        if (item.box.fqdn.isNotEmpty() && muted) {
            Text(item.box.fqdn.substringBefore('.'), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** One dialog per waiting ask: Allow (labelled by how long it lasts) / Deny / Not now. */
@Composable
fun BrowserGrantDialogHost(center: BrowserGrantCenter) {
    val shown by center.shown.collectAsState()
    val scope = rememberCoroutineScope()
    val s = shown ?: return
    val item = s.item
    when (val phase = s.phase) {
        is BrowserGrantCenter.Phase.Done -> AlertDialog(
            onDismissRequest = { scope.launch { center.close() } },
            title = { Text(phase.message, modifier = Modifier.testTag("browser-grant-done-title")) },
            confirmButton = {
                TextButton(onClick = { scope.launch { center.close() } }, modifier = Modifier.testTag("browser-grant-close")) {
                    Text(stringResource(R.string.close))
                }
            },
            modifier = Modifier.testTag("browser-grant-done"),
        )
        else -> {
            val sending = phase as? BrowserGrantCenter.Phase.Sending
            AlertDialog(
                onDismissRequest = { if (sending == null) scope.launch { center.notNow() } },
                title = { Text(stringResource(R.string.browser_grant_title), modifier = Modifier.testTag("browser-grant-title")) },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        BrowserGrantDetails(item, muted = false)
                        Text(stringResource(R.string.browser_grant_deny_note), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
                        (phase as? BrowserGrantCenter.Phase.Failed)?.let {
                            Text(it.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("browser-grant-error"))
                        }
                    }
                },
                confirmButton = {
                    Column(horizontalAlignment = androidx.compose.ui.Alignment.End) {
                        item.durationChoices.forEach { d ->
                            TextButton(
                                enabled = sending == null,
                                onClick = { scope.launch { center.answerShown(true, d) } },
                                modifier = Modifier.testTag(allowTag("browser-grant-allow", item, d)),
                            ) { Text(BrowserGrantText.allowLabel(d)) }
                        }
                        TextButton(
                            enabled = sending == null,
                            onClick = { scope.launch { center.answerShown(false) } },
                            modifier = Modifier.testTag("browser-grant-deny"),
                        ) { Text(stringResource(R.string.deny)) }
                    }
                },
                dismissButton = {
                    TextButton(
                        enabled = sending == null,
                        onClick = { scope.launch { center.notNow() } },
                        modifier = Modifier.testTag("browser-grant-not-now"),
                    ) { Text(stringResource(R.string.not_now)) }
                },
                modifier = Modifier.testTag("browser-grant"),
            )
        }
    }
}

/** Activity's list, or one app's asks when [serviceId] is set. */
@Composable
fun BrowserGrantRequestsList(center: BrowserGrantCenter, serviceId: String? = null, scope: CoroutineScope = rememberCoroutineScope()) {
    val listing by center.listing.collectAsState()
    val busy by center.busy.collectAsState()
    val toasts = LocalToastCenter.current
    val canAnswer = center.canAnswerHere()
    val items = listing.requests.filter { serviceId == null || it.request.serviceId == serviceId }
    Column(Modifier.fillMaxWidth().testTag("browser-grant-list"), verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        if (items.isEmpty() && serviceId == null) {
            Text(stringResource(R.string.browser_grant_none), color = FS.colors.textMuted, modifier = Modifier.testTag("browser-grant-empty"))
        }
        items.forEach { r ->
            val t = tagOf(r)
            FSCard(modifier = Modifier.testTag("browser-grant-card-$t")) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Text(stringResource(R.string.browser_grant_title), style = MaterialTheme.typography.titleSmall)
                    BrowserGrantDetails(r, muted = true)
                    if (!canAnswer) {
                        Text(stringResource(R.string.browser_grant_admin_only), color = FS.colors.textMuted, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("browser-grant-admin-only"))
                    } else {
                        r.durationChoices.forEach { d ->
                            val onClick: () -> Unit = {
                                scope.launch {
                                    val failure = center.answer(r, true, d)
                                    if (failure == null) toasts.success(BrowserGrantText.answered(true)) else toasts.error(failure)
                                }
                            }
                            val tag = allowTag("browser-grant-card-allow-$t", r, d)
                            if (d == r.request.duration) {
                                FSPrimaryButton(BrowserGrantText.allowLabel(d), onClick = onClick, enabled = r.key !in busy, block = true, modifier = Modifier.testTag(tag))
                            } else {
                                FSSecondaryButton(BrowserGrantText.allowLabel(d), onClick = onClick, enabled = r.key !in busy, block = true, modifier = Modifier.testTag(tag))
                            }
                        }
                        FSSecondaryButton(
                            stringResource(R.string.deny),
                            onClick = {
                                scope.launch {
                                    val failure = center.answer(r, false)
                                    if (failure == null) toasts.success(BrowserGrantText.answered(false)) else toasts.error(failure)
                                }
                            },
                            enabled = r.key !in busy,
                            block = true,
                            modifier = Modifier.testTag("browser-grant-card-deny-$t"),
                        )
                        Text(stringResource(R.string.browser_grant_deny_note), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}

/** The sites an app's manifest names under `browser.domains` (a list, or an object keyed by site). */
fun manifestBrowserDomains(manifest: Map<String, JsonElement>): List<String> {
    val domains = (manifest["browser"] as? JsonObject)?.get("domains") ?: return emptyList()
    return when (domains) {
        is JsonArray -> domains.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
        is JsonObject -> domains.keys.toList()
        else -> emptyList()
    }.filter { it.isNotBlank() }
}

/** One grant the owner gave: the sites and network, what it can do, how long, the app's words; Withdraw. */
@Composable
private fun OwnerGrantCard(center: BrowserGrantCenter, item: OwnerGrantItem, appName: String, canWithdraw: Boolean, busy: Boolean, scope: CoroutineScope) {
    val t = tagOf(item)
    val g = item.grant
    val toasts = LocalToastCenter.current
    FSCard(modifier = Modifier.testTag("browser-granted-$t")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            if (g.origins.isNotEmpty()) {
                Text(stringResource(R.string.browser_grant_sites), style = MaterialTheme.typography.titleSmall)
                g.origins.forEach { o ->
                    val (host, note) = BrowserGrantText.site(o)
                    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        Text(host, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), modifier = Modifier.testTag("browser-granted-site-$t"))
                        note?.let { Text(it, color = FS.colors.textMuted, style = MaterialTheme.typography.bodyMedium) }
                    }
                }
            }
            BrowserGrantText.localNetwork(g.localNetwork)?.let {
                Text(it, color = FS.colors.textMuted, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("browser-granted-lan-$t"))
            }
            Text(stringResource(R.string.browser_grant_it_can), style = MaterialTheme.typography.titleSmall)
            Text(g.capabilities.joinToString(", ") { BrowserGrantText.capability(it) }, color = FS.colors.textMuted, style = MaterialTheme.typography.bodyMedium)
            Text(BrowserGrantText.duration(g.duration), color = FS.colors.textMuted, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("browser-granted-duration-$t"))
            if (g.explanation.isNotBlank()) {
                Text(stringResource(R.string.browser_grant_app_says), style = MaterialTheme.typography.titleSmall)
                Text("“${g.explanation}”", color = FS.colors.textMuted, style = MaterialTheme.typography.bodyMedium)
            }
            if (canWithdraw) {
                FSSecondaryButton(
                    stringResource(R.string.browser_grant_withdraw),
                    onClick = {
                        scope.launch {
                            val failure = center.withdraw(item, appName)
                            if (failure == null) toasts.success(BrowserGrantText.withdrawn()) else toasts.error(failure)
                        }
                    },
                    enabled = !busy,
                    block = true,
                    modifier = Modifier.testTag("browser-granted-withdraw-$t"),
                )
            } else {
                Text(stringResource(R.string.browser_grant_admin_only), color = FS.colors.textMuted, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

/** The app page's "Browser access": what its manifest was approved with, what it asks now, what the owner allowed. */
@Composable
fun BrowserAccessSection(serviceId: String, manifest: Map<String, JsonElement>, appName: String = serviceId) {
    val center = LocalBrowserGrantCenter.current
    // Answering the last ask (or withdrawing the last grant) takes its card away: the work outlives it.
    val scope = rememberCoroutineScope()
    LaunchedEffect(center, serviceId) {
        runCatching { center?.load() }
        runCatching { center?.loadGrants(serviceId) }
    }
    val listing by (center?.listing ?: kotlinx.coroutines.flow.MutableStateFlow(BrowserGrantCenter.Listing())).collectAsState()
    val grantMap by (center?.grants ?: kotlinx.coroutines.flow.MutableStateFlow(emptyMap())).collectAsState()
    val busy by (center?.busy ?: kotlinx.coroutines.flow.MutableStateFlow(emptySet())).collectAsState()
    val declared = manifestBrowserDomains(manifest)
    val asks = listing.requests.filter { it.request.serviceId == serviceId }
    val given = grantMap[serviceId].orEmpty()
    if (declared.isEmpty() && asks.isEmpty() && given.isEmpty()) return
    Column(Modifier.testTag("service-detail-browser-access"), verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        FSSectionHeader(stringResource(R.string.browser_access))
        if (declared.isNotEmpty()) {
            FSCard {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                    declared.forEach { d ->
                        Text(d, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), modifier = Modifier.testTag("browser-access-declared"))
                    }
                    Text(stringResource(R.string.browser_access_manifest), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        if (center != null && asks.isNotEmpty()) BrowserGrantRequestsList(center, serviceId, scope)
        if (center != null && given.isNotEmpty()) {
            Text(stringResource(R.string.browser_grant_allowed_by_you), style = MaterialTheme.typography.titleSmall, modifier = Modifier.testTag("browser-granted-title"))
            val canWithdraw = center.canAnswerHere()
            given.forEach { OwnerGrantCard(center, it, appName, canWithdraw, it.key in busy, scope) }
        }
    }
}
