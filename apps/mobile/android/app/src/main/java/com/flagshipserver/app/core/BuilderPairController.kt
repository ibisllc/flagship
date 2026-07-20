package com.flagshipserver.app.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Drives a phone↔builder pairing session and delivers a freshly-minted
 * recipe — a ONE-SHOT deposit. Kotlin mirror of the iOS BuilderPairViewModel:
 * parse the scanned QR / typed code → connect → learn the builder pubkey →
 * derive the SAS → (user confirms) → mint + seal + deliver over the live
 * session. Minting is injected (`mint`) so this stays unit-testable; the screen
 * wires it to the create-server minter (byte-identical recipe to share/copy),
 * with any Advanced toggles (embed-secrets, debug-friendly) already baked in.
 *
 * ONE-SHOT: once the builder acknowledges the staged recipe, the phone has no
 * further role. Both peers close immediately after that receipt.
 *
 * The 600ms anti-double-tap gate on the confirm button is a UI concern
 * (the screen disables the button) — this controller proceeds on confirm
 * whenever it's in Matching.
 */
class BuilderPairController(
    private val client: BuilderPairClient,
    private val scope: CoroutineScope,
    /** Produces the on-wire recipe JSON + its server domain + serial. */
    private val mint: suspend () -> MintedRecipe,
) {
    data class MintedRecipe(val json: String, val serverDomain: String, val serial: String)

    sealed interface Phase {
        data object Scan : Phase
        data object EnterCode : Phase
        data object Connecting : Phase
        data class Matching(val matchCode: String) : Phase
        data object Delivering : Phase
        data class Delivered(val serverDomain: String) : Phase
        data class Failed(val message: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Scan)
    val phase: StateFlow<Phase> = _phase

    var lastDeliveredSerial: String? = null
        private set

    private var session: QrSession? = null
    private var builderPub: ByteArray? = null
    private var sessionId: String? = null
    private var deliveredDomain: String? = null
    private var helloSent = false
    private var consumeJob: Job? = null
    private var reconnectJob: Job? = null
    private var receiptTimeoutJob: Job? = null
    private var reconnectAttempts = 0

    fun switchToEnterCode() { _phase.value = Phase.EnterCode }
    fun switchToScan() { _phase.value = Phase.Scan }

    /** Begin a session from a scanned QR or a typed short code. */
    suspend fun begin(raw: String) {
        if (consumeJob != null) return
        _phase.value = Phase.Connecting
        val scanned = BuilderPairing.parse(raw)
        if (scanned == null) { _phase.value = Phase.Failed("That code isn't valid."); return }
        val sid = BuilderPairing.sessionId(scanned.codeBytes)
        sessionId = sid
        builderPub = scanned.builderPublicKey
        session = QrSession.fresh()
        openStream(sid)
    }

    private suspend fun openStream(sid: String) {
        consumeJob?.cancel()
        helloSent = false
        val ch = client.connect(sid)
        consumeJob = scope.launch { for (ev in ch) onInbound(ev) }
    }

    /** Handle one inbound relay event (also called directly by tests). */
    suspend fun onInbound(ev: BuilderInbound) {
        // ONE-SHOT: once the recipe is delivered the phone has no further role.
        // Ignore any later peer-gone / expired / error — the builder keeps the
        // recipe and the laptop user disconnects on the builder side.
        if (_phase.value is Phase.Delivered) return
        when (ev) {
            is BuilderInbound.Accepted -> {
                reconnectAttempts = 0
                deriveAndHello()
            }
            is BuilderInbound.PeerPresent, is BuilderInbound.PeerJoined -> deriveAndHello()
            is BuilderInbound.BuilderHello -> {
                if (builderPub == null) builderPub = Base64URL.decode(ev.builderPkB64)
                deriveAndHello()
            }
            is BuilderInbound.RecipeAccepted -> {
                val domain = deliveredDomain ?: return
                if (_phase.value !is Phase.Delivering) return
                receiptTimeoutJob?.cancel()
                receiptTimeoutJob = null
                _phase.value = Phase.Delivered(domain)
                consumeJob?.cancel()
                consumeJob = null
                client.close()
            }
            is BuilderInbound.ConsentRequest -> { /* no debug-consent round-trip in the one-shot model */ }
            is BuilderInbound.PeerGone -> fail("The computer's builder app disconnected.")
            is BuilderInbound.Expired -> fail("The pairing session timed out.")
            is BuilderInbound.RelayError -> handleConnectionLoss(ev.message)
            is BuilderInbound.Pong -> { /* liveness */ }
        }
    }

    private suspend fun deriveAndHello() {
        if (helloSent) return
        val pub = builderPub ?: return
        val s = session ?: return
        val code = s.pair(pub)
        helloSent = true
        client.send(BuilderOutbound.PhoneHello(Base64URL.encode(s.phonePubKey)))
        _phase.value = Phase.Matching(code)
    }

    /** The user confirmed the SAS matches: unlock the builder, mint, deliver.
     *  The phone is done only after the builder's acceptance receipt. */
    suspend fun confirmAndDeliver() {
        val s = session ?: return
        if (_phase.value !is Phase.Matching) return
        client.send(BuilderOutbound.ConfirmPairing)
        _phase.value = Phase.Delivering
        try {
            val minted = mint()
            lastDeliveredSerial = minted.serial
            deliveredDomain = minted.serverDomain
            val sealed = s.seal(minted.json.toByteArray())
            client.send(BuilderOutbound.Deliver(sealed.ciphertextB64u, sealed.nonceB64u))
            receiptTimeoutJob?.cancel()
            receiptTimeoutJob = scope.launch {
                delay(20_000)
                if (_phase.value is Phase.Delivering) {
                    fail("The builder saved the recipe but didn't confirm receipt. Update or reopen the builder and try again.")
                }
            }
        } catch (t: Throwable) {
            fail(t.message ?: "Delivery failed.")
        }
    }

    fun cancel() {
        reconnectJob?.cancel()
        reconnectJob = null
        receiptTimeoutJob?.cancel()
        receiptTimeoutJob = null
        consumeJob?.cancel()
        consumeJob = null
        client.close()
        _phase.value = Phase.Scan
    }

    private fun handleConnectionLoss(message: String) {
        if (_phase.value !is Phase.Connecting && _phase.value !is Phase.Matching) {
            fail(message)
            return
        }
        val sid = sessionId
        if (sid == null || reconnectAttempts >= 3) {
            fail(message)
            return
        }
        reconnectAttempts += 1
        _phase.value = Phase.Connecting
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(reconnectAttempts * 300L)
            runCatching { openStream(sid) }
                .onFailure { handleConnectionLoss(it.message ?: message) }
        }
    }

    private fun fail(message: String) {
        reconnectJob?.cancel()
        reconnectJob = null
        receiptTimeoutJob?.cancel()
        receiptTimeoutJob = null
        consumeJob?.cancel()
        consumeJob = null
        client.close()
        _phase.value = Phase.Failed(message)
    }
}
