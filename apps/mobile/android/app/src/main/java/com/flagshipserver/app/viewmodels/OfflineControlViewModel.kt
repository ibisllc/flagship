// Offline control (docs/data-sovereignty.md): find the server on this Wi-Fi, prove it by its pinned
// key, open a session with an owner-signed order, then see its status and apps, start/stop/restart an
// app, restart or shut it down, and make and download a backup. Every action is its own signed order
// the server checks itself. No `.com`, no relay. MIRRORS the iOS OfflineControlViewModel.swift.

package com.flagshipserver.app.viewmodels

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.flagshipserver.app.R
import com.flagshipserver.app.api.PqSignatureWire
import com.flagshipserver.app.api.ServerArchiveStartRequest
import com.flagshipserver.app.api.ServerArchiveStatus
import com.flagshipserver.app.api.ServerBackupSlot
import com.flagshipserver.app.core.ArchiveDownloader
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.Rescue
import com.flagshipserver.app.core.RescueConnection
import com.flagshipserver.app.core.RescueConnector
import com.flagshipserver.app.core.RescueDiscovery
import com.flagshipserver.app.core.RescueEndpoint
import com.flagshipserver.app.core.RescueServerBook
import com.flagshipserver.app.core.RescueServerSnapshot
import com.flagshipserver.app.core.RescueTransportException
import com.flagshipserver.app.core.ServerArchive
import com.flagshipserver.app.core.ServerBackupFormat
import com.flagshipserver.app.core.UserErrorText
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File

/** What Offline control needs from the device: everything local, nothing from `.com`. */
class OfflineControlEnvironment(
    /** The servers this device knows: name, pinned key (hex) and last-seen addresses. */
    val servers: () -> List<Triple<String, String?, List<String>>>,
    val pinnedMldsa: (String) -> String?,
    val strict: (String) -> Boolean,
    /** The sensitive-order key: (signer, PQ role, public key hex): the admin root where held, else the IRK. */
    val orderKey: suspend (reason: String) -> Triple<Ed25519Sign, String, String>,
    val pqSignature: (canonical: ByteArray, key: Ed25519Sign, role: String, pubHex: String) -> PqSignatureWire?,
    val accountKek: suspend (archiveId: String) -> ByteArray,
    val passcodeSlot: suspend (archiveId: String, contentKey: ByteArray, passcode: String) -> ServerBackupSlot,
    val connector: RescueConnector,
    val discovery: () -> RescueDiscovery,
    val book: RescueServerBook,
    val downloadDir: () -> File,
    val now: () -> Long = System::currentTimeMillis,
)

class OfflineControlViewModel(
    private val env: OfflineControlEnvironment,
    private val focus: String? = null,
    val suggestedPasscode: String = ServerBackupFormat.generatePasscode(),
    private val pollMs: Long = 1_500,
) {
    data class ServerRow(val domain: String, val pinned: Boolean, val found: RescueEndpoint?, val lastSeen: List<String>) {
        val label: String get() = domain.substringBefore('.')
    }

    sealed interface Phase {
        data object List : Phase
        data class Connecting(val domain: String) : Phase
        data object Connected : Phase
        data class Failed(val message: String) : Phase
    }

    sealed interface Backup {
        data object Idle : Backup
        data object Passcode : Backup
        data class Building(val label: String, val fraction: Double) : Backup
        data class Downloading(val fraction: Double) : Backup
        /** The download stopped: the parts already in are kept for Resume. */
        data class Interrupted(val fraction: Double, val message: String) : Backup
        data class Saved(val file: File) : Backup
        data class Failed(val message: String) : Backup
    }

    private val _servers = MutableStateFlow<kotlin.collections.List<ServerRow>>(emptyList())
    val servers: StateFlow<kotlin.collections.List<ServerRow>> = _servers.asStateFlow()
    private val _phase = MutableStateFlow<Phase>(Phase.List)
    val phase: StateFlow<Phase> = _phase.asStateFlow()
    private val _snapshot = MutableStateFlow<RescueServerSnapshot?>(null)
    val snapshot: StateFlow<RescueServerSnapshot?> = _snapshot.asStateFlow()
    private val _backup = MutableStateFlow<Backup>(Backup.Idle)
    val backup: StateFlow<Backup> = _backup.asStateFlow()

    var serverDomain by mutableStateOf<String?>(null); private set
    var certificateNote by mutableStateOf<String?>(null); private set
    var busy by mutableStateOf<String?>(null); private set
    var notice by mutableStateOf<String?>(null); private set
    var actionError by mutableStateOf<String?>(null); private set
    var searching by mutableStateOf(false); private set

    var useOwnPasscode by mutableStateOf(false)
    var ownPasscode by mutableStateOf("")
    var ownPasscodeAgain by mutableStateOf("")
    var passcodeSaved by mutableStateOf(false)
    var manualName by mutableStateOf("")
    var manualAddress by mutableStateOf("")

    private var connection: RescueConnection? = null
    private var discovery: RescueDiscovery? = null
    private var archive: ServerArchiveStatus? = null

    // ── finding ──

    fun start() {
        _servers.value = env.servers().filter { focus == null || it.first == focus.lowercase() }
            .map { ServerRow(it.first, it.second != null, null, it.third) }
        if (discovery != null) return
        searching = true
        discovery = env.discovery().also { d -> d.start { found -> apply(found) } }
    }

    fun stop() {
        discovery?.stop()
        discovery = null
        searching = false
        connection?.close()
        connection = null
    }

    private fun apply(found: Map<String, RescueEndpoint>) {
        val pins = env.servers()
        _servers.value = _servers.value.map { row ->
            val stk = pins.firstOrNull { it.first == row.domain }?.second?.let(HexUtil::decode)
            val id = stk?.let { Rescue.discoveryId(it, row.domain) }
            row.copy(found = id?.let { found[it] })
        }
    }

    // ── connecting ──

    private class RefusedHere(message: String) : Exception(message)

    /** Connect to [domain]: where NSD found it, else where it was last seen, else [address]. */
    suspend fun connect(domain: String, address: String? = null) {
        val d = domain.trim().lowercase()
        actionError = null
        notice = null
        val known = env.servers().firstOrNull { it.first == d }
        val stkHex = known?.second
        val stk = stkHex?.let(HexUtil::decode)?.takeIf { it.size == 32 }
        if (stkHex == null || stk == null) {
            _phase.value = Phase.Failed(FSStrings.get(R.string.offline_never_confirmed_key, d))
            return
        }
        val endpoints = buildList {
            address?.let(RescueEndpoint::parse)?.let(::add)
            _servers.value.firstOrNull { it.domain == d }?.found?.let(::add)
            known.third.mapNotNull(RescueEndpoint::parse).forEach(::add)
        }.distinct()
        if (endpoints.isEmpty()) {
            _phase.value = Phase.Failed(FSStrings.get(R.string.offline_not_found, d))
            return
        }
        _phase.value = Phase.Connecting(d)
        var last = FSStrings.get(R.string.offline_didnt_answer, d)
        for (e in endpoints) {
            val conn = env.connector.connect(e, d)
            try {
                openSession(conn, d, stk, stkHex, e)
                return
            } catch (c: CancellationException) {
                conn.close()
                throw c
            } catch (_: RescueTransportException.Unreachable) {
                conn.close()
                continue
            } catch (t: Throwable) {
                conn.close()
                last = message(t)
                break
            }
        }
        _phase.value = Phase.Failed(last)
    }

    private suspend fun openSession(conn: RescueConnection, domain: String, stk: ByteArray, stkHex: String, endpoint: RescueEndpoint) {
        val clientNonce = Rescue.newNonce()
        val reply = conn.hello(clientNonce)
        Rescue.checkHello(reply.hello, reply.signature, stk, domain, clientNonce, reply.seenCertSha256, env.now())?.let { throw RefusedHere(helloRefusal(it, domain)) }
        Rescue.checkHelloPq(reply.hello, reply.pqSuite, reply.pqSignatureHex, stkHex, env.pinnedMldsa(domain), env.strict(domain))?.let { throw RefusedHere(pqRefusal(it)) }
        // From here on, only a connection that presents this very certificate is accepted.
        conn.pin(reply.seenCertSha256)
        val order = reply.hello.copy(issuedAt = env.now())
        val canonical = order.sessionCanonical()
        val (key, role, pub) = env.orderKey(FSStrings.get(R.string.offline_reason_connect, domain))
        val sig = HexUtil.encode(key.sign(canonical))
        conn.openSession(order, sig, env.pqSignature(canonical, key, role, pub))
        val s = conn.server()
        connection = conn
        _snapshot.value = s
        serverDomain = domain
        certificateNote = if (reply.certificateTrusted) null else FSStrings.get(R.string.offline_certificate_note)
        env.book.saw(domain, endpoint.record)
        _phase.value = Phase.Connected
    }

    fun disconnect() {
        connection?.close()
        connection = null
        _snapshot.value = null
        serverDomain = null
        _backup.value = Backup.Idle
        _phase.value = Phase.List
    }

    suspend fun refresh() {
        val conn = connection ?: return
        try {
            _snapshot.value = conn.server()
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            actionError = message(t)
        }
    }

    // ── controls ──

    val offersControls: Boolean get() = !_snapshot.value?.controls.isNullOrEmpty()

    /** Sign and send one offline action. [serviceId] for an app action. */
    suspend fun perform(action: Rescue.Action, serviceId: String? = null) {
        val conn = connection ?: return
        val domain = serverDomain ?: return
        val sessionNonce = _snapshot.value?.sessionNonce ?: return
        actionError = null
        notice = null
        val target = if (action.isServerAction) domain else serviceId.orEmpty()
        val name = _snapshot.value?.apps?.firstOrNull { it.serviceId == target }?.name ?: target
        busy = "$target|${action.wire}"
        try {
            val order = Rescue.ControlOrder.of(domain, sessionNonce, action, target, env.now())
            val canonical = order.canonical()
            val (key, role, pub) = env.orderKey(reason(action, name, domain))
            conn.control(order, HexUtil.encode(key.sign(canonical)), env.pqSignature(canonical, key, role, pub))
            notice = done(action, name)
            if (action.isServerAction) {
                // The server goes down a moment after it answers: this session ends with it.
                connection?.close()
                connection = null
                _snapshot.value = null
                _phase.value = Phase.List
            } else {
                refresh()
            }
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            actionError = message(t)
        } finally {
            busy = null
        }
    }

    // ── backup ("Rescue my data") ──

    val chosenPasscode: String?
        get() {
            if (!useOwnPasscode) return suggestedPasscode
            if (ServerBackupFormat.passcodeProblem(ownPasscode) != null || ownPasscode != ownPasscodeAgain) return null
            return ownPasscode
        }

    val ownPasscodeHint: String?
        get() {
            if (!useOwnPasscode) return null
            if (ownPasscode.isEmpty()) return FSStrings.get(R.string.at_least_12_characters_with_three)
            ServerBackupFormat.passcodeProblem(ownPasscode)?.let { return it }
            if (ownPasscodeAgain.isNotEmpty() && ownPasscodeAgain != ownPasscode) return FSStrings.get(R.string.the_two_dont_match)
            return null
        }

    val canStartBackup: Boolean get() = _backup.value == Backup.Passcode && chosenPasscode != null && passcodeSaved

    fun askPasscode() { _backup.value = Backup.Passcode }

    suspend fun startBackup() {
        val passcode = chosenPasscode
        val conn = connection
        if (!canStartBackup || passcode == null || conn == null) return
        _backup.value = Backup.Building(FSStrings.get(R.string.protecting_the_backup_with_its_passcode), 0.0)
        val contentKey = ServerBackupFormat.randomBytes(32)
        try {
            val id = ServerArchive.newArchiveId()
            val account = ServerBackupFormat.wrapAccountSlot(id, contentKey, env.accountKek(id), ServerBackupFormat.randomBytes(12))
            val pass = env.passcodeSlot(id, contentKey, passcode)
            conn.archiveStart(ServerArchiveStartRequest(id, HexUtil.encode(contentKey), listOf(pass, account)))
            while (true) {
                val s = conn.archiveStatus() ?: throw IllegalStateException(FSStrings.get(R.string.the_backup_disappeared_from_the_server))
                if (s.state == "failed") throw IllegalStateException(FSStrings.get(R.string.the_backup_failed_2, s.reason ?: "the backup couldn't be made"))
                if (s.state == "ready") { archive = s; break }
                val p = s.progress
                val total = maxOf(p?.total ?: 0, 0)
                _backup.value = Backup.Building(
                    if (total > 0) FSStrings.get(R.string.backing_up_of, p?.app ?: "apps", minOf((p?.done ?: 0) + 1, total), total) else FSStrings.get(R.string.making_the_backup),
                    if (total > 0) (p?.done ?: 0).toDouble() / total else 0.0,
                )
                delay(pollMs)
            }
        } catch (c: CancellationException) {
            _backup.value = Backup.Passcode
            throw c
        } catch (t: Throwable) {
            _backup.value = Backup.Failed(message(t))
            return
        } finally {
            contentKey.fill(0)
        }
        download()
    }

    /** Download the one `.flagship` file: 4 MiB parts, several at once, resuming where an
     *  interrupted download stopped, checked against the server's SHA-256. */
    suspend fun download() {
        val conn = connection ?: return
        val s = archive ?: return
        val domain = serverDomain ?: return
        val total = s.bundleBytes ?: 0
        if (total <= 0) {
            _backup.value = Backup.Failed(FSStrings.get(R.string.offline_no_bundle))
            return
        }
        val dir = File(env.downloadDir(), s.archiveId).apply { mkdirs() }
        val name = s.bundleFileName ?: "${ServerArchive.fileStem(domain, s.startedAt)}.${ServerBackupFormat.BUNDLE_EXTENSION}"
        val part = File(dir, "$name.part")
        _backup.value = Backup.Downloading(0.0)
        try {
            ArchiveDownloader.download(
                total = total, sha256 = s.bundleSha256, file = part, stateFile = File(dir, "$name.part.json"),
                fetch = { offset -> conn.bundle(offset) },
                progress = { received -> _backup.value = Backup.Downloading(received.toDouble() / total) },
            )
            val out = File(dir, name)
            out.delete()
            part.renameTo(out)
            runCatching { conn.archiveForget() }
            _backup.value = Backup.Saved(out)
        } catch (c: CancellationException) {
            throw c
        } catch (e: ArchiveDownloader.DownloadException) {
            _backup.value = Backup.Failed(e.message ?: FSStrings.get(R.string.the_backup_failed))
        } catch (t: Throwable) {
            val got = (_backup.value as? Backup.Downloading)?.fraction ?: 0.0
            _backup.value = Backup.Interrupted(got, FSStrings.get(R.string.offline_download_stopped, message(t)))
        }
    }

    // ── manual ──

    val canConnectManually: Boolean get() = manualName.isNotBlank() && RescueEndpoint.parse(manualAddress) != null

    suspend fun connectManually() = connect(manualName, manualAddress)

    // ── words ──

    companion object {
        fun helloRefusal(why: String, domain: String): String = when (why) {
            "bad-signature" -> FSStrings.get(R.string.offline_not_your_server, domain)
            "cert-mismatch" -> FSStrings.get(R.string.offline_connection_changed)
            "wrong-server" -> FSStrings.get(R.string.offline_another_server)
            "expired", "not-yet-valid" -> FSStrings.get(R.string.offline_clocks_apart)
            else -> FSStrings.get(R.string.offline_answer_mismatch)
        }

        fun pqRefusal(why: String): String = when (why) {
            "strict-requires-hybrid", "strict-requires-binding" -> FSStrings.get(R.string.offline_strict_unproven)
            else -> FSStrings.get(R.string.offline_pq_bad)
        }

        fun reason(a: Rescue.Action, name: String, server: String): String = when (a) {
            Rescue.Action.APP_START -> FSStrings.get(R.string.offline_reason_start, name)
            Rescue.Action.APP_STOP -> FSStrings.get(R.string.offline_reason_stop, name)
            Rescue.Action.APP_RESTART -> FSStrings.get(R.string.offline_reason_restart, name)
            Rescue.Action.SERVER_RESTART -> FSStrings.get(R.string.offline_reason_restart, server)
            Rescue.Action.SERVER_SHUTDOWN -> FSStrings.get(R.string.offline_reason_shutdown, server)
        }

        fun done(a: Rescue.Action, name: String): String = when (a) {
            Rescue.Action.APP_START -> FSStrings.get(R.string.offline_done_started, name)
            Rescue.Action.APP_STOP -> FSStrings.get(R.string.offline_done_stopped, name)
            Rescue.Action.APP_RESTART -> FSStrings.get(R.string.offline_done_restarted, name)
            Rescue.Action.SERVER_RESTART -> FSStrings.get(R.string.offline_done_server_restart)
            Rescue.Action.SERVER_SHUTDOWN -> FSStrings.get(R.string.offline_done_server_shutdown)
        }

        fun message(t: Throwable): String = when (t) {
            is RescueTransportException -> t.message ?: FSStrings.get(R.string.offline_failed)
            is RefusedHere, is IllegalStateException -> t.message ?: FSStrings.get(R.string.offline_failed)
            else -> UserErrorText.of(t)
        }
    }
}

/** The device's own keys, pins and network. */
fun offlineControlEnvironment(context: android.content.Context, username: String): OfflineControlEnvironment {
    val user = username.lowercase()
    val app = context.applicationContext
    return OfflineControlEnvironment(
        servers = {
            val pins = com.flagshipserver.app.core.ServerKeyPins.shared
            val book = RescueServerBook.shared
            (pins.domains() + book.entries().map { it.domain }).toSortedSet()
                .map { Triple(it, pins.pinnedHex(it), book.entry(it)?.lan ?: emptyList()) }
        },
        pinnedMldsa = { com.flagshipserver.app.core.ServerKeyPins.shared.record(it)?.mldsa },
        strict = { com.flagshipserver.app.keystore.QuantumSafetyService.isStrict(user, it) },
        orderKey = { reason ->
            val ks = com.flagshipserver.app.keystore.Keystore
            if (ks.hasAdminRoot()) Triple(ks.adminRootKey(reason), "admin-root", ks.adminRootPubHex().orEmpty())
            else Triple(ks.deriveIRK(reason), "account-irk", ks.irkPubHex())
        },
        pqSignature = { canonical, key, role, pub ->
            com.flagshipserver.app.keystore.QuantumSafetyService.pqSignature(user, role, canonical, key, pub)
        },
        accountKek = { id ->
            com.flagshipserver.app.keystore.Keystore.deriveServerArchiveKey(id, FSStrings.get(R.string.offline_protect_backup))
        },
        passcodeSlot = { id, key, passcode ->
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { ServerBackupFormat.passcodeSlot(id, key, passcode) }
        },
        connector = com.flagshipserver.app.core.LiveRescueConnector,
        discovery = { com.flagshipserver.app.core.NsdRescueDiscovery(app) },
        book = RescueServerBook.shared,
        downloadDir = { File(app.filesDir, "rescue").apply { mkdirs() } },
    )
}
