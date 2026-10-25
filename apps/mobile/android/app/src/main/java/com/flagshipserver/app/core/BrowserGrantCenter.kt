// Browser access beyond an app's manifest (SEC-BROWSER-002, packages/server-daemon/src/browser/
// grantRequests.ts). An app asks its box for a one-time visit, the session, an exact host or the
// local network; the box holds the ask until an admin answers. Like chat requests, the phone asks
// every box it manages (GET /api/browser/owner/grant-requests) on foreground and when a push lands,
// raises one dialog per request and lists them under Activity and on the app's page. Allow is an
// owner-signed `flagship/browser-grant/v1` over exactly what was shown, with the ask's own duration;
// Deny needs the session alone and starts the box's cooldown. Everything shown comes from the
// structured ask, never the box's English sentences; the app's explanation is labelled as its own.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.api.BrowserGrantAnswerBody
import com.flagshipserver.app.api.BrowserGrantRequestWire
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.boxError
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** One ask, on the box that holds it. [appName] is the box's own name for [serviceId]. */
data class BrowserGrantItem(
    val box: AccessBox,
    val request: BrowserGrantRequestWire,
    val appName: String,
) {
    val key: String get() = "${box.fqdn}|browser|${request.requestId}"
    val wholeLan: Boolean get() = request.localNetwork?.kind == "whole-lan"
    val exactHosts: List<String>? get() = request.localNetwork?.takeIf { it.kind == "exact" }?.hosts
}

object BrowserGrantText {
    private val CAPS = setOf("navigate", "read-dom", "screenshot", "input", "download")
    private val DURATIONS = setOf("once", "session", "service")

    /** The box's list, kept to asks this app can show and sign exactly. */
    fun read(box: AccessBox, requests: List<BrowserGrantRequestWire>, names: Map<String, String>): List<BrowserGrantItem> =
        requests.filter { r ->
            r.requestId.isNotEmpty() && r.serviceId.isNotEmpty() && r.duration in DURATIONS &&
                r.capabilities.isNotEmpty() && r.capabilities.all { it in CAPS } &&
                (r.origins.isNotEmpty() || r.localNetwork != null) &&
                (r.localNetwork == null || r.localNetwork.kind == "whole-lan" || (r.localNetwork.kind == "exact" && r.localNetwork.hosts.isNotEmpty()))
        }.map { BrowserGrantItem(box, it, names[it.serviceId] ?: it.serviceId) }

    fun wants(item: BrowserGrantItem): String = FSStrings.get(R.string.browser_grant_wants, item.appName)

    /** Each site exactly as asked; a `*.` pattern says that it covers every address under it. */
    fun site(origin: String): Pair<String, String?> =
        origin to if (origin.startsWith("*.")) FSStrings.get(R.string.browser_grant_under) else null

    fun localNetwork(item: BrowserGrantItem): String? = when {
        item.wholeLan -> FSStrings.get(R.string.browser_grant_lan_whole)
        item.exactHosts != null -> FSStrings.get(R.string.browser_grant_lan_exact, item.exactHosts!!.joinToString(", "))
        else -> null
    }

    fun capability(c: String): String = when (c) {
        "navigate" -> FSStrings.get(R.string.browser_grant_cap_navigate)
        "read-dom" -> FSStrings.get(R.string.browser_grant_cap_read_dom)
        "screenshot" -> FSStrings.get(R.string.browser_grant_cap_screenshot)
        "input" -> FSStrings.get(R.string.browser_grant_cap_input)
        "download" -> FSStrings.get(R.string.browser_grant_cap_download)
        else -> c
    }

    fun duration(d: String): String = when (d) {
        "once" -> FSStrings.get(R.string.browser_grant_once)
        "session" -> FSStrings.get(R.string.browser_grant_session)
        else -> FSStrings.get(R.string.browser_grant_service)
    }

    /** Allow names how long it lasts: the box verifies the ask's own duration. */
    fun allowLabel(d: String): String = when (d) {
        "once" -> FSStrings.get(R.string.browser_grant_allow_once)
        "session" -> FSStrings.get(R.string.browser_grant_allow_session)
        else -> FSStrings.get(R.string.browser_grant_allow_service)
    }

    fun answered(allow: Boolean): String =
        FSStrings.get(if (allow) R.string.browser_grant_allowed else R.string.browser_grant_denied)

    fun error(t: Throwable): String = when ((t as? ScreensError.Http)?.status) {
        404 -> FSStrings.get(R.string.browser_grant_gone)
        403 -> FSStrings.get(R.string.browser_grant_admin_only)
        else -> t.boxError() ?: FSStrings.get(R.string.couldnt_reach_the_server_check_your)
    }

    /** The signed bytes for Allow, exactly as shown and as the box rebuilds them. */
    fun canonical(item: BrowserGrantItem, serverDomain: String, issuedAt: Long): ByteArray {
        val r = item.request
        return BrowserGrant.canonicalBytes(
            serverDomain = serverDomain,
            requestId = r.requestId,
            serviceId = r.serviceId,
            decision = "allow",
            duration = r.duration,
            capabilities = r.capabilities,
            origins = r.origins,
            exactHosts = item.exactHosts,
            wholeLan = item.wholeLan,
            issuedAt = issuedAt,
        )
    }
}

class BrowserGrantCenter(
    private val boxes: () -> List<AccessBox>,
    private val isActiveGate: () -> Boolean = { true },
    /** This device can sign the answer (holds the admin root, or the IRK on a legacy account). */
    private val canAnswer: () -> Boolean = { true },
    private val alertsEnabled: () -> Boolean = { true },
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> com.flagshipserver.app.keystore.Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
    private val snoozeMs: Long = 24L * 3600 * 1000,
    private val pollIntervalMs: Long = 60_000L,
) {
    data class Listing(val requests: List<BrowserGrantItem> = emptyList(), val loaded: Boolean = false)

    sealed interface Phase {
        data object Asking : Phase
        data class Sending(val allow: Boolean) : Phase
        data class Done(val message: String) : Phase
        data class Failed(val message: String) : Phase
    }

    data class Shown(val item: BrowserGrantItem, val phase: Phase)

    private val _listing = MutableStateFlow(Listing())
    val listing: StateFlow<Listing> = _listing.asStateFlow()

    private val _shown = MutableStateFlow<Shown?>(null)
    val shown: StateFlow<Shown?> = _shown.asStateFlow()

    private val _busy = MutableStateFlow<Set<String>>(emptySet())
    val busy: StateFlow<Set<String>> = _busy.asStateFlow()

    fun canAnswerHere(): Boolean = canAnswer()

    private val queue = ArrayList<BrowserGrantItem>()
    private val snoozedUntil = HashMap<String, Long>()
    private val answered = HashSet<String>()
    private val mutex = Mutex()
    private var poll: Job? = null

    /** Every box's waiting asks, named by each box's own app list. */
    suspend fun load(): Listing {
        val all = ArrayList<BrowserGrantItem>()
        for (box in boxes()) {
            val r = try {
                box.client.browserGrantRequests()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                // The app browser is off (404), an older box, an offline one: nothing waits there.
                continue
            }
            if (r.requests.isEmpty()) continue
            val names = try {
                box.client.appsList().apps.associate { it.serviceId to it.slug.replaceFirstChar { c -> c.uppercase() } }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                emptyMap()
            }
            all += BrowserGrantText.read(box, r.requests, names)
        }
        val next = Listing(all.sortedBy { it.request.at }, loaded = true)
        _listing.value = next
        return next
    }

    fun forService(serviceId: String): List<BrowserGrantItem> = _listing.value.requests.filter { it.request.serviceId == serviceId }

    suspend fun refresh(): Int {
        if (!isActiveGate()) return 0
        val found = load().requests
        if (!alertsEnabled() || !canAnswer()) {
            mutex.withLock {
                queue.clear()
                if (_shown.value?.phase == Phase.Asking) _shown.value = null
            }
            return 0
        }
        return mutex.withLock {
            val t = now()
            snoozedUntil.entries.removeAll { it.value <= t }
            val live = found.map { it.key }.toSet()
            queue.removeAll { it.key !in live }
            answered.retainAll(live)
            if (_shown.value?.phase == Phase.Asking && _shown.value?.item?.key !in live) _shown.value = null
            var added = 0
            for (a in found) {
                if (a.key in answered || snoozedUntil.containsKey(a.key)) continue
                if (queue.any { it.key == a.key } || _shown.value?.item?.key == a.key) continue
                queue += a
                added += 1
            }
            if (_shown.value == null) showNextLocked()
            added
        }
    }

    fun start(scope: CoroutineScope) {
        stop()
        poll = scope.launch {
            while (isActive) {
                runCatching { refresh() }
                delay(pollIntervalMs)
            }
        }
    }

    fun stop() {
        poll?.cancel()
        poll = null
    }

    /** Allow (signed) or Deny. Returns null on success, else the sentence to show. */
    suspend fun answer(item: BrowserGrantItem, allow: Boolean): String? {
        _busy.value = _busy.value + item.key
        try {
            val issuedAt = now()
            val signature = if (!allow) null else {
                val domain = runCatching { item.box.client.boxFqdn() }.getOrNull()?.takeIf { it.isNotEmpty() } ?: item.box.fqdn
                val key = try {
                    signer(FSStrings.get(R.string.browser_grant_sign_reason, item.appName))
                } catch (e: CancellationException) {
                    throw e
                } catch (t: Throwable) {
                    return FSStrings.get(R.string.couldnt_access_your_account_key, UserErrorText.reason(t))
                }
                HexUtil.encode(key.sign(BrowserGrantText.canonical(item, domain, issuedAt)))
            }
            try {
                item.box.client.browserGrantAnswer(
                    BrowserGrantAnswerBody(item.request.requestId, if (allow) "allow" else "deny", issuedAt, signature),
                )
            } catch (e: CancellationException) {
                throw e
            } catch (t: Throwable) {
                if ((t as? ScreensError.Http)?.status == 404) forget(item)
                return BrowserGrantText.error(t)
            }
            forget(item)
            return null
        } finally {
            _busy.value = _busy.value - item.key
        }
    }

    private suspend fun forget(item: BrowserGrantItem) {
        mutex.withLock {
            answered += item.key
            queue.removeAll { it.key == item.key }
        }
        val l = _listing.value
        _listing.value = l.copy(requests = l.requests.filterNot { it.key == item.key })
    }

    suspend fun answerShown(allow: Boolean) {
        val current = _shown.value ?: return
        if (current.phase !is Phase.Asking && current.phase !is Phase.Failed) return
        _shown.value = Shown(current.item, Phase.Sending(allow))
        val failure = answer(current.item, allow)
        val phase = if (failure == null) Phase.Done(BrowserGrantText.answered(allow)) else Phase.Failed(failure)
        if (_shown.value?.item?.key == current.item.key) _shown.value = Shown(current.item, phase)
    }

    /** Not now: the ask stays on the box and under Activity; don't raise it again for a while. */
    suspend fun notNow() {
        mutex.withLock {
            _shown.value?.let { snoozedUntil[it.item.key] = now() + snoozeMs }
            showNextLocked()
        }
    }

    suspend fun close() {
        mutex.withLock {
            _shown.value?.let { s -> if (s.phase !is Phase.Done) snoozedUntil[s.item.key] = now() + snoozeMs }
            showNextLocked()
        }
    }

    private fun showNextLocked() {
        val next = if (queue.isEmpty()) null else queue.removeAt(0)
        _shown.value = next?.let { Shown(it, Phase.Asking) }
    }
}
