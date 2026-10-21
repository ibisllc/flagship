// "Claim your .com name" — the dibs flow (docs/naming-recovery-and-name-change.md §7).
// Kotlin mirror of iOS NameDibsViewModel.swift.
//
// While the one-year window is open, a name matching a registered .com is held
// for whoever controls that domain. Load the window, start a claim (IRK-signed),
// show where to publish the record, then check (IRK-signed). Re-starting a
// pending claim returns the same record, so leaving the screen while DNS
// propagates is safe.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.DibsClaim
import com.flagshipserver.app.api.DibsInitiateBody
import com.flagshipserver.app.api.DibsInitiateRequest
import com.flagshipserver.app.api.DibsVerifyBody
import com.flagshipserver.app.api.DibsVerifyRequest
import com.flagshipserver.app.api.DibsWindow
import com.flagshipserver.app.api.NameDibsClient
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.NameDibsInitiate
import com.flagshipserver.app.core.NameDibsVerify
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface NameDibsPhase {
    data object Loading : NameDibsPhase
    /** The window isn't open; [opensAt] is set when it's announced for the future. */
    data class Closed(val opensAt: Long?) : NameDibsPhase
    data class EnterName(val closesAt: Long?) : NameDibsPhase
    data object Working : NameDibsPhase
    data class Publish(val claim: DibsClaim) : NameDibsPhase
    data class Proven(val name: String) : NameDibsPhase
    data class Failed(val message: String) : NameDibsPhase
}

class NameDibsViewModel(
    private val client: NameDibsClient,
    username: String,
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
    private val irkPubHex: suspend () -> String = { Keystore.irkPubHex() },
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val username = username.lowercase()
    private val _phase = MutableStateFlow<NameDibsPhase>(NameDibsPhase.Loading)
    val phase: StateFlow<NameDibsPhase> = _phase.asStateFlow()
    private val _inlineError = MutableStateFlow<String?>(null)
    val inlineError: StateFlow<String?> = _inlineError.asStateFlow()
    private var claim: DibsClaim? = null
    private var lastWindow: DibsWindow? = null

    suspend fun load() {
        _phase.value = NameDibsPhase.Loading
        _phase.value = try {
            val w = client.window()
            lastWindow = w
            when {
                w.open -> NameDibsPhase.EnterName(w.end)
                w.configured && (w.start ?: 0) > now() -> NameDibsPhase.Closed(w.start)
                else -> NameDibsPhase.Closed(null)
            }
        } catch (e: Exception) {
            NameDibsPhase.Failed(e.message ?: "Couldn't load the dibs window")
        }
    }

    suspend fun start(raw: String) {
        val name = normalize(raw)
        if (name.isEmpty()) {
            _inlineError.value = "Enter a name."
            return
        }
        _inlineError.value = null
        val previous = _phase.value
        _phase.value = NameDibsPhase.Working
        try {
            val key = signer("Claim $name.com")
            val request = DibsInitiateRequest(username, name, irkPubHex().lowercase(), now())
            val sig = key.sign(NameDibsInitiate.canonicalBytes(request.username, request.name, request.irkPubHex, request.issuedAt))
            val c = client.initiate(DibsInitiateBody(request, HexUtil.encode(sig)))
            claim = c
            _phase.value = if (c.verified) NameDibsPhase.Proven(c.name) else NameDibsPhase.Publish(c)
        } catch (e: Exception) {
            _inlineError.value = e.message ?: "Couldn't start the claim"
            _phase.value = previous
        }
    }

    suspend fun check() {
        val c = claim ?: return
        _inlineError.value = null
        _phase.value = NameDibsPhase.Working
        try {
            val key = signer("Check ${c.name}.com")
            val request = DibsVerifyRequest(username, c.name, c.nonce, now())
            val sig = key.sign(NameDibsVerify.canonicalBytes(request.username, request.name, request.nonce, request.issuedAt))
            val r = client.verify(DibsVerifyBody(request, HexUtil.encode(sig)))
            _phase.value = if (r.verified) NameDibsPhase.Proven(r.name) else NameDibsPhase.Publish(c)
        } catch (e: Exception) {
            _inlineError.value = e.message ?: "Couldn't check the claim"
            _phase.value = NameDibsPhase.Publish(c)
        }
    }

    /** Back from the publish step to pick a different name. */
    fun restart() {
        claim = null
        _inlineError.value = null
        _phase.value = NameDibsPhase.EnterName(lastWindow?.end)
    }

    companion object {
        const val BANNER_DISMISS_KEY = "flagship.dibs.banner.dismissed.v1"

        /** "Acme.com " → "acme". */
        fun normalize(raw: String): String = raw.trim().lowercase().removeSuffix(".com")

        /** Show the Home notice iff the window is open and this device hasn't dismissed it. */
        fun shouldShowBanner(window: DibsWindow?, dismissed: Boolean): Boolean =
            (window?.open ?: false) && !dismissed
    }
}
