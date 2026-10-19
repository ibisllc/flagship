// Security notices (docs/security-notices.md sections 5 and 6): the fetch, the
// per-install store, the decision and the poller. The envelope, rules and
// decisions are SecurityNotice.kt; this file is what the app does with them.
//
// The request is ONE anonymous GET: no cookie, no identifier, no version, no
// query, no referrer, no redirect followed, and not through the authenticated
// API client (so none of the app's x-flagship headers and no cert-pin or lock
// interceptor sees it). The app decides locally whether a notice is about it;
// which build, platform and protocol level it runs never leaves the phone.

package com.flagshipserver.app.core

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** What one fetch of /api/notices came to. */
sealed interface NoticeFetch {
    /** 204: no notice in force on this deploy. */
    data object NoNotice : NoticeFetch

    /** An error, a redirect, a non-2xx: change nothing. */
    data object Failed : NoticeFetch

    data class Document(val body: String) : NoticeFetch
}

fun interface NoticeFetcher {
    suspend fun fetch(): NoticeFetch
}

/** The real fetch: a GET with nothing in it, on a client of its own. */
class AnonymousNoticeFetcher(
    private val baseUrl: () -> String = { Endpoints.controlBaseUrl },
    private val client: OkHttpClient = anonymousClient(),
    /** The document to read: the security notice by default (the relay hint is the other). */
    private val path: String = SecurityNoticeCenter.PATH,
) : NoticeFetcher {
    override suspend fun fetch(): NoticeFetch = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        try {
            val req = Request.Builder().url(baseUrl() + path).get().build()
            client.newCall(req).execute().use { res ->
                when {
                    res.code == 204 -> NoticeFetch.NoNotice
                    res.code != 200 -> NoticeFetch.Failed
                    else -> {
                        val body = res.body?.source()?.let { src ->
                            src.request(MAX_BODY + 1)
                            if (src.buffer.size > MAX_BODY) null else src.buffer.readUtf8()
                        }
                        if (body == null) NoticeFetch.Failed else NoticeFetch.Document(body)
                    }
                }
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            NoticeFetch.Failed
        }
    }

    companion object {
        private const val MAX_BODY = 1L shl 20

        fun anonymousClient(): OkHttpClient = OkHttpClient.Builder()
            .cookieJar(CookieJar.NO_COOKIES)
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .callTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}

/** Where the per-install store lives (not per account, so it survives sign-out and a second account). */
interface NoticeStoreBackend {
    fun read(): String?
    fun write(value: String)
}

class PrefsNoticeStoreBackend(context: Context) : NoticeStoreBackend {
    private val prefs = context.applicationContext.getSharedPreferences("flagship-security-notice", Context.MODE_PRIVATE)
    override fun read(): String? = runCatching { prefs.getString(KEY, null) }.getOrNull()
    override fun write(value: String) {
        runCatching { prefs.edit().putString(KEY, value).commit() }
    }

    private companion object {
        const val KEY = "store.v1"
    }
}

class MemoryNoticeStoreBackend(var value: String? = null) : NoticeStoreBackend {
    override fun read(): String? = value
    override fun write(value: String) {
        this.value = value
    }
}

/** highestSeq, the last accepted document, the newest authority mandate seen, and what was dismissed. */
data class StoredNotices(
    val highestSeq: Long = 0,
    val doc: JsonObject? = null,
    val tip: Long = 0,
    val dismissedSeq: Long = 0,
    val dismissedAt: Long = 0,
) {
    fun toJson(): String = buildJsonObject {
        put("highestSeq", highestSeq)
        put("doc", doc ?: JsonNull)
        put("tip", tip)
        if (dismissedSeq > 0) {
            put("dismissed", buildJsonObject {
                put("seq", dismissedSeq)
                put("at", dismissedAt)
            })
        }
    }.toString()

    companion object {
        /** A corrupt store is an empty one. */
        fun parse(raw: String?): StoredNotices {
            if (raw.isNullOrEmpty()) return StoredNotices()
            return try {
                val o = SecurityNoticeProtocol.json.parseToJsonElement(raw) as? JsonObject ?: return StoredNotices()
                fun num(e: JsonElement?): Long = (e as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toLongOrNull()?.takeIf { it >= 0 } ?: 0
                val d = o["dismissed"] as? JsonObject
                StoredNotices(
                    highestSeq = num(o["highestSeq"]),
                    doc = o["doc"] as? JsonObject,
                    tip = num(o["tip"]),
                    dismissedSeq = num(d?.get("seq")),
                    dismissedAt = num(d?.get("at")),
                )
            } catch (_: Throwable) {
                StoredNotices()
            }
        }
    }
}

class SecurityNoticeCenter(
    private val backend: NoticeStoreBackend,
    private val fetcher: () -> NoticeFetcher,
    private val client: NoticeClient,
    private val pin: () -> String = { MaintainersTrust.bakedPin },
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val jitterMs: () -> Long = { (Math.random() * JITTER_MS).toLong() },
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    private val lock = Mutex()
    private val inFlight = AtomicBoolean(false)
    private val outcomeState = MutableStateFlow<NoticeOutcome>(NoticeOutcome.nothing)
    private val bannerState = MutableStateFlow<NoticeOutcome.Banner?>(null)

    @Volatile private var sessionDismissed = false
    @Volatile private var lastFetchAt = 0L
    @Volatile private var timer: Job? = null
    @Volatile private var pollJob: Job? = null

    /** What the stored notice comes to now: nothing, a banner, or the lock. */
    val outcome: StateFlow<NoticeOutcome> get() = outcomeState

    /** The banner to draw, or null (no banner, or it was dismissed). */
    val banner: StateFlow<NoticeOutcome.Banner?> get() = bannerState

    fun load(): StoredNotices = StoredNotices.parse(backend.read())

    private fun save(s: StoredNotices) = backend.write(s.toJson())

    /** Re-evaluate the stored notice at the clock and publish the outcome. */
    suspend fun evaluate(): NoticeOutcome = lock.withLock { evaluateLocked() }

    private fun evaluateLocked(): NoticeOutcome {
        val now = clock()
        val store = load()
        var outcome: NoticeOutcome = NoticeOutcome.nothing
        var notice: SecurityNotice? = null
        val doc = store.doc
        if (doc != null) {
            notice = SecurityNoticeProtocol.parse(doc["notice"])
            val mandates = SecurityNoticeProtocol.parseMandates(doc["mandates"])
            if (notice != null && mandates != null) {
                val auth = SecurityNoticeProtocol.authority(mandates, now, pin(), store.tip)
                outcome = SecurityNoticeProtocol.storedOutcome(NoticeStore(store.highestSeq, notice), auth.keys, client, now)
            }
        }
        publish(outcome, store, now)
        scheduleNextBoundary(notice, now)
        return outcome
    }

    private fun publish(outcome: NoticeOutcome, store: StoredNotices, now: Long) {
        outcomeState.value = outcome
        UpdateLock.set(outcome is NoticeOutcome.Lock)
        bannerState.value = (outcome as? NoticeOutcome.Banner)?.takeIf { bannerVisible(it, store, now) }
    }

    /**
     * Should this banner show? A maintenance banner stays dismissed for its seq.
     * An update banner returns after a day; the grace window of an
     * update-required comes back on every launch (dismissal lasts the launch).
     */
    fun bannerVisible(banner: NoticeOutcome.Banner, store: StoredNotices, now: Long): Boolean {
        val n = banner.notice
        if (sessionDismissed) return false
        if (n.kind == "update-required") return true
        if (store.dismissedSeq != n.seq) return true
        if (banner.style == "maintenance") return false
        return now - store.dismissedAt >= ADVISORY_REAPPEAR_MS
    }

    fun dismiss(banner: NoticeOutcome.Banner) {
        if (banner.notice.kind == "update-required") {
            sessionDismissed = true
        } else {
            save(load().copy(dismissedSeq = banner.notice.seq, dismissedAt = clock()))
        }
        bannerState.value = null
    }

    private fun scheduleNextBoundary(n: SecurityNotice?, now: Long) {
        timer?.cancel()
        timer = null
        if (n == null) return
        val next = listOf(n.validFrom, n.lockFrom, n.validUntil).filter { it > now }.minOrNull() ?: return
        // Re-check at the boundary (at most every 6 hours, so a slept phone still catches up).
        val wait = minOf(next - now + 250, SIX_HOURS_MS)
        timer = scope.launch {
            delay(wait)
            timer = null
            evaluate()
        }
    }

    /**
     * One anonymous GET, then fold the answer in. Never throws: any failure
     * leaves the cached notice as it was. Never more than one in flight.
     */
    suspend fun refresh(): RefreshResult {
        if (!inFlight.compareAndSet(false, true)) return RefreshResult(fetched = false, refused = "busy")
        try {
            return lock.withLock { refreshLocked() }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            return RefreshResult(fetched = false)
        } finally {
            inFlight.set(false)
        }
    }

    private suspend fun refreshLocked(): RefreshResult {
        lastFetchAt = clock()
        val res = fetcher().fetch()
        val body = when (res) {
            is NoticeFetch.NoNotice -> return RefreshResult(fetched = true)
            is NoticeFetch.Failed -> return RefreshResult(fetched = false)
            is NoticeFetch.Document -> res.body
        }
        val doc = SecurityNoticeProtocol.json.parseToJsonElement(body) as? JsonObject
            ?: return RefreshResult(fetched = true, refused = "malformed")
        val version = (doc["version"] as? JsonPrimitive)?.content
        val notice = doc["notice"] as? JsonObject
        val mandatesJson = doc["mandates"] as? JsonArray
        if (version != "1" || notice == null || mandatesJson == null) return RefreshResult(fetched = true, refused = "malformed")
        val mandates = SecurityNoticeProtocol.parseMandates(mandatesJson)
            ?: return RefreshResult(fetched = true, refused = "malformed")
        val now = clock()
        val store = load()
        val auth = SecurityNoticeProtocol.authority(mandates, now, pin(), store.tip)
        val folded = SecurityNoticeProtocol.accept(NoticeStore(store.highestSeq, null), notice, auth.keys)
        val accepted = folded.store.notice
        if (folded.refused == null && accepted != null) {
            save(store.copy(highestSeq = folded.store.highestSeq, doc = SecurityNoticeProtocol.document(accepted.raw, mandatesJson), tip = auth.tip))
            evaluateLocked()
        } else if (auth.tip > store.tip) {
            save(store.copy(tip = auth.tip))
        }
        // Nothing new (a refusal, a repeat): the screen stays as it is until the
        // next boundary or foreground, so a hostile or stale answer cannot
        // reshuffle what the person already sees.
        return RefreshResult(fetched = true, refused = folded.refused)
    }

    /** Decide from the store at once, then poll shortly after launch. Safe to call again (a recreated activity). */
    fun start() = onForeground()

    /** The app returned to the foreground: re-decide, and poll if the last attempt was 15 minutes ago or more. */
    fun onForeground() {
        scope.launch { evaluate() }
        if (clock() - lastFetchAt >= POLL_INTERVAL_MS) kick()
    }

    private fun kick() {
        // Reserve the slot now so a quick second foreground does not queue another fetch.
        lastFetchAt = clock()
        pollJob = scope.launch {
            delay(jitterMs())
            refresh()
        }
    }

    /** Forget the in-memory state (the stored notice is the backend's): a new gym scenario, or a test. */
    fun reset() {
        timer?.cancel()
        timer = null
        pollJob?.cancel()
        pollJob = null
        sessionDismissed = false
        lastFetchAt = 0
        inFlight.set(false)
        outcomeState.value = NoticeOutcome.nothing
        bannerState.value = null
        UpdateLock.set(false)
    }

    data class RefreshResult(val fetched: Boolean, val refused: String? = null)

    companion object {
        const val PATH = "/api/notices"
        const val POLL_INTERVAL_MS = 15L * 60_000
        const val JITTER_MS = 10_000L
        private const val SIX_HOURS_MS = 6L * 3600_000
        private const val ADVISORY_REAPPEAR_MS = 24L * 3600_000

        /** The app's one center, created by MainActivity. */
        @Volatile var shared: SecurityNoticeCenter? = null
            private set

        @Synchronized
        fun install(context: Context): SecurityNoticeCenter {
            shared?.let { return it }
            val c = SecurityNoticeCenter(
                backend = PrefsNoticeStoreBackend(context),
                fetcher = { Variant.noticeFetcher() ?: AnonymousNoticeFetcher() },
                client = NoticeClient(
                    SecurityNoticeProtocol.PLATFORM,
                    com.flagshipserver.app.BuildConfig.VERSION_CODE.toLong(),
                    SecurityNoticeProtocol.CLIENT_PROTOCOL_LEVEL,
                ),
                pin = { Variant.noticePin },
                clock = { Variant.noticeNowMs() },
                jitterMs = { if (Variant.usesMockClients) 0 else (Math.random() * JITTER_MS).toLong() },
            )
            shared = c
            return c
        }
    }
}
