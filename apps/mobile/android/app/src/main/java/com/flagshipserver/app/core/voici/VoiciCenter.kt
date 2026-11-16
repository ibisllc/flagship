// The app's voi.ci page and Messages (docs/voici-and-messages.md §5, §7-§11): one per process, set up by
// MainActivity. It keeps this device's copy (VoiciVault), merges the published page with every pending change,
// publishes from an admin device (and only there), hands a non-admin device's changes to the admin phone or the
// drafts lane, reads the inbox, sends replies, keeps the Messages state blob in step across the account's devices,
// and answers the phone endpoint's `live` and `deliver` (§8.2). Nothing here ever reaches a model (§10.4).

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.api.VoiciAccountKeys
import com.flagshipserver.app.api.VoiciClient
import com.flagshipserver.app.api.VoiciDeviceSigner
import com.flagshipserver.app.api.VoiciHttpError
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.concurrent.ConcurrentHashMap

/** What VoiciCenter needs from the device's keys. The Keystore-backed one is in VoiciKeystoreKeyring. */
interface VoiciKeyring {
    fun username(): String?
    fun umk(): ByteArray?
    /** This device holds the account's sensitive key (its admin root; the IRK on an account that pins none). */
    fun holdsSensitiveKey(account: VoiciAccountKeys): Boolean
    /** Signing a sensitive record now would raise a prompt (the session is locked). */
    fun sensitiveNeedsPrompt(): Boolean
    /** The sensitive key's seed and kind ("admin-root" | "irk"), after the biometric when the session needs one. */
    suspend fun sensitiveSeed(reason: String): Pair<ByteArray, String>
    /** The account device key (device headers, drafts, phone acks). Null on a device without one. */
    fun device(): VoiciDeviceSigner?
    /** Ask the person (biometric) before an act that is consent, even in an unlocked session. */
    suspend fun confirm(reason: String)
    /** The account's display name, for a first page. */
    fun displayName(): String
}

/**
 * Turning the page public never skips a step (docs/voici-and-messages.md §3.3): the page and message rules once per
 * device, then the one-time "Everything you put on your page is public" warning per account, then the signature. A
 * device that can't sign the page never gets past [Refuse]. Same steps as iOS PagePublicWarning.
 */
enum class PagePublicStep {
    Refuse, Rules, Warning, Publish;

    companion object {
        fun next(isAdmin: Boolean, rulesAccepted: Boolean, acknowledged: Boolean): PagePublicStep = when {
            !isAdmin -> Refuse
            !rulesAccepted -> Rules
            !acknowledged -> Warning
            else -> Publish
        }
    }
}

/** What ringing a visitor of this account's page back did (VoiciCenter.callVisitor). */
sealed interface CallVisitorOutcome {
    /** `.com` pushed the ring to the caller's devices; their app dials out to this page while it rings. */
    data class Ringing(val ringId: String, val until: Long) : CallVisitorOutcome
    /** The caller didn't choose "Call and allow call-back" (no ring-back channel): Call is disabled for them. */
    data object NoCallBack : CallVisitorOutcome
    data class Failed(val code: String) : CallVisitorOutcome
}

data class VoiciPageUi(
    val username: String = "",
    val loaded: Boolean = false,
    val publishedSeq: Long = 0,
    val published: VoiciPageState? = null,
    /** The page with every pending change applied (what the editor and preview show). */
    val working: VoiciPageState? = null,
    val pendingPostIds: Set<String> = emptySet(),
    val pendingProfile: Boolean = false,
    val pendingAccepts: Boolean = false,
    val pendingCount: Int = 0,
    val canPublish: Boolean = false,
    val publishing: Boolean = false,
    /** A refusal code from the last publish (VoiciCopy turns it into a sentence). */
    val error: String? = null,
    val takenDown: Boolean = false,
    val rulesAccepted: Boolean = false,
    val inboxEpoch: Long = 1,
    /** `.com` answered for this account's page at least once (published or not), so "no page" is known. */
    val checked: Boolean = false,
    /** Visitors see the page on voi.ci now (published and not removed). */
    val isPublic: Boolean = false,
    /** The owner took the page down; its content stays on the device. */
    val removed: Boolean = false,
    /** The one-time public warning was accepted on this device. */
    val publicWarned: Boolean = false,
    /** Calls are on in the published index (docs/voici-calls.md §6; only while the page is public). */
    val callsOn: Boolean = false,
    /**
     * The next publish is the page's first (this device saw no index and no removal): it turns on messages and calls
     * from signed-in people (VoiciCallSettings.FIRST_PUBLISH), and the public warning says so.
     */
    val firstPublish: Boolean = false,
    /** Who may call while calls are on: "accepted" or "signed-in". */
    val callsFrom: String = "accepted",
    /** The owner's call hours (synced between the owner's devices, never in the page); null = any time. */
    val callHours: VoiciCallHours? = null,
    /** "Answer calls while Flagship is locked" is on here: this device holds a bound call key. */
    val answersWhileLocked: Boolean = false,
)

data class VoiciMessagesUi(
    val conversations: List<StoredVoiciConversation> = emptyList(),
    val state: MessagesState = MessagesState(),
    val loading: Boolean = false,
    val error: String? = null,
    /** Missed calls opened and checked here (docs/voici-calls.md §6), shown in their conversation's thread. */
    val missedCalls: List<com.flagshipserver.app.calls.VoiciMissedCallRow> = emptyList(),
) {
    fun isRequest(c: StoredVoiciConversation) = c.conv !in state.accepted && c.messages.none { it.mine }
    val visible: List<StoredVoiciConversation> get() = conversations.filter { it.conv !in state.archived && it.pseudonymPub !in state.blocks }.sortedByDescending { it.lastAt }
    val accepted: List<StoredVoiciConversation> get() = visible.filter { !isRequest(it) }
    val requests: List<StoredVoiciConversation> get() = visible.filter { isRequest(it) }
    fun unread(c: StoredVoiciConversation): Boolean {
        val last = c.ordered.lastOrNull { !it.mine } ?: return false
        val read = state.readUpTo[c.conv] ?: return true
        if (read == last.msgId) return false
        val readAt = c.messages.firstOrNull { it.msgId == read }?.sentAt ?: return true
        return last.sentAt > readAt
    }
    val unreadCount: Int get() = visible.count { unread(it) }
    fun name(c: StoredVoiciConversation, generated: (String) -> String): String = state.nicknames[c.pseudonymPub]?.name ?: generated(c.pseudonymPub)
}

class VoiciCenter(
    val client: VoiciClient,
    private val keyring: VoiciKeyring,
    private val vault: VoiciVault,
    /** The CA keys `.com`'s attestations verify under (the maintainer chain, checked by the caller). */
    private val caKeysSource: suspend () -> List<String>,
    private val now: () -> Long = System::currentTimeMillis,
    private val origin: () -> String = { com.flagshipserver.app.core.Endpoints.voiciOrigin },
    val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    /** The app's HTTP client, for link cards (third-party sites, fetched once by this device, §2.5). */
    private val http: okhttp3.OkHttpClient? = null,
    /** This device's call-only keys (answering while locked); null where calls never ring. */
    private val callKeyVault: com.flagshipserver.app.calls.VoiciCallKeyVault? = null,
) {
    private val mutex = Mutex()
    private val _page = MutableStateFlow(VoiciPageUi())
    val page: StateFlow<VoiciPageUi> = _page.asStateFlow()
    private val _messages = MutableStateFlow(VoiciMessagesUi())
    val messages: StateFlow<VoiciMessagesUi> = _messages.asStateFlow()

    private val _demoPage = MutableStateFlow<VoiciDemoPageUi?>(null)
    /** A sample account's example page, read only (VoiciDemoPage); null until read, and for real accounts. */
    val demoPage: StateFlow<VoiciDemoPageUi?> = _demoPage.asStateFlow()

    /** Reads a sample account's page as a visitor would; a failed read keeps what was shown. */
    suspend fun refreshDemoPage(username: String) {
        val u = username.lowercase().takeIf { it.isNotEmpty() } ?: return
        if (_demoPage.value?.username != u) _demoPage.value = null
        VoiciDemoPage.load(client, u)?.let { _demoPage.value = it }
    }

    @Volatile private var account: VoiciAccountKeys? = null
    @Volatile private var caCache: List<String> = emptyList()
    @Volatile private var grantsCache: List<JsonObject> = emptyList()
    @Volatile private var pageCheckedFor: String? = null
    private val seenDirect = ConcurrentHashMap<String, Long>()

    // ── local state ──

    private fun user(): String? = keyring.username()?.lowercase()?.takeIf { it.isNotEmpty() }

    private fun <T> withLocal(block: (String, ByteArray, VoiciLocal) -> T): T? {
        val u = user() ?: return null
        val umk = keyring.umk() ?: return null
        return block(u, umk, vault.load(umk, u))
    }

    private suspend fun update(block: (VoiciLocal) -> VoiciLocal): VoiciLocal? = mutex.withLock {
        val u = user() ?: return null
        val umk = keyring.umk() ?: return null
        val next = applyForgotten(block(vault.load(umk, u)), umk)
        vault.save(umk, u, next)
        publishUi(u, next)
        next
    }

    /**
     * Delete = forget on every device (docs/voici-and-messages.md §10.1.1): for each deletion marker in the synced state
     * this device hasn't acted on yet, what it keeps by itself of that conversation goes: the stored messages, a
     * checked reveal, the ring-back flag and call history (owner side, by conv), and, when the conversation is this
     * account's own as a caller, the page's call-back and reveal records, reply notices and calls (caller side).
     */
    private fun applyForgotten(l: VoiciLocal, umk: ByteArray): VoiciLocal {
        val raw = l.state?.get("forgotten") as? JsonObject
        if (raw == null) return if (l.forgetApplied.isEmpty()) l else l.copy(forgetApplied = emptyMap())
        // Only the markers are read here (this runs on every update): the state was checked when it was stored.
        val t = now()
        val live = raw.mapNotNull { (conv, f) -> VoiciJs.time((f as? JsonObject)?.get("at"))?.let { conv to it } }
            .filter { (_, at) -> t - at < VoiciMessages.FORGET_KEEP_MS }.toMap()
        val fresh = live.filter { (conv, at) -> at > (l.forgetApplied[conv] ?: -1) }
        val applied = live.mapValues { (conv, at) -> maxOf(at, l.forgetApplied[conv] ?: 0) }
        if (fresh.isEmpty()) return if (applied == l.forgetApplied) l else l.copy(forgetApplied = applied)
        var out = l
        for (conv in fresh.keys) out = forgetLocally(out, conv, umk)
        if (out.callHistory != l.callHistory) _callHistoryVersion.value += 1
        _messages.value = _messages.value.copy(missedCalls = _messages.value.missedCalls.filter { it.conv !in fresh.keys })
        return out.copy(forgetApplied = applied)
    }

    /** What this device keeps of one conversation, by itself (never synced), goes. */
    private fun forgetLocally(l: VoiciLocal, conv: String, umk: ByteArray): VoiciLocal {
        val secret = VoiciMessages.deriveMessagesSecret(umk)
        val candidates = l.callBackPages + l.revealedTo.keys + l.signInPages.keys + l.replyLatest.keys + l.callHistory.mapNotNull { it.peerPageId }
        val pages = candidates.toSet().filter { pid ->
            runCatching { VoiciMessages.voiciConv(pid, VoiciJs.hex(VoiciMessages.deriveMessagesPseudonymKey(secret, pid).publicKey)) == conv }.getOrDefault(false)
        }.toSet()
        return l.copy(
            conversations = l.conversations.filter { it.conv != conv },
            reveals = l.reveals - conv,
            ringBackOff = l.ringBackOff - conv,
            callHistory = l.callHistory.filterNot { it.conv == conv || it.peerPageId in pages },
            callBackPages = l.callBackPages - pages,
            revealedTo = l.revealedTo - pages,
            replyLatest = l.replyLatest - pages,
            replySeen = l.replySeen - pages,
            replyCursor = l.replyCursor - pages,
        )
    }

    fun image(sha: String?): ByteArray? {
        sha ?: return null
        return withLocal { u, umk, _ -> vault.image(umk, u, sha) }
    }

    fun putImage(bytes: ByteArray): String? = withLocal { u, umk, _ -> vault.putImage(umk, u, bytes) }

    private fun ops(local: VoiciLocal): List<VoiciDraftOp> =
        (local.localOps.mapNotNull { VoiciMessages.parseVoiciDraftOp(it.op) } + local.laneOps.mapNotNull { VoiciMessages.parseVoiciDraftOp(it) })
            .distinctBy { it.opId }

    private fun isFirstPublish(idx: VoiciPageIndex?, local: VoiciLocal): Boolean = idx == null && !local.removed && local.ladderSeq == 0L

    private fun publishedState(u: String, local: VoiciLocal): VoiciPageState =
        // A first page carries the account name (the username) until the owner changes it: never a private label.
        VoiciOwner.parsePageState(local.publishedState) ?: VoiciOwner.emptyState(u)

    private fun publishUi(u: String, local: VoiciLocal) {
        val ops = ops(local)
        val base = publishedState(u, local)
        val acc = account
        val idx = local.publishedIndex?.let(VoiciPage::parseVoiciPageIndex)
        _page.value = VoiciPageUi(
            username = u,
            loaded = true,
            publishedSeq = idx?.body?.seq ?: 0,
            published = VoiciOwner.parsePageState(local.publishedState),
            working = VoiciPage.mergeVoiciPage(base, ops),
            pendingPostIds = ops.mapNotNull { it.post?.id ?: it.postId }.toSet(),
            pendingProfile = ops.any { it.op == "profile" },
            pendingAccepts = ops.any { it.op == "accept-messages" },
            pendingCount = ops.size,
            canPublish = acc != null && keyring.holdsSensitiveKey(acc),
            publishing = _page.value.publishing,
            error = _page.value.error,
            takenDown = local.takenDown,
            rulesAccepted = local.rulesAccepted,
            inboxEpoch = local.inboxEpoch,
            checked = pageCheckedFor == u,
            isPublic = idx != null && !local.removed,
            removed = local.removed,
            publicWarned = local.publicWarned,
            callsOn = idx != null && !local.removed && idx.body.takesCalls,
            firstPublish = isFirstPublish(idx, local),
            callsFrom = com.flagshipserver.app.calls.VoiciCallSettings.read(idx?.body?.acceptsCalls, idx?.body?.callsFrom).second,
            callHours = callHoursSetting(local)?.hours,
            answersWhileLocked = callKeyVault?.load(u) != null,
        )
        val state = local.state?.let(VoiciMessages::parseMessagesState) ?: MessagesState()
        _messages.value = _messages.value.copy(conversations = local.conversations, state = state)
    }

    /**
     * The account leaves this device (sign out, remove this device, account gone): its sealed copy (the page, a removed
     * page's content, drafts, conversations, images) goes with it.
     */
    fun forgetLocal() {
        _demoPage.value = null
        val u = user() ?: return
        // Sign-out or removal: the call key goes too, revoked first (the owner key may be gone: it signs itself).
        callKeyVault?.load(u)?.let { k ->
            val body = runCatching { k.selfRevokeBody(now()) }.getOrNull()
            callKeyVault.delete(u)
            if (body != null) scope.launch { runCatching { client.revokeCallKey(u, body) } }
        }
        vault.forget(u)
        pageCheckedFor = null
        _page.value = VoiciPageUi()
        _messages.value = VoiciMessagesUi()
    }

    /** Load what this device holds, then refresh from `.com`. */
    fun start() {
        withLocal { u, _, local -> publishUi(u, local) }
        scope.launch { refresh() }
    }

    suspend fun refresh() {
        runCatching { refreshAccount() }
        runCatching { refreshPage() }
        runCatching { refreshDrafts() }
        runCatching { syncState() }
        runCatching { refreshInbox() }
        runCatching { refreshCallHours() }
        runCatching { rebindCallKeyIfNeeded() }
        runCatching { checkReplies() }
        // Every change waits for Publish on an admin device (or the Messages header's quick controls).
        withLocal { u, _, local -> publishUi(u, local) }
    }

    private suspend fun refreshAccount(): VoiciAccountKeys? {
        val u = user() ?: return null
        client.accountKeys(u)?.let { account = it }
        if (caCache.isEmpty()) caCache = runCatching { caKeysSource() }.getOrDefault(emptyList())
        grantsCache = runCatching { client.deviceGrants(u) }.getOrDefault(grantsCache)
        return account
    }

    // ── the published page ──

    /** Read `.com`'s current index, check it against the account's own key, and keep it with its pieces. */
    private suspend fun refreshPage() {
        val u = user() ?: return
        val acc = account ?: return
        val json = client.page(u)
        if (json == null) {
            // No page on `.com`: never made, or removed (here or on another device). Its content stays here.
            if (withLocal { _, _, l -> l.publishedIndex != null && !l.removed } == true) update { it.copy(removed = true) }
            pageCheckedFor = u
            return
        }
        val local = withLocal { _, _, l -> l } ?: return
        val known = local.publishedIndex?.let(VoiciPage::parseVoiciPageIndex)
        // Never older than the highest seq this device saw (an index or a removal): neither can be replayed.
        val seen = maxOf(known?.body?.seq ?: 0, local.ladderSeq).takeIf { it > 0 }
        val r = VoiciPage.checkVoiciPageIndex(json, u, acc.sensitiveKind, acc.sensitivePub, seen, known?.body?.pageId)
        val idx = r.valueOrNull() ?: return
        if (known != null && idx.body.seq == known.body.seq) {
            pageCheckedFor = u
            return
        }
        if (adopt(u, idx) != null) pageCheckedFor = u
    }

    private suspend fun adopt(u: String, idx: VoiciPageIndex): VoiciPageState? {
        val umk = keyring.umk() ?: return null
        val fetched = HashMap<String, ByteArray>()
        for (p in idx.body.pieces) {
            val have = vault.image(umk, u, p.sha256)
            val b = have ?: client.piece(u, idx.body.pageId, p.sha256) ?: continue
            fetched[p.sha256] = b
            if (have == null && (p.role == "avatar" || p.role.startsWith("card-"))) vault.putImage(umk, u, b)
        }
        val state = VoiciOwner.readPublished(idx) { fetched[it.sha256] } ?: return null
        update { l ->
            l.copy(
                pageId = idx.body.pageId,
                inboxEpoch = maxOf(l.inboxEpoch, idx.body.inboxEpoch),
                publishedIndex = idx.toJson(),
                publishedState = state.toJson(),
                localOps = l.localOps.filter { lo -> lo.op.let(VoiciMessages::parseVoiciDraftOp)?.let { !(lo.delivered && it.at <= idx.body.issuedAt) } ?: false },
                takenDown = false,
                removed = false,
                ladderSeq = maxOf(l.ladderSeq, idx.body.seq),
            )
        }
        return state
    }

    // ── editing (any device) ──

    /**
     * Record a change made on this device: a draft until Publish on an admin device; another device hands it to the
     * admin device. A profile or accept-messages change replaces this device's earlier one that hasn't left it (so
     * "N changes not published" counts what changed), and is dropped when it equals what's published.
     */
    suspend fun edit(op: String, post: VoiciPost? = null, postId: String? = null, profile: VoiciProfile? = null, accepts: Int? = null) {
        val u = user() ?: return
        val umk = keyring.umk() ?: return
        val deviceId = keyring.device()?.deviceId ?: "device"
        val images = buildList {
            post?.links?.forEach { l -> l.card?.image?.let { sha -> vault.image(umk, u, sha)?.let { add(VoiciDraftImage(sha, WebEnvelopes.b64Encode(it))) } } }
            profile?.avatar?.let { sha -> vault.image(umk, u, sha)?.let { add(VoiciDraftImage(sha, WebEnvelopes.b64Encode(it))) } }
        }.takeIf { it.isNotEmpty() }
        // A profile or accept-messages change is newer than the published page even when the page was signed by a
        // device whose clock runs ahead (the merge keeps the later `at`).
        val publishedAt = withLocal { _, _, l -> publishedState(u, l).issuedAt } ?: 0
        val at = if (op == "profile" || op == "accept-messages") maxOf(now(), publishedAt + 1) else now()
        val d = VoiciDraftOp(VoiciOwner.randomHex(16), op, at, deviceId.take(64), post, postId, profile, accepts, images)
        requireNotNull(VoiciMessages.parseVoiciDraftOp(d.toJson())) { "voici: malformed change" }
        val stored = d.copy(images = null).toJson()
        val replaces = op == "profile" || op == "accept-messages"
        var recorded = true
        update { l ->
            val kept = if (replaces) l.localOps.filter { it.delivered || VoiciJs.str(it.op["op"]) != op } else l.localOps
            val base = publishedState(u, l)
            val same = (op == "profile" && profile == base.profile) || (op == "accept-messages" && accepts == base.acceptsMessages)
            val laneHasOne = l.laneOps.any { VoiciJs.str(it["op"]) == op }
            recorded = !(replaces && same && !laneHasOne)
            l.copy(localOps = if (recorded) kept + VoiciLocalOp(stored) else kept)
        }
        if (!recorded) return
        val acc = account ?: refreshAccount()
        if (acc == null || !keyring.holdsSensitiveKey(acc)) scope.launch { runCatching { handOver(d) } }
    }

    /** A non-admin device's change: to the admin phone when it holds its name, else the drafts lane (§5.2). */
    private suspend fun handOver(op: VoiciDraftOp) {
        val u = user() ?: return
        val umk = keyring.umk() ?: return
        val device = keyring.device() ?: return
        val row = grantsCache.firstOrNull { (it["devicePubHex"] as? JsonPrimitive)?.content?.lowercase() == device.pubHex }
            ?: client.deviceGrants(u).also { grantsCache = it }.firstOrNull { (it["devicePubHex"] as? JsonPrimitive)?.content?.lowercase() == device.pubHex }
            ?: return
        val (grant, sig) = VoiciOwner.grantCred(row) ?: return
        val seq = (update { it.copy(draftSeq = it.draftSeq + 1) } ?: return).draftSeq
        val env = VoiciOwner.draftEnvelope(VoiciMessages.deriveVoiciDraftsKey(umk), u, op, device.pubHex, { device.signer.sign(it) }, grant, sig, seq).toJson()
        val direct = deliverToPhone(u, env, op.opId)
        if (!direct) client.depositDraft(u, device, env)
        update { l -> l.copy(localOps = l.localOps.map { if (VoiciJs.str(it.op["opId"]) == op.opId) it.copy(delivered = true) else it }) }
    }

    /** Native delivery to the admin phone (§8.2): live with the page's key, an ack by a key that holds an admin grant. */
    private suspend fun deliverToPhone(u: String, envelope: JsonObject, msgId: String): Boolean {
        val live = VoiciPhoneWeb.parsePhoneLiveAnswer(client.phoneLive(u) ?: return false) ?: return false
        if (live.account != u) return false
        val ack = client.phoneDeliver(u, envelope) ?: return false
        val phonePub = VoiciJs.str(ack["phoneRoutePub"]) ?: return false
        if (VoiciMessages.verifyVoiciAck(ack, phonePub, msgId, "") == null) return false
        return grantsCache.any { g ->
            VoiciJs.str(g["devicePubHex"])?.lowercase() == phonePub && VoiciJs.str(g["signerRoot"]) == "admin-root" &&
                VoiciJs.arr(g["scopes"])?.any { VoiciJs.str(it) == "admin" } == true
        }
    }

    // ── the drafts lane (admin side) ──

    private suspend fun refreshDrafts() {
        val u = user() ?: return
        val umk = keyring.umk() ?: return
        val acc = account ?: return
        val items = client.drafts(u)
        val draftsKey = VoiciMessages.deriveVoiciDraftsKey(umk)
        val opened = items.mapNotNull { openDraft(u, umk, draftsKey, acc, it.envelope, null) }
        update { l ->
            val mine = l.localOps.mapNotNull { VoiciJs.str(it.op["opId"]) }.toSet()
            val lane = (l.laneOps + opened.map { it.copy(images = null).toJson() }).distinctBy { VoiciJs.str(it["opId"]) }.filter { VoiciJs.str(it["opId"]) !in mine }
            val listed = opened.map { it.opId }.toSet()
            // A non-admin device drops a delivered change once it left the lane (published and consumed).
            val local = if (keyring.holdsSensitiveKey(acc)) l.localOps else l.localOps.filter { !it.delivered || VoiciJs.str(it.op["opId"]) in listed }
            l.copy(laneOps = if (keyring.holdsSensitiveKey(acc)) lane else lane.filter { VoiciJs.str(it["opId"]) in listed }, localOps = local)
        }
    }

    /** Checks a voici-draft (grant chain against the account's keys), opens it and keeps its images. */
    private fun openDraft(u: String, umk: ByteArray, draftsKey: ByteArray, acc: VoiciAccountKeys, envelope: JsonElement, freshAt: Long?): VoiciDraftOp? {
        val r = VoiciMessages.checkVoiciDraft(envelope, u, { g, s, pub -> VoiciOwner.grantOk(g, s, pub, u, acc, now()) }, freshAt)
        val env = r.valueOrNull() ?: return null
        val op = VoiciMessages.openVoiciDraft(draftsKey, u, env.msgId, WebEnvelopes.b64Decode(env.bodyB64) ?: return null) ?: return null
        op.images?.forEach { im -> WebEnvelopes.b64Decode(im.data)?.let { vault.putImage(umk, u, it) } }
        return op
    }

    // ── publishing (admin device only, §5.1, §5.3) ──

    /**
     * Sign and publish. [reason] null: never prompt (the unlocked-session rule); otherwise the biometric when the
     * session needs it. [only]: just these ops on top of the published page (the header's quick controls), every
     * other draft stays a draft; null publishes every pending change. [mayRepublish]: only the Public switch (after its
     * warning) brings back a page another device took down; any other publish that learns of it from a 409 stops.
     */
    suspend fun publish(reason: String?, only: List<VoiciDraftOp>? = null, mayRepublish: Boolean = false, calls: Pair<Boolean, String>? = null): Boolean {
        val u = user() ?: return false
        val umk = keyring.umk() ?: return false
        val acc = account ?: refreshAccount() ?: return fail("not-found")
        if (!keyring.holdsSensitiveKey(acc)) return fail("not-sensitive-key")
        if (reason == null && keyring.sensitiveNeedsPrompt()) return false
        if (_page.value.publishing) return false
        _page.value = _page.value.copy(publishing = true, error = null)
        try {
            val (seed, kind) = keyring.sensitiveSeed(reason ?: "")
            repeat(3) {
                val local = withLocal { _, _, l -> l } ?: return fail("not-found")
                val idx = local.publishedIndex?.let(VoiciPage::parseVoiciPageIndex)
                val base = publishedState(u, local)
                val ops = only ?: ops(local)
                val working = VoiciPage.mergeVoiciPage(base, ops)
                val pageId = idx?.body?.pageId ?: local.pageId ?: VoiciOwner.randomHex(16)
                if (local.pageId == null) update { it.copy(pageId = pageId) }
                val keys = VoiciOwnerKeys.derive(umk, pageId, local.inboxEpoch)
                // After a removal `.com` dropped the pieces: send them all again.
                val have = if (local.removed) emptyList() else idx?.body?.pieces.orEmpty()
                val plan = VoiciOwner.planPieces(working, { vault.image(umk, u, it) }, have)
                val listed = have.map { it.sha256 }.toSet()
                for (p in plan) {
                    if (p.sha256 in listed || p.bytes == null) continue
                    val at = now()
                    val sig = VoiciPage.signVoiciPieceUpload(VoiciPieceUpload(u, pageId, p.sha256, p.size, at), seed)
                    client.uploadPiece(u, pageId, p.sha256, p.size, at, VoiciJs.hex(VoiciJs.edPub(seed)), sig, p.bytes, p.contentType)
                }
                val seq = maxOf(idx?.body?.seq ?: 0, local.ladderSeq) + 1
                // Every publish carries the calls setting of the index it replaces (a profile edit never turns calls off).
                // A first publish turns calls on for signed-in callers (owner decision 2026-11-16).
                val current = if (isFirstPublish(idx, local)) com.flagshipserver.app.calls.VoiciCallSettings.FIRST_PUBLISH
                else com.flagshipserver.app.calls.VoiciCallSettings.read(if (local.removed) null else idx?.body?.acceptsCalls, idx?.body?.callsFrom)
                val (callsOn, callsFrom) = calls ?: current
                val fields = com.flagshipserver.app.calls.VoiciCallSettings.indexFields(callsOn, callsFrom)
                val body = VoiciPageIndexBody(
                    u, pageId, seq, now(), working.acceptsMessages, keys.epoch, keys.inboxPub, keys.signPub,
                    plan.map { it.ref }, kind, acceptsCalls = fields.first, callsFrom = fields.second,
                )
                val signed = VoiciPage.signVoiciPageIndex(body, seed)
                try {
                    client.publish(u, signed.toJson())
                } catch (e: VoiciHttpError) {
                    when (e.code) {
                        "seq-conflict" -> {
                            takeConflict(u, acc, e)
                            if (!mayRepublish && withLocal { _, _, l -> l.removed } == true) {
                                _page.value = _page.value.copy(publishing = false)
                                return false
                            }
                            return@repeat
                        }
                        "wrong-page" -> {
                            // A device that never saw the page (removed before) continues it under its pageId.
                            val stored = VoiciJs.str(e.body["pageId"])
                            if (idx == null && stored != null && WebEnvelopes.isLowerHex(stored, 16)) {
                                update { it.copy(pageId = stored) }
                                return@repeat
                            }
                            return fail("wrong-page")
                        }
                        "taken-down" -> {
                            update { it.copy(takenDown = true) }
                            return fail("taken-down")
                        }
                        else -> return fail(e.code ?: "network")
                    }
                }
                val applied = ops.map { it.opId }.toSet()
                val laneIds = if (only != null) emptyList() else local.laneOps.mapNotNull { VoiciJs.str(it["opId"]) }.filter { it in applied }
                val published = working.copy(issuedAt = signed.body.issuedAt)
                update { l ->
                    l.copy(
                        pageId = pageId,
                        publishedIndex = signed.toJson(),
                        publishedState = published.toJson(),
                        localOps = if (only == null) l.localOps.filter { VoiciJs.str(it.op["opId"]) !in applied }
                        else l.localOps.mapNotNull { lo -> VoiciMessages.parseVoiciDraftOp(lo.op)?.let { carry(it, published) }?.let { lo.copy(op = it.copy(images = null).toJson()) } },
                        laneOps = if (only == null) l.laneOps.filter { VoiciJs.str(it["opId"]) !in applied }
                        else l.laneOps.mapNotNull { j -> VoiciMessages.parseVoiciDraftOp(j)?.let { carry(it, published) }?.copy(images = null)?.toJson() },
                        takenDown = false,
                        removed = false,
                        ladderSeq = maxOf(l.ladderSeq, seq),
                    )
                }
                if (laneIds.isNotEmpty()) runCatching { laneIds.chunked(200).forEach { client.consumeDrafts(u, VoiciOwner.consumeBody(u, it, now(), seed)) } }
                _page.value = _page.value.copy(publishing = false, error = null)
                return true
            }
            return fail("conflict")
        } catch (e: VoiciHttpError) {
            return fail(e.code ?: "network")
        } catch (e: com.flagshipserver.app.keystore.BiometricCancelled) {
            _page.value = _page.value.copy(publishing = false)
            return false
        } catch (e: Exception) {
            return fail("network")
        }
    }

    /**
     * A 409's answer: a removed page names the removal's seq (its stored index is the old public one); otherwise the
     * stored index, checked against the account's own key and never older than what this device saw.
     */
    private suspend fun takeConflict(u: String, acc: VoiciAccountKeys, e: VoiciHttpError) {
        val removedThere = (e.body["removed"] as? JsonPrimitive)?.content == "true"
        val storedSeq = VoiciJs.time(e.body["seq"]) ?: 0
        if (removedThere) {
            val storedPageId = VoiciJs.str(e.body["pageId"])?.takeIf { WebEnvelopes.isLowerHex(it, 16) }
            update { l ->
                l.copy(
                    ladderSeq = maxOf(l.ladderSeq, storedSeq),
                    removed = l.publishedIndex != null,
                    pageId = if (l.publishedIndex == null && storedPageId != null) storedPageId else l.pageId,
                )
            }
            return
        }
        val local = withLocal { _, _, l -> l } ?: return
        val stored = VoiciPage.checkVoiciPageIndex(e.body["index"], u, acc.sensitiveKind, acc.sensitivePub, local.ladderSeq.takeIf { it > 0 }).valueOrNull()
        if (stored != null) adopt(u, stored)
    }

    /**
     * A draft left after a quick publish: a profile draft takes the name and photo just published (and goes when
     * nothing else in it differs); profile and accept-messages drafts stay newer than the page, so the merge (the
     * later `at` wins) still applies them.
     */
    private fun carry(op: VoiciDraftOp, published: VoiciPageState): VoiciDraftOp? {
        var o = op
        if (o.op == "profile" && o.profile != null) {
            val p = o.profile!!.copy(displayName = published.profile.displayName, avatar = published.profile.avatar)
            if (p == published.profile) return null
            o = o.copy(profile = p)
        }
        if (o.op == "profile" || o.op == "accept-messages") o = o.copy(at = maxOf(o.at, published.issuedAt + 1))
        return o
    }

    private fun fail(code: String): Boolean {
        _page.value = _page.value.copy(publishing = false, error = code)
        return false
    }

    suspend fun acceptRules() {
        update { it.copy(rulesAccepted = true) }
    }

    /** "Make it public" on the one-time warning (remembered for this account on this device). */
    suspend fun acknowledgePublicWarning() {
        update { it.copy(publicWarned = true) }
    }

    /** What the Public switch, or Publish while the page is not public, must show before anything is signed. */
    fun publicStep(): PagePublicStep {
        val p = _page.value
        // A first publish always shows the warning, since it says what the page starts with.
        return PagePublicStep.next(isAdmin = p.canPublish, rulesAccepted = p.rulesAccepted, acknowledged = p.publicWarned && !p.firstPublish)
    }

    /**
     * The Public switch turned on: the page goes up with its name and photo as the header shows them, on top of what
     * was published last (a page turned off comes back as it was); every other draft stays a draft. The caller has
     * walked [publicStep] to [PagePublicStep.Publish].
     */
    suspend fun goPublic(reason: String): Boolean {
        val u = user() ?: return false
        val local = withLocal { _, _, l -> l } ?: return false
        if (_page.value.isPublic) return true
        val base = publishedState(u, local)
        val working = VoiciPage.mergeVoiciPage(base, ops(local))
        val q = base.profile.copy(displayName = working.profile.displayName, avatar = working.profile.avatar)
        val deviceId = keyring.device()?.deviceId ?: "device"
        return publish(reason, only = listOf(VoiciDraftOp(VoiciOwner.randomHex(16), "profile", maxOf(now(), base.issuedAt + 1), deviceId.take(64), profile = q)), mayRepublish = true)
    }

    /**
     * The Messages header's name and photo. While the page is public an admin device publishes just this change at
     * once (other drafts stay); otherwise it is a draft like any other. Null on success, else a refusal code.
     */
    suspend fun setQuickProfile(displayName: String, avatar: String?, reason: String): String? {
        val u = user() ?: return "not-found"
        val name = VoiciText.prepareVoiciText(VoiciTextField.displayName, displayName.trim())
        val n = name.valueOrNull() ?: return name.code
        val local = withLocal { _, _, l -> l } ?: return "not-found"
        val p = _page.value
        val base = publishedState(u, local)
        if (p.isPublic && p.canPublish) {
            val q = base.profile.copy(displayName = n, avatar = avatar)
            if (q == base.profile) return null
            val deviceId = keyring.device()?.deviceId ?: "device"
            val ok = publish(reason, only = listOf(VoiciDraftOp(VoiciOwner.randomHex(16), "profile", maxOf(now(), base.issuedAt + 1), deviceId.take(64), profile = q)))
            return if (ok) null else _page.value.error
        }
        val working = VoiciPage.mergeVoiciPage(base, ops(local))
        val q = working.profile.copy(displayName = n, avatar = avatar)
        if (q != working.profile) edit("profile", profile = q)
        return null
    }

    /**
     * "Remove my page": a signed VoiciPageRemove on the publish ladder (seq + 1), with the key and the biometric rule
     * publishing uses. Visitors then see "There's no page here."; posts, profile, drafts and conversations stay here.
     */
    suspend fun removePage(reason: String): Boolean {
        val u = user() ?: return false
        val acc = account ?: refreshAccount() ?: return fail("not-found")
        if (!keyring.holdsSensitiveKey(acc)) return fail("not-sensitive-key")
        if (!_page.value.isPublic || _page.value.publishing) return false
        _page.value = _page.value.copy(publishing = true, error = null)
        try {
            val (seed, kind) = keyring.sensitiveSeed(reason)
            repeat(2) { attempt ->
                val local = withLocal { _, _, l -> l } ?: return fail("not-found")
                val idx = local.publishedIndex?.let(VoiciPage::parseVoiciPageIndex) ?: return fail("not-found")
                if (local.removed) {
                    _page.value = _page.value.copy(publishing = false)
                    return true
                }
                val r = VoiciPageRemove.sign(u, idx.body.pageId, maxOf(idx.body.seq, local.ladderSeq) + 1, now(), kind, seed)
                try {
                    client.removePage(u, r.toJson())
                    update { it.copy(removed = true, ladderSeq = maxOf(it.ladderSeq, r.seq)) }
                    _page.value = _page.value.copy(publishing = false, error = null)
                    return true
                } catch (e: VoiciHttpError) {
                    when {
                        // Another admin device published first: refresh and retry once, on the index `.com` now holds.
                        e.code == "seq-conflict" && attempt == 0 -> takeConflict(u, acc, e)
                        // Already gone (removed on another device).
                        e.code == "not-found" -> {
                            update { it.copy(removed = true) }
                            _page.value = _page.value.copy(publishing = false, error = null)
                            return true
                        }
                        e.code == "wrong-signer" -> return fail("not-sensitive-key")
                        else -> return fail(e.code ?: "network")
                    }
                }
            }
            return fail("remove-failed")
        } catch (e: VoiciHttpError) {
            return fail(e.code ?: "network")
        } catch (e: com.flagshipserver.app.keystore.BiometricCancelled) {
            _page.value = _page.value.copy(publishing = false)
            return false
        } catch (e: Exception) {
            return fail("network")
        }
    }

    /**
     * Settings → Messages → Calls: on/off and who may call, published at once in the index by an admin device
     * (docs/voici-calls.md §6, §8). Drafts stay drafts. False when it couldn't be published (`page.error` says why).
     */
    suspend fun setCalls(on: Boolean, from: String, reason: String): Boolean {
        val p = _page.value
        if (!p.isPublic || !p.canPublish || from !in com.flagshipserver.app.calls.VoiciCallSettings.FROM_VALUES) return false
        if (on == p.callsOn && (!on || from == p.callsFrom)) return true
        return publish(reason, only = emptyList(), calls = on to from)
    }

    // ── the owner's call hours: synced between the owner's devices, never in the page (owner decision 2026-11-16) ──

    /** Called with the hours whenever they sync, so the device keeps a copy that a locked phone can enforce. */
    @Volatile var onCallHours: ((VoiciCallHours?) -> Unit)? = null

    private fun callHoursSetting(local: VoiciLocal): VoiciCallHoursSetting? = local.callHoursSetting?.let(VoiciCallHoursSettings::parse)

    /** The synced setting from `.com` (opened with the account's own key), merged with this device's copy: newer wins. */
    suspend fun refreshCallHours() {
        val u = user() ?: return
        val umk = keyring.umk() ?: return
        val blob = client.callSettings(u) ?: return
        val remote = VoiciCallHoursSettings.open(VoiciCallHoursSettings.deriveKey(umk), u, blob) ?: return
        val local = withLocal { _, _, l -> l } ?: return
        val mine = callHoursSetting(local)
        val merged = if (mine == null) remote else VoiciCallHoursSettings.merge(mine, remote)
        update { it.copy(callHoursSetting = merged.toJson(), callHoursVersion = VoiciCallHoursSettings.version(blob)) }
        onCallHours?.invoke(merged.hours)
    }

    /**
     * Set or clear the owner's call hours (null = calls ring any time): sealed with the account's own key and written
     * as the next version; on a conflict the newer one wins and the write is tried again. `.com` never sees the hours.
     */
    suspend fun setCallHours(hours: VoiciCallHours?): Boolean {
        val u = user() ?: return false
        val umk = keyring.umk() ?: return false
        val device = keyring.device() ?: return false
        if (hours != null && VoiciCallHoursSettings.parseHours(hours.toJson()) == null) return false
        val key = VoiciCallHoursSettings.deriveKey(umk)
        var mine = VoiciCallHoursSetting(hours, now())
        var version = (withLocal { _, _, l -> l.callHoursVersion } ?: 0) + 1
        for (attempt in 0 until 3) {
            try {
                client.putCallSettings(u, device, VoiciCallHoursSettings.seal(key, u, version, mine))
                update { it.copy(callHoursSetting = mine.toJson(), callHoursVersion = version) }
                onCallHours?.invoke(mine.hours)
                withLocal { uu, _, l -> publishUi(uu, l) }
                return true
            } catch (e: VoiciHttpError) {
                if (e.code != "version-conflict") return false
                val stored = e.body["settings"]
                VoiciCallHoursSettings.open(key, u, stored)?.let { remote -> mine = VoiciCallHoursSettings.merge(mine, remote) }
                version = VoiciCallHoursSettings.version(stored) + 1
            } catch (e: Exception) {
                return false
            }
        }
        return false
    }

    // ── answering while locked (docs/voici-calls.md, owner decisions 2026-11-15) ──

    /**
     * Settings → Messages → "Answer calls while Flagship is locked" (off by default). On: an unlocked admin device makes
     * its call-only key, binds it under the owner messages key and registers the binding with `.com`. Off: a signed
     * revocation, then the key is deleted. Null on success, else a code.
     */
    suspend fun setAnswerWhileLocked(on: Boolean): String? {
        val vault = callKeyVault ?: return "unsupported"
        val u = user() ?: return "not-found"
        if (!on) {
            revokeCallKey()
            return null
        }
        val umk = keyring.umk() ?: return "locked"
        val device = keyring.device() ?: return "locked"
        val local = withLocal { _, _, l -> l } ?: return "not-found"
        if (local.removed || !_page.value.canPublish) return "not-admin"
        val idx = local.publishedIndex?.let(VoiciPage::parseVoiciPageIndex) ?: return "not-found"
        val keys = VoiciOwnerKeys.derive(umk, idx.body.pageId, idx.body.inboxEpoch)
        val signer = runCatching { vault.generate(u) }.getOrElse { return "keystore" }
        return try {
            val proof = VoiciCalls.signCallKeyBinding(u, device.deviceId, signer.pubHex, now(), keys.sign.seed)
            client.registerCallKey(u, device, proof)
            vault.load(u)?.takeIf { it.pubHex != signer.pubHex }?.let { old -> runCatching { client.revokeCallKey(u, ownerRevokeBody(old, keys)) } }
            vault.save(com.flagshipserver.app.calls.VoiciCallKey(u, device.deviceId, idx.body.pageId, keys.signPub, proof, signer))
            withLocal { uu, _, l -> publishUi(uu, l) }
            null
        } catch (e: VoiciHttpError) {
            vault.discard(signer)
            e.code ?: "network"
        } catch (e: Exception) {
            vault.discard(signer)
            "network"
        }
    }

    private fun ownerRevokeBody(k: com.flagshipserver.app.calls.VoiciCallKey, keys: VoiciOwnerKeys): JsonObject {
        val at = now()
        val sig = VoiciJs.hex(VoiciJs.edSign(keys.sign.seed, VoiciCalls.canonicalCallKeyRevoke(k.username, k.deviceId, k.pubHex, at)))
        return JsonObject(mapOf("revoke" to VoiciCalls.revokeJson(k.username, k.deviceId, k.pubHex, at), "signature" to JsonPrimitive(sig)))
    }

    /** Off: a revocation signed by the owner key when this device holds it, else by the call key itself. */
    suspend fun revokeCallKey() {
        val vault = callKeyVault ?: return
        val u = user() ?: return
        val k = vault.load(u) ?: return
        val owner = keyring.umk()?.let { umk -> withLocal { _, _, l -> l }?.let { ownerKeys(it, umk) } }?.takeIf { it.signPub == k.ownerSignPub }
        runCatching { client.revokeCallKey(u, if (owner != null) ownerRevokeBody(k, owner) else k.selfRevokeBody(now())) }
        vault.delete(u)
        withLocal { uu, _, l -> publishUi(uu, l) }
    }

    /** The inbox key was rotated (a new ownerSignPub): the binding no longer verifies, so bind the same key again. */
    private suspend fun rebindCallKeyIfNeeded() {
        val vault = callKeyVault ?: return
        val u = user() ?: return
        val k = vault.load(u) ?: return
        val umk = keyring.umk() ?: return
        val device = keyring.device() ?: return
        val local = withLocal { _, _, l -> l } ?: return
        if (local.removed) return
        val idx = local.publishedIndex?.let(VoiciPage::parseVoiciPageIndex) ?: return
        val keys = VoiciOwnerKeys.derive(umk, idx.body.pageId, idx.body.inboxEpoch)
        if (keys.signPub == k.ownerSignPub) return
        val proof = VoiciCalls.signCallKeyBinding(u, k.deviceId, k.pubHex, now(), keys.sign.seed)
        runCatching { client.registerCallKey(u, device, proof) }.onSuccess {
            vault.save(com.flagshipserver.app.calls.VoiciCallKey(u, k.deviceId, idx.body.pageId, keys.signPub, proof, k.signer))
        }
    }

    /** A ringing phone that is locked: its call key, when the setting is on. */
    suspend fun lockedCallKeys(): com.flagshipserver.app.calls.VoiciCallKeys? {
        val vault = callKeyVault ?: return null
        val u = user() ?: vault.currentAccount() ?: return null
        val k = vault.load(u) ?: return null
        return com.flagshipserver.app.calls.VoiciCallKeys.locked(k, caKeys(), origin())
    }

    /** Settings → Messages → Rotate inbox key: a new inbox epoch, published at once (§10.2). Drafts stay drafts. */
    suspend fun rotateInbox(reason: String): Boolean {
        if (!_page.value.isPublic) return false
        update { it.copy(inboxEpoch = it.inboxEpoch + 1) }
        return publish(reason, only = emptyList())
    }

    // ── Messages: the inbox (§8.3) ──

    suspend fun refreshInbox() {
        val u = user() ?: return
        val umk = keyring.umk() ?: return
        val local = withLocal { _, _, l -> l } ?: return
        val idx = local.publishedIndex?.let(VoiciPage::parseVoiciPageIndex) ?: return
        val ca = caKeys()
        if (ca.isEmpty()) return
        _messages.value = _messages.value.copy(loading = true)
        try {
            var cursor = local.inboxCursor
            val convs = local.conversations.associateBy { it.conv }.toMutableMap()
            var blocks: List<String> = local.inboxBlocks
            var revoked: List<String> = local.revoked
            var anonBlocks: List<String> = local.anonBlocks
            val ringBack = HashMap<String, Boolean>()
            var rounds = 0
            while (rounds++ < 10) {
                val page = client.inbox(u, cursor)
                blocks = page.blocks
                revoked = page.revoked
                page.anonBlocks?.let { anonBlocks = it }
                // `.com` flags each item's conversation with whether it can be rung back now (Call back starts disabled).
                for (item in page.items) item.ringBack?.let { rb -> VoiciJs.str(item.envelope["conv"])?.let { ringBack[it] = rb } }
                val state = local.state?.let(VoiciMessages::parseMessagesState) ?: MessagesState()
                val epochs = (idx.body.inboxEpoch downTo 1L)
                val seeds = epochs.map { VoiciMessages.deriveVoiciInboxKey(umk, idx.body.pageId, it).seed }
                val signPubs = epochs.map { VoiciJs.hex(VoiciMessages.deriveVoiciOwnerSignKey(umk, idx.body.pageId, it).publicKey) }
                for (item in page.items.sortedBy { VoiciJs.time(it.envelope["sentAt"]) ?: 0 }) {
                    val status = if (item.direct) "direct" else if (item.fetched) "delivered" else "sent"
                    val r = VoiciOwner.readInboxItem(item.envelope, idx.body.pageId, origin(), ca, (blocks + state.blocks).toSet(), revoked.toSet(), seeds, signPubs, convs, status)
                    if (r is VoiciInboxOutcome.Added) convs[r.conv.conv] = r.conv
                }
                val more = page.more && page.cursor != cursor
                cursor = page.cursor
                if (!more) break
            }
            val t = now()
            update { l ->
                l.copy(
                    conversations = convs.values.toList(), inboxCursor = cursor, inboxBlocks = blocks, revoked = revoked, anonBlocks = anonBlocks,
                    ringBackOff = l.ringBackOff - ringBack.filterValues { it }.keys + ringBack.filterValues { !it }.keys.associateWith { t },
                )
            }
            if (ringBack.isNotEmpty()) _callHistoryVersion.value += 1
            runCatching { checkReveals(convs.values) }
            _messages.value = _messages.value.copy(loading = false, error = null)
            refreshMissedCalls(u, umk, idx, ca)
        } catch (e: VoiciHttpError) {
            _messages.value = _messages.value.copy(loading = false, error = e.code ?: "network")
        } catch (e: Exception) {
            _messages.value = _messages.value.copy(loading = false, error = "network")
        }
    }

    /** Every missed call `.com` holds for the page, opened under each inbox epoch and checked; a failed read keeps what was shown. */
    private suspend fun refreshMissedCalls(u: String, umk: ByteArray, idx: VoiciPageIndex, ca: List<String>) {
        val items = runCatching { client.missedCalls(u) }.getOrNull() ?: return
        val seeds = (idx.body.inboxEpoch downTo 1L).map { VoiciMessages.deriveVoiciInboxKey(umk, idx.body.pageId, it).seed }
        val rows = com.flagshipserver.app.calls.VoiciMissedCalls.open(items, seeds, idx.body.pageId, origin(), ca)
        _messages.value = _messages.value.copy(missedCalls = rows)
        for (r in rows) clearRingBackOff(r.conv, r.ringingAt)
    }

    /** The thread menu's "Allow calls from them" / "Don't allow calls from them" (`flagship/voici-call-allow/v1`). Null on success, else a code. */
    suspend fun callAllow(conv: String, allow: Boolean): String? {
        val u = user() ?: return "not-found"
        val umk = keyring.umk() ?: return "not-found"
        val local = withLocal { _, _, l -> l } ?: return "not-found"
        val keys = ownerKeys(local, umk) ?: return "not-found"
        val pageId = local.publishedIndex?.let(VoiciPage::parseVoiciPageIndex)?.body?.pageId ?: return "not-found"
        val op = if (allow) "allow" else "disallow"
        val at = now()
        return try {
            val sig = VoiciCalls.signAllow(pageId, conv, op, at, keys.sign.seed)
            client.callAllow(u, kotlinx.serialization.json.buildJsonObject {
                put("allow", VoiciCalls.allowJson(pageId, conv, op, at))
                put("signature", kotlinx.serialization.json.JsonPrimitive(sig))
            })
            null
        } catch (e: VoiciHttpError) {
            e.code ?: "network"
        } catch (e: Exception) {
            "network"
        }
    }

    private fun ownerKeys(local: VoiciLocal, umk: ByteArray): VoiciOwnerKeys? {
        val idx = local.publishedIndex?.let(VoiciPage::parseVoiciPageIndex) ?: return null
        return VoiciOwnerKeys.derive(umk, idx.body.pageId, idx.body.inboxEpoch)
    }

    /** Send a reply (§7.4). Null on success, else a refusal code. */
    suspend fun reply(conv: String, text: String, replyTo: String? = null): String? {
        val prepared = VoiciText.prepareVoiciText(VoiciTextField.messageText, text)
        val t = prepared.valueOrNull() ?: return prepared.code
        val u = user() ?: return "not-found"
        val umk = keyring.umk() ?: return "not-found"
        val local = withLocal { _, _, l -> l } ?: return "not-found"
        val keys = ownerKeys(local, umk) ?: return "not-found"
        val c = local.conversations.firstOrNull { it.conv == conv } ?: return "not-found"
        val seq = local.publishedIndex?.let(VoiciPage::parseVoiciPageIndex)?.body?.seq ?: return "not-found"
        val env = VoiciOwner.reply(keys, c, t, replyTo, seq, now())
        return try {
            client.send(env.toJson())
            val msg = StoredVoiciMessage(env.msgId, env.from, env.seq, env.sentAt, t, replyTo, mine = true, status = "sent")
            update { l -> l.copy(conversations = l.conversations.map { if (it.conv == conv) it.copy(messages = it.messages + msg) else it }) }
            if (conv !in _messages.value.state.accepted) changeState { it.copy(accepted = (it.accepted + conv).distinct().sorted()) }
            null
        } catch (e: VoiciHttpError) {
            e.code ?: "network"
        } catch (e: Exception) {
            "network"
        }
    }

    suspend fun block(conv: String, block: Boolean, record: Boolean = true): String? {
        val umk = keyring.umk() ?: return "not-found"
        val u = user() ?: return "not-found"
        val local = withLocal { _, _, l -> l } ?: return "not-found"
        val keys = ownerKeys(local, umk) ?: return "not-found"
        val c = local.conversations.firstOrNull { it.conv == conv } ?: return "not-found"
        if (record) changeState { s -> s.copy(blocks = if (block) (s.blocks + c.pseudonymPub).distinct().sorted() else s.blocks - c.pseudonymPub) }
        return try {
            client.block(u, VoiciOwner.blockBody(keys, c.pseudonymPub, block, now()))
            null
        } catch (e: VoiciHttpError) {
            e.code ?: "network"
        } catch (e: Exception) {
            "network"
        }
    }

    suspend fun report(conv: String, msgId: String, reason: String): String? {
        val umk = keyring.umk() ?: return "not-found"
        val local = withLocal { _, _, l -> l } ?: return "not-found"
        val keys = ownerKeys(local, umk) ?: return "not-found"
        val env = local.conversations.firstOrNull { it.conv == conv }?.messages?.firstOrNull { it.msgId == msgId }?.envelope ?: return "not-found"
        val body = VoiciOwner.reportBody(keys, env, reason, now()) ?: return "malformed"
        return try {
            client.report(body)
            null
        } catch (e: VoiciHttpError) {
            e.code ?: "network"
        } catch (e: Exception) {
            "network"
        }
    }

    suspend fun rename(pseudonymPub: String, name: String?): String? {
        if (name == null || name.isBlank()) {
            changeState { it.copy(nicknames = it.nicknames - pseudonymPub) }
            return null
        }
        val p = VoiciText.prepareVoiciText(VoiciTextField.nickname, name.trim())
        val n = p.valueOrNull() ?: return p.code
        changeState { it.copy(nicknames = (it.nicknames + (pseudonymPub to MessagesNickname(n, now()))).toSortedMap()) }
        return null
    }

    /**
     * Accept a request (§11.1): local in the state blob, and an `unblock` order on the block route, which is how `.com`
     * marks the conversation accepted and lifts the awaiting-reply cap (§9.4; B1). Null on success, else a code.
     */
    suspend fun accept(conv: String): String? {
        changeState { it.copy(accepted = (it.accepted + conv).distinct().sorted()) }
        return block(conv, false, record = false)
    }

    /** A post's link card, fetched once by this device; null without one. Call off the main thread. */
    fun fetchCard(url: String): VoiciCard? {
        val client = http ?: return null
        return runCatching { VoiciCardFetcher(client) { putImage(it) }.fetch(url) }.getOrNull()
    }

    suspend fun archive(conv: String) = changeState { it.copy(archived = (it.archived + conv).distinct().sorted()) }

    suspend fun markRead(conv: String) {
        val c = _messages.value.conversations.firstOrNull { it.conv == conv } ?: return
        val last = c.ordered.lastOrNull { !it.mine } ?: return
        if (_messages.value.state.readUpTo[conv] == last.msgId) return
        changeState { it.copy(readUpTo = (it.readUpTo + (conv to last.msgId)).toSortedMap()) }
    }

    // ── the Messages state blob (§10.1) ──

    private suspend fun changeState(f: (MessagesState) -> MessagesState) {
        update { l -> l.copy(state = f(l.state?.let(VoiciMessages::parseMessagesState) ?: MessagesState()).toJson(), stateDirty = true) }
        scope.launch { runCatching { syncState() } }
    }

    /**
     * Keep the state blob in step with `.com` (compare-and-set on `version`, at most 3 tries). Unchanged here: take
     * `.com`'s copy. Changed here on top of the version `.com` still holds: write ours as is (so a removal, an
     * unblock or a sign-out, sticks). Changed on both sides: the §10.1 merge, then write.
     */
    suspend fun syncState() {
        val u = user() ?: return
        val umk = keyring.umk() ?: return
        val key = VoiciMessages.deriveMessagesStateKey(umk)
        repeat(3) {
            val remoteBlob = client.messagesState(u)
            val remote = remoteBlob?.let { VoiciMessages.openMessagesState(key, u, it) }
            val remoteVersion = remoteBlob?.let { VoiciJs.time(it["version"]) } ?: 0
            val local = withLocal { _, _, l -> l } ?: return
            val mine = local.state?.let(VoiciMessages::parseMessagesState) ?: MessagesState()
            if (!local.stateDirty) {
                if (remote != null) update { it.copy(state = remote.toJson(), stateVersion = remoteVersion) }
                return
            }
            val next = if (remote != null && remoteVersion != local.stateVersion) VoiciMessages.mergeMessagesState(mine, remote) else mine
            val device = keyring.device() ?: return
            val blob = VoiciMessages.sealMessagesState(key, u, remoteVersion + 1, next)
            try {
                client.putMessagesState(u, device, blob.toJson())
                update { l ->
                    // A change made while this write was out stays dirty for the next sync.
                    val changedMeanwhile = l.state != local.state
                    val kept = if (changedMeanwhile) VoiciMessages.mergeMessagesState(l.state?.let(VoiciMessages::parseMessagesState) ?: MessagesState(), next) else next
                    l.copy(state = kept.toJson(), stateVersion = remoteVersion + 1, stateDirty = changedMeanwhile)
                }
                return
            } catch (e: VoiciHttpError) {
                if (e.status != 409) return
            }
        }
    }

    // ── visitor side: signed-in sites (Settings → Messages) ──

    suspend fun recordSignIn(pageId: String, username: String, delegatePub: String, attestation: JsonObject) {
        update { it.copy(attestations = it.attestations + (pageId to attestation), signInPages = it.signInPages + (pageId to username)) }
        changeState { s -> s.copy(signedInSites = (s.signedInSites.filter { it.delegatePub != delegatePub } + MessagesSignedInSite(pageId, delegatePub, now())).sortedBy { it.delegatePub }) }
    }

    /** "You have a reply on voi.ci/<username>": a page this account signed in to, whose owner replied since last opened. */
    data class ReplyNotice(val pageId: String, val username: String, val latest: Long)

    private val _replyNotices = MutableStateFlow<List<ReplyNotice>>(emptyList())
    val replyNotices: StateFlow<List<ReplyNotice>> = _replyNotices.asStateFlow()

    /**
     * On open and foreground only (no push, no background polling): for each page this device signed in to, read the
     * visitor's own thread with the app's reader key (delegated by P, §6.4), keep the newest owner reply that checks
     * against the page's signed key, and offer a notice when it is newer than the last one opened. The conversation
     * itself stays on voi.ci.
     */
    suspend fun checkReplies() {
        val umk = keyring.umk() ?: return
        val local = withLocal { _, _, l -> l } ?: return
        if (local.signInPages.isEmpty()) {
            _replyNotices.value = emptyList()
            return
        }
        val secret = VoiciMessages.deriveMessagesSecret(umk)
        val ca = caKeys()
        val out = ArrayList<ReplyNotice>()
        for ((pageId, username) in local.signInPages.toSortedMap()) {
            val latest = runCatching { latestReply(secret, pageId, username, local, ca) }.getOrNull() ?: local.replyLatest[pageId] ?: continue
            if (latest > (local.replySeen[pageId] ?: 0)) out += ReplyNotice(pageId, username, latest)
        }
        _replyNotices.value = out
    }

    private suspend fun latestReply(secret: ByteArray, pageId: String, username: String, local: VoiciLocal, ca: List<String>): Long? {
        val visitor = VoiciVisitorKeys(pageId, VoiciMessages.deriveMessagesPseudonymKey(secret, pageId), VoiciMessages.deriveMessagesThreadKey(secret, pageId))
        val t = now()
        val att = local.attestations[pageId]?.let { a ->
            if (ca.isEmpty()) MessagesAttestations.parseMessagesKeyAttestation(a)
            else MessagesAttestations.checkMessagesKeyAttestation(a, ca, t, visitor.pseudonymPub).valueOrNull()
        } ?: return null
        val keys = client.accountKeys(username) ?: return null
        val idx = VoiciPage.checkVoiciPageIndex(client.page(username) ?: return null, username, keys.sensitiveKind, keys.sensitivePub, pageId = pageId).valueOrNull() ?: return null
        val conv = VoiciMessages.voiciConv(pageId, visitor.pseudonymPub)
        val reader = VoiciOwner.readerKey(secret, pageId)
        var since = local.replyCursor[pageId] ?: ""
        var latest = local.replyLatest[pageId] ?: 0
        var rounds = 0
        while (rounds++ < 10) {
            val (items, next, more) = client.thread(VoiciOwner.threadFetchBody(visitor, att, reader, since, now()))
            for (item in items) {
                if (VoiciJs.str(item.envelope["kind"]) != "voici-reply") continue
                if (VoiciMessages.checkVoiciReply(item.envelope, pageId, idx.body.ownerSignPub, conv).ok) latest = maxOf(latest, item.storedAt)
            }
            val moved = next != since
            since = next
            if (!more || !moved) break
        }
        update { it.copy(replyCursor = it.replyCursor + (pageId to since), replyLatest = it.replyLatest + (pageId to latest)) }
        return latest.takeIf { it > 0 }
    }

    /** The notice was tapped (the page opens on voi.ci): it goes until the next reply. */
    suspend fun openedReply(n: ReplyNotice) {
        update { it.copy(replySeen = it.replySeen + (n.pageId to n.latest)) }
        _replyNotices.value = _replyNotices.value.filter { it.pageId != n.pageId }
    }

    fun previousAttestation(pageId: String): JsonObject? = withLocal { _, _, l -> l.attestations[pageId] }

    // ── calls from the app and the call history (docs/voici-calls.md "Calling from the app") ──

    /** Pages this account signed in to, so it can call them as their visitor. */
    fun callablePages(): List<com.flagshipserver.app.calls.VoiciCallTarget> =
        withLocal { _, _, l -> l.signInPages.toSortedMap().map { (pageId, user) -> com.flagshipserver.app.calls.VoiciCallTarget(user, pageId) } } ?: emptyList()

    /** This device's calls merged with the page's missed calls, newest first. */
    fun callHistory(): List<com.flagshipserver.app.calls.VoiciCallRecord> =
        com.flagshipserver.app.calls.VoiciCallHistory.merge(withLocal { _, _, l -> l.callHistory } ?: emptyList(), _messages.value.missedCalls)

    private val _callHistoryVersion = MutableStateFlow(0)
    /** Bumps when a call is recorded, so the history screen reads [callHistory] again. */
    val callHistoryVersion: StateFlow<Int> = _callHistoryVersion.asStateFlow()

    suspend fun recordCall(r: com.flagshipserver.app.calls.VoiciCallRecord) {
        update { it.copy(callHistory = com.flagshipserver.app.calls.VoiciCallHistory.add(it.callHistory, r)) }
        _callHistoryVersion.value += 1
        if (r.direction == "in") r.conv?.let { clearRingBackOff(it, r.at) }
    }

    /** A call from this app to a page it signed in to. Media through [engine]; without one the call goes to a voi.ci tab. */
    fun outgoingCall(
        target: com.flagshipserver.app.calls.VoiciCallTarget,
        video: Boolean,
        integrity: VoiciIntegrity,
        engine: com.flagshipserver.app.calls.CallMediaEngine,
        room: com.flagshipserver.app.calls.VoiciCallerRoom,
        handoff: com.flagshipserver.app.calls.VoiciCallHandoffPipe,
        allowCallBack: Boolean = false,
        openBrowser: (String) -> Unit,
    ) = com.flagshipserver.app.calls.VoiciOutgoingCall(target, video, this, keyring, integrity, engine, room, handoff, openBrowser, scope, now, origin, allowCallBack = allowCallBack)

    /**
     * The caller's side of ringing back ("Call and allow call-back" / "Stop call-backs"): a ring-back order for this
     * account's conversation on [pageId], signed by its pseudonym there and sent with the device headers, so `.com` can
     * push the owner's ring to this account's devices. Null on success, else a code.
     */
    suspend fun setCallBack(pageId: String, allow: Boolean): String? {
        val u = user() ?: return "locked"
        val umk = keyring.umk() ?: return "locked"
        val device = keyring.device() ?: return "locked"
        val visitor = VoiciVisitorKeys.derive(umk, pageId)
        val conv = VoiciMessages.voiciConv(pageId, visitor.pseudonymPub)
        val body = VoiciCallModes.signRingBackPseudonym(pageId, conv, if (allow) "attach" else "stop", now(), visitor.pseudonym.seed)
        return try {
            client.ringBack(u, device, body)
            update { it.copy(callBackPages = if (allow) (it.callBackPages + pageId).distinct().sorted() else it.callBackPages - pageId) }
            null
        } catch (e: VoiciHttpError) {
            e.code ?: "network"
        } catch (e: Exception) {
            "network"
        }
    }

    /** Anonymous callers' conversations this page blocked (`.com`'s list, from the last inbox read). */
    fun anonBlocks(): Set<String> = withLocal { _, _, l -> l.anonBlocks.toSet() } ?: emptySet()

    /**
     * Block or unblock an anonymous caller (an "anyone" page; `flagship/voici-anon-block/v1` by the page's owner key):
     * its conversation (its browser key, the identity its proof of work was for) can't call again until unblocked or
     * deleted. Null on success, else a code.
     */
    suspend fun blockAnonymous(conv: String, block: Boolean): String? {
        val u = user() ?: return "locked"
        val umk = keyring.umk() ?: return "locked"
        val local = withLocal { _, _, l -> l } ?: return "locked"
        val keys = ownerKeys(local, umk) ?: return "not-found"
        return try {
            client.anonBlock(u, VoiciCallModes.signAnonBlock(keys.pageId, conv, if (block) "block" else "unblock", now(), keys.sign.seed))
            update { it.copy(anonBlocks = if (block) (it.anonBlocks + conv).distinct() else it.anonBlocks - conv) }
            _callHistoryVersion.value += 1
            null
        } catch (e: VoiciHttpError) {
            e.code ?: "network"
        } catch (e: Exception) {
            "network"
        }
    }

    // ── reveal who I am (docs/voici-calls.md "Reveal who I am", "What the reveal shows") ──

    /** Owner side: the caller's checked reveal for [conv], or null (none, withdrawn, or it didn't check). */
    fun reveal(conv: String): VoiciRevealShown? = withLocal { _, _, l -> l.reveals[conv] }

    /**
     * Owner side: the newest control in each conversation decides. A reveal counts only when it checks under the page
     * key `.com` serves for its username (that page's verified index); anything else shows nothing.
     */
    private suspend fun checkReveals(convs: Collection<StoredVoiciConversation>) {
        val local = withLocal { _, _, l -> l } ?: return
        var reveals = local.reveals
        for (c in convs) {
            val last = c.lastControl ?: continue
            when (val ctl = VoiciCallModes.parseRevealControl(last.control)) {
                is VoiciCallModes.RevealControl.Hidden -> reveals = reveals - c.conv
                is VoiciCallModes.RevealControl.Shown -> {
                    if (reveals[c.conv]?.issuedAt == ctl.reveal.issuedAt) continue
                    reveals = if (verifyReveal(last.control!!, c.conv, ctl.reveal.username)) {
                        reveals + (c.conv to VoiciRevealShown(ctl.reveal.username, ctl.reveal.displayName, ctl.reveal.issuedAt))
                    } else {
                        reveals - c.conv
                    }
                }
                null -> {}
            }
        }
        if (reveals != local.reveals) update { it.copy(reveals = reveals) }
    }

    private suspend fun verifyReveal(control: JsonObject, conv: String, username: String): Boolean {
        val keys = client.accountKeys(username) ?: return false
        val idx = VoiciPage.checkVoiciPageIndex(client.page(username) ?: return false, username, keys.sensitiveKind, keys.sensitivePub).valueOrNull() ?: return false
        return VoiciCallModes.checkReveal(control, conv, idx.body.ownerSignPub).ok
    }

    // ── the caller's side of a conversation this account started on another page ──

    /** One message in a conversation this account started: its own, or the owner's reply. */
    data class VisitorMessage(val msgId: String, val mine: Boolean, val text: String, val sentAt: Long)

    data class VisitorThread(val target: com.flagshipserver.app.calls.VoiciCallTarget, val displayName: String, val messages: List<VisitorMessage>, val nextSeq: Long)

    /** The parts every send and fetch of a visitor conversation needs. */
    private class VisitorSession(
        val u: String, val visitor: VoiciVisitorKeys, val att: MessagesKeyAttestation, val reader: ByteArray, val conv: String,
        val idx: VoiciPageIndex, val cred: JsonObject,
    )

    private suspend fun visitorSession(target: com.flagshipserver.app.calls.VoiciCallTarget, integrity: VoiciIntegrity): VisitorSession? {
        val u = user() ?: return null
        val umk = keyring.umk() ?: return null
        val device = keyring.device() ?: return null
        val keys = client.accountKeys(target.username) ?: return null
        val idx = VoiciPage.checkVoiciPageIndex(client.page(target.username) ?: return null, target.username, keys.sensitiveKind, keys.sensitivePub, pageId = target.pageId).valueOrNull() ?: return null
        val visitor = VoiciVisitorKeys.derive(umk, target.pageId)
        val t = now()
        val att = VoiciVisitorAttestation.obtain(this, u, device, integrity, visitor, t) ?: return null
        val reader = VoiciOwner.readerKey(VoiciMessages.deriveMessagesSecret(umk), target.pageId)
        val nonce = WebEnvelopes.sha256Hex("${target.pageId}|${att.issuedAt}").take(32)
        val d = WebDelegation("voici-messages", origin(), target.pageId, visitor.pseudonymPub, "p256", VoiciJs.hex(VoiciJs.p256PublicKey(reader)), att.issuedAt, att.expiresAt, nonce)
        val ts = VoiciThreadStatement(target.pageId, visitor.pseudonymPub, visitor.threadPub, att.issuedAt)
        val cred = JsonObject(
            linkedMapOf(
                "attestation" to att.toJson(), "delegation" to d.toJson(), "delegationSig" to JsonPrimitive(WebDelegations.signWebDelegation(d, visitor.pseudonym.seed)),
                "threadStmt" to ts.toJson(), "threadSig" to JsonPrimitive(VoiciMessages.signVoiciThreadStatement(ts, visitor.pseudonym.seed)),
            ),
        )
        return VisitorSession(u, visitor, att, reader, VoiciMessages.voiciConv(target.pageId, visitor.pseudonymPub), idx, cred)
    }

    /** The whole conversation this account has with [target]'s page: its own messages and the owner's replies, opened with T. */
    suspend fun visitorThread(target: com.flagshipserver.app.calls.VoiciCallTarget, integrity: VoiciIntegrity = VoiciIntegrity.NONE): VisitorThread? {
        val s = visitorSession(target, integrity) ?: return null
        val out = ArrayList<VisitorMessage>()
        var mySeq = 0L
        var since = ""
        var rounds = 0
        while (rounds++ < 20) {
            val (items, next, more) = client.thread(VoiciOwner.threadFetchBody(s.visitor, s.att, s.reader, since, now()))
            for (item in items) {
                val env = item.envelope
                val msgId = VoiciJs.str(env["msgId"]) ?: continue
                val body = WebEnvelopes.b64Decode(VoiciJs.str(env["body"]) ?: VoiciJs.str(env["bodyB64"])) ?: continue
                val mine = VoiciJs.str(env["kind"]) == "voici-message"
                if (mine) {
                    if (VoiciJs.str(env["from"]) != s.visitor.pseudonymPub) continue
                    mySeq = maxOf(mySeq, VoiciJs.time(env["seq"]) ?: 0)
                } else if (!VoiciMessages.checkVoiciReply(env, target.pageId, s.idx.body.ownerSignPub, s.conv).ok) {
                    continue
                }
                val pt = VoiciMessages.openVoiciBodyAny(body, s.conv, msgId, s.visitor.thread.seed).valueOrNull() as? VoiciPlaintext ?: continue
                out += VisitorMessage(msgId, mine, pt.text, VoiciJs.time(env["sentAt"]) ?: item.storedAt)
            }
            val moved = next != since
            since = next
            if (!more || !moved) break
        }
        val name = runCatching {
            val ref = s.idx.body.pieces.first { it.role == "profile" }
            client.piece(target.username, target.pageId, ref.sha256)?.takeIf { WebEnvelopes.sha256Hex(it) == ref.sha256 }?.let(VoiciPage::parseVoiciProfilePiece)?.displayName
        }.getOrNull() ?: target.username
        return VisitorThread(target, name, out.sortedWith(compareBy({ it.sentAt }, { it.msgId })), mySeq + 1)
    }

    /** Sends [text] (or a control) as this account's pseudonym on the page: sealed to the owner's inbox key and our T. */
    private suspend fun sendVisitorEnvelope(target: com.flagshipserver.app.calls.VoiciCallTarget, text: String?, control: JsonObject?, integrity: VoiciIntegrity): String? {
        val s = visitorSession(target, integrity) ?: return "locked"
        val thread = visitorThread(target, integrity) ?: return "network"
        val t = now()
        val msgId = VoiciOwner.randomHex(16)
        val recipients = listOf(WebEnvelopes.hexToBytes(s.idx.body.inboxPub), s.visitor.thread.publicKey)
        val body = if (control != null) VoiciMessages.sealVoiciControl(s.conv, msgId, t, s.visitor.pseudonymPub, recipients, control)
        else VoiciMessages.sealVoiciBody(s.conv, msgId, t, s.visitor.pseudonymPub, recipients, VoiciPlaintext(text!!, null))
        val env = WebEnvelope("voici-message", target.pageId, s.conv, s.visitor.pseudonymPub, msgId, thread.nextSeq, t, WebEnvelopes.b64Encode(body), s.cred)
        return try {
            client.send(WebEnvelopes.signWebEnvelopeP256(env, s.reader).toJson())
            null
        } catch (e: VoiciHttpError) {
            e.code ?: "network"
        } catch (e: Exception) {
            "network"
        }
    }

    suspend fun sendAsVisitor(target: com.flagshipserver.app.calls.VoiciCallTarget, text: String, integrity: VoiciIntegrity = VoiciIntegrity.NONE): String? {
        val prepared = VoiciText.prepareVoiciText(VoiciTextField.messageText, text)
        val t = prepared.valueOrNull() ?: return prepared.code
        return sendVisitorEnvelope(target, t, null, integrity)
    }

    /** Pages where this account turned on "Show <name> who I am". */
    fun revealedTo(): Set<String> = withLocal { _, _, l -> l.revealedTo.keys } ?: emptySet()

    /**
     * "Show <name> who I am": a reveal signed with this account's own page key (its username and its page's display
     * name), or an unreveal, sent inside the sealed conversation. Needs a published page. Null on success, else a code.
     */
    suspend fun setReveal(target: com.flagshipserver.app.calls.VoiciCallTarget, on: Boolean, integrity: VoiciIntegrity = VoiciIntegrity.NONE): String? {
        val u = user() ?: return "locked"
        val umk = keyring.umk() ?: return "locked"
        val local = withLocal { _, _, l -> l } ?: return "locked"
        val umkConv = VoiciMessages.voiciConv(target.pageId, VoiciVisitorKeys.derive(umk, target.pageId).pseudonymPub)
        val t = now()
        val control = if (on) {
            if (local.removed) return "no-page"
            val keys = ownerKeys(local, umk) ?: return "no-page"
            val name = VoiciOwner.parsePageState(local.publishedState)?.profile?.displayName?.takeIf { VoiciText.checkVoiciText(VoiciTextField.displayName, it) == null }
            VoiciCallModes.signReveal(umkConv, u, name, t, keys.sign.seed)
        } else {
            VoiciCallModes.unreveal(umkConv, t)
        }
        sendVisitorEnvelope(target, null, control, integrity)?.let { return it }
        update { it.copy(revealedTo = if (on) it.revealedTo + (target.pageId to t) else it.revealedTo - target.pageId) }
        return null
    }

    /**
     * Delete = forget, from the caller's side: a delete signed by this account's pseudonym, then this device's copy goes.
     * [authorize] is the biometric / device-credential prompt (docs/voici-calls.md "Deleting a conversation"): unless it
     * answers true nothing is deleted or sent, and the answer is [DELETE_NOT_CONFIRMED].
     */
    suspend fun deleteVisitorConversation(target: com.flagshipserver.app.calls.VoiciCallTarget, authorize: suspend () -> Boolean): String? {
        if (!authorize()) return DELETE_NOT_CONFIRMED
        val umk = keyring.umk() ?: return "locked"
        val visitor = VoiciVisitorKeys.derive(umk, target.pageId)
        val conv = VoiciMessages.voiciConv(target.pageId, visitor.pseudonymPub)
        return try {
            client.deleteConversation(VoiciCallModes.signConvDeletePseudonym(target.pageId, conv, now(), visitor.pseudonym.seed))
            update {
                it.copy(
                    callBackPages = it.callBackPages - target.pageId, revealedTo = it.revealedTo - target.pageId,
                    replyLatest = it.replyLatest - target.pageId, replySeen = it.replySeen - target.pageId, replyCursor = it.replyCursor - target.pageId,
                    callHistory = it.callHistory.filterNot { r -> r.peerPageId == target.pageId },
                )
            }
            // The account's other devices forget it too (the synced state's deletion marker).
            changeState { st -> runCatching { VoiciMessages.forgetConversation(st, conv, visitor.pseudonymPub, now()) }.getOrDefault(st) }
            null
        } catch (e: VoiciHttpError) {
            e.code ?: "network"
        } catch (e: Exception) {
            "network"
        }
    }

    /**
     * Delete = forget, from the owner's side: a delete signed by the page's owner key; `.com` drops the conversation's
     * mail, ring-back channel and missed calls, and this device erases its copy. The caller's own copy stays with them.
     * [authorize] is the biometric / device-credential prompt: unless it answers true nothing is deleted or sent, and
     * the answer is [DELETE_NOT_CONFIRMED].
     */
    suspend fun deleteConversation(conv: String, authorize: suspend () -> Boolean): String? {
        if (!authorize()) return DELETE_NOT_CONFIRMED
        val umk = keyring.umk() ?: return "locked"
        val local = withLocal { _, _, l -> l } ?: return "locked"
        val keys = ownerKeys(local, umk) ?: return "not-found"
        return try {
            client.deleteConversation(VoiciCallModes.signConvDeleteOwner(keys.pageId, conv, now(), keys.sign.seed))
            val pseudonym = local.conversations.firstOrNull { it.conv == conv }?.pseudonymPub?.takeIf { WebEnvelopes.isLowerHex(it, 32) }
            // The synced state forgets it too, and its marker makes the owner's other devices drop their copies.
            changeState { st -> runCatching { VoiciMessages.forgetConversation(st, conv, pseudonym, now()) }.getOrDefault(st) }
            _messages.value = _messages.value.copy(missedCalls = _messages.value.missedCalls.filter { it.conv != conv })
            _callHistoryVersion.value += 1
            null
        } catch (e: VoiciHttpError) {
            e.code ?: "network"
        } catch (e: Exception) {
            "network"
        }
    }

    /** Pages this account allowed to ring it back (this device's record; `.com` holds the channels). */
    fun callBackPages(): Set<String> = withLocal { _, _, l -> l.callBackPages.toSet() } ?: emptySet()

    /**
     * An owner's ring (push category voici-ring): the hint opens only under this account's thread key for the page that
     * rang, and must name that page as this device knows it (its sign-in). Null while locked or for an unknown page.
     */
    fun openRingHint(ringId: String, hintB64: String): com.flagshipserver.app.calls.VoiciRingHint? {
        val umk = keyring.umk() ?: return null
        val sealed = WebEnvelopes.b64Decode(hintB64) ?: return null
        val pages = withLocal { _, _, l -> l.signInPages } ?: return null
        val secret = VoiciMessages.deriveMessagesSecret(umk)
        for ((pageId, username) in pages) {
            val p = VoiciMessages.deriveMessagesPseudonymKey(secret, pageId)
            val t = VoiciMessages.deriveMessagesThreadKey(secret, pageId)
            val conv = VoiciMessages.voiciConv(pageId, VoiciJs.hex(p.publicKey))
            val opened = runCatching {
                com.flagshipserver.app.core.pq.PqHybrid.hybridOpen(t.seed, VoiciRings.TAG_RING_HINT, listOf(VoiciJs.utf8(conv), VoiciJs.utf8(ringId)), sealed).plaintext
            }.getOrNull() ?: continue
            val o = VoiciJs.parseJson(opened.decodeToString())?.let(VoiciJs::obj) ?: return null
            if (!VoiciJs.exactKeys(o, listOf("v", "pageId", "username", "conv", "ringId", "media", "issuedAt")) || !VoiciJs.isNumEq(o["v"], 1)) return null
            if (VoiciJs.str(o["pageId"]) != pageId || VoiciJs.str(o["username"]) != username || VoiciJs.str(o["conv"]) != conv || VoiciJs.str(o["ringId"]) != ringId) return null
            val media = VoiciJs.str(o["media"])?.takeIf { it in VoiciCalls.MEDIA_VALUES } ?: return null
            return com.flagshipserver.app.calls.VoiciRingHint(com.flagshipserver.app.calls.VoiciCallTarget(username, pageId), ringId, media == VoiciCalls.MEDIA_VIDEO, VoiciJs.time(o["issuedAt"]) ?: 0)
        }
        return null
    }

    /**
     * Conversations whose caller didn't allow call-backs, as `.com` last answered a ring here (no read of a channel
     * exists, so this device learns it from a refused ring). Call is disabled for them until the caller writes or
     * calls again, which may come with a fresh "Call and allow call-back".
     */
    fun ringBackOff(): Set<String> = withLocal { _, _, l -> l.ringBackOff.keys } ?: emptySet()

    /**
     * Ring a visitor of this account's page back (owner decision 2026-11-15: through the conversation's ring-back
     * channel when the caller chose "Call and allow call-back", disabled otherwise). Signs a `flagship/voici-ring/v1`
     * with the page's owner messages key, the hint sealed to the caller's thread key, and posts it; `.com` pushes it to
     * the caller's devices, and their app dials out to this page, so the call then rings here as any call does. The
     * caller stays a pseudonym: no username or bare name of theirs is ever used.
     */
    suspend fun callVisitor(conv: String, video: Boolean = false): CallVisitorOutcome {
        val u = user() ?: return CallVisitorOutcome.Failed("locked")
        val umk = keyring.umk() ?: return CallVisitorOutcome.Failed("locked")
        val local = withLocal { _, _, l -> l } ?: return CallVisitorOutcome.Failed("locked")
        val keys = ownerKeys(local, umk) ?: return CallVisitorOutcome.Failed("not-found")
        val c = local.conversations.firstOrNull { it.conv == conv } ?: return CallVisitorOutcome.Failed("not-found")
        val t = now()
        val ringId = VoiciOwner.randomHex(16)
        val media = if (video) VoiciCalls.MEDIA_VIDEO else VoiciCalls.MEDIA_AUDIO
        val hint = try {
            val eseed = ByteArray(com.flagshipserver.app.core.pq.PqHybrid.HYBRID_SEAL_RANDOMNESS_LEN).also { java.security.SecureRandom().nextBytes(it) }
            WebEnvelopes.b64Encode(VoiciRings.sealHint(WebEnvelopes.hexToBytes(c.threadPub), keys.pageId, u, conv, ringId, media, t, eseed))
        } catch (e: Exception) {
            return CallVisitorOutcome.Failed("failed")
        }
        val ring = VoiciRing(keys.pageId, conv, ringId, hint, media, t)
        val body = JsonObject(mapOf("ring" to ring.toJson(), "signature" to JsonPrimitive(VoiciRings.signRing(ring, keys.sign.seed))))
        return try {
            client.ring(u, body)
            CallVisitorOutcome.Ringing(ringId, t + VoiciRings.RING_TTL_MS)
        } catch (e: VoiciHttpError) {
            if (e.code == "no-ring-back") {
                update { it.copy(ringBackOff = it.ringBackOff + (conv to t)) }
                _callHistoryVersion.value += 1
                CallVisitorOutcome.NoCallBack
            } else {
                CallVisitorOutcome.Failed(e.code ?: "network")
            }
        } catch (e: Exception) {
            CallVisitorOutcome.Failed("network")
        }
    }

    /** The caller wrote or called again after a refused ring: they may have allowed call-backs since, so Call comes back. */
    private suspend fun clearRingBackOff(conv: String, at: Long) {
        if ((withLocal { _, _, l -> l.ringBackOff[conv] } ?: Long.MAX_VALUE) < at) {
            update { it.copy(ringBackOff = it.ringBackOff - conv) }
            _callHistoryVersion.value += 1
        }
    }

    /** Sign a browser out (§6.4): signed by P, sent to `.com`, dropped from the list. */
    suspend fun signOutSite(site: MessagesSignedInSite): String? {
        val umk = keyring.umk() ?: return "not-found"
        val visitor = VoiciVisitorKeys.derive(umk, site.pageId)
        return try {
            client.revoke(VoiciOwner.revokeBody(visitor, site.pageId, site.delegatePub, now()))
            changeState { s -> s.copy(signedInSites = s.signedInSites.filter { it.delegatePub != site.delegatePub }) }
            // The last browser of that page signed out: no more reply notices for it.
            if (_messages.value.state.signedInSites.none { it.pageId == site.pageId }) {
                update { it.copy(signInPages = it.signInPages - site.pageId) }
                _replyNotices.value = _replyNotices.value.filter { it.pageId != site.pageId }
            }
            null
        } catch (e: VoiciHttpError) {
            if (e.code == "rate-limited") "rate-limited" else "sign-out-failed"
        } catch (e: Exception) {
            "network"
        }
    }

    // ── the phone endpoint (§8.2): only while this admin phone holds its name ──

    private val deliverTimes = ArrayDeque<Long>()
    private val deliverBySender = HashMap<String, ArrayDeque<Long>>()

    /** `GET /api/phone/live`: null when this phone has no published page to receive for. */
    fun phoneLive(): PhoneLiveAnswer? {
        val u = user() ?: return null
        val acc = account ?: return null
        if (!keyring.holdsSensitiveKey(acc)) return null
        val idx = withLocal { _, _, l -> l.publishedIndex?.let(VoiciPage::parseVoiciPageIndex) } ?: return null
        return PhoneLiveAnswer(u, idx.body.ownerSignPub)
    }

    private fun overRate(from: String): Boolean = synchronized(deliverTimes) {
        val t = now()
        while (deliverTimes.isNotEmpty() && t - deliverTimes.first() > 60_000) deliverTimes.removeFirst()
        val mine = deliverBySender.getOrPut(from) { ArrayDeque() }
        while (mine.isNotEmpty() && t - mine.first() > 60_000) mine.removeFirst()
        if (deliverTimes.size >= VoiciPhoneWeb.PHONE_DELIVER_PER_MINUTE || mine.size >= VoiciPhoneWeb.PHONE_DELIVER_PER_SENDER_PER_MINUTE) return true
        deliverTimes.addLast(t)
        mine.addLast(t)
        if (deliverBySender.size > 512) deliverBySender.keys.firstOrNull()?.let(deliverBySender::remove)
        false
    }

    /**
     * `POST /api/phone/deliver`: the envelope's own chain, cheapest check first (§12.1); then stored, acked, and
     * forwarded to the mailbox (messages) or the drafts lane (drafts). Returns (status, JSON body).
     */
    fun phoneDeliver(body: ByteArray, phoneRoutePub: String): Pair<Int, String> {
        val u = user() ?: return 404 to """{"error":"not found","code":"not-found"}"""
        val umk = keyring.umk() ?: return 404 to """{"error":"not found","code":"not-found"}"""
        val acc = account ?: return 503 to """{"error":"not ready","code":"not-ready"}"""
        val text = runCatching { body.decodeToString(throwOnInvalidSequence = true) }.getOrNull() ?: return 400 to """{"error":"malformed","code":"malformed"}"""
        val json = VoiciJs.parseJson(text) as? JsonObject ?: return 400 to """{"error":"malformed","code":"malformed"}"""
        val from = VoiciJs.str(json["from"]) ?: return 400 to """{"error":"malformed","code":"malformed"}"""
        when (VoiciJs.str(json["kind"])) {
            "voici-message" -> {
                if (body.size > VoiciPhoneWeb.PHONE_DELIVER_MAX_BYTES) return 413 to """{"error":"too large","code":"too-large"}"""
                val local = withLocal { _, _, l -> l } ?: return 404 to """{"error":"not found","code":"not-found"}"""
                val idx = local.publishedIndex?.let(VoiciPage::parseVoiciPageIndex) ?: return 404 to """{"error":"not found","code":"not-found"}"""
                val state = local.state?.let(VoiciMessages::parseMessagesState) ?: MessagesState()
                val blocked = (state.blocks + local.inboxBlocks).toSet()
                if (from in blocked) return 200 to """{"accepted":true}"""
                if (overRate(from)) return 429 to """{"error":"rate limited","code":"rate-limited","retryAfterSec":60}"""
                val ctx = VoiciMessageCheckContext(idx.body.pageId, idx.body.acceptsMessages == 1, origin(), caCache, now(), blocked, local.revoked.toSet())
                val r = VoiciMessages.checkVoiciMessage(text, ctx)
                val c = r.valueOrNull() ?: return 403 to """{"error":"refused","code":"${r.code}"}"""
                val key = c.envelope.conv + "|" + c.envelope.msgId
                if (seenDirect.putIfAbsent(key, now()) != null || local.conversations.any { cv -> cv.messages.any { it.msgId == c.envelope.msgId } }) {
                    return 409 to """{"error":"duplicate","code":"duplicate"}"""
                }
                val keys = VoiciOwnerKeys.derive(umk, idx.body.pageId, idx.body.inboxEpoch)
                val ack = VoiciOwner.ack(c.envelope.conv, c.envelope.msgId, now(), phoneRoutePub, keys.sign.seed)
                scope.launch {
                    runCatching {
                        val convs = (withLocal { _, _, l -> l.conversations } ?: emptyList()).associateBy { it.conv }
                        val seeds = (idx.body.inboxEpoch downTo 1L).map { VoiciMessages.deriveVoiciInboxKey(umk, idx.body.pageId, it).seed }
                        val out = VoiciOwner.readInboxItem(json, idx.body.pageId, origin(), caCache, blocked, local.revoked.toSet(), seeds, listOf(keys.signPub), convs, "direct")
                        if (out is VoiciInboxOutcome.Added) update { l -> l.copy(conversations = l.conversations.filter { it.conv != out.conv.conv } + out.conv) }
                    }
                    runCatching { client.send(json, direct = true) }
                }
                return 200 to JsonObject(mapOf("ack" to ack.toJson())).toString()
            }
            "voici-draft" -> {
                if (body.size > VoiciMessages.VOICI_DRAFT_MAX_ENVELOPE_BYTES) return 413 to """{"error":"too large","code":"too-large"}"""
                if (overRate(from)) return 429 to """{"error":"rate limited","code":"rate-limited","retryAfterSec":60}"""
                val device = keyring.device() ?: return 503 to """{"error":"not ready","code":"not-ready"}"""
                val op = openDraft(u, umk, VoiciMessages.deriveVoiciDraftsKey(umk), acc, json, now())
                    ?: return 403 to """{"error":"refused","code":"refused"}"""
                val ack = VoiciAck("", op.opId, now(), phoneRoutePub).let { a -> a.copy(signature = VoiciJs.hex(device.signer.sign(VoiciMessages.canonicalVoiciAck(a)))) }
                scope.launch {
                    update { l -> l.copy(laneOps = (l.laneOps + op.copy(images = null).toJson()).distinctBy { VoiciJs.str(it["opId"]) }) }
                    runCatching { client.depositDraft(u, device, json) }
                }
                return 200 to JsonObject(mapOf("ack" to ack.toJson())).toString()
            }
            else -> return 400 to """{"error":"malformed","code":"wrong-kind"}"""
        }
    }

    /**
     * What a voi.ci call needs from this device's keys (docs/voici-calls.md §4), or null while the account is locked
     * or has no published page: the call then rings with a generic name and asks for an unlock before answering.
     */
    suspend fun callKeys(): com.flagshipserver.app.calls.VoiciCallKeys? {
        val u = user() ?: return null
        val umk = keyring.umk() ?: return null
        val device = keyring.device() ?: return null
        val local = vault.load(umk, u)
        val idx = local.publishedIndex?.let(VoiciPage::parseVoiciPageIndex) ?: return null
        val keys = VoiciOwnerKeys.derive(umk, idx.body.pageId, idx.body.inboxEpoch)
        val inboxSeeds = (idx.body.inboxEpoch downTo 1L).map { VoiciMessages.deriveVoiciInboxKey(umk, idx.body.pageId, it).seed }
        val state = local.state?.let(VoiciMessages::parseMessagesState) ?: MessagesState()
        return com.flagshipserver.app.calls.VoiciCallKeys(
            username = u,
            device = device,
            pageId = idx.body.pageId,
            acceptsCalls = idx.body.takesCalls,
            ownerSignSeed = keys.sign.seed,
            ownerSignPub = keys.signPub,
            inboxSeeds = inboxSeeds,
            caKeys = caKeys(),
            origin = origin(),
            blocked = (local.inboxBlocks + state.blocks).toSet(),
            revoked = local.revoked.toSet(),
            nicknames = state.nicknames.mapValues { it.value.name },
            callsFrom = idx.body.callsFrom ?: "accepted",
        )
    }

    /** The CA keys, for the sign-in screen's own check of `.com`'s attestation. */
    suspend fun caKeys(): List<String> = caCache.ifEmpty { runCatching { caKeysSource() }.getOrDefault(emptyList()).also { caCache = it } }

    suspend fun accountKeys(username: String): VoiciAccountKeys? = client.accountKeys(username)

    companion object {
        /** A delete whose prompt was cancelled or failed: nothing was deleted or sent (the screen already said why). */
        const val DELETE_NOT_CONFIRMED = "not-confirmed"

        /** Set by MainActivity; null until an account is open. */
        @Volatile var shared: VoiciCenter? = null
    }
}
