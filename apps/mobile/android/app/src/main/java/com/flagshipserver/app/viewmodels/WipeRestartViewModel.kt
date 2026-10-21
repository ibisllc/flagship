// E4 — Kotlin mirror of FlagshipUI's WipeRestartViewModel. Rotates
// UMK + IRK + recovery passkey + push token in one atomic ceremony.
// See WipeRestartViewModel.swift for the canonical commentary.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.core.UserErrorText
import androidx.lifecycle.ViewModel
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.WipeRestartRequest
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.WipeRestartClaim
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.Recovery
import com.flagshipserver.app.keystore.WebAuthnProvider
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Hkdf
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.security.MessageDigest
import java.security.SecureRandom

sealed interface WipeRestartPhase {
    data object Idle : WipeRestartPhase
    data object PreparingKeys : WipeRestartPhase
    data object RegisteringPasskey : WipeRestartPhase
    data object WrappingNewUmk : WipeRestartPhase
    data object Signing : WipeRestartPhase
    data object Posting : WipeRestartPhase
    data object InstallingLocally : WipeRestartPhase
    data object Completed : WipeRestartPhase
    data class Failed(val message: String) : WipeRestartPhase
}

class WipeRestartViewModel(
    private val server: FlagshipServerClient,
    // No default: the new UMK must be wrapped under a REAL platform passkey.
    // A mock PRF uploads an envelope cloud recovery can never unwrap, so
    // every caller has to choose the provider explicitly.
    private val webAuthn: WebAuthnProvider,
    private val username: () -> String?,
    private val rng: SecureRandom = SecureRandom(),
) : ViewModel() {
    private val _phase = MutableStateFlow<WipeRestartPhase>(WipeRestartPhase.Idle)
    val phase: StateFlow<WipeRestartPhase> = _phase.asStateFlow()

    suspend fun run(currentEtag: String?) {
        val user = username()
        if (user.isNullOrEmpty()) {
            _phase.value = WipeRestartPhase.Failed(FSStrings.get(R.string.no_active_account_on_this_device))
            return
        }
        _phase.value = WipeRestartPhase.PreparingKeys

        // 1 — Read OLD UMK + derive OLD IRK while the existing
        // identity is still active.
        val oldUmk: ByteArray
        val oldIrkSign: Ed25519Sign
        val oldIrkPubHex: String
        try {
            oldUmk = Keystore.currentUmkSeed()
            oldIrkSign = Keystore.deriveIRK(FSStrings.get(R.string.authorize_wipe), version = Keystore.currentIrkVersion())
            // We need the OLD IRK pub for the canonical-bytes claim.
            // Re-derive via the cached seed slot.
            val oldSeed = Keystore.requireIrkSeedForVersion(Keystore.currentIrkVersion())
            val pair = Ed25519Sign.KeyPair.newKeyPairFromSeed(oldSeed)
            oldIrkPubHex = HexUtil.encode(pair.publicKey)
        } catch (e: Throwable) {
            _phase.value = WipeRestartPhase.Failed(FSStrings.get(R.string.couldnt_access_your_current_key, UserErrorText.reason(e)))
            return
        }

        // 2 — Fresh UMK + passkey register.
        val newUmk = ByteArray(32).also(rng::nextBytes)
        _phase.value = WipeRestartPhase.RegisteringPasskey
        val credentialId: String
        try {
            credentialId = webAuthn.register()
        } catch (e: Throwable) {
            _phase.value = WipeRestartPhase.Failed(FSStrings.get(R.string.passkey_registration_failed, e.message))
            return
        }
        val prfSecret: ByteArray
        try {
            prfSecret = webAuthn.prfAssert(credentialId)
        } catch (e: Throwable) {
            _phase.value = WipeRestartPhase.Failed(FSStrings.get(R.string.prf_assertion_failed, e.message))
            return
        }

        // 3 — Wrap NEW UMK under PRF secret. Recovery.wrap returns ONE
        // self-contained blob (nonce ‖ ct ‖ tag) — exactly what the Worker
        // base64-decodes and hashes.
        _phase.value = WipeRestartPhase.WrappingNewUmk
        val newWrappedUmkB64 = Recovery.wrap(newUmk, prfSecret)
        val wrappedHashHex = sha256Hex(java.util.Base64.getDecoder().decode(newWrappedUmkB64))

        // 4 — Derive NEW IRK pub from NEW UMK at v1.
        _phase.value = WipeRestartPhase.Signing
        val newIrkSeed = Hkdf.computeHkdf(
            /* macAlgorithm = */ "HMACSHA256",
            /* ikm = */ newUmk,
            /* salt = */ "flagship/irk/v1".toByteArray(),
            /* info = */ "ed25519-seed".toByteArray(),
            /* size = */ 32,
        )
        val newPair = Ed25519Sign.KeyPair.newKeyPairFromSeed(newIrkSeed)
        val newIrkPubHex = HexUtil.encode(newPair.publicKey)
        val issuedAt = System.currentTimeMillis()
        val canonical = WipeRestartClaim.canonicalBytes(
            username = user,
            oldIrkPubHex = oldIrkPubHex,
            newIrkPubHex = newIrkPubHex,
            newCredentialIdHex = credentialId,
            newWrappedUmkHashHex = wrappedHashHex,
            issuedAt = issuedAt,
        )
        val signature = oldIrkSign.sign(canonical)

        // 5 — POST.
        _phase.value = WipeRestartPhase.Posting
        val idempotencyKey = randomIdempotencyKey()
        try {
            server.wipeRestart(
                username = user,
                body = WipeRestartRequest(
                    request = WipeRestartRequest.Inner(
                        username = user,
                        oldIrkPub = oldIrkPubHex,
                        newIrkPub = newIrkPubHex,
                        newCredentialId = credentialId,
                        newWrappedUmk = newWrappedUmkB64,
                        issuedAt = issuedAt,
                    ),
                    signature = HexUtil.encode(signature),
                    idempotencyKey = idempotencyKey,
                ),
                ifMatch = currentEtag,
            )
        } catch (e: Throwable) {
            val msg = e.message.orEmpty()
            val friendly = when {
                msg.contains("412") -> FSStrings.get(R.string.your_device_list_changed_in_the)
                msg.contains("429") -> FSStrings.get(R.string.wipe_rate_limited_1_per_hour)
                msg.contains("409") -> FSStrings.get(R.string.another_rotation_completed_first_your)
                else -> FSStrings.get(R.string.couldnt_reach_the_server, msg)
            }
            _phase.value = WipeRestartPhase.Failed(friendly)
            return
        }

        // 6 — Atomic local install.
        _phase.value = WipeRestartPhase.InstallingLocally
        try {
            Keystore.installUmk(newUmk)
            // Drop our push token — it's bound to an identity that
            // no longer exists on .com.
            Keystore.setPushTokenId(null)
            // The account key was just replaced — drop any watch-delegate key
            // (the new IRK won't attest the old delegate, so .com already
            // stops honoring it; this clears the orphaned local key).
            Keystore.clearWatchDelegate()
        } catch (e: Throwable) {
            _phase.value = WipeRestartPhase.Failed(
                FSStrings.get(R.string.server_committed_but_local_install_failed, e.message),
            )
            return
        }
        _phase.value = WipeRestartPhase.Completed
    }

    private fun sha256Hex(data: ByteArray): String {
        val md = MessageDigest.getInstance("SHA-256")
        val h = md.digest(data)
        return h.joinToString("") { "%02x".format(it) }
    }

    private fun randomIdempotencyKey(): String {
        val bytes = ByteArray(16).also(rng::nextBytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
