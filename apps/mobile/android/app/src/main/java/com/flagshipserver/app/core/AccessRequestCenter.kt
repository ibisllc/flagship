// Internet-access alerts (docs/ai-privacy-and-staging.md §3a). The box's push
// (category `app-access`) carries no app or host; the phone asks every box it
// manages over the paired session (GET /api/screens/access-requests) when it
// comes to the foreground, on an `access-request` frame from a box's event
// socket, when a push lands while it is open, and on a slow foreground poll. Each request becomes one "<App> wants to reach <host>"
// dialog: Allow / Deny edit the list with withRule and send a signed order;
// Not now keeps the request on the box and stops asking for a day.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.AccessRequest
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.viewmodels.AppAccessOrder
import com.flagshipserver.app.viewmodels.AppAccessViewModel
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

/** One box the phone manages, reached over its own paired session. */
data class AccessBox(val podId: String?, val fqdn: String, val client: ScreensClient)

data class AccessAlert(val box: AccessBox, val request: AccessRequest) {
    val key: String get() = "${box.fqdn}|${request.serviceId}|${request.host}"
    val appName: String get() = request.appName?.takeIf { it.isNotBlank() } ?: request.serviceId
    val asks: String get() = AppAccessViewModel.asksText(appName, request.host)
    val detail: String get() = AppAccessViewModel.sourceText(request.source, request.attempts)
}

class AccessRequestCenter(
    /** The boxes to ask, resolved at each fetch. */
    private val boxes: () -> List<AccessBox>,
    /** Only fetch while this holds (paired, unlocked, owner device). */
    private val isActiveGate: () -> Boolean = { true },
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> com.flagshipserver.app.keystore.Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
    private val snoozeMs: Long = 24L * 3600 * 1000,
    private val pollIntervalMs: Long = 60_000L,
) {
    sealed interface Phase {
        data object Asking : Phase
        data class Sending(val allow: Boolean) : Phase
        data class Done(val allowed: Boolean, val message: String) : Phase
        data class Failed(val message: String) : Phase
    }

    data class Shown(val alert: AccessAlert, val phase: Phase)

    private val _shown = MutableStateFlow<Shown?>(null)
    val shown: StateFlow<Shown?> = _shown.asStateFlow()

    private val queue = ArrayList<AccessAlert>()
    private val snoozedUntil = HashMap<String, Long>()
    private val answered = HashSet<String>()
    private val mutex = Mutex()
    private var poll: Job? = null

    /** Fetch from every box now (foreground, a push, a screens-socket event). */
    suspend fun refresh(): Int {
        if (!isActiveGate()) return 0
        val found = ArrayList<AccessAlert>()
        for (box in boxes()) {
            val requests = try {
                box.client.accessRequests().requests
            } catch (e: CancellationException) {
                throw e
            } catch (_: ScreensError.NotImplemented) {
                continue
            } catch (_: Throwable) {
                // An older box (404), an offline one, or no session: ask again next time.
                continue
            }
            requests.forEach { found += AccessAlert(box, it) }
        }
        return mutex.withLock {
            val t = now()
            snoozedUntil.entries.removeAll { it.value <= t }
            val live = found.map { it.key }.toSet()
            // The box no longer lists it (answered elsewhere): drop it from the queue.
            queue.removeAll { it.key !in live }
            answered.retainAll(live)
            var added = 0
            for (a in found) {
                if (a.key in answered || snoozedUntil.containsKey(a.key)) continue
                if (queue.any { it.key == a.key } || _shown.value?.alert?.key == a.key) continue
                queue += a
                added += 1
            }
            if (_shown.value == null) showNextLocked()
            added
        }
    }

    /** While the app is open: listen on each box's event socket and fetch on
     *  an `access-request` frame, with a slow poll as the safety net. Each tick
     *  also reopens a socket that closed and follows boxes added or removed. */
    fun start(scope: CoroutineScope) {
        stop()
        poll = scope.launch {
            while (isActive) {
                runCatching { refresh() }
                if (isActiveGate()) syncListeners(this) else stopListeners()
                delay(pollIntervalMs)
            }
        }
    }

    fun stop() {
        poll?.cancel()
        poll = null
        stopListeners()
    }

    private val listeners = HashMap<String, Job>()

    private fun syncListeners(scope: CoroutineScope) {
        val current = runCatching { boxes() }.getOrDefault(emptyList()).associateBy { it.fqdn }
        listeners.entries.removeAll { (fqdn, job) ->
            val gone = fqdn !in current || !job.isActive
            if (gone) job.cancel()
            gone
        }
        for ((fqdn, box) in current) {
            if (listeners.containsKey(fqdn)) continue
            listeners[fqdn] = scope.launch {
                runCatching {
                    box.client.screensEvents().collect { e ->
                        if (e.type == com.flagshipserver.app.api.ScreensEvent.ACCESS_REQUEST) refresh()
                    }
                }
            }
        }
    }

    private fun stopListeners() {
        listeners.values.forEach { it.cancel() }
        listeners.clear()
    }

    /** Allow or Deny: withRule on the box's current list, Face ID, sign, send. */
    suspend fun answer(allow: Boolean) {
        val current = _shown.value ?: return
        if (current.phase is Phase.Sending || current.phase is Phase.Done) return
        val alert = current.alert
        _shown.value = Shown(alert, Phase.Sending(allow))
        val host = alert.request.host
        val phase = try {
            val base = alert.box.client.serviceAccess(alert.request.serviceId).list
            val list = AppAccessList.withRule(base, if (allow) AppAccessList.ALLOW else AppAccessList.DENY, host)
            val order = AppAccessOrder(alert.box.client, { alert.box.fqdn }, signer, now)
            val reason = if (allow) "Allow ${alert.appName} to reach $host" else "Stop ${alert.appName} reaching $host"
            when (val r = order.send(alert.request.serviceId, list, reason)) {
                is AppAccessOrder.Outcome.Applied -> {
                    mutex.withLock { answered += alert.key }
                    Phase.Done(
                        allow,
                        if (allow) AppAccessViewModel.allowedText(alert.appName, host)
                        else AppAccessViewModel.deniedText(alert.appName, host),
                    )
                }
                is AppAccessOrder.Outcome.Invalid -> Phase.Failed(
                    "The app's list has an error on line ${r.errors.firstOrNull()?.line ?: "?"}. Open the list to fix it.",
                )
                is AppAccessOrder.Outcome.Failed -> Phase.Failed(r.message)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: IllegalArgumentException) {
            Phase.Failed("\"$host\" can't go in an access list: ${e.message}")
        } catch (t: Throwable) {
            (AppAccessOrder.refusal(t) as? AppAccessOrder.Outcome.Failed)?.let { Phase.Failed(it.message) }
                ?: Phase.Failed("Couldn't reach the server. Check your connection and try again.")
        }
        if (_shown.value?.alert?.key == alert.key) _shown.value = Shown(alert, phase)
    }

    /** Not now: the request stays on the box; don't ask again for a while. */
    suspend fun notNow() {
        mutex.withLock {
            _shown.value?.let { snoozedUntil[it.alert.key] = now() + snoozeMs }
            showNextLocked()
        }
    }

    /** Close the confirmation (or a failure) and show the next request. */
    suspend fun close() {
        mutex.withLock {
            _shown.value?.let { s -> if (s.phase !is Phase.Done) snoozedUntil[s.alert.key] = now() + snoozeMs }
            showNextLocked()
        }
    }

    /** View access list: close and hand back the alert to navigate to. */
    suspend fun viewList(): AccessAlert? {
        val a = _shown.value?.alert
        close()
        return a
    }

    private fun showNextLocked() {
        val next = if (queue.isEmpty()) null else queue.removeAt(0)
        _shown.value = next?.let { Shown(it, Phase.Asking) }
    }
}

/** Static hand-off so the FCM service can wake the center when an
 *  `app-access` push lands while the app is open. */
object AccessRequestBridge {
    @Volatile var onAccessRequest: (() -> Unit)? = null
}
