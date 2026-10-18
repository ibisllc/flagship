// The owner's Database section (docs/app-apis.md §6): an app's live data over
// the owner's paired session. Browsing and unsigned queries are read-only on
// the box; a statement that changes data needs a `flagship/app-db-write/v1`
// order signed with the sensitive-order key, good for one run. Never shown to
// a restricted device, and hidden when the box answers 403 (a companion
// session) or 404 (a box from before the section).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.UserErrorText
import com.flagshipserver.app.api.AppDbQueryRequest
import com.flagshipserver.app.api.AppDbQueryResult
import com.flagshipserver.app.api.AppDbRefusal
import com.flagshipserver.app.api.AppDbRows
import com.flagshipserver.app.api.AppDbStore
import com.flagshipserver.app.api.AppDbTable
import com.flagshipserver.app.api.AppDbWriteGrantBody
import com.flagshipserver.app.api.AppDetailResponse
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.AppDbWrite
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import java.util.Locale

/** The stores and their tables (the entry on the app's page and its screen). */
class AppDatabaseViewModel(
    private val serviceId: String,
    private val client: ScreensClient,
) {
    sealed interface Phase {
        data object Loading : Phase
        /** A box without the section (404) or a session it refuses (403): no entry at all. */
        data object Hidden : Phase
        data class Failed(val message: String) : Phase
        data class Loaded(val stores: List<AppDbStore>) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Loading)
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    suspend fun load() {
        try {
            _phase.value = Phase.Loaded(client.serviceDb(serviceId).stores)
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            when {
                hides(t) -> _phase.value = Phase.Hidden
                _phase.value !is Phase.Loaded -> _phase.value = Phase.Failed(failure(t))
            }
        }
    }

    companion object {
        const val TITLE = "Database"
        const val RUN_SQL = "Run SQL"
        const val EXPORT_CSV = "Export CSV"
        const val NO_TABLES = "No tables yet."
        const val NOTE = "Live data. Only you can see it here; no AI ever does."

        /** The page offers the entry only to the owner, for an app with a Postgres store. */
        fun showsEntry(detail: AppDetailResponse, restricted: Boolean): Boolean =
            !restricted && detail.dataLayerInstances.any { it.store == "postgres" }

        /** 404 (older box, or the app is gone) and 403 (companion) hide the section. */
        fun hides(t: Throwable): Boolean =
            t is ScreensError.NotImplemented || (t is ScreensError.Http && (t.status == 404 || t.status == 403))

        fun failure(t: Throwable): String {
            if (t !is ScreensError.Http) return t.userFacing()
            return when (t.status) {
                503 -> "The database isn't reachable right now. Try again in a moment."
                else -> t.boxError() ?: t.userFacing()
            }
        }

        fun summaryText(stores: List<AppDbStore>): String {
            val n = stores.sumOf { it.tables.size }
            val tables = if (n == 1) "1 table" else "$n tables"
            return if (stores.size > 1) "$tables in ${stores.size} stores" else tables
        }

        fun rowsText(t: AppDbTable): String {
            val rows = t.rows?.takeIf { it >= 0 }?.toLong()
            val count = when {
                rows == null -> if (t.kind == "view") "view" else "rows unknown"
                rows == 1L -> "about 1 row"
                else -> "about ${String.format(Locale.US, "%,d", rows)} rows"
            }
            return if (t.kind == "view" && rows != null) "view · $count" else count
        }

        fun sizeText(bytes: Double): String {
            val b = bytes.coerceAtLeast(0.0)
            return when {
                b < 1024 -> "${b.toLong()} B"
                b < 1024 * 1024 -> "${(b / 1024).toLong()} KB"
                b < 1024.0 * 1024 * 1024 -> String.format(Locale.US, "%.1f MB", b / (1024 * 1024))
                else -> String.format(Locale.US, "%.1f GB", b / (1024.0 * 1024 * 1024))
            }
        }

        /** A cell as Postgres printed it; NULL for a null. */
        fun cellText(e: JsonElement): String = when (e) {
            is JsonNull -> "NULL"
            is JsonPrimitive -> e.content
            else -> e.toString()
        }
    }
}

/** One table's rows, 100 at a time, and its CSV export. */
class AppDbTableViewModel(
    private val serviceId: String,
    private val store: String,
    val table: String,
    private val client: ScreensClient,
    val pageSize: Int = PAGE_SIZE,
) {
    private val _page = MutableStateFlow<AppDbRows?>(null)
    val page: StateFlow<AppDbRows?> = _page.asStateFlow()

    private val _offset = MutableStateFlow(0)
    val offset: StateFlow<Int> = _offset.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _exporting = MutableStateFlow(false)
    val exporting: StateFlow<Boolean> = _exporting.asStateFlow()

    val hasPrevious: Boolean get() = _offset.value > 0
    val hasNext: Boolean get() = _page.value?.let { _offset.value + it.rows.size < it.total } ?: false

    suspend fun load(offset: Int = _offset.value) {
        _loading.value = true
        _error.value = null
        try {
            _page.value = client.serviceDbTable(serviceId, store, table, offset.coerceAtLeast(0), pageSize)
            _offset.value = offset.coerceAtLeast(0)
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            _error.value = AppDatabaseViewModel.failure(t)
        } finally {
            _loading.value = false
        }
    }

    suspend fun next() {
        if (hasNext) load(_offset.value + pageSize)
    }

    suspend fun previous() {
        if (hasPrevious) load((_offset.value - pageSize).coerceAtLeast(0))
    }

    /** The whole table as CSV, or null with [error] set. */
    suspend fun exportCsv(): ByteArray? {
        if (_exporting.value) return null
        _exporting.value = true
        _error.value = null
        return try {
            client.serviceDbExportCsv(serviceId, store, table)
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            _error.value = if (t is ScreensError.Http && t.status == 413) {
                "This table is too big to export in one file. Export it in parts with a query."
            } else {
                AppDatabaseViewModel.failure(t)
            }
            null
        } finally {
            _exporting.value = false
        }
    }

    fun rangeText(): String {
        val p = _page.value ?: return ""
        if (p.rows.isEmpty()) return if (p.total == 0L) "No rows" else "No rows here (${p.total} in all)"
        val from = _offset.value + 1
        val to = _offset.value + p.rows.size
        return "Rows ${fmt(from.toLong())}–${fmt(to.toLong())} of ${fmt(p.total)}"
    }

    companion object {
        const val PAGE_SIZE = 100

        private fun fmt(n: Long) = String.format(Locale.US, "%,d", n)

        /** A safe file name for the share sheet. */
        fun csvFileName(table: String): String =
            (table.replace(Regex("[^A-Za-z0-9._-]+"), "_").take(80).ifEmpty { "table" }) + ".csv"
    }
}

/** Run SQL against one store: read-only unsigned; a write is signed once the owner confirms. */
class AppDbQueryViewModel(
    private val serviceId: String,
    val store: String,
    private val client: ScreensClient,
    private val appName: String = serviceId,
    /** The paired session's box when the client can't say (never the leader:
     *  the grant must name the box that receives it). */
    private val fallbackServerDomain: () -> String? = { null },
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    sealed interface Phase {
        data object Idle : Phase
        data object Running : Phase
        /** The statement changes data: confirm to sign and run it. */
        data class NeedsGrant(val sql: String) : Phase
        data class Done(val result: AppDbQueryResult, val signed: Boolean) : Phase
        data class Failed(val message: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Idle)
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    private var lastIssuedAt = 0L

    /** Run read-only. A write comes back as [Phase.NeedsGrant]. */
    suspend fun run(sql: String) {
        if (_phase.value is Phase.Running) return
        if (sql.isBlank()) {
            _phase.value = Phase.Failed(SQL_REQUIRED)
            return
        }
        _phase.value = Phase.Running
        _phase.value = try {
            Phase.Done(client.serviceDbQuery(serviceId, store, AppDbQueryRequest(sql)), signed = false)
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            if (refusal(t)?.needsGrant == true) Phase.NeedsGrant(sql) else Phase.Failed(failure(t, signed = false))
        }
    }

    /** Confirm the write: biometrics, sign, resend. A 409 (that order was already
     *  used) signs once more with a new issuedAt. */
    suspend fun confirmWrite() {
        val sql = (_phase.value as? Phase.NeedsGrant)?.sql ?: return
        _phase.value = Phase.Running
        val domain = runCatching { client.boxFqdn() }.getOrNull()?.takeIf { it.isNotEmpty() }
            ?: fallbackServerDomain()?.takeIf { it.isNotEmpty() }
        if (domain == null) {
            _phase.value = Phase.Failed("Couldn't tell which server this app is on.")
            return
        }
        val key = try {
            signer("Change the data in $appName")
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            _phase.value = Phase.Failed("Couldn't access your account key: ${UserErrorText.reason(t)}")
            return
        }
        _phase.value = try {
            try {
                Phase.Done(send(key, domain, sql), signed = true)
            } catch (t: ScreensError.Http) {
                if (t.status != 409) throw t
                Phase.Done(send(key, domain, sql), signed = true)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            Phase.Failed(failure(t, signed = true))
        }
    }

    /** Leave the write unsent. */
    fun cancelWrite() {
        if (_phase.value is Phase.NeedsGrant) _phase.value = Phase.Idle
    }

    private suspend fun send(key: Ed25519Sign, domain: String, sql: String): AppDbQueryResult {
        val issuedAt = maxOf(now(), lastIssuedAt + 1)
        lastIssuedAt = issuedAt
        val signed = AppDbWrite.sign(key, domain, serviceId, store, sql, issuedAt)
        val g = signed.grant
        return client.serviceDbQuery(
            serviceId,
            store,
            AppDbQueryRequest(
                sql = sql,
                grant = AppDbWriteGrantBody(g.serverDomain, g.serviceId, g.store, g.sqlSha256, g.issuedAt),
                signature = signed.signatureHex,
            ),
        )
    }

    companion object {
        const val RUN = "Run"
        const val NEEDS_GRANT = "This changes data. Confirm with your fingerprint, face or screen lock to run it."
        const val CONFIRM = "Confirm and run"
        const val CANCEL = "Cancel"
        const val SQL_REQUIRED = "Write a statement first."
        const val HELP = "One statement. It runs read-only unless it changes data, which you confirm first."

        private val LENIENT = Json { ignoreUnknownKeys = true }

        fun refusal(t: Throwable): AppDbRefusal? {
            if (t !is ScreensError.Http || t.status != 400) return null
            return runCatching { LENIENT.decodeFromString(AppDbRefusal.serializer(), t.body) }.getOrNull()
        }

        fun failure(t: Throwable, signed: Boolean): String {
            if (t !is ScreensError.Http) return t.userFacing()
            val box = t.boxError()
            return when (t.status) {
                400 -> {
                    val r = refusal(t)
                    val where = listOfNotNull(
                        r?.sqlState?.let { "SQLSTATE $it" },
                        r?.position?.let { "at character $it" },
                    ).joinToString(", ")
                    (box ?: "The server couldn't run this statement.") + if (where.isNotEmpty()) " ($where)" else ""
                }
                403 -> if (signed) {
                    "The server refused this change${box?.let { ": $it" } ?: ""}. Check this phone's clock and try again."
                } else {
                    "This device can't use the database."
                }
                404 -> "This app or its store is no longer on the server."
                409 -> "That signed order was already used. Run it again to sign a new one."
                413 -> box ?: "The statement is too long."
                503 -> "The database isn't reachable right now. Try again in a moment."
                else -> box ?: t.userFacing()
            }
        }

        fun summaryText(r: AppDbQueryResult): String {
            val cmd = r.command.ifEmpty { "Done" }
            val n = r.rowCount ?: return cmd
            return "$cmd · ${if (n == 1L) "1 row" else String.format(Locale.US, "%,d rows", n)}"
        }

        fun truncatedText(r: AppDbQueryResult): String? =
            if (r.truncated) "Showing the first ${r.rows.size} rows. There are more: narrow the query to see them." else null
    }
}
