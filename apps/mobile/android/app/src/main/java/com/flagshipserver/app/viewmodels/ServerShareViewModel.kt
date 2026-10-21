// Share this server (docs/share-a-server.md §8): the owner's "Shared with"
// card, the other account's accept flow, its "Shared with me" list and the
// restricted page it gets for a shared server.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import android.content.Context
import androidx.compose.runtime.staticCompositionLocalOf
import com.flagshipserver.app.api.AccessRequest
import com.flagshipserver.app.api.AppDetailResponse
import com.flagshipserver.app.api.InMemorySessionStore
import com.flagshipserver.app.api.LiveScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ReleaseCatalogResponse
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.ServerDetailResponse
import com.flagshipserver.app.api.ServerMetricsResponse
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.ActivityEntry
import com.flagshipserver.app.core.ActiveShare
import com.flagshipserver.app.core.AcceptedShare
import com.flagshipserver.app.core.CreatedShare
import com.flagshipserver.app.core.OkHttpJsonTransport
import com.flagshipserver.app.core.OpenedShare
import com.flagshipserver.app.core.OwnerShares
import com.flagshipserver.app.core.PendingShare
import com.flagshipserver.app.core.ServerShare
import com.flagshipserver.app.core.ServerShareClient
import com.flagshipserver.app.core.ShareAccount
import com.flagshipserver.app.core.ShareException
import com.flagshipserver.app.core.ShareInviteRefusal
import com.flagshipserver.app.core.ShareOptions
import com.flagshipserver.app.core.ShareSession
import com.flagshipserver.app.core.ShareSignIn
import com.flagshipserver.app.core.SharePushPrefs
import com.flagshipserver.app.core.ShareStartup
import com.flagshipserver.app.core.SharedEntry
import com.flagshipserver.app.core.TrustGatedTransport
import com.flagshipserver.app.keystore.KeystoreShareKeys
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.tasks.await
import okhttp3.OkHttpClient

/** Everything the share screens need, provided once by the activity (live only). */
class ServerShareRuntime(
    val client: ServerShareClient,
    /** A screens client that signs in to [serverDomain] with a share token instead of an owner session. */
    val memberScreens: (serverDomain: String, token: String) -> ScreensClient,
    /** The owner's session on a server when this phone's session store has none (the smoke-mode mock box). */
    val ownerSession: (podId: String) -> String? = { null },
) {
    val sharedWithMe = SharedWithMeModel(client)

    companion object {
        fun live(
            okHttp: OkHttpClient,
            context: Context,
            account: () -> ShareAccount? = { null },
            isTrusted: () -> Boolean,
        ): ServerShareRuntime {
            val client = ServerShareClient(
                account = account,
                apex = TrustGatedTransport(OkHttpJsonTransport(okHttp), isTrusted),
                box = OkHttpJsonTransport(okHttp),
                keys = KeystoreShareKeys(),
                pushStore = SharePushPrefs.from(context),
                pushToken = {
                    if (!com.flagshipserver.app.core.PrivacySettings.fromContext(context).pushNotificationsEnabled.value) {
                        null
                    } else {
                        runCatching {
                            com.google.firebase.messaging.FirebaseMessaging.getInstance().token.await()
                        }.getOrNull()?.let { "fcm" to it }
                    }
                },
            )
            return ServerShareRuntime(client, memberScreens = { domain, token ->
                LiveScreensClient(
                    client = okHttp,
                    store = InMemorySessionStore().apply {
                        setPodBaseUrl("https://$domain")
                        setSessionToken(token)
                    },
                )
            })
        }
    }
}

val LocalServerShares = staticCompositionLocalOf<ServerShareRuntime?> { null }

object ShareCopy {
    val CAN_VIEW get() = FSStrings.get(R.string.can_view)
    val CAN_MANAGE get() = FSStrings.get(R.string.can_manage)
    val VIEW_LINE get() = FSStrings.get(R.string.see_the_servers_status_monitoring_and)
    val MANAGE_LINE get() = FSStrings.get(R.string.also_build_apps_with_ai_accept)
    val UNLOCK_TITLE get() = FSStrings.get(R.string.let_them_approve_start_up)
    val UNLOCK_LINE get() = FSStrings.get(R.string.their_phone_gets_a_copy_of)
    val DATA_TITLE get() = FSStrings.get(R.string.let_them_see_app_data)
    val DATA_LINE get() = FSStrings.get(R.string.they_can_read_what_your_apps)
    val NEVER_LINE get() = FSStrings.get(R.string.they_can_never_delete_move_or)
    val HOUSE_KEY_LINE get() = FSStrings.get(R.string.only_give_this_to_someone_youd)

    val NOTICES_TITLE get() = FSStrings.get(R.string.notify_this_device_when_it_needs)
    val NOTICES_LINE get() = FSStrings.get(R.string.turning_this_on_lets_flagships_service)
    // A co-manager is manager-class in every app of a shared server (owner rule
    // "Three ranks"), so a members-only app still lets them in.
    val MEMBERS_ONLY_HINT get() = FSStrings.get(R.string.members_only_as_a_co_manager)

    const val UPDATE_TITLE = "Update"
    val UPDATE_CURRENT get() = FSStrings.get(R.string.up_to_date)

    fun updateButton(tag: String?, commit: String): String = FSStrings.get(R.string.update_to, tag?.takeIf { it.isNotBlank() } ?: commit.take(8))

    fun updateConfirm(serverName: String): String =
        FSStrings.get(R.string.restarts_on_the_new_release_only, serverName)

    fun updating(serverName: String): String = FSStrings.get(R.string.updating_it_restarts_in_a_few, serverName)

    fun level(level: String): String = if (level == ServerShare.LEVEL_MANAGE) CAN_MANAGE else CAN_VIEW

    fun sas(sas: String): String = ServerShare.formatShareSas(sas)

    /** "Sam · started an app build with AI", "You · shared this server". */
    fun activityLine(e: ActivityEntry): String {
        val who = if (e.actor.kind == "share") e.actor.label?.takeIf { it.isNotBlank() } ?: FSStrings.get(R.string.someone_you_shared_with) else "You"
        val person = e.target?.takeIf { it.isNotBlank() } ?: "someone"
        val what = when (e.action) {
            "share.granted" -> "gave $person access"
            "share.changed" -> "changed what $person can do"
            "share.revoked" -> if (e.actor.kind == "share") "lost access" else "removed $person's access"
            else -> (ACTIONS[e.action] ?: e.action) +
                (e.target?.takeIf { it.isNotBlank() && !e.action.startsWith("share.") }?.let { " ($it)" } ?: "")
        }
        val failed = if (e.ok) "" else ", refused"
        return FSStrings.get(R.string.text_2, who, what, failed)
    }

    private val ACTIONS = mapOf(
        "share.signed-in" to "signed in",
        "share.left" to "left",
        "ai.start" to "started an app build with AI",
        "ai.reply" to "answered the AI",
        "app.access.edit" to "changed an app's internet access",
        "app.access.dismiss" to "ignored an internet request",
        "app.update.accept" to "accepted an app update",
        "db.write" to "changed app data",
        "db.read" to "read app data",
        "server.update" to "updated the server",
    )
}

private fun Throwable.shareMessage(): String = when (this) {
    is ShareException -> message ?: FSStrings.get(R.string.something_went_wrong_try_again)
    is ShareInviteRefusal -> message ?: FSStrings.get(R.string.something_went_wrong_try_again)
    else -> userFacing()
}

// ── Owner ──────────────────────────────────────────────────────────────────

data class OwnerShareUi(
    val loading: Boolean = true,
    val shares: OwnerShares? = null,
    val error: String? = null,
    val activity: List<ActivityEntry> = emptyList(),
    val busy: Set<String> = emptySet(),
)

class OwnerShareViewModel(
    private val client: ServerShareClient,
    private val username: String,
    private val serverDomain: String,
    private val serverName: String,
    private val stkPubHex: String,
    private val ownerSession: () -> String?,
) {
    private val _ui = MutableStateFlow(OwnerShareUi())
    val ui: StateFlow<OwnerShareUi> = _ui.asStateFlow()

    private val _message = MutableStateFlow<String?>(null)
    /** The last action's failure, for a toast. */
    val message: StateFlow<String?> = _message.asStateFlow()

    fun clearMessage() { _message.value = null }

    suspend fun load() {
        try {
            val shares = client.ownerShares(username, serverDomain, ownerSession())
            val activity = ownerSession()?.let { s ->
                runCatching { client.activity(serverDomain, s) }.getOrNull()
            }.orEmpty()
            _ui.update { it.copy(loading = false, shares = shares, error = null, activity = activity) }
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            _ui.update { it.copy(loading = false, error = t.shareMessage()) }
        }
    }

    suspend fun create(options: ShareOptions): CreatedShare? = act("new") {
        client.createOffer(username, serverDomain, serverName, stkPubHex, options)
    }?.also { load() }

    suspend fun confirm(share: AcceptedShare): Boolean = act(share.shareId) {
        client.confirm(username, serverDomain, session(), share)
    }.also { if (it != null) load() } != null

    suspend fun change(share: ActiveShare, level: String = share.level, unlockAtBoot: Boolean = share.unlockAtBoot, seeAppData: Boolean = share.seeAppData): Boolean =
        act(share.shareId) {
            client.change(username, serverDomain, session(), share, level, unlockAtBoot, seeAppData)
        }.also { if (it != null) load() } != null

    suspend fun remove(shareId: String, label: String): Boolean = act(shareId) {
        client.remove(username, serverDomain, ownerSession(), shareId, label)
    }.also { if (it != null) load() } != null

    suspend fun cancel(share: PendingShare): Boolean = act(share.shareId) {
        client.cancel(username, serverDomain, share.shareId, share.label)
    }.also { if (it != null) load() } != null

    private fun session(): String = ownerSession()
        ?: throw ShareException(ShareException.Kind.Refused, FSStrings.get(R.string.this_phone_isnt_signed_in_to))

    private suspend fun <T> act(id: String, block: suspend () -> T): T? {
        if (id in _ui.value.busy) return null
        _ui.update { it.copy(busy = it.busy + id) }
        return try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            _message.value = t.shareMessage()
            null
        } finally {
            _ui.update { it.copy(busy = it.busy - id) }
        }
    }
}

// ── The other account: accept ─────────────────────────────────────────────

class ShareAcceptViewModel(
    private val client: ServerShareClient,
    private val sharedWithMe: SharedWithMeModel? = null,
) {
    sealed interface Phase {
        data object Input : Phase
        data object Opening : Phase
        data class Offer(val opened: OpenedShare) : Phase
        data class Accepting(val opened: OpenedShare) : Phase
        /** Read [sas] to the owner; [signedIn] once they've confirmed. */
        data class Code(val entry: SharedEntry, val sas: String, val level: String, val signedIn: Boolean = false) : Phase
        data class Failed(val message: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Input)
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    suspend fun open(text: String) {
        val link = ServerShare.parseShareLink(text)
        if (link == null) {
            _phase.value = Phase.Failed(FSStrings.get(R.string.that_isnt_a_share_link_ask))
            return
        }
        _phase.value = Phase.Opening
        _phase.value = try {
            Phase.Offer(client.open(link))
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            Phase.Failed(t.shareMessage())
        }
    }

    suspend fun accept() {
        val opened = (_phase.value as? Phase.Offer)?.opened ?: return
        _phase.value = Phase.Accepting(opened)
        _phase.value = try {
            val (entry, sas) = client.accept(opened)
            sharedWithMe?.upsert(entry)
            Phase.Code(entry, sas, opened.offer.level)
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            Phase.Failed(t.shareMessage())
        }
    }

    /** One sign-in attempt while the code is showing; true once the owner has confirmed. */
    suspend fun checkConfirmed(): Boolean {
        val code = _phase.value as? Phase.Code ?: return false
        if (code.signedIn) return true
        val r = try {
            client.signIn(code.entry, reuse = false)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            return false
        }
        return when (r) {
            is ShareSignIn.In -> {
                _phase.value = code.copy(signedIn = true, level = r.session.level)
                sharedWithMe?.markSignedIn(code.entry, r.session)
                true
            }
            ShareSignIn.Ended -> {
                _phase.value = Phase.Failed(FSStrings.get(R.string.the_owner_stopped_sharing_this_server))
                false
            }
            ShareSignIn.Waiting -> false
        }
    }

    fun reset() { _phase.value = Phase.Input }
}

// ── The other account: "Shared with me" ───────────────────────────────────

data class SharedItem(val entry: SharedEntry, val status: Status) {
    sealed interface Status {
        data class Active(val level: String) : Status
        data object Waiting : Status
        data object Starting : Status
        data object Unreachable : Status
    }
}

data class SharedWithMeUi(val loaded: Boolean = false, val items: List<SharedItem> = emptyList(), val error: String? = null)

class SharedWithMeModel(private val client: ServerShareClient) {
    private val _ui = MutableStateFlow(SharedWithMeUi())
    val ui: StateFlow<SharedWithMeUi> = _ui.asStateFlow()

    fun entry(shareId: String): SharedEntry? = _ui.value.items.firstOrNull { it.entry.shareId == shareId }?.entry

    fun upsert(entry: SharedEntry) {
        _ui.update { s ->
            val rest = s.items.filter { it.entry.shareId != entry.shareId }
            s.copy(items = listOf(SharedItem(entry, SharedItem.Status.Waiting)) + rest)
        }
    }

    fun markSignedIn(entry: SharedEntry, session: ShareSession) {
        _ui.update { s ->
            s.copy(items = s.items.map { if (it.entry.shareId == entry.shareId) it.copy(status = SharedItem.Status.Active(session.level)) else it })
        }
    }

    fun remove(shareId: String) {
        _ui.update { s -> s.copy(items = s.items.filter { it.entry.shareId != shareId }) }
    }

    /** Read the inbox and sign in to each server; ended shares leave the inbox. */
    suspend fun refresh(interactive: Boolean = false) {
        if (!interactive && !client.canRunSilently()) return
        val entries = try {
            client.inbox()
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            _ui.update { it.copy(loaded = true, error = t.shareMessage()) }
            return
        }
        val items = coroutineScope {
            entries.map { e -> async { statusOf(e)?.let { SharedItem(e, it) } } }.map { it.await() }
        }.filterNotNull()
        _ui.value = SharedWithMeUi(loaded = true, items = items)
    }

    private suspend fun statusOf(e: SharedEntry): SharedItem.Status? {
        val signIn = try {
            client.signIn(e)
        } catch (c: CancellationException) {
            throw c
        } catch (_: Throwable) {
            null
        }
        return when (signIn) {
            is ShareSignIn.In -> SharedItem.Status.Active(signIn.session.level)
            ShareSignIn.Waiting -> SharedItem.Status.Waiting
            ShareSignIn.Ended -> {
                drop(e)
                null
            }
            null -> {
                val com = runCatching { client.comState(e) }.getOrNull()
                when {
                    com?.state == "ended" -> {
                        drop(e)
                        null
                    }
                    com?.unlock == true && runCatching { client.pendingStartups(e) }.getOrNull().orEmpty().isNotEmpty() ->
                        SharedItem.Status.Starting
                    else -> SharedItem.Status.Unreachable
                }
            }
        }
    }

    private suspend fun drop(e: SharedEntry) {
        e.entryId?.let { id -> runCatching { client.inboxDelete(id) } }
    }
}

// ── The other account: the shared server's page ───────────────────────────

data class SharedServerUi(
    val phase: Phase = Phase.Loading,
    val session: ShareSession? = null,
    val detail: ServerDetailResponse? = null,
    val metrics: ServerMetricsResponse? = null,
    val apps: List<ServerAppsViewModel.Row>? = null,
    val accessRequests: List<AccessRequest> = emptyList(),
    val startups: List<ShareStartup> = emptyList(),
    /** `.com` holds this share's start-up copy (known even while the server is off). */
    val canUnlock: Boolean = false,
    /** This device asked `.com` to wake it when the server waits to start. */
    val notices: Boolean = false,
    /** The box lets this share order an endorsed update (manage level). */
    val canUpdate: Boolean = false,
    val releases: ReleaseCatalogResponse? = null,
    val busy: Boolean = false,
    val message: String? = null,
) {
    enum class Phase { Loading, Ready, Waiting, Unreachable, Ended, Left }

    val level: String? get() = session?.level
    val manage: Boolean get() = session?.level == ServerShare.LEVEL_MANAGE
}

class SharedServerViewModel(
    private val runtime: ServerShareRuntime,
    val entry: SharedEntry,
) {
    private val client get() = runtime.client
    private val _ui = MutableStateFlow(SharedServerUi())
    val ui: StateFlow<SharedServerUi> = _ui.asStateFlow()
    private var screens: ScreensClient? = null
    private var screensToken: String? = null

    private suspend fun screensFor(fresh: Boolean): ScreensClient? {
        val r = client.signIn(entry, reuse = !fresh)
        return when (r) {
            is ShareSignIn.In -> {
                _ui.update { it.copy(session = r.session) }
                if (screensToken != r.session.token || screens == null) {
                    screens = runtime.memberScreens(entry.serverDomain, r.session.token)
                    screensToken = r.session.token
                }
                screens
            }
            ShareSignIn.Waiting -> {
                _ui.update { it.copy(phase = SharedServerUi.Phase.Waiting) }
                null
            }
            ShareSignIn.Ended -> {
                ended()
                null
            }
        }
    }

    private suspend fun ended() {
        _ui.update { it.copy(phase = SharedServerUi.Phase.Ended, session = null) }
        client.forgetStartupNotices(entry.shareId)
        runtime.sharedWithMe.remove(entry.shareId)
        entry.entryId?.let { id -> runCatching { client.inboxDelete(id) } }
    }

    /** Runs [block] with the share client, signing in again once on a 401. */
    private suspend fun <T> withScreens(block: suspend (ScreensClient) -> T): T? {
        val s = screensFor(fresh = false) ?: return null
        return try {
            block(s)
        } catch (e: ScreensError.Http) {
            when {
                e.status == 401 -> {
                    client.forgetSession(entry.shareId)
                    val again = screensFor(fresh = true) ?: return null
                    block(again)
                }
                e.status == 403 && e.body.contains("share-ended") -> {
                    ended()
                    null
                }
                else -> throw e
            }
        }
    }

    suspend fun load() {
        val reachable = try {
            withScreens { s ->
                coroutineScope {
                    val detail = async { runCatching { s.serverDetail() }.getOrNull() }
                    val metrics = async { runCatching { s.serverMetrics("self") }.getOrNull() }
                    val apps = async { s.appsList().apps }
                    val apps2 = apps.await()
                    _ui.update {
                        it.copy(
                            phase = SharedServerUi.Phase.Ready,
                            detail = detail.await() ?: it.detail,
                            metrics = metrics.await() ?: it.metrics,
                            apps = ServerAppsViewModel.rows(apps2, emptyList()),
                        )
                    }
                }
                true
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ScreensError.Http) {
            _ui.update { it.copy(phase = SharedServerUi.Phase.Ready, message = e.userFacing()) }
            true
        } catch (_: Throwable) {
            false
        }
        val phase = _ui.value.phase
        if (phase == SharedServerUi.Phase.Ended) return
        if (reachable == false || (reachable == null && phase == SharedServerUi.Phase.Loading)) {
            _ui.update { it.copy(phase = SharedServerUi.Phase.Unreachable) }
        }
        if (_ui.value.manage) {
            loadAccessRequests()
            loadUpdates()
        }
        refreshStartups()
    }

    /** The box's say on whether this share may update it, and the releases it would offer. */
    suspend fun loadUpdates() {
        val me = runCatching { client.me(entry) }.getOrNull()
        val can = me?.canUpdate == true && me.level == ServerShare.LEVEL_MANAGE
        if (!can) {
            _ui.update { it.copy(canUpdate = false, releases = null) }
            return
        }
        val catalog = runCatching { withScreens { it.serverUpdates(refresh = false) } }.getOrNull()
        _ui.update { it.copy(canUpdate = true, releases = catalog ?: it.releases) }
    }

    /** Order the newest endorsed release; the box checks the endorsement itself. */
    suspend fun update(): Boolean {
        val target = _ui.value.releases?.latest?.commit ?: return false
        val from = _ui.value.detail?.currentCommit ?: _ui.value.releases?.currentCommit
        if (from == null) {
            _ui.update { it.copy(message = FSStrings.get(R.string.this_server_hasnt_said_which_version)) }
            return false
        }
        return busy { client.orderUpdate(entry, target, from) }
    }

    /** Turn this device's start-up notices on or off (#10 to `.com`). */
    suspend fun setNotices(on: Boolean): Boolean = busy {
        client.setStartupNotices(entry, on)
        _ui.update { it.copy(notices = client.startupNotices(entry.shareId)) }
    }

    suspend fun loadAccessRequests() {
        val reqs = runCatching { withScreens { it.accessRequests().requests } }.getOrNull() ?: return
        _ui.update { it.copy(accessRequests = reqs.filter { r -> !r.isDraft && r.host.isNotEmpty() }) }
    }

    /** Start-up requests this share may approve (the opt-in is on and the server is waiting). */
    suspend fun refreshStartups() {
        val session = _ui.value.session
        val canUnlock = session?.unlockAtBoot ?: (runCatching { client.comState(entry) }.getOrNull()?.unlock == true)
        if (!canUnlock) {
            _ui.update { it.copy(canUnlock = false, startups = emptyList()) }
            return
        }
        val startups = runCatching { client.pendingStartups(entry) }.getOrNull().orEmpty()
        _ui.update { it.copy(canUnlock = true, startups = startups, notices = client.startupNotices(entry.shareId)) }
    }

    suspend fun approve(startup: ShareStartup): Boolean = busy {
        client.approveStartup(entry, startup)
        _ui.update { it.copy(startups = it.startups - startup) }
    }

    suspend fun answer(request: AccessRequest, allow: Boolean): Boolean {
        val s = screensFor(fresh = false) ?: return false
        val vm = AppAccessViewModel(
            serviceId = request.serviceId,
            client = s,
            order = AppAccessOrder(
                client = s,
                fallbackServerDomain = { entry.serverDomain },
                signer = { reason -> client.memberSigner(entry, reason) },
            ),
            appName = request.appName ?: request.serviceId,
        )
        val ok = vm.answer(request.host, allow)
        if (ok) {
            _ui.update { it.copy(accessRequests = it.accessRequests.filterNot { r -> r.serviceId == request.serviceId && r.host == request.host }) }
        } else {
            _ui.update { it.copy(message = vm.error.value ?: FSStrings.get(R.string.couldnt_save_that_answer)) }
        }
        return ok
    }

    suspend fun leave(): Boolean = busy {
        client.leave(entry)
        runtime.sharedWithMe.remove(entry.shareId)
        _ui.update { it.copy(phase = SharedServerUi.Phase.Left) }
    }

    fun clearMessage() = _ui.update { it.copy(message = null) }

    private suspend fun busy(block: suspend () -> Unit): Boolean {
        if (_ui.value.busy) return false
        _ui.update { it.copy(busy = true, message = null) }
        return try {
            block()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            _ui.update { it.copy(message = t.shareMessage()) }
            false
        } finally {
            _ui.update { it.copy(busy = false) }
        }
    }
}

// ── The other account: one app on a shared server ─────────────────────────

data class SharedAppUi(
    val phase: Phase = Phase.Loading,
    val detail: AppDetailResponse? = null,
    /** The share's own screens client, for the app's sections. */
    val client: ScreensClient? = null,
    val session: ShareSession? = null,
    val message: String? = null,
) {
    enum class Phase { Loading, Ready, Failed, Waiting, Ended }

    val manage: Boolean get() = session?.level == ServerShare.LEVEL_MANAGE
    val seeAppData: Boolean get() = session?.seeAppData == true
}

/** One app's page on a server shared with this account: what it is, its
 *  internet access at "Can manage", and its data when the owner allowed it.
 *  Mirror of iOS SharedAppScreen. */
class SharedAppViewModel(
    private val runtime: ServerShareRuntime,
    val entry: SharedEntry,
    val serviceId: String,
) {
    private val client get() = runtime.client
    private val _ui = MutableStateFlow(SharedAppUi())
    val ui: StateFlow<SharedAppUi> = _ui.asStateFlow()

    val appName: String get() = serviceId.substringAfter("--").replaceFirstChar { it.uppercase() }

    /** The share's member key signs this app's orders (never the account's admin key). */
    suspend fun memberSigner(reason: String) = client.memberSigner(entry, reason)

    /** This app's "Invite people" panel (co-manager invites, at Can manage). */
    fun coInvites(): CoInviteViewModel = CoInviteViewModel(client, entry, serviceId, appName)

    private suspend fun signedIn(fresh: Boolean): ScreensClient? =
        when (val r = client.signIn(entry, reuse = !fresh)) {
            is ShareSignIn.In -> {
                val s = _ui.value.client.takeIf { _ui.value.session?.token == r.session.token }
                    ?: runtime.memberScreens(entry.serverDomain, r.session.token)
                _ui.update { it.copy(session = r.session, client = s) }
                s
            }
            ShareSignIn.Waiting -> {
                _ui.update { it.copy(phase = SharedAppUi.Phase.Waiting) }
                null
            }
            ShareSignIn.Ended -> {
                _ui.update { it.copy(phase = SharedAppUi.Phase.Ended) }
                null
            }
        }

    suspend fun load() {
        try {
            val s = signedIn(fresh = false) ?: return
            val detail = try {
                s.appDetail(serviceId)
            } catch (e: ScreensError.Http) {
                if (e.status != 401) throw e
                client.forgetSession(entry.shareId)
                (signedIn(fresh = true) ?: return).appDetail(serviceId)
            }
            _ui.update { it.copy(phase = SharedAppUi.Phase.Ready, detail = detail, message = null) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ScreensError.Http) {
            if (e.status == 403 && e.body.contains("share-ended")) {
                _ui.update { it.copy(phase = SharedAppUi.Phase.Ended) }
            } else if (_ui.value.detail == null) {
                _ui.update { it.copy(phase = SharedAppUi.Phase.Failed, message = e.shareMessage()) }
            }
        } catch (t: Throwable) {
            if (_ui.value.detail == null) _ui.update { it.copy(phase = SharedAppUi.Phase.Failed, message = t.shareMessage()) }
        }
    }
}
