// Internet-access alerts (docs/ai-privacy-and-staging.md §3a). The box's push
// (category `generic`, or `app-access` from an older box) carries no app or host; the phone asks every box it
// manages over the paired session (GET /api/screens/access-requests) when it
// comes to the foreground, on an `access-request` frame from a box's event
// socket, when a push lands while it is open, and on a slow foreground poll. Each request becomes one "<App> wants to reach <host>"
// dialog: Allow / Deny edit the list with withRule and send a signed order;
// Not now keeps the request on the box and stops asking for a day. A
// suggested list (a draft, listed first) becomes "<App> suggests an access
// list" with Review (open that app's editor with the draft) / Not now. With
// Settings → Push notifications off, no dialogs are raised at all; the
// requests still wait on each app's page.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
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
    val isDraft: Boolean get() = request.isDraft
    /** A newer draft (another createdAt) is a new alert. */
    val key: String get() =
        if (isDraft) "${box.fqdn}|${request.serviceId}|draft|${request.createdAt}"
        else "${box.fqdn}|${request.serviceId}|${request.host}"
    val appName: String get() = request.appName?.takeIf { it.isNotBlank() } ?: request.serviceId
    val asks: String get() =
        if (isDraft) AppAccessViewModel.draftAsksText(appName) else AppAccessViewModel.asksText(appName, request.host)
    val detail: String get() =
        if (isDraft) request.hosts.joinToString("\n") { AppAccessViewModel.suggestionText(it) }
        else AppAccessViewModel.sourceText(request.source, request.attempts)
}

class AccessRequestCenter(
    /** The boxes to ask, resolved at each fetch. */
    private val boxes: () -> List<AccessBox>,
    /** Only fetch while this holds (paired, unlocked, owner device). */
    private val isActiveGate: () -> Boolean = { true },
    /** Settings → Push notifications: off raises no dialogs. */
    private val alertsEnabled: () -> Boolean = { true },
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
        if (!alertsEnabled()) {
            mutex.withLock {
                queue.clear()
                // An answer already being sent finishes; an unanswered ask goes.
                if (_shown.value?.phase == Phase.Asking) _shown.value = null
            }
            return 0
        }
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
        // A draft is answered in the editor (Review), never from the alert.
        if (current.alert.isDraft) return
        val alert = current.alert
        _shown.value = Shown(alert, Phase.Sending(allow))
        val host = alert.request.host
        val phase = try {
            val base = alert.box.client.serviceAccess(alert.request.serviceId).list
            val list = AppAccessList.withRule(base, if (allow) AppAccessList.ALLOW else AppAccessList.DENY, host)
            val order = AppAccessOrder(alert.box.client, { alert.box.fqdn }, signer, now)
            val reason = if (allow) FSStrings.get(R.string.allow_to_reach, alert.appName, host) else FSStrings.get(R.string.stop_reaching, alert.appName, host)
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
                    FSStrings.get(R.string.the_apps_list_has_an_error, r.errors.firstOrNull()?.line ?: "?"),
                )
                is AppAccessOrder.Outcome.Failed -> Phase.Failed(r.message)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: IllegalArgumentException) {
            Phase.Failed("\"$host\" can't go in an access list: ${e.message}")
        } catch (t: Throwable) {
            (AppAccessOrder.refusal(t) as? AppAccessOrder.Outcome.Failed)?.let { Phase.Failed(it.message) }
                ?: Phase.Failed(FSStrings.get(R.string.couldnt_reach_the_server_check_your))
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

    /** Review a draft: hand back the alert so its app's editor opens with the
     *  draft. It isn't asked again today here; saving the list clears it on
     *  the box, and the page keeps offering it until then. */
    suspend fun review(): AccessAlert? = mutex.withLock {
        val a = _shown.value?.alert?.takeIf { it.isDraft } ?: return@withLock null
        snoozedUntil[a.key] = now() + snoozeMs
        showNextLocked()
        a
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

/** Static hand-off so the FCM service can wake the center when a
 *  `generic` (or older `app-access`) push lands while the app is open. */
object AccessRequestBridge {
    @Volatile var onAccessRequest: (() -> Unit)? = null
}
