// The relay hint's fetch and per-install store (docs/relay-hints.md). The
// envelope and rules are RelayHint.kt. The request is ONE anonymous GET, like the
// security notice's: no cookie, identifier, version or query, on a client of its
// own. Failure changes nothing, and the hint is only ever consulted when DNS has
// already failed, so a bad one costs a failed fallback and nothing else.

package com.flagshipserver.app.core

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
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
import okhttp3.Request
import java.net.InetAddress

/** highestSeq, the last accepted document, and the newest authority mandate seen. */
data class StoredRelayHint(val highestSeq: Long = 0, val doc: JsonObject? = null, val tip: Long = 0) {
    fun toJson(): String = buildJsonObject {
        put("highestSeq", highestSeq)
        put("doc", doc ?: JsonNull)
        put("tip", tip)
    }.toString()

    companion object {
        /** A corrupt store is an empty one. */
        fun parse(raw: String?): StoredRelayHint {
            if (raw.isNullOrEmpty()) return StoredRelayHint()
            return try {
                val o = SecurityNoticeProtocol.json.parseToJsonElement(raw) as? JsonObject ?: return StoredRelayHint()
                fun num(e: JsonElement?): Long = (e as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toLongOrNull()?.takeIf { it >= 0 } ?: 0
                StoredRelayHint(num(o["highestSeq"]), o["doc"] as? JsonObject, num(o["tip"]))
            } catch (_: Throwable) {
                StoredRelayHint()
            }
        }
    }
}

class PrefsRelayHintBackend(context: Context) : NoticeStoreBackend {
    private val prefs = context.applicationContext.getSharedPreferences("flagship-relay-hint", Context.MODE_PRIVATE)
    override fun read(): String? = runCatching { prefs.getString(KEY, null) }.getOrNull()
    override fun write(value: String) {
        runCatching { prefs.edit().putString(KEY, value).commit() }
    }

    private companion object {
        const val KEY = "store.v1"
    }
}

class RelayHintCenter(
    private val backend: NoticeStoreBackend,
    private val fetcher: () -> NoticeFetcher,
    private val pin: () -> String = { MaintainersTrust.bakedPin },
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    private val lock = Mutex()

    @Volatile private var lastFetchAt = 0L

    fun load(): StoredRelayHint = StoredRelayHint.parse(backend.read())

    /**
     * The addresses to try when DNS fails: the stored hint's if it is in its
     * window and verifies against the authority now, then [seed]. Never throws.
     */
    fun addresses(seed: List<InetAddress>): List<InetAddress> = try {
        val store = load()
        val now = clock()
        val hint = store.doc?.let { RelayHintProtocol.parse(it["hint"]) }
        val mandates = store.doc?.let { SecurityNoticeProtocol.parseMandates(it["mandates"]) }
        val keys = if (hint != null && mandates != null) SecurityNoticeProtocol.authority(mandates, now, pin(), store.tip).keys else emptyList()
        val hex = RelayHintProtocol.addresses(RelayHintStore(store.highestSeq, hint), keys, seed.mapNotNull { it.hostAddress }, now)
        hex.mapNotNull { runCatching { InetAddress.getByName(it) }.getOrNull() }.distinct()
    } catch (_: Throwable) {
        seed
    }

    /** One anonymous GET, then fold the answer in. Never throws; any failure leaves the cached hint as it was. */
    suspend fun refresh(): String? = try {
        lock.withLock { refreshLocked() }
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (_: Throwable) {
        null
    }

    private suspend fun refreshLocked(): String? {
        lastFetchAt = clock()
        val body = when (val res = fetcher().fetch()) {
            is NoticeFetch.NoNotice, is NoticeFetch.Failed -> return null
            is NoticeFetch.Document -> res.body
        }
        val doc = SecurityNoticeProtocol.json.parseToJsonElement(body) as? JsonObject ?: return "malformed"
        val hint = doc["hint"] as? JsonObject
        val mandatesJson = doc["mandates"] as? JsonArray
        if ((doc["version"] as? JsonPrimitive)?.content != "1" || hint == null || mandatesJson == null) return "malformed"
        val mandates = SecurityNoticeProtocol.parseMandates(mandatesJson) ?: return "malformed"
        val now = clock()
        val store = load()
        val auth = SecurityNoticeProtocol.authority(mandates, now, pin(), store.tip)
        val folded = RelayHintProtocol.accept(RelayHintStore(store.highestSeq, null), hint, auth.keys)
        val accepted = folded.store.hint
        if (folded.refused == null && accepted != null) {
            val saved = buildJsonObject {
                put("hint", accepted.raw)
                put("mandates", mandatesJson)
            }
            backend.write(StoredRelayHint(folded.store.highestSeq, saved, auth.tip).toJson())
        } else if (auth.tip > store.tip) {
            backend.write(store.copy(tip = auth.tip).toJson())
        }
        return folded.refused
    }

    /** Fetch shortly after launch and then about daily; the first fetch waits a little so it never competes with start-up. */
    fun start() {
        if (clock() - lastFetchAt < POLL_INTERVAL_MS) return
        lastFetchAt = clock()
        scope.launch {
            delay(START_DELAY_MS)
            refresh()
        }
    }

    companion object {
        const val PATH = "/api/relay-hints"
        const val POLL_INTERVAL_MS = 24L * 3600_000
        private const val START_DELAY_MS = 20_000L

        @Volatile var shared: RelayHintCenter? = null
            private set

        @Synchronized
        fun install(context: Context): RelayHintCenter {
            shared?.let { return it }
            val c = RelayHintCenter(
                backend = PrefsRelayHintBackend(context),
                fetcher = { AnonymousNoticeFetcher(path = PATH) },
                pin = { Variant.noticePin },
                clock = { Variant.noticeNowMs() },
            )
            shared = c
            return c
        }

        /** The addresses for [apex] when DNS has failed: the signed hint, then the compiled-in seed (prod apex only). */
        fun addressesFor(apex: String): List<InetAddress> {
            if (apex != Endpoints.PROD_DATA_APEX) return emptyList()
            return shared?.addresses(RelayAddresses.prod) ?: RelayAddresses.prod
        }
    }
}
