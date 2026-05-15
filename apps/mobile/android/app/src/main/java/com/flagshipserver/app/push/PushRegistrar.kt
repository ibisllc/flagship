// Pairs the OS-supplied FCM device token with the user's IRK + a
// per-device X25519 push key and POSTs the result to .com so the
// Worker has somewhere to relay encrypted push payloads.
//
// MIRRORS: apps/mobile/ios/Sources/FlagshipUI/Push/PushRegistrar.swift
// Canonical-bytes layout is identical to the verifier in
// packages/protocol/src/auth.ts ("flagship/push-token-register/v1|...")
// so the Worker's verifyPushTokenRegister accepts both clients.

package com.flagshipserver.app.push

import android.os.Build
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.PushTokenRegisterRequest
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.PushTokenRegister
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
            val label = sanitizeLabel(deviceLabel())
            val canonical = PushTokenRegister.canonicalBytes(
                username = username,
                platform = "fcm",
                providerToken = fcmToken,
                pushX25519PubHex = pushPubHex,
                label = label,
                issuedAt = issuedAt,
            )
            val signature = HexUtil.encode(irk.sign(canonical))
            val req = PushTokenRegisterRequest(
                request = PushTokenRegisterRequest.Inner(
                    username = username,
                    platform = "fcm",
                    providerToken = fcmToken,
                    pushX25519Pub = pushPubHex,
                    label = label,
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

    /** Default device label = "<Manufacturer> <Model>" (e.g.
     *  "Google Pixel 8"). Android doesn't expose UIDevice.current.name
     *  equivalent; an editable nickname can layer later. Visible to
     *  tests via `internal`. */
    internal fun deviceLabel(): String {
        val manufacturer = (Build.MANUFACTURER ?: "").trim().replaceFirstChar { it.titlecase() }
        val model = (Build.MODEL ?: "").trim()
        return when {
            manufacturer.isEmpty() && model.isEmpty() -> "Android"
            model.startsWith(manufacturer, ignoreCase = true) || manufacturer.isEmpty() -> model
            else -> "$manufacturer $model"
        }
    }

    /** Length-cap + strip control characters to match the Worker's
     *  validation (control-plane/src/push.ts caps at 64 bytes + rejects
     *  0x00-0x1f + 0x7f). Internal so unit tests can exercise the
     *  contract without a CredentialManager round-trip. */
    internal companion object {
        fun sanitizeLabel(raw: String): String {
            val stripped = buildString(raw.length) {
                for (c in raw) {
                    val v = c.code
                    if (v >= 0x20 && v != 0x7f) append(c)
                }
            }.trim()
            // Truncate by UTF-8 bytes — not chars — since the server
            // caps bytes. Step back until under the 64-byte budget.
            var out = stripped
            while (out.toByteArray(Charsets.UTF_8).size > 64 && out.isNotEmpty()) {
                out = out.dropLast(1)
            }
            return out
        }
    }

    /** Drop the last-registered push token on .com + wipe the persisted
     *  tokenId. Tolerates network failure (sign-out shouldn't depend on
     *  the device being online). */
    suspend fun revoke() {
        val tokenId = Keystore.pushTokenId() ?: return
        try {
            client.revokePushToken(tokenId)
        } catch (t: Throwable) {
            _lastError.value = t
        }
        Keystore.setPushTokenId(null)
        _lastRegisteredTokenId.value = null
    }
}
