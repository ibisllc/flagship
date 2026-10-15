// Kotlin mirror of FlagshipUI's WatchDelegateViewModel. Drives the "Quick
// approve from watch" toggle (docs/watch-delegate-key-design.md §4).
//
// ON  → mint a device delegate key (no biometric gate), IRK-attest it (one
//       biometric prompt), register the WatchDelegateKey with .com.
// OFF → IRK-sign a RevokeWatchDelegate, POST it, clear the local key.
//
// Default-OFF. The IRK stays fully biometric-gated; only this separate,
// boot-approval-only key is minted without the biometric gate so a later
// watch-driven boot approval is silent.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.WatchDelegateMintRequest
import com.flagshipserver.app.api.WatchDelegateRevokeRequest
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.RevokeWatchDelegate
import com.flagshipserver.app.core.WatchDelegateKey
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.UUID

sealed interface WatchDelegatePhase {
    data object Idle : WatchDelegatePhase
    data object Loading : WatchDelegatePhase
    data object Enabling : WatchDelegatePhase
    data object Disabling : WatchDelegatePhase
    data class Failed(val message: String) : WatchDelegatePhase
}

class WatchDelegateViewModel(
    private val server: FlagshipServerClient,
    private val username: () -> String?,
    /** Pluggable for tests; default uses the Keystore-backed IRK (biometric). */
    // Slice D — minting/revoking a watch delegate grant is SENSITIVE
    // (watchDelegates.ts gates it on the admin master root): sign with the admin
    // root when held, else the owner IRK (legacy). Canonical bytes unchanged.
    private val signer: suspend (String) -> Ed25519Sign = { r -> Keystore.adminSigningKey(r) },
    /** Ensures the device delegate key exists + returns its pubkey hex. */
    private val provisionDelegatePubHex: () -> String = {
        Keystore.loadOrCreateWatchDelegateKey()
        Keystore.watchDelegatePubHex() ?: error("delegate key missing after create")
    },
    private val loadGrantId: () -> String? = { Keystore.watchDelegateGrantId() },
    /** null clears the local delegate entirely (key + grantId). */
    private val saveGrantId: (String?) -> Unit = { id ->
        if (id != null) Keystore.setWatchDelegateGrantId(id) else Keystore.clearWatchDelegate()
    },
    private val now: () -> Long = { System.currentTimeMillis() },
    private val grantIdGen: () -> String = { UUID.randomUUID().toString() },
) : ViewModel() {

    private val _phase = MutableStateFlow<WatchDelegatePhase>(WatchDelegatePhase.Idle)
    val phase: StateFlow<WatchDelegatePhase> = _phase.asStateFlow()

    private val _isEnabled = MutableStateFlow(false)
    val isEnabled: StateFlow<Boolean> = _isEnabled.asStateFlow()

    private val _expiresAt = MutableStateFlow<Long?>(null)
    val expiresAt: StateFlow<Long?> = _expiresAt.asStateFlow()

    companion object {
        /** 7-day default TTL, matching the design + the cloud convention. */
        const val DEFAULT_TTL_MS = 7L * 24 * 60 * 60 * 1000
    }

    /** Reconcile the toggle with the server's truth. The cloud lists only
     *  delegates that still verify under the current IRK, so a delegate
     *  orphaned by an IRK rotation reads back as off. */
    suspend fun load() {
        val user = username()
        if (user.isNullOrEmpty()) { _isEnabled.value = false; return }
        _phase.value = WatchDelegatePhase.Loading
        try {
            val list = server.listWatchDelegates(user)
            val active = list.delegates.firstOrNull { it.expiresAt > now() }
            _isEnabled.value = active != null
            _expiresAt.value = active?.expiresAt
        } catch (_: Throwable) {
            // A read failure leaves the last-known state.
        }
        _phase.value = WatchDelegatePhase.Idle
    }

    suspend fun enable() {
        val user = username()
        if (user.isNullOrEmpty()) {
            _phase.value = WatchDelegatePhase.Failed("No active account on this device.")
            return
        }
        _phase.value = WatchDelegatePhase.Enabling
        val pubHex: String
        try {
            pubHex = provisionDelegatePubHex()
        } catch (e: Throwable) {
            _phase.value = WatchDelegatePhase.Failed("Couldn't create the watch key: ${e.message}")
            return
        }
        val irk: Ed25519Sign
        try {
            irk = signer("Allow your watch to approve boots")
        } catch (e: Throwable) {
            _phase.value = WatchDelegatePhase.Failed("Couldn't access your account key: ${e.message}")
            return
        }
        val issuedAt = now()
        val expiresAt = issuedAt + DEFAULT_TTL_MS
        val grantId = grantIdGen()
        val scopes = listOf(WatchDelegateKey.BOOT_APPROVAL_SCOPE)
        val sig = WatchDelegateKey.sign(irk, grantId, user, pubHex, scopes, issuedAt, expiresAt)
        try {
            val res = server.mintWatchDelegate(
                user,
                WatchDelegateMintRequest(
                    grant = WatchDelegateMintRequest.Grant(
                        grantId = grantId,
                        username = user,
                        delegatePubKey = pubHex,
                        scopes = scopes,
                        issuedAt = issuedAt,
                        expiresAt = expiresAt,
                    ),
                    signature = HexUtil.encode(sig),
                ),
            )
            saveGrantId(res.grantId)
            _isEnabled.value = true
            _expiresAt.value = res.expiresAt
            _phase.value = WatchDelegatePhase.Idle
        } catch (e: HttpException) {
            _phase.value = WatchDelegatePhase.Failed("Server rejected the request (${e.status}): ${e.body}")
        } catch (e: Throwable) {
            _phase.value = WatchDelegatePhase.Failed("Couldn't reach the server: ${e.message}")
        }
    }

    suspend fun disable() {
        val user = username()
        if (user.isNullOrEmpty()) {
            _phase.value = WatchDelegatePhase.Failed("No active account on this device.")
            return
        }
        val grantId = loadGrantId()
        if (grantId == null) {
            // Nothing to target — treat as already-off + clear any local key.
            saveGrantId(null)
            _isEnabled.value = false
            _expiresAt.value = null
            _phase.value = WatchDelegatePhase.Idle
            return
        }
        _phase.value = WatchDelegatePhase.Disabling
        val irk: Ed25519Sign
        try {
            irk = signer("Stop allowing your watch to approve boots")
        } catch (e: Throwable) {
            _phase.value = WatchDelegatePhase.Failed("Couldn't access your account key: ${e.message}")
            return
        }
        val issuedAt = now()
        val sig = RevokeWatchDelegate.sign(irk, grantId, user, issuedAt)
        try {
            server.revokeWatchDelegate(
                user,
                WatchDelegateRevokeRequest(
                    request = WatchDelegateRevokeRequest.Inner(grantId, user, issuedAt),
                    signature = HexUtil.encode(sig),
                ),
            )
        } catch (_: Throwable) {
            // Even on failure, clear the local key — the server's list
            // re-verify + TTL are the backstops.
        }
        saveGrantId(null)
        _isEnabled.value = false
        _expiresAt.value = null
        _phase.value = WatchDelegatePhase.Idle
    }
}
