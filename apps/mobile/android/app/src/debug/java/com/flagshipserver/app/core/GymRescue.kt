// GYM-ONLY in-process box for Offline control (twin of iOS GymRescue / MockRescueBox): the real hello
// checks run under the pinned key, the session and every offline order are verified against the owner's
// key, and the backup is served in parts. Scenarios: found, not-found, wrong-key, expired-cert,
// interrupt (the first download stops partway and resumes), stranger (the session is refused).

package com.flagshipserver.app.core

import com.flagshipserver.app.api.PqSignatureWire
import com.flagshipserver.app.api.ServerArchiveStartRequest
import com.flagshipserver.app.api.ServerArchiveStatus
import com.flagshipserver.app.api.ServerBackupKdf
import com.flagshipserver.app.api.ServerBackupSlot
import com.flagshipserver.app.viewmodels.OfflineControlEnvironment
import com.google.crypto.tink.subtle.Ed25519Sign
import java.io.File
import java.io.IOException
import java.security.MessageDigest

object GymRescue {
    private fun pair(fill: Int) = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { fill.toByte() })
    val owner: Ed25519Sign.KeyPair by lazy { pair(0x0A) }
    val stk: Ed25519Sign.KeyPair by lazy { pair(0x5B) }
    val stranger: Ed25519Sign.KeyPair by lazy { pair(0x66) }
    private val otherBox: Ed25519Sign.KeyPair by lazy { pair(0x77) }

    const val TOTAL = 10 * 1024 * 1024
    private const val PART = 4L * 1024 * 1024
    val data: ByteArray by lazy { ByteArray(TOTAL) { (it * 31).toByte() } }

    class MockRescueBox(val domain: String, val scenario: String, private val now: () -> Long) {
        val apps = linkedMapOf("${domain.substringAfter('.').substringBefore('.')}--notes" to "running", "${domain.substringAfter('.').substringBefore('.')}--wiki" to "running")
        val seenControls = mutableListOf<String>()
        private var failedOnce = false
        private val boxNonce = Rescue.newNonce()
        private var sessionNonce: String? = null

        fun connection() = object : RescueConnection {
            override suspend fun hello(clientNonce: String): RescueHelloReply {
                val signer = if (scenario == "wrong-key") otherBox else stk
                val h = Rescue.Exchange(domain, clientNonce, boxNonce, "ab".repeat(32), now())
                return RescueHelloReply(h, Ed25519Sign(signer.privateKey).sign(h.helloCanonical()), null, null, "ab".repeat(32), scenario != "expired-cert")
            }
            override fun pin(certSha256: String) {}
            override suspend fun openSession(order: Rescue.Exchange, signatureHex: String, pq: PqSignatureWire?): Long {
                val sig = HexUtil.decode(signatureHex)
                if (sig == null || !Rescue.verifyEd25519(owner.publicKey, sig, order.sessionCanonical()))
                    throw RescueTransportException.Box(403, "the rescue session was refused: not signed by this server's owner key", "rescue-session-refused")
                sessionNonce = order.boxNonce
                return now() + 600_000
            }
            override suspend fun server() = RescueServerSnapshot(
                serverDomain = domain,
                apps = apps.map { RescueServerApp(it.key, it.key.substringAfter("--").replaceFirstChar(Char::uppercase), it.value) },
                controls = listOf("app-start", "app-stop", "app-restart", "server-restart", "server-shutdown"),
                status = RescueServerStatus(version = "0.3.0", startedAt = now() - 3_600_000, diskUsedBytes = 12L shl 30, diskTotalBytes = 100L shl 30, certValidUntil = now() + 30L * 86_400_000),
                sessionNonce = sessionNonce,
            )
            override suspend fun control(order: Rescue.ControlOrder, signatureHex: String, pq: PqSignatureWire?) {
                val sig = HexUtil.decode(signatureHex)
                if (sig == null || !Rescue.verifyEd25519(owner.publicKey, sig, order.canonical())) throw RescueTransportException.Box(403, "the order wasn't signed by this server's owner key", null)
                if (order.sessionNonce != sessionNonce) throw RescueTransportException.Box(403, "that order belongs to another session", null)
                seenControls += "${order.action}|${order.target}"
                when (order.action) {
                    "app-stop" -> apps[order.target] = "stopped"
                    "app-start", "app-restart" -> apps[order.target] = "running"
                }
            }
            override suspend fun archiveStart(req: ServerArchiveStartRequest) {}
            override suspend fun archiveStatus() = ServerArchiveStatus(
                archiveId = "a".repeat(32), state = "ready", startedAt = 1,
                bundleFileName = "home.flagship", bundleBytes = TOTAL.toLong(),
                bundleSha256 = HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(data)),
            )
            override suspend fun bundle(offset: Long): ByteArray {
                if (scenario == "interrupt" && !failedOnce && offset >= PART) { failedOnce = true; throw IOException("Wi-Fi dropped") }
                return data.copyOfRange(offset.toInt(), minOf(TOTAL.toLong(), offset + PART).toInt())
            }
            override suspend fun archiveForget() {}
            override fun close() {}
        }
    }

    /** The environment Offline control runs in against a mock box: this device knows [domain] by its pinned key. */
    fun environment(
        domain: String,
        scenario: String,
        dir: File,
        now: () -> Long = System::currentTimeMillis,
        book: RescueServerBook = RescueServerBook(InMemoryRescueBookStore()),
        pinned: Boolean = true,
        found: Boolean = scenario != "not-found",
        lan: List<String> = emptyList(),
    ): Pair<OfflineControlEnvironment, MockRescueBox> {
        val box = MockRescueBox(domain, scenario, now)
        val signer = if (scenario == "stranger") stranger else owner
        val stkHex = HexUtil.encode(stk.publicKey)
        val id = Rescue.discoveryId(stk.publicKey, domain)!!
        return OfflineControlEnvironment(
            servers = { listOf(Triple(domain, if (pinned) stkHex else null, lan)) },
            pinnedMldsa = { null }, strict = { false },
            orderKey = { Triple(Ed25519Sign(signer.privateKey), "admin-root", HexUtil.encode(signer.publicKey)) },
            pqSignature = { _, _, _, _ -> null },
            accountKek = { ByteArray(32) { 0x33 } },
            passcodeSlot = { _, _, _ -> ServerBackupSlot("passcode", ServerBackupKdf(m = 64, t = 1, p = 1, saltHex = "01".repeat(16)), "02".repeat(12), "03".repeat(48)) },
            connector = RescueConnector { _, _ -> box.connection() },
            discovery = {
                object : RescueDiscovery {
                    override fun start(onChange: (Map<String, RescueEndpoint>) -> Unit) {
                        onChange(if (found) mapOf(id to RescueEndpoint("192.168.1.20")) else emptyMap())
                    }
                    override fun stop() {}
                }
            },
            book = book, downloadDir = { dir }, now = now,
        ) to box
    }
}
