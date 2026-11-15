// The phone side of a retail claim (docs/retail-box-setup.md §4, §7, §15.1): the presence rule,
// the handshake, the timed press, the recipe, the receipt and key registration, the network step,
// the internet check and the certificate check. Kotlin twin of iOS FlagshipCore/RetailClaimFlow.swift;
// the screens render [RetailClaimViewModel.phase].

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.core.pq.BoxClaim
import com.flagshipserver.app.core.pq.BoxClaimException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Why a retail claim stopped (§4, §7.4, §7.6). Each has one sentence the app shows. */
enum class RetailClaimStop {
    ANOTHER_BOX_NEARBY, TWO_BOXES, EARLY, LATE, BURST, CONTENTION, NO_PRESS, BUSY, WINDOW_CLOSED,
    ALREADY_CLAIMED, RECIPE_REFUSED, OUT_OF_ORDER, ENTROPY, BAD_RECEIPT, KEY_TAKEN, NOT_ADMIN,
    BLUETOOTH_OFF, BLUETOOTH_NOT_ALLOWED, BLUETOOTH_UNSUPPORTED, LINK_LOST, WRONG_CODE, NO_ANSWER, BAD_LINK;

    val title: String get() = FSStrings.get(
        when (this) {
            ANOTHER_BOX_NEARBY, TWO_BOXES -> R.string.retail_title_more_than_one
            EARLY, BAD_RECEIPT -> R.string.retail_title_dont_continue
            CONTENTION -> R.string.retail_title_contention
            BLUETOOTH_OFF, BLUETOOTH_NOT_ALLOWED, BLUETOOTH_UNSUPPORTED -> R.string.retail_title_bluetooth
            KEY_TAKEN -> R.string.retail_title_key_taken
            NOT_ADMIN -> R.string.retail_title_not_admin
            else -> R.string.retail_title_stopped
        },
    )

    val message: String get() = FSStrings.get(
        when (this) {
            ANOTHER_BOX_NEARBY -> R.string.retail_stop_another_box
            TWO_BOXES -> R.string.retail_stop_two_boxes
            EARLY -> R.string.retail_stop_early
            LATE -> R.string.retail_stop_late
            BURST -> R.string.retail_stop_burst
            CONTENTION -> R.string.retail_stop_contention
            NO_PRESS -> R.string.retail_stop_no_press
            BUSY -> R.string.retail_stop_busy
            WINDOW_CLOSED -> R.string.retail_stop_window_closed
            ALREADY_CLAIMED -> R.string.retail_stop_already_claimed
            RECIPE_REFUSED -> R.string.retail_stop_recipe_refused
            OUT_OF_ORDER -> R.string.retail_stop_out_of_order
            ENTROPY -> R.string.retail_stop_entropy
            BAD_RECEIPT -> R.string.retail_stop_bad_receipt
            KEY_TAKEN -> R.string.retail_stop_key_taken
            NOT_ADMIN -> R.string.retail_stop_not_admin
            BLUETOOTH_OFF -> R.string.retail_stop_bluetooth_off
            BLUETOOTH_NOT_ALLOWED -> R.string.retail_stop_bluetooth_not_allowed
            BLUETOOTH_UNSUPPORTED -> R.string.retail_stop_bluetooth_unsupported
            LINK_LOST -> R.string.retail_stop_link_lost
            WRONG_CODE -> R.string.retail_stop_wrong_code
            NO_ANSWER -> R.string.retail_stop_no_answer
            BAD_LINK -> R.string.retail_stop_bad_link
        },
    )
}

enum class RetailClaimAlarm {
    /** The server that came online holds another key than the box this phone paired with. */
    KEY_MISMATCH,
    /** No server came online under this recipe. */
    NEVER_ONLINE;

    val message: String get() = FSStrings.get(
        if (this == KEY_MISMATCH) R.string.retail_alarm_key_mismatch else R.string.retail_alarm_never_online,
    )
}

object RetailClaimCopy {
    fun networkFailure(f: String): String = FSStrings.get(
        when (f) {
            "no-link" -> R.string.retail_net_no_link
            "network-not-found" -> R.string.retail_net_not_found
            "wrong-password" -> R.string.retail_net_wrong_password
            "unsupported-security" -> R.string.retail_net_unsupported_security
            "no-dhcp" -> R.string.retail_net_no_dhcp
            "no-dns" -> R.string.retail_net_no_dns
            "captive-portal" -> R.string.retail_net_captive_portal
            else -> R.string.retail_net_relay_unreachable
        },
    )

    val wifiWarning: String get() = FSStrings.get(R.string.retail_wifi_warning)
    val resetInstructions: String get() = FSStrings.get(R.string.retail_reset_instructions)
    val alarmResetInstructions: String get() = FSStrings.get(R.string.retail_alarm_reset_instructions)
    val certificateSlow: String get() = FSStrings.get(R.string.retail_certificate_slow)
}

/** The key registration at `.com` refused (§4 step 8). */
class RetailClaimKeyException(val kind: Kind) : Exception(kind.name) {
    enum class Kind { TAKEN, NOT_ADMIN, SIGNER_GONE }
}

/**
 * The admin key the create flow unsealed for the recipe, held only until it signs the box key
 * (`flagship/box-claim-key/v1`), so a claim asks for the biometric once. [discard] wipes it; the
 * flow discards it right after the registration and on every stop.
 */
class RetailClaimSigner(private var sign: ((ByteArray) -> ByteArray)?, private var wipe: (() -> Unit)? = null) {
    val isHeld: Boolean @Synchronized get() = sign != null

    @Synchronized
    fun sign(message: ByteArray): ByteArray =
        (sign ?: throw RetailClaimKeyException(RetailClaimKeyException.Kind.SIGNER_GONE))(message)

    @Synchronized
    fun discard() {
        sign = null
        wipe?.invoke()
        wipe = null
    }

    companion object {
        /** Holds a copy of a 32-byte Ed25519 seed and zeroes it on [discard]. */
        fun fromSeed(seed: ByteArray): RetailClaimSigner {
            val held = seed.copyOf()
            seed.fill(0)
            return RetailClaimSigner(
                sign = { m -> com.google.crypto.tink.subtle.Ed25519Sign(held).sign(m) },
                wipe = { held.fill(0) },
            )
        }
    }
}

/** What the create flow hands the claim: the signed recipe and the key that signed it. */
class RetailClaimRecipe(val json: String, val serverDomain: String, val serial: String, val signer: RetailClaimSigner)

class RetailClaimDeps(
    val username: String,
    val radio: BoxClaimRadio,
    val mailboxLink: (mailboxId: String) -> BoxClaimLink,
    /** Signs the recipe (the create flow; the claim's one biometric) and returns it with the key
     *  that signed it, held for the box key registration. */
    val mintRecipe: suspend () -> RetailClaimRecipe,
    /** Posts `flagship/box-claim-key/v1` signed by `signature`; throws RetailClaimKeyException. */
    val registerKey: suspend (key: BoxClaim.ClaimKey, signature: ByteArray) -> Unit,
    /** Pins the box key the receipt named (first contact from the box itself, §3 G4). */
    val pinStk: (serverDomain: String, stkPubHex: String) -> Unit,
    /** The STK `.com` lists for the server, once it registered. */
    val registeredStk: suspend (serverDomain: String) -> String?,
    /** Opens the box over the relay with the pinned certificate: true when it holds, false on a
     *  mismatch, null while the box has not reported a certificate yet. */
    val tlsCheck: suspend (serverDomain: String) -> Boolean?,
    /** The server is on the account now (Home shows it as setting up). */
    val onClaimed: (serverDomain: String, serial: String) -> Unit,
    /** The key-mismatch alarm: this phone stops trusting the server (persisted). */
    val markUntrusted: (serverDomain: String) -> Unit,
    val region: String,
    val now: () -> Long = { System.currentTimeMillis() },
    val sleepMs: suspend (Long) -> Unit = { delay(it) },
    val pauseMs: () -> Long = { BoxClaim.instructionPauseMs() },
    val baselineMs: Long = 3_000,
    val pressHintMs: Long = 60_000,
    val noBoxMs: Long = 180_000,
    val answerTimeoutMs: Long = 30_000,
    val onlineTimeoutMs: Long = 600_000,
    /** After this long without a certificate the screen says it is taking long, and keeps checking. */
    val certificateSlowMs: Long = 300_000,
    /** Checking stops after this long; "Check again" starts it over. */
    val certificateGiveUpMs: Long = 1_800_000,
    val pollMs: Long = 5_000,
)

class RetailClaimViewModel(private val deps: RetailClaimDeps, private val scope: CoroutineScope) {
    enum class PlugHint { WAITING, PRESS_ONCE, NO_BOX }

    sealed interface Phase {
        data object Intro : Phase
        data object ScanCode : Phase
        data object CheckingNearby : Phase
        data class PlugIn(val hint: PlugHint) : Phase
        data object Connecting : Phase
        data object GetReady : Phase
        data object PressNow : Phase
        data object Signing : Phase
        data object RegisteringKey : Phase
        data object ChooseNetwork : Phase
        data object ScanningWifi : Phase
        data class WifiList(val networks: List<BoxClaim.WifiNetwork>) : Phase
        data class WifiPassword(val ssid: String) : Phase
        data class WifiWarning(val ssid: String) : Phase
        data object ConnectingNetwork : Phase
        data class NetworkFailed(val failure: String) : Phase
        data class CheckingInternet(val serverDomain: String) : Phase
        /** The right box is online; waiting for its certificate and the pinned TLS check. */
        data class GettingCertificate(val serverDomain: String) : Phase
        /** Still no certificate after `certificateSlowMs`; checking goes on until the give-up time. */
        data class CertificateSlow(val serverDomain: String) : Phase
        data class Done(val serverDomain: String) : Phase
        data class Alarm(val alarm: RetailClaimAlarm, val serverDomain: String) : Phase
        data class Stopped(val stop: RetailClaimStop) : Phase
        data class Failed(val message: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Intro)
    val phase: StateFlow<Phase> = _phase
    var receipt: BoxClaim.Receipt? = null
        private set
    var mode: BoxClaim.Mode = BoxClaim.Mode.OPEN
        private set
    /** The box key `.com` listed when the alarm went off (for Delete this server). */
    var alarmStk: String? = null
        private set

    private var presence = BoxClaimPresence()
    private var link: BoxClaimLink? = null
    private var channel: BoxClaim.Channel? = null
    private var session: Job = Job()
    private var hints: Job? = null
    private var certificate: Job? = null
    private var handshakes = Channel<ByteArray>(Channel.UNLIMITED)
    private var records = Channel<Pair<BoxClaim.BoxMessage, Long>>(Channel.UNLIMITED)
    @Volatile private var linkDead = false
    private var minted: RetailClaimRecipe? = null
    private var pendingWifi: BoxClaim.WiFiConfig? = null
    @Volatile private var generation = 0

    private fun launch(block: suspend CoroutineScope.() -> Unit): Job = scope.launch(session, block = block)

    // ── entry points ──

    /** The normal method: Bluetooth and a timed press. */
    fun startBluetooth() {
        reset()
        mode = BoxClaim.Mode.OPEN
        _phase.value = Phase.CheckingNearby
        val gen = generation
        launch { runScan(gen) }
    }

    fun showCodeScanner() {
        reset()
        _phase.value = Phase.ScanCode
    }

    /** The sharing method: a setup code from the box's screen, claimed through the `.com` mailbox. */
    fun startWithCode(scanned: String) {
        val code = BoxClaim.parseSetupCodeLink(scanned) ?: BoxClaim.normalizeSetupCode(scanned)
        val mailboxId = code?.let { runCatching { BoxClaim.setupCodeMailboxId(it) }.getOrNull() }
        if (code == null || mailboxId == null) {
            stop(RetailClaimStop.BAD_LINK)
            return
        }
        reset()
        mode = BoxClaim.Mode.CODE
        _phase.value = Phase.Connecting
        val gen = generation
        val l = deps.mailboxLink(mailboxId)
        launch { runClaim(l, code, gen) }
    }

    fun tryAgain() {
        if (mode == BoxClaim.Mode.CODE) showCodeScanner() else startBluetooth()
    }

    fun cancel() {
        abortQuietly()
        _phase.value = Phase.Intro
    }

    // ── network step ──

    fun useCable() {
        pendingWifi = null
        send(BoxClaim.PhoneMessage.Network(null))
        _phase.value = Phase.ConnectingNetwork
    }

    fun useWifi() {
        _phase.value = Phase.ScanningWifi
        send(BoxClaim.PhoneMessage.WifiScan)
    }

    fun pickNetwork(ssid: String) {
        _phase.value = Phase.WifiPassword(ssid)
    }

    /** Checks the password's shape, then shows the warning before anything leaves the phone. */
    fun submitPassword(ssid: String, password: String): Boolean {
        val cfg = BoxClaim.WiFiConfig(ssid, password, deps.region, deps.now())
        if (!cfg.isValid) return false
        pendingWifi = cfg
        _phase.value = Phase.WifiWarning(ssid)
        return true
    }

    fun sendWifi() {
        val cfg = pendingWifi ?: return
        send(BoxClaim.PhoneMessage.Network(cfg))
        _phase.value = Phase.ConnectingNetwork
    }

    fun retryNetwork() {
        _phase.value = Phase.ChooseNetwork
    }

    /** "Check again" on the slow-certificate screen. */
    fun checkCertificateAgain() {
        val p = _phase.value as? Phase.CertificateSlow ?: return
        val want = receipt?.stkPubHex?.lowercase() ?: return
        val gen = generation
        certificate?.cancel()
        certificate = launch { waitForCertificate(p.serverDomain, want, gen) }
    }

    // ── internals ──

    private fun reset() {
        generation++
        session.cancel()
        session = Job()
        hints = null
        certificate = null
        minted?.signer?.discard()
        deps.radio.stopScan()
        link?.close()
        link = null; channel = null; linkDead = false
        handshakes = Channel(Channel.UNLIMITED)
        records = Channel(Channel.UNLIMITED)
        presence = BoxClaimPresence()
        minted = null; receipt = null; pendingWifi = null; alarmStk = null
    }

    private fun sendAbort(l: BoxClaimLink?, ch: BoxClaim.Channel?) {
        if (l == null || ch == null) return
        val rec = runCatching { ch.seal(BoxClaim.PhoneMessage.Abort.jsonText.toByteArray()) }.getOrNull() ?: return
        scope.launch {
            runCatching { l.send(BoxClaim.encodeMessage(BoxClaim.FRAME_RECORD, rec)) }
            l.close()
        }
    }

    private fun stop(s: RetailClaimStop) {
        val ch = channel
        val l = link
        reset()
        sendAbort(l, ch)
        _phase.value = Phase.Stopped(s)
    }

    private fun abortQuietly() {
        val ch = channel
        val l = link
        reset()
        sendAbort(l, ch)
    }

    private suspend fun runScan(gen: Int) {
        try {
            deps.radio.startScan { adverts -> scope.launch(session) { onAdverts(adverts, gen) } }
        } catch (e: CancellationException) {
            throw e
        } catch (e: BoxClaimRadioException) {
            if (gen != generation) return
            stop(
                when (e.kind) {
                    BoxClaimRadioException.Kind.BLUETOOTH_OFF -> RetailClaimStop.BLUETOOTH_OFF
                    BoxClaimRadioException.Kind.NOT_ALLOWED -> RetailClaimStop.BLUETOOTH_NOT_ALLOWED
                    else -> RetailClaimStop.BLUETOOTH_UNSUPPORTED
                },
            )
            return
        } catch (_: Throwable) {
            if (gen == generation) stop(RetailClaimStop.BLUETOOTH_UNSUPPORTED)
            return
        }
        deps.sleepMs(deps.baselineMs)
        if (gen != generation || _phase.value != Phase.CheckingNearby) return
        presence.endBaseline()
        _phase.value = Phase.PlugIn(PlugHint.WAITING)
        hints = launch {
            deps.sleepMs(deps.pressHintMs)
            if (gen == generation && _phase.value == Phase.PlugIn(PlugHint.WAITING)) _phase.value = Phase.PlugIn(PlugHint.PRESS_ONCE)
            deps.sleepMs(deps.noBoxMs - deps.pressHintMs)
            if (gen == generation && _phase.value is Phase.PlugIn) _phase.value = Phase.PlugIn(PlugHint.NO_BOX)
        }
    }

    private fun onAdverts(adverts: List<BoxClaimAdvert>, gen: Int) {
        if (gen != generation || mode != BoxClaim.Mode.OPEN) return
        when (val v = presence.observe(adverts)) {
            BoxClaimPresence.Verdict.Waiting -> Unit
            BoxClaimPresence.Verdict.AnotherBoxNearby -> stop(RetailClaimStop.ANOTHER_BOX_NEARBY)
            BoxClaimPresence.Verdict.TwoBoxes -> stop(RetailClaimStop.TWO_BOXES)
            is BoxClaimPresence.Verdict.One -> {
                if (_phase.value !is Phase.PlugIn || link != null) return
                hints?.cancel()
                _phase.value = Phase.Connecting
                launch {
                    val l = try {
                        deps.radio.connect(v.advert)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Throwable) {
                        if (gen == generation) stop(RetailClaimStop.LINK_LOST)
                        return@launch
                    }
                    runClaim(l, null, gen)
                }
            }
        }
    }

    private fun startReader(l: BoxClaimLink, gen: Int) {
        val hs = handshakes
        val rs = records
        launch {
            while (isActive) {
                val raw = try {
                    l.receive()
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Throwable) {
                    if (gen == generation) {
                        linkDead = true
                        hs.close(); rs.close()
                    }
                    return@launch
                }
                if (gen != generation) return@launch
                val (kind, payload) = runCatching { BoxClaim.decodeMessage(raw) }.getOrNull() ?: continue
                if (kind == BoxClaim.FRAME_HANDSHAKE) {
                    hs.trySend(payload)
                } else {
                    val ch = channel
                    val m = ch?.let { runCatching { BoxClaim.BoxMessage.parse(it.openJson(payload)) }.getOrNull() }
                    if (m != null) rs.trySend(m to deps.now()) else {
                        linkDead = true
                        hs.close(); rs.close()
                        return@launch
                    }
                }
            }
        }
    }

    private suspend fun nextHandshake(timeoutMs: Long): ByteArray? =
        withTimeoutOrNull(timeoutMs.coerceAtLeast(1)) { handshakes.receiveCatching().getOrNull() }

    private suspend fun next(timeoutMs: Long): Pair<BoxClaim.BoxMessage, Long>? =
        withTimeoutOrNull(timeoutMs.coerceAtLeast(1)) { records.receiveCatching().getOrNull() }

    private fun send(m: BoxClaim.PhoneMessage) {
        val l = link ?: return
        val ch = channel ?: return
        val rec = runCatching { ch.seal(m.jsonText.toByteArray()) }.getOrNull() ?: return
        val gen = generation
        launch {
            try {
                l.send(BoxClaim.encodeMessage(BoxClaim.FRAME_RECORD, rec))
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                if (gen == generation) stop(RetailClaimStop.LINK_LOST)
            }
        }
        if (m is BoxClaim.PhoneMessage.Network) listenForNetwork(gen)
        if (m is BoxClaim.PhoneMessage.WifiScan) listenForWifiList(gen)
    }

    private fun json(o: JsonObject): ByteArray = o.toString().toByteArray()

    private suspend fun runClaim(l: BoxClaimLink, code: String?, gen: Int) {
        if (gen != generation) { l.close(); return }
        link = l
        startReader(l, gen)
        try {
            val start = BoxClaim.PhoneStart(if (code == null) BoxClaim.Mode.OPEN else BoxClaim.Mode.CODE, code)
            l.send(BoxClaim.encodeMessage(BoxClaim.FRAME_HANDSHAKE, json(start.hello.json)))
            val acceptBytes = nextHandshake(deps.answerTimeoutMs)
            if (acceptBytes == null) {
                if (gen == generation) stop(if (code == null) RetailClaimStop.LINK_LOST else RetailClaimStop.NO_ANSWER)
                return
            }
            val (finish, pending) = start.finish(parse(acceptBytes))
            l.send(BoxClaim.encodeMessage(BoxClaim.FRAME_HANDSHAKE, json(finish)))
            val readyBytes = nextHandshake(deps.answerTimeoutMs)
            if (readyBytes == null) {
                if (gen == generation) stop(if (code == null) RetailClaimStop.LINK_LOST else RetailClaimStop.WRONG_CODE)
                return
            }
            val ch = pending.confirm(parse(readyBytes))
            if (gen != generation) return
            channel = ch
            press(gen)
        } catch (e: CancellationException) {
            throw e
        } catch (e: BoxClaimException) {
            if (gen != generation) return
            stop(
                when (e.code) {
                    "confirm-failed", "wrong-code" -> if (code == null) RetailClaimStop.BAD_RECEIPT else RetailClaimStop.WRONG_CODE
                    "mode-mismatch" -> RetailClaimStop.BAD_RECEIPT
                    else -> RetailClaimStop.LINK_LOST
                },
            )
        } catch (_: Throwable) {
            if (gen == generation) stop(RetailClaimStop.LINK_LOST)
        }
    }

    private fun parse(b: ByteArray): JsonElement = Json.parseToJsonElement(b.toString(Charsets.UTF_8))

    private fun stopForPress(r: String?): RetailClaimStop = when (r) {
        "burst", "long-press" -> RetailClaimStop.BURST
        "late" -> RetailClaimStop.LATE
        "contention" -> RetailClaimStop.CONTENTION
        "not-armed", "busy" -> RetailClaimStop.BUSY
        else -> RetailClaimStop.NO_PRESS
    }

    private fun stopForRefusal(r: String): RetailClaimStop = when (r) {
        "no-grant", "window-closed" -> RetailClaimStop.WINDOW_CLOSED
        "recipe-invalid", "recipe-expired" -> RetailClaimStop.RECIPE_REFUSED
        "already-claimed" -> RetailClaimStop.ALREADY_CLAIMED
        "entropy" -> RetailClaimStop.ENTROPY
        else -> RetailClaimStop.OUT_OF_ORDER
    }

    private suspend fun press(gen: Int) {
        val armSentAt = deps.now()
        send(BoxClaim.PhoneMessage.Arm)
        if (mode == BoxClaim.Mode.CODE) {
            val r = next(deps.answerTimeoutMs)
            if (r == null) { if (gen == generation) stop(RetailClaimStop.LINK_LOST); return }
            when (val m = r.first) {
                is BoxClaim.BoxMessage.Armed -> {
                    val r2 = next(deps.answerTimeoutMs)?.first
                    if (r2 is BoxClaim.BoxMessage.PressResult && r2.ok) return claim(gen)
                    stopForCodeArm(r2, gen)
                }
                is BoxClaim.BoxMessage.PressResult -> if (m.ok) return claim(gen) else stop(stopForPress(m.reason))
                else -> stopForCodeArm(m, gen)
            }
            return
        }
        _phase.value = Phase.GetReady
        deps.sleepMs(deps.pauseMs())
        if (gen != generation) return
        val instructionAt = deps.now()
        _phase.value = Phase.PressNow
        val deadline = armSentAt + BoxClaim.PRESS_WINDOW_MS + BoxClaim.POWER_KEY_BURST_END_MS + 5_000
        var pressed = false
        while (gen == generation) {
            val r = next(deadline - deps.now())
            if (r == null) {
                if (gen == generation) stop(if (linkDead) RetailClaimStop.LINK_LOST else RetailClaimStop.NO_PRESS)
                return
            }
            when (val m = r.first) {
                is BoxClaim.BoxMessage.Armed -> continue
                is BoxClaim.BoxMessage.Press -> when (BoxClaim.judgePressReport(armSentAt, instructionAt, m.atMs, m.count, m.long, r.second)) {
                    BoxClaim.PressVerdict.OK -> pressed = true
                    BoxClaim.PressVerdict.EARLY -> { stop(RetailClaimStop.EARLY); return }
                    BoxClaim.PressVerdict.LATE -> { stop(RetailClaimStop.LATE); return }
                    BoxClaim.PressVerdict.BURST -> { stop(RetailClaimStop.BURST); return }
                }
                is BoxClaim.BoxMessage.PressResult -> {
                    if (m.ok && pressed) return claim(gen)
                    if (m.ok) { stop(RetailClaimStop.EARLY); return }
                    stop(stopForPress(m.reason))
                    return
                }
                is BoxClaim.BoxMessage.Refused -> { stop(stopForRefusal(m.reason)); return }
                else -> { stop(RetailClaimStop.OUT_OF_ORDER); return }
            }
        }
    }

    private fun stopForCodeArm(m: BoxClaim.BoxMessage?, gen: Int) {
        if (gen != generation) return
        when (m) {
            null -> stop(RetailClaimStop.LINK_LOST)
            is BoxClaim.BoxMessage.PressResult -> stop(stopForPress(m.reason))
            is BoxClaim.BoxMessage.Refused -> stop(stopForRefusal(m.reason))
            else -> stop(RetailClaimStop.OUT_OF_ORDER)
        }
    }

    private suspend fun claim(gen: Int) {
        val ch = channel ?: return
        _phase.value = Phase.Signing
        val m = try {
            deps.mintRecipe()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            if (gen == generation) {
                if (e is AddServerRefused || (e as? RetailClaimKeyException)?.kind == RetailClaimKeyException.Kind.NOT_ADMIN) {
                    stop(RetailClaimStop.NOT_ADMIN)
                } else {
                    abortQuietly()
                    _phase.value = Phase.Failed(UserErrorText.reason(e))
                }
            }
            return
        }
        if (gen != generation) { m.signer.discard(); return }
        minted = m
        send(BoxClaim.PhoneMessage.Claim(m.json))
        val r = next(deps.answerTimeoutMs * 2)
        if (r == null) { if (gen == generation) stop(RetailClaimStop.LINK_LOST); return }
        val wire = when (val msg = r.first) {
            is BoxClaim.BoxMessage.Receipt -> msg.receipt
            is BoxClaim.BoxMessage.Refused -> { stop(stopForRefusal(msg.reason)); return }
            else -> { stop(RetailClaimStop.OUT_OF_ORDER); return }
        }
        val rc = try {
            BoxClaim.verifyReceipt(wire, ch.transcriptHex, mode, m.serverDomain, m.serial)
        } catch (_: Throwable) {
            stop(RetailClaimStop.BAD_RECEIPT)
            return
        }
        receipt = rc
        deps.pinStk(m.serverDomain, rc.stkPubHex)
        _phase.value = Phase.RegisteringKey
        try {
            val key = BoxClaim.ClaimKey(deps.username, m.serial, m.serverDomain, rc.stkPubHex.lowercase(), deps.now())
            val signature = try { m.signer.sign(key.canonical) } finally { m.signer.discard() }
            deps.registerKey(key, signature)
        } catch (e: CancellationException) {
            throw e
        } catch (e: RetailClaimKeyException) {
            if (gen != generation) return
            when (e.kind) {
                RetailClaimKeyException.Kind.TAKEN -> stop(RetailClaimStop.KEY_TAKEN)
                RetailClaimKeyException.Kind.NOT_ADMIN -> stop(RetailClaimStop.NOT_ADMIN)
                RetailClaimKeyException.Kind.SIGNER_GONE -> { abortQuietly(); _phase.value = Phase.Failed(UserErrorText.reason(e)) }
            }
            return
        } catch (e: Throwable) {
            if (gen == generation) { abortQuietly(); _phase.value = Phase.Failed(UserErrorText.reason(e)) }
            return
        }
        if (gen != generation) return
        deps.onClaimed(m.serverDomain, m.serial)
        deps.radio.stopScan()
        if (mode == BoxClaim.Mode.CODE) useCable() else _phase.value = Phase.ChooseNetwork
    }

    private fun listenForWifiList(gen: Int) {
        launch {
            while (gen == generation) {
                val r = next(30_000)
                if (r == null) {
                    if (gen == generation && _phase.value == Phase.ScanningWifi) _phase.value = Phase.WifiList(emptyList())
                    return@launch
                }
                val m = r.first
                if (m is BoxClaim.BoxMessage.WifiList) {
                    _phase.value = Phase.WifiList(m.networks.sortedByDescending { it.signal })
                    return@launch
                }
            }
        }
    }

    private fun listenForNetwork(gen: Int) {
        launch {
            while (gen == generation) {
                val r = next(120_000)
                if (r == null) {
                    if (gen == generation && _phase.value == Phase.ConnectingNetwork) _phase.value = Phase.NetworkFailed("relay-unreachable")
                    return@launch
                }
                when (val m = r.first) {
                    is BoxClaim.BoxMessage.NetworkStatus -> when {
                        m.stage == "connecting" -> continue
                        m.stage == "online" -> { internetCheck(gen); return@launch }
                        m.failure != null -> { _phase.value = Phase.NetworkFailed(m.failure); return@launch }
                        else -> continue
                    }
                    is BoxClaim.BoxMessage.Refused -> { stop(stopForRefusal(m.reason)); return@launch }
                    else -> continue
                }
            }
        }
    }

    private fun raiseAlarm(alarm: RetailClaimAlarm, serverDomain: String, stk: String?) {
        if (alarm == RetailClaimAlarm.KEY_MISMATCH) deps.markUntrusted(serverDomain)
        alarmStk = stk
        _phase.value = Phase.Alarm(alarm, serverDomain)
    }

    private suspend fun internetCheck(gen: Int) {
        val m = minted ?: return
        val rc = receipt ?: return
        _phase.value = Phase.CheckingInternet(m.serverDomain)
        link?.close()
        val want = rc.stkPubHex.lowercase()
        val deadline = deps.now() + deps.onlineTimeoutMs
        while (gen == generation) {
            val stk = deps.registeredStk(m.serverDomain)?.lowercase()
            if (stk != null) {
                if (gen != generation) return
                if (stk != want) { raiseAlarm(RetailClaimAlarm.KEY_MISMATCH, m.serverDomain, stk); return }
                break
            }
            if (deps.now() >= deadline) {
                if (gen == generation) raiseAlarm(RetailClaimAlarm.NEVER_ONLINE, m.serverDomain, null)
                return
            }
            deps.sleepMs(deps.pollMs)
        }
        if (gen != generation) return
        waitForCertificate(m.serverDomain, want, gen)
    }

    /** "Done" only once the box serves a certificate that the pinned key vouched for: a null check
     *  means no certificate yet and keeps waiting, a false one is the alarm. */
    private suspend fun waitForCertificate(domain: String, want: String, gen: Int) {
        _phase.value = Phase.GettingCertificate(domain)
        val start = deps.now()
        while (gen == generation) {
            val stk = deps.registeredStk(domain)?.lowercase()
            if (stk != null && stk != want) {
                if (gen == generation) raiseAlarm(RetailClaimAlarm.KEY_MISMATCH, domain, stk)
                return
            }
            when (deps.tlsCheck(domain)) {
                false -> { if (gen == generation) raiseAlarm(RetailClaimAlarm.KEY_MISMATCH, domain, null); return }
                true -> { if (gen == generation) _phase.value = Phase.Done(domain); return }
                null -> Unit
            }
            if (gen != generation) return
            val waited = deps.now() - start
            if (waited >= deps.certificateSlowMs && _phase.value == Phase.GettingCertificate(domain)) {
                _phase.value = Phase.CertificateSlow(domain)
            }
            if (waited >= deps.certificateGiveUpMs) return
            deps.sleepMs(deps.pollMs)
        }
    }
}
