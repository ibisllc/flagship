// Abuse notices and suspension (docs/abuse-handling.md §4-§5). An operator's notice
// names one app, page, link or server of this account, why, what to do and by when;
// the account's admin devices see it on Home and can mark it done with a signed note:
//
//   flagship/abuse-notice-done/v1|<username lowercase>|<noticeId>|<sha256 hex of the UTF-8 note>|<issuedAt>
//
// signed with the sensitive-order key (admin root, else the IRK), pinned by
// packages/protocol/test-vectors/abuse-notice-done/vectors.json. A suspended account
// shows every device the suspended screen; the data stays on the owner's own server.
// Nothing here is ever given to a model.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import java.net.URLEncoder
import java.security.MessageDigest

object AbuseNotices {
    const val CANONICAL_TAG = "flagship/abuse-notice-done/v1"
    const val NOTE_MAX = 1000
    const val PUSH_CATEGORY = "abuse-notice"
    const val APPEAL_EMAIL = "abuse@flagship.services"
    const val APPEAL_URL = "https://flagshipserver.com/abuse#appeal"
    private val NOTICE_ID = Regex("^[0-9a-f]{32}$")
    private val USERNAME = Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")

    fun noteSha256Hex(note: String): String =
        HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(note.toByteArray(Charsets.UTF_8)))

    fun canonicalBytes(username: String, noticeId: String, note: String, issuedAt: Long): ByteArray {
        val u = username.lowercase()
        require(USERNAME.matches(u)) { "username" }
        require(NOTICE_ID.matches(noticeId)) { "noticeId" }
        require(note.length <= NOTE_MAX) { "note" }
        require(issuedAt > 0) { "issuedAt" }
        return listOf(CANONICAL_TAG, u, noticeId, noteSha256Hex(note), issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun paths(username: String) = "/api/users/${username.lowercase()}/abuse-notices"

    fun categoryLabel(category: String): String = when (category) {
        "spam" -> FSStrings.get(R.string.abuse_category_spam)
        "phishing" -> FSStrings.get(R.string.abuse_category_phishing)
        "active-phishing" -> FSStrings.get(R.string.abuse_category_active_phishing)
        "malware" -> FSStrings.get(R.string.abuse_category_malware)
        "csam" -> FSStrings.get(R.string.abuse_category_csam)
        "harassment" -> FSStrings.get(R.string.abuse_category_harassment)
        "impersonation" -> FSStrings.get(R.string.abuse_category_impersonation)
        "copyright" -> FSStrings.get(R.string.abuse_category_copyright)
        "illegal" -> FSStrings.get(R.string.abuse_category_illegal)
        else -> FSStrings.get(R.string.abuse_category_other)
    }

    fun actionLine(action: String): String =
        if (action == "take-down") FSStrings.get(R.string.abuse_action_take_down)
        else FSStrings.get(R.string.abuse_action_modify)

    /** `mailto:` for an appeal, naming the account in the subject. */
    fun appealMailto(username: String?): String {
        // The subject stays English: it is read by the abuse desk, not shown in the app.
        val who = if (username.isNullOrEmpty()) "" else "%20%28" + URLEncoder.encode(username, "UTF-8") + "%29"
        return "mailto:$APPEAL_EMAIL?subject=Appeal$who"
    }
}

@Serializable
data class AbuseNotice(
    val id: String,
    val subjectKind: String = "app",
    val subject: String,
    val serviceId: String? = null,
    val category: String,
    val action: String,
    val detail: String? = null,
    val deadlineAt: Long,
    val issuedAt: Long,
    val doneAt: Long? = null,
    val doneNote: String? = null,
)

@Serializable
data class AbuseSuspension(
    val suspendedAt: Long,
    val category: String,
    val reason: String,
    val appealEmail: String = AbuseNotices.APPEAL_EMAIL,
    val appealUrl: String = AbuseNotices.APPEAL_URL,
)

@Serializable
data class AbuseNoticesResponse(
    val notices: List<AbuseNotice> = emptyList(),
    val suspension: AbuseSuspension? = null,
)

@Serializable
data class AbuseNoticeDoneRequest(val request: Inner, val signature: String) {
    @Serializable
    data class Inner(val username: String, val noticeId: String, val note: String, val issuedAt: Long)
}

/** What the Home banner shows for one notice (pure, so a test reads the exact lines). */
data class AbuseNoticeBannerModel(
    val id: String,
    val title: String,
    val about: String,
    val reason: String,
    val whatToDo: String,
    val deadline: String,
    val warning: String,
    val detail: String?,
    /** "Marked done on …" once an admin marked it; the buttons give way to it. */
    val doneLine: String?,
)

/** What the suspended screen shows. */
data class AbuseSuspendedModel(
    val title: String,
    val reason: String,
    val operatorReason: String,
    val offline: String,
    val dataStays: String,
    val appealLine: String,
    val appealMailto: String,
)

object AbuseNoticeModels {
    /** Admin devices only (every device of a demo account stands in for its owner). */
    fun banners(
        response: AbuseNoticesResponse?,
        isAdmin: Boolean,
        formatDate: (Long) -> String = { FlagshipDateFormat.format(it, includeTime = true) },
    ): List<AbuseNoticeBannerModel> {
        if (!isAdmin || response == null) return emptyList()
        return response.notices.sortedBy { it.deadlineAt }.map { n ->
            AbuseNoticeBannerModel(
                id = n.id,
                title = FSStrings.get(R.string.abuse_notice_title),
                about = FSStrings.get(R.string.abuse_notice_about, n.subject),
                reason = FSStrings.get(R.string.abuse_reason_line, AbuseNotices.categoryLabel(n.category)),
                whatToDo = AbuseNotices.actionLine(n.action),
                deadline = FSStrings.get(R.string.abuse_deadline_line, formatDate(n.deadlineAt)),
                warning = FSStrings.get(R.string.abuse_notice_warning),
                detail = n.detail?.takeIf { it.isNotBlank() },
                doneLine = n.doneAt?.let { FSStrings.get(R.string.abuse_notice_done_line, formatDate(it)) },
            )
        }
    }

    fun suspended(s: AbuseSuspension?, username: String?): AbuseSuspendedModel? = s?.let {
        AbuseSuspendedModel(
            title = FSStrings.get(R.string.abuse_suspended_title),
            reason = FSStrings.get(R.string.abuse_reason_line, AbuseNotices.categoryLabel(it.category)),
            operatorReason = it.reason,
            offline = FSStrings.get(R.string.abuse_suspended_offline),
            dataStays = FSStrings.get(R.string.abuse_suspended_data_stays),
            appealLine = FSStrings.get(R.string.abuse_suspended_appeal_line),
            appealMailto = AbuseNotices.appealMailto(username),
        )
    }
}

/** The two `.com` calls. */
interface AbuseNoticesApi {
    suspend fun fetch(username: String): AbuseNoticesResponse
    suspend fun markDone(username: String, noticeId: String, body: AbuseNoticeDoneRequest)
}

class LiveAbuseNoticesApi(
    private val transport: JsonHttpTransport,
    private val baseUrl: () -> String = { Endpoints.controlBaseUrl },
) : AbuseNoticesApi {
    override suspend fun fetch(username: String): AbuseNoticesResponse =
        AccountReadTokens.authorize(username) { auth ->
            transport.getJson(baseUrl().trimEnd('/') + AbuseNotices.paths(username), AbuseNoticesResponse.serializer(), auth)
        }

    override suspend fun markDone(username: String, noticeId: String, body: AbuseNoticeDoneRequest) {
        transport.postJson(
            baseUrl().trimEnd('/') + AbuseNotices.paths(username) + "/$noticeId/done",
            body,
            AbuseNoticeDoneRequest.serializer(),
        )
    }
}

sealed interface AbuseDoneResult {
    data object Done : AbuseDoneResult
    data class Failed(val message: String) : AbuseDoneResult
}

/** One per process: the account's notices and suspension, refreshed on Home, on foreground and on the push. */
class AbuseNoticeCenter(
    private val api: AbuseNoticesApi,
    private val username: () -> String?,
    private val isAdmin: () -> Boolean,
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> com.flagshipserver.app.keystore.Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    companion object {
        @Volatile var shared: AbuseNoticeCenter? = null
    }

    private val _state = MutableStateFlow<AbuseNoticesResponse?>(null)
    val state: StateFlow<AbuseNoticesResponse?> = _state.asStateFlow()

    /** "Continue to my data": the suspended screen gives way to a banner for this session. */
    private val _suspendedDismissed = MutableStateFlow(false)
    val suspendedDismissed: StateFlow<Boolean> = _suspendedDismissed.asStateFlow()
    private val mutex = Mutex()
    private var stateUser: String? = null

    fun admin(): Boolean = runCatching { isAdmin() }.getOrDefault(false)

    fun dismissSuspended() { _suspendedDismissed.value = true }
    fun showSuspended() { _suspendedDismissed.value = false }

    /** Sign-out or a profile switch: forget the last account's state. */
    fun clear() {
        _state.value = null
        _suspendedDismissed.value = false
        stateUser = null
    }

    /** Failures are silent: the last answer stays. */
    suspend fun refresh() = mutex.withLock {
        val u = username()?.lowercase()
        if (u.isNullOrEmpty()) { clear(); return@withLock }
        if (u != stateUser) { _state.value = null; _suspendedDismissed.value = false }
        try {
            val r = api.fetch(u)
            stateUser = u
            if (r.suspension == null) _suspendedDismissed.value = false
            _state.value = r
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
        }
    }

    suspend fun markDone(noticeId: String, note: String): AbuseDoneResult {
        val u = username()?.lowercase()
        if (u.isNullOrEmpty() || !admin()) return AbuseDoneResult.Failed(FSStrings.get(R.string.abuse_only_admin))
        val trimmed = note.trim().take(AbuseNotices.NOTE_MAX)
        val issuedAt = now()
        val sig = try {
            signer(FSStrings.get(R.string.abuse_done_sign_reason))
                .sign(AbuseNotices.canonicalBytes(u, noticeId, trimmed, issuedAt))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            return AbuseDoneResult.Failed(FSStrings.get(R.string.abuse_done_failed))
        }
        return try {
            api.markDone(u, noticeId, AbuseNoticeDoneRequest(AbuseNoticeDoneRequest.Inner(u, noticeId, trimmed, issuedAt), HexUtil.encode(sig)))
            val cur = _state.value
            if (cur != null) {
                _state.value = cur.copy(notices = cur.notices.map {
                    if (it.id == noticeId && it.doneAt == null) it.copy(doneAt = issuedAt, doneNote = trimmed) else it
                })
            }
            AbuseDoneResult.Done
        } catch (e: CancellationException) {
            throw e
        } catch (e: HttpException) {
            AbuseDoneResult.Failed(
                FSStrings.get(if (e.status == 403) R.string.abuse_only_admin else R.string.abuse_done_failed),
            )
        } catch (_: Throwable) {
            AbuseDoneResult.Failed(FSStrings.get(R.string.abuse_done_failed))
        }
    }
}
