package com.flagshipserver.app.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Drives a phone↔burner pairing session and delivers a freshly-minted
 * recipe — a ONE-SHOT deposit. Kotlin mirror of the iOS BurnerPairViewModel:
 * parse the scanned QR / typed code → connect → learn the burner pubkey →
 * derive the SAS → (user confirms) → mint + seal + deliver over the live
 * session. Minting is injected (`mint`) so this stays unit-testable; the screen
 * wires it to the create-server minter (byte-identical recipe to share/copy),
 * with any Advanced toggles (embed-secrets, debug-friendly) already baked in.
 *
 * ONE-SHOT: once the recipe is delivered the phone has NO further role — it
 * shows "Sent ✓" and the user may lock/leave. There is no ongoing session, no
 * resume, no countdown, no debug-consent round-trip (the debug grant, if any,
 * is baked into the recipe at mint). The burner keeps the recipe and the
 * laptop user disconnects on the burner side; `peer-gone` ends the session.
 *
 * The 600ms anti-double-tap gate on the confirm button is a UI concern
 * (the screen disables the button) — this controller proceeds on confirm
 * whenever it's in Matching.
 */
class BurnerPairController(
    private val client: BurnerPairClient,
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
    private var burnerPub: ByteArray? = null
    private var helloSent = false
    private var consumeJob: Job? = null

    fun switchToEnterCode() { _phase.value = Phase.EnterCode }
    fun switchToScan() { _phase.value = Phase.Scan }

    /** Begin a session from a scanned QR or a typed short code. */
    suspend fun begin(raw: String) {
        if (consumeJob != null) return
        _phase.value = Phase.Connecting
        val scanned = BurnerPairing.parse(raw)
        if (scanned == null) { _phase.value = Phase.Failed("That code isn't valid."); return }
        val sid = BurnerPairing.sessionId(scanned.codeBytes)
        burnerPub = scanned.burnerPublicKey
        session = QrSession.fresh()
        val ch = client.connect(sid)
        consumeJob = scope.launch { for (ev in ch) onInbound(ev) }
        if (scanned.burnerPublicKey != null) deriveAndHello()
    }

    /** Handle one inbound relay event (also called directly by tests). */
    suspend fun onInbound(ev: BurnerInbound) {
        // ONE-SHOT: once the recipe is delivered the phone has no further role.
        // Ignore any later peer-gone / expired / error — the burner keeps the
        // recipe and the laptop user disconnects on the burner side.
        if (_phase.value is Phase.Delivered) return
        when (ev) {
            is BurnerInbound.PeerPresent, is BurnerInbound.PeerJoined -> deriveAndHello()
            is BurnerInbound.BurnerHello -> {
                if (burnerPub == null) burnerPub = Base64URL.decode(ev.burnerPkB64)
                deriveAndHello()
            }
            is BurnerInbound.ConsentRequest -> { /* no debug-consent round-trip in the one-shot model */ }
            is BurnerInbound.PeerGone -> fail("The computer's burner app disconnected.")
            is BurnerInbound.Expired -> fail("The pairing session timed out.")
            is BurnerInbound.RelayError -> fail(ev.message)
            is BurnerInbound.Pong -> { /* liveness */ }
        }
    }

    private suspend fun deriveAndHello() {
        if (helloSent) return
        val pub = burnerPub ?: return
        val s = session ?: return
        val code = s.pair(pub)
        helloSent = true
        client.send(BurnerOutbound.PhoneHello(Base64URL.encode(s.phonePubKey)))
        _phase.value = Phase.Matching(code)
    }

    /** The user confirmed the SAS matches: unlock the burner, mint, deliver.
     *  After delivery the phone is done (one-shot). */
    suspend fun confirmAndDeliver() {
        val s = session ?: return
        if (_phase.value !is Phase.Matching) return
        client.send(BurnerOutbound.ConfirmPairing)
        _phase.value = Phase.Delivering
        try {
            val minted = mint()
            lastDeliveredSerial = minted.serial
            val sealed = s.seal(minted.json.toByteArray())
            client.send(BurnerOutbound.Deliver(sealed.ciphertextB64u, sealed.nonceB64u))
            _phase.value = Phase.Delivered(minted.serverDomain)
        } catch (t: Throwable) {
            fail(t.message ?: "Delivery failed.")
        }
    }

    fun cancel() {
        consumeJob?.cancel()
        consumeJob = null
        client.close()
        _phase.value = Phase.Scan
    }

    private fun fail(message: String) {
        consumeJob?.cancel()
        consumeJob = null
        client.close()
        _phase.value = Phase.Failed(message)
    }
}
