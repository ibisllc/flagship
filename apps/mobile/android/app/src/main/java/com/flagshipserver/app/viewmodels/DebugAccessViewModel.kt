// Owner debug access on the server page (docs/recipe-delivery-and-remote-install.md
// "Debug access"): an admin device signs a flagship/debug-access/v2 grant for
// a pasted SSH key and a duration, or a flagship/debug-access-revoke/v1, and
// posts it to the box. Other devices see the state only. Mirrors the webapp
// and iOS server-page control.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.DebugAccessView
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.core.Variant
import com.flagshipserver.app.api.boxError
import com.flagshipserver.app.api.userFacing
import com.flagshipserver.app.core.DebugAccess
import com.flagshipserver.app.keystore.BiometricAuthority
import com.flagshipserver.app.keystore.BiometricCancelled
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class DebugAccessViewModel(
    private val serverDomain: String,
    private val client: ScreensClient,
    initial: DebugAccessView?,
    /** Only a device holding the admin root may sign (owner rule: admin-only). */
    private val isAdminDevice: () -> Boolean = { Variant.forceAdminRoot || Keystore.hasAdminRoot() },
    /** A biometric that runs for EVERY grant, even in an unlocked session (one per grant, like an admin invite). */
    private val confirmGrant: suspend (reason: String) -> Unit = { r -> BiometricAuthority.confirmNow(r) },
    /** The admin root (the IRK on an account that pins none), read after [confirmGrant]: the session is fresh, so no second prompt. */
    private val adminKey: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminRootSeed()?.let { Ed25519Sign(it) } ?: Keystore.adminSigningKey(r) },
    /** Turning off may ride the unlocked session. */
    private val revokeSigner: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {

    data class State(
        val view: DebugAccessView?,
        val busy: Boolean = false,
        val error: String? = null,
        val notice: String? = null,
    )

    private val _state = MutableStateFlow(State(view = initial))
    val state: StateFlow<State> = _state.asStateFlow()

    val canChange: Boolean get() = isAdminDevice()

    /** The server-detail reload carries the box's latest state. */
    fun reconcile(view: DebugAccessView?) {
        if (!_state.value.busy) _state.value = _state.value.copy(view = view)
    }

    /** Whether the box has debug access on right now (its end hasn't passed). */
    fun isOn(at: Long = now()): Boolean {
        val v = _state.value.view ?: return false
        return v.on && (v.expiresAt ?: 0L) > at
    }

    /** Turn on, or renew (the same grant, newer), for [keyText] and [duration]. */
    suspend fun turnOn(keyText: String, duration: DebugAccess.Duration): Boolean {
        if (!isAdminDevice()) return fail(DebugAccess.ADMIN_ONLY)
        val key = DebugAccess.normalizeSshPublicKey(keyText)
            ?: return fail(if (keyText.isBlank()) "Debug access needs an SSH public key." else "That isn't an SSH public key this server can use.")
        val issuedAt = now()
        val grant = DebugAccess.Grant(serverDomain, key, issuedAt, issuedAt + duration.ms)
        DebugAccess.grantProblem(grant)?.let { return fail(it) }
        val wasOn = isOn()
        _state.value = _state.value.copy(busy = true, error = null, notice = null)
        return try {
            confirmGrant(if (wasOn) "Renew debug access on $serverDomain" else "Turn on debug access on $serverDomain")
            val sig = DebugAccess.sign(grant, adminKey("Turn on debug access on $serverDomain"))
            val r = client.debugAccessGrant(DebugAccess.envelopeJson(grant, sig))
            _state.value = State(
                view = r.debugAccess ?: DebugAccessView(true, grant.expiresAt, DebugAccess.fingerprint(key), "admin"),
                notice = if (r.change == "renewed") "Debug access renewed." else "Debug access is on.",
            )
            true
        } catch (t: Throwable) {
            fail(t.sentence())
        }
    }

    suspend fun turnOff(): Boolean {
        if (!isAdminDevice()) return fail(DebugAccess.ADMIN_ONLY)
        _state.value = _state.value.copy(busy = true, error = null, notice = null)
        return try {
            val revoke = DebugAccess.Revoke(serverDomain, now())
            val sig = DebugAccess.signRevoke(revoke, revokeSigner("Turn off debug access on $serverDomain"))
            val r = client.debugAccessRevoke(DebugAccess.revokeJson(revoke, sig))
            _state.value = State(view = r.debugAccess ?: DebugAccessView(on = false), notice = "Debug access is off.")
            true
        } catch (t: Throwable) {
            fail(t.sentence())
        }
    }

    private fun Throwable.sentence(): String =
        when {
            this is BiometricCancelled -> "Debug access not changed: you didn't confirm it."
            this is IllegalStateException && message == "Open Flagship to confirm this." -> message!!
            else -> boxError() ?: userFacing()
        }

    private fun fail(message: String): Boolean {
        _state.value = _state.value.copy(busy = false, error = message, notice = null)
        return false
    }
}
