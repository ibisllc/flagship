// A scripted retail box on a fake radio for the mock gym and the unit tests: real
// `flagship/box-claim/v1` bytes, a receipt signed by a fixed box key, and one scenario per stop the
// claim screens must show (docs/retail-box-setup.md §13.2 item 5). Twin of iOS MockBoxClaimRadio.

package com.flagshipserver.app.core

import com.flagshipserver.app.core.pq.BoxClaim
import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqHybrid
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

class MockBoxClaimRadio(
    val scenario: Scenario,
    /** How long after the scan starts the box "powers on" and appears. */
    val appearAfterMs: Long = 4_000,
    pressAfterArmMs: Long = 3_200,
) : BoxClaimRadio {
    enum class Scenario(val wire: String) {
        NORMAL("normal"),
        /** An unclaimed box is already advertising before the buyer plugs theirs in. */
        BOX_ALREADY_NEARBY("boxAlreadyNearby"),
        /** A second box appears after the first. */
        SECOND_BOX("secondBox"),
        /** The box reports a press before the phone showed the instruction. */
        EARLY_PRESS("earlyPress"),
        /** Two phones armed at once. */
        CONTENTION("contention"),
        /** A burst of two presses. */
        DOUBLE_PRESS("doublePress"),
        /** The box sends a receipt from another session (a relay passing the real box's on). */
        RELAY_RECEIPT("relayReceipt"),
        /** The first Wi-Fi attempt fails with a wrong password; the second goes online. */
        WRONG_PASSWORD("wrongPassword"),
        /** Nothing ever advertises. */
        NO_BOX("noBox");

        companion object { fun of(s: String?) = entries.firstOrNull { it.wire.equals(s, ignoreCase = true) } }
    }

    companion object {
        /** The mock box's key: Ed25519 seed 0x71…, ML-DSA seed 0x72… (as the shared vectors). */
        val stkSecret: ByteArray = ByteArray(32) { 0x71 } + ByteArray(32) { 0x72 }
        val stkHybridPubHex: String by lazy {
            PqHex.encode(PqHybrid.hybridSigKeygen(stkSecret.copyOfRange(0, 32), stkSecret.copyOfRange(32, 64)).publicKey)
        }
        val stkPubHex: String get() = stkHybridPubHex.substring(0, 64)
        val box = BoxClaimAdvert("mock-box", "0123456789abcdef", BoxClaim.AdvertState.UNCLAIMED)
        val other = BoxClaimAdvert("mock-other", "fedcba9876543210", BoxClaim.AdvertState.UNCLAIMED)
    }

    val pressAfterArmMs: Long = if (scenario == Scenario.EARLY_PRESS) 100 else pressAfterArmMs
    internal val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    @Volatile private var onAdverts: ((List<BoxClaimAdvert>) -> Unit)? = null
    /** What the phone sent in its network step: absent = nothing yet, `Optional.empty` = the cable. */
    @Volatile var sentNetwork: java.util.Optional<BoxClaim.WiFiConfig>? = null
        private set

    override suspend fun startScan(onAdverts: (List<BoxClaimAdvert>) -> Unit) {
        this.onAdverts = onAdverts
        if (scenario == Scenario.BOX_ALREADY_NEARBY) onAdverts(listOf(other))
        if (scenario == Scenario.NO_BOX) return
        scope.launch {
            delay(appearAfterMs)
            emit(listOf(box))
            if (scenario == Scenario.SECOND_BOX) {
                delay(minOf(1_500, appearAfterMs))
                emit(listOf(box, other))
            }
        }
    }

    private fun emit(a: List<BoxClaimAdvert>) { onAdverts?.invoke(a) }

    override fun stopScan() { onAdverts = null }

    override suspend fun connect(advert: BoxClaimAdvert): BoxClaimLink = MockBoxClaimLink(this)

    internal fun recordNetwork(w: BoxClaim.WiFiConfig?) { sentNetwork = java.util.Optional.ofNullable(w) }
}

/** The box end of one mock link: answers the phone as the box's RetailClaimService does. */
internal class MockBoxClaimLink(private val radio: MockBoxClaimRadio) : BoxClaimLink {
    private val queue = Channel<ByteArray>(Channel.UNLIMITED)
    @Volatile private var closed = false
    private var pending: BoxClaim.BoxPending? = null
    private var channel: BoxClaim.Channel? = null
    private var wifiTries = 0
    private val lock = Any()

    override suspend fun send(message: ByteArray) {
        if (closed) throw BoxClaimRadioException(BoxClaimRadioException.Kind.LINK_CLOSED)
        synchronized(lock) { handle(message) }
    }

    override suspend fun receive(): ByteArray =
        queue.receiveCatching().getOrNull() ?: throw BoxClaimRadioException(BoxClaimRadioException.Kind.LINK_CLOSED)

    override fun close() {
        closed = true
        queue.close()
    }

    private fun push(m: ByteArray) { queue.trySend(m) }

    private fun record(json: String) {
        val ch = channel ?: return
        val r = synchronized(lock) { runCatching { ch.seal(json.toByteArray()) }.getOrNull() } ?: return
        push(BoxClaim.encodeMessage(BoxClaim.FRAME_RECORD, r))
    }

    private fun later(ms: Long, f: () -> Unit) { radio.scope.launch { delay(ms); f() } }

    private fun handle(raw: ByteArray) {
        val (kind, payload) = BoxClaim.decodeMessage(raw)
        if (kind == BoxClaim.FRAME_HANDSHAKE) {
            val obj = Json.parseToJsonElement(payload.toString(Charsets.UTF_8))
            val p = pending
            if ((obj as? JsonObject)?.get("t")?.jsonPrimitive?.content == "hello") {
                val np = BoxClaim.BoxPending(obj, BoxClaim.AdvertState.UNCLAIMED, null)
                pending = np
                push(BoxClaim.encodeMessage(BoxClaim.FRAME_HANDSHAKE, np.accept.json.toString().toByteArray()))
            } else if (p != null) {
                pending = null
                val (ready, ch) = p.complete(obj)
                channel = ch
                push(BoxClaim.encodeMessage(BoxClaim.FRAME_HANDSHAKE, ready.toString().toByteArray()))
            }
            return
        }
        val ch = channel ?: return
        val s = radio.scenario
        when (val msg = BoxClaim.PhoneMessage.parse(ch.openJson(payload))) {
            BoxClaim.PhoneMessage.Arm -> {
                record("""{"t":"armed"}""")
                if (s == MockBoxClaimRadio.Scenario.CONTENTION) {
                    later(1_000) { record("""{"t":"press-result","ok":false,"reason":"contention"}""") }
                    return
                }
                val at = radio.pressAfterArmMs
                val count = if (s == MockBoxClaimRadio.Scenario.DOUBLE_PRESS) 2 else 1
                later(at + 400) {
                    record("""{"t":"press","atMs":$at,"count":$count,"long":false}""")
                    if (count == 1) record("""{"t":"press-result","ok":true}""") else record("""{"t":"press-result","ok":false,"reason":"burst"}""")
                }
            }
            BoxClaim.PhoneMessage.WifiScan -> record(
                """{"t":"wifi-list","networks":[{"ssid":"Home Wi-Fi","security":"wpa2-wpa3","signal":82,"band":"5"},{"ssid":"Neighbour","security":"wpa2","signal":31,"band":"2.4"},{"ssid":"Office","security":"enterprise","signal":40,"band":"5"}]}""",
            )
            is BoxClaim.PhoneMessage.Claim -> {
                val blob = runCatching { Json.parseToJsonElement(msg.recipe).jsonObject["blob"]!!.jsonObject }.getOrNull()
                val domain = blob?.get("serverDomain")?.jsonPrimitive?.content
                val serial = blob?.get("authCode")?.jsonObject?.get("serial")?.jsonPrimitive?.content
                if (domain == null || serial == null) {
                    record("""{"t":"refused","reason":"recipe-invalid"}""")
                    return
                }
                val transcript = if (s == MockBoxClaimRadio.Scenario.RELAY_RECEIPT) "ab".repeat(64) else ch.transcriptHex
                val unsigned = BoxClaim.Receipt(
                    BoxClaim.Mode.OPEN, domain, serial, MockBoxClaimRadio.stkHybridPubHex, "", "Mini PC N100", "0.4.0",
                    transcript, System.currentTimeMillis(),
                )
                val signed = unsigned.signed { p, m -> PqHybrid.hybridSign(MockBoxClaimRadio.stkSecret, p, m) }
                record(buildJsonObject { put("t", "receipt"); put("receipt", signed.json) }.toString())
            }
            is BoxClaim.PhoneMessage.Network -> {
                val w = msg.wifi
                radio.recordNetwork(w)
                val via = if (w == null) "ethernet" else "wifi"
                record("""{"t":"network-status","stage":"connecting","via":"$via"}""")
                wifiTries++
                val fail = s == MockBoxClaimRadio.Scenario.WRONG_PASSWORD && w != null && wifiTries == 1
                later(800) {
                    if (fail) record("""{"t":"network-status","stage":"failed","via":"wifi","failure":"wrong-password"}""")
                    else record("""{"t":"network-status","stage":"online","via":"$via"}""")
                }
            }
            BoxClaim.PhoneMessage.Abort -> close()
        }
    }
}
