// Pairs the OS-supplied FCM device token with the user's IRK + a
// per-device X25519 push key and POSTs the result to .com so the
// Worker has somewhere to relay encrypted push payloads.
//
// MIRRORS: apps/mobile/ios/Sources/FlagshipUI/Push/PushRegistrar.swift
// Canonical-bytes layout is identical to the verifier in
// packages/protocol/src/auth.ts ("flagship/push-token-register/v1|...")
// so the Worker's verifyPushTokenRegister accepts both clients.

package com.flagshipserver.app.push

import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.PushTokenRegisterRequest
import com.flagshipserver.app.api.PushTokenRevokeRequest
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.PushTokenRegister
import com.flagshipserver.app.core.PushTokenRevoke
import com.flagshipserver.app.keystore.Keystore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class PushRegistrar(
    private val appState: AppState,
    private val client: FlagshipServerClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val _lastRegisteredTokenId = MutableStateFlow<String?>(Keystore.pushTokenId())
    val lastRegisteredTokenId: StateFlow<String?> = _lastRegisteredTokenId.asStateFlow()

    private val _lastError = MutableStateFlow<Throwable?>(null)
    val lastError: StateFlow<Throwable?> = _lastError.asStateFlow()

    /** Called from FlagshipFcmService.onNewToken. The actual network
     *  call happens on the IO dispatcher; failures are swallowed and
     *  reported via lastError so the OS callback never blocks. */
    fun onNewToken(fcmToken: String?): Job = scope.launch {
        if (fcmToken.isNullOrEmpty()) return@launch  // OS revoked — leave the prior tokenId
        val username = appState.currentUser.value
        if (username.isNullOrEmpty()) return@launch  // pre-pairing
        try {
            val irk = Keystore.deriveIRK(reason = "Register push token with Flagship")
            val push = Keystore.loadOrCreatePushX25519()
            val pushPubHex = HexUtil.encode(push.publicKey)
            val issuedAt = System.currentTimeMillis()
            val deviceId = requireNotNull(appState.activeProfile?.deviceId?.takeIf { it.isNotEmpty() }) {
                "account-scoped device identity is not initialized"
            }
            val canonical = PushTokenRegister.canonicalBytes(
                username = username,
                deviceId = deviceId,
                platform = "fcm",
                providerToken = fcmToken,
                pushX25519PubHex = pushPubHex,
                issuedAt = issuedAt,
            )
            val signature = HexUtil.encode(irk.sign(canonical))
            val req = PushTokenRegisterRequest(
                request = PushTokenRegisterRequest.Inner(
                    username = username,
                    deviceId = deviceId,
                    platform = "fcm",
                    providerToken = fcmToken,
                    pushX25519Pub = pushPubHex,
                    issuedAt = issuedAt,
                ),
                signature = signature,
            )
            val resp = client.registerPushToken(req)
            Keystore.setPushTokenId(resp.tokenId)
            _lastRegisteredTokenId.value = resp.tokenId
            _lastError.value = null
        } catch (t: Throwable) {
            _lastError.value = t
        }
    }

    /** Drop the last-registered push token on .com + wipe the persisted
     *  tokenId. Tolerates network failure (sign-out shouldn't depend on
     *  the device being online). */
    suspend fun revoke() {
        val tokenId = Keystore.pushTokenId() ?: return
        try {
            // Revoke is now IRK-signed (SEC): .com verifies the envelope
            // against the token owner's registered IRK before deleting the
            // tether. Sign behind the biometric, exactly like register.
            val irk = Keystore.deriveIRK(reason = "Revoke push token from Flagship")
            val issuedAt = System.currentTimeMillis()
            val canonical = PushTokenRevoke.canonicalBytes(tokenId = tokenId, issuedAt = issuedAt)
            val signature = HexUtil.encode(irk.sign(canonical))
            client.revokePushToken(
                PushTokenRevokeRequest(
                    request = PushTokenRevokeRequest.Inner(tokenId = tokenId, issuedAt = issuedAt),
                    signature = signature,
                ),
            )
        } catch (t: Throwable) {
            _lastError.value = t
        }
        Keystore.setPushTokenId(null)
        _lastRegisteredTokenId.value = null
    }
}
