// App chat between owners (N08, packages/server-daemon/src/chat/approvals.ts). A box holds a
// chat request from another owner's app (incoming), or from one of its own apps to another
// owner's app (outgoing), until an admin answers. Like an internet-access request, the box's
// push is content-free (`generic`), so the phone asks every box it manages
// (GET /api/screens/chat/requests) on foreground, on a `chat-request` frame from a box's event
// socket and when a push lands while it is open. Each request is one dialog; every request
// and every Always allow also waits under Activity → App chat requests. Allow / Always allow /
// Deny is an owner-signed `flagship/chat-approval/v1`; Ask me each time (ending an Always
// allow) needs the session alone. The sender's name is what the remote machine claims, never
// an identity, so every sentence says so. Wording matches the webapp's lib/chatAlerts.js.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.api.ChatAlwaysWire
import com.flagshipserver.app.api.ChatAnswerBody
import com.flagshipserver.app.api.ChatAppIdentity
import com.flagshipserver.app.api.ChatRequestWire
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.ScreensEvent
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

/** One held request, on the box that holds it. */
data class ChatItem(
    val box: AccessBox,
    val requestId: String,
    val kind: ChatApproval.Kind,
    val sender: ChatAppIdentity,
    val receiver: ChatAppIdentity,
    val phrase: String?,
    val count: Int,
    val at: Long,
) {
    val key: String get() = "${box.fqdn}|chat|${kind.wire}|$requestId"
}

/** An Always allow on [box]: [sender] (a claim) may start a chat with [app] without asking. */
data class ChatAlwaysItem(val box: AccessBox, val app: ChatAppIdentity, val sender: ChatAppIdentity) {
    val key: String get() = "${box.fqdn}|${sender.author}/${sender.slug}>${app.author}/${app.slug}"
}

object ChatText {
    private val NAME = Regex("^[a-z0-9][a-z0-9-]{0,62}$", RegexOption.IGNORE_CASE)

    /** The box's list, kept to well-formed entries. */
    fun read(box: AccessBox, requests: List<ChatRequestWire>, always: List<ChatAlwaysWire>): Pair<List<ChatItem>, List<ChatAlwaysItem>> {
        val items = requests.mapNotNull { r ->
            val kind = ChatApproval.Kind.entries.firstOrNull { it.wire == r.kind } ?: return@mapNotNull null
            val sender = r.claimedSender?.takeIf { it.author.isNotEmpty() && it.slug.isNotEmpty() } ?: return@mapNotNull null
            val receiver = r.receiverApp?.takeIf { it.author.isNotEmpty() && it.slug.isNotEmpty() } ?: return@mapNotNull null
            if (r.requestId.isEmpty()) return@mapNotNull null
            ChatItem(box, r.requestId, kind, sender, receiver, r.phrase?.takeIf { it.isNotBlank() }, r.count.coerceAtLeast(1), r.at)
        }
        fun ok(a: ChatAppIdentity?) = a != null && NAME.matches(a.author) && NAME.matches(a.slug)
        val apps = always.filter { ok(it.receiverApp) && ok(it.claimedSender) }.map { ChatAlwaysItem(box, it.receiverApp!!, it.claimedSender!!) }
        return items to apps
    }

    fun title(r: ChatItem): String = when (r.kind) {
        ChatApproval.Kind.INCOMING -> FSStrings.get(R.string.chat_request_incoming, r.sender.author, r.sender.slug, r.receiver.slug)
        ChatApproval.Kind.OUTGOING -> FSStrings.get(R.string.chat_request_outgoing, r.sender.slug, r.receiver.author, r.receiver.slug)
    }

    /** The lines under the title: what the name means, the phrase, how many times. */
    fun notes(r: ChatItem): List<String> = buildList {
        add(
            if (r.kind == ChatApproval.Kind.INCOMING) FSStrings.get(R.string.chat_request_incoming_note)
            else FSStrings.get(R.string.chat_request_outgoing_note),
        )
        r.phrase?.let { add(FSStrings.get(R.string.chat_request_phrase, it)) }
        if (r.count > 1) add(FSStrings.plural(R.plurals.chat_request_asked_times, r.count, r.count))
    }

    fun alwaysNote(r: ChatItem): String =
        FSStrings.get(R.string.chat_always_allow_note_sender, r.sender.author, r.sender.slug, r.receiver.slug)

    /** "<claimed sender> → <your app>". */
    fun alwaysTitle(a: ChatAlwaysItem): String = "${a.sender.author}/${a.sender.slug} → ${a.app.slug}"
    fun alwaysLine(a: ChatAlwaysItem): String =
        FSStrings.get(R.string.chat_always_allow_line_sender, a.sender.author, a.sender.slug, a.app.slug)

    fun answered(r: ChatItem, decision: ChatApproval.Decision): String = when (decision) {
        ChatApproval.Decision.DENY -> FSStrings.get(R.string.chat_request_denied)
        ChatApproval.Decision.ALWAYS -> FSStrings.get(R.string.chat_request_now_always_sender, r.sender.author, r.sender.slug, r.receiver.slug)
        ChatApproval.Decision.ALLOW -> FSStrings.get(R.string.chat_request_allowed)
    }

    fun error(t: Throwable): String {
        val status = (t as? ScreensError.Http)?.status
        return when (status) {
            404 -> FSStrings.get(R.string.chat_request_gone)
            409 -> FSStrings.get(R.string.chat_request_already_answered)
            403 -> FSStrings.get(R.string.chat_request_admin_only)
            else -> t.boxError() ?: FSStrings.get(R.string.couldnt_reach_the_server_check_your)
        }
    }
}

class ChatRequestCenter(
    /** The boxes to ask, resolved at each fetch. */
    private val boxes: () -> List<AccessBox>,
    /** Only fetch while this holds (paired, unlocked, not locked by a notice). */
    private val isActiveGate: () -> Boolean = { true },
    /** This device can sign the answer (holds the admin root, or the IRK on a legacy account). */
    private val canAnswer: () -> Boolean = { true },
    /** Settings → Push notifications: off raises no dialogs (the Activity list still shows them). */
    private val alertsEnabled: () -> Boolean = { true },
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> com.flagshipserver.app.keystore.Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
    private val snoozeMs: Long = 24L * 3600 * 1000,
    private val pollIntervalMs: Long = 60_000L,
) {
    data class Listing(
        val requests: List<ChatItem> = emptyList(),
        val always: List<ChatAlwaysItem> = emptyList(),
        val loaded: Boolean = false,
    )

    sealed interface Phase {
        data object Asking : Phase
        data class Sending(val decision: ChatApproval.Decision) : Phase
        data class Done(val message: String) : Phase
        data class Failed(val message: String) : Phase
    }

    data class Shown(val item: ChatItem, val phase: Phase)

    private val _listing = MutableStateFlow(Listing())
    val listing: StateFlow<Listing> = _listing.asStateFlow()

    private val _shown = MutableStateFlow<Shown?>(null)
    val shown: StateFlow<Shown?> = _shown.asStateFlow()

    /** Keys of requests being answered or revoked from the Activity list. */
    private val _busy = MutableStateFlow<Set<String>>(emptySet())
    val busy: StateFlow<Set<String>> = _busy.asStateFlow()

    fun canAnswerHere(): Boolean = canAnswer()

    private val queue = ArrayList<ChatItem>()
    private val snoozedUntil = HashMap<String, Long>()
    private val answered = HashSet<String>()
    private val mutex = Mutex()
    private var poll: Job? = null

    /** Fetch every box's list (the Activity section), without raising a dialog. */
    suspend fun load(): Listing {
        val requests = ArrayList<ChatItem>()
        val always = ArrayList<ChatAlwaysItem>()
        for (box in boxes()) {
            val r = try {
                box.client.chatRequests()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                // An older box (404), an offline one, or no session: ask again next time.
                continue
            }
            val (items, apps) = ChatText.read(box, r.requests, r.always)
            requests += items
            always += apps
        }
        val next = Listing(requests.sortedBy { it.at }, always, loaded = true)
        _listing.value = next
        return next
    }

    /** Fetch, then queue a dialog for each new request (foreground, a push, a socket event). */
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

    /** While the app is open: each box's event socket, with a slow poll as the safety net. */
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
                    box.client.screensEvents().collect { e -> if (e.type == ScreensEvent.CHAT_REQUEST) refresh() }
                }
            }
        }
    }

    private fun stopListeners() {
        listeners.values.forEach { it.cancel() }
        listeners.clear()
    }

    /**
     * Sign and send one answer. Returns null on success, else the sentence to show. The request
     * leaves the list either way when the box no longer holds it.
     */
    suspend fun answer(item: ChatItem, decision: ChatApproval.Decision): String? {
        if (decision == ChatApproval.Decision.ALWAYS && item.kind != ChatApproval.Kind.INCOMING) return null
        _busy.value = _busy.value + item.key
        try {
            val domain = runCatching { item.box.client.boxFqdn() }.getOrNull()?.takeIf { it.isNotEmpty() } ?: item.box.fqdn
            val key = try {
                signer(FSStrings.get(R.string.chat_request_sign_reason, item.receiver.slug))
            } catch (e: CancellationException) {
                throw e
            } catch (t: Throwable) {
                return FSStrings.get(R.string.couldnt_access_your_account_key, UserErrorText.reason(t))
            }
            val issuedAt = now()
            val sig = key.sign(ChatApproval.canonicalBytes(domain, item.requestId, item.kind, decision, issuedAt))
            try {
                item.box.client.chatAnswer(ChatAnswerBody(item.requestId, item.kind.wire, decision.wire, issuedAt, HexUtil.encode(sig)))
            } catch (e: CancellationException) {
                throw e
            } catch (t: Throwable) {
                if ((t as? ScreensError.Http)?.status in setOf(404, 409)) forget(item)
                return ChatText.error(t)
            }
            forget(item)
            if (decision == ChatApproval.Decision.ALWAYS) {
                val app = ChatAlwaysItem(item.box, item.receiver, item.sender)
                val l = _listing.value
                if (l.always.none { it.key == app.key }) _listing.value = l.copy(always = l.always + app)
            }
            return null
        } finally {
            _busy.value = _busy.value - item.key
        }
    }

    /** Ask me each time: end an Always allow. Returns null on success, else the sentence to show. */
    suspend fun revoke(item: ChatAlwaysItem): String? {
        _busy.value = _busy.value + item.key
        try {
            item.box.client.chatAlwaysRevoke(item.app, item.sender)
            val l = _listing.value
            _listing.value = l.copy(always = l.always.filterNot { it.key == item.key })
            return null
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            return ChatText.error(t)
        } finally {
            _busy.value = _busy.value - item.key
        }
    }

    private suspend fun forget(item: ChatItem) {
        mutex.withLock {
            answered += item.key
            queue.removeAll { it.key == item.key }
        }
        val l = _listing.value
        _listing.value = l.copy(requests = l.requests.filterNot { it.key == item.key })
    }

    /** The dialog's Allow / Always allow / Deny. */
    suspend fun answerShown(decision: ChatApproval.Decision) {
        val current = _shown.value ?: return
        if (current.phase !is Phase.Asking && current.phase !is Phase.Failed) return
        _shown.value = Shown(current.item, Phase.Sending(decision))
        val failure = answer(current.item, decision)
        val phase = if (failure == null) Phase.Done(ChatText.answered(current.item, decision)) else Phase.Failed(failure)
        if (_shown.value?.item?.key == current.item.key) _shown.value = Shown(current.item, phase)
    }

    /** Not now: the request stays on the box and under Activity; don't ask again for a while. */
    suspend fun notNow() {
        mutex.withLock {
            _shown.value?.let { snoozedUntil[it.item.key] = now() + snoozeMs }
            showNextLocked()
        }
    }

    /** Close a confirmation or a failure and show the next request. */
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
