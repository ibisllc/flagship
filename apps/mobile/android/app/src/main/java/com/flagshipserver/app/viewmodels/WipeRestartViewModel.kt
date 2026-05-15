// E4 — Kotlin mirror of FlagshipUI's WipeRestartViewModel. Rotates
// UMK + IRK + recovery passkey + push token in one atomic ceremony.
// See WipeRestartViewModel.swift for the canonical commentary.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.WipeRestartRequest
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.WipeRestartClaim
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.MockWebAuthnProvider
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
    private val webAuthn: WebAuthnProvider = MockWebAuthnProvider(),
    private val username: () -> String?,
    private val rng: SecureRandom = SecureRandom(),
) {
    private val _phase = MutableStateFlow<WipeRestartPhase>(WipeRestartPhase.Idle)
    val phase: StateFlow<WipeRestartPhase> = _phase.asStateFlow()

    suspend fun run(currentEtag: String?) {
        val user = username()
        if (user.isNullOrEmpty()) {
            _phase.value = WipeRestartPhase.Failed("No active account on this device.")
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
            oldIrkSign = Keystore.deriveIRK("Authorize wipe", version = Keystore.currentIrkVersion())
            // We need the OLD IRK pub for the canonical-bytes claim.
            // Re-derive via the cached seed slot.
            val oldSeed = Keystore.requireIrkSeedForVersion(Keystore.currentIrkVersion())
            val pair = Ed25519Sign.KeyPair.newKeyPairFromSeed(oldSeed)
            oldIrkPubHex = HexUtil.encode(pair.publicKey)
        } catch (e: Throwable) {
            _phase.value = WipeRestartPhase.Failed("Couldn't access your current key: ${e.message}")
            return
        }

        // 2 — Fresh UMK + passkey register.
        val newUmk = ByteArray(32).also(rng::nextBytes)
        _phase.value = WipeRestartPhase.RegisteringPasskey
        val credentialId: String
        try {
            credentialId = webAuthn.register()
        } catch (e: Throwable) {
            _phase.value = WipeRestartPhase.Failed("Passkey registration failed: ${e.message}")
            return
        }
        val prfSecret: ByteArray
        try {
            prfSecret = webAuthn.prfAssert(credentialId)
        } catch (e: Throwable) {
            _phase.value = WipeRestartPhase.Failed("PRF assertion failed: ${e.message}")
            return
        }

        // 3 — Wrap NEW UMK under PRF secret.
        _phase.value = WipeRestartPhase.WrappingNewUmk
        val sealed = Recovery.wrap(newUmk, prfSecret)
        // The Worker hashes the decoded ciphertext bytes (nonce||ct).
        val nonceBytes = java.util.Base64.getDecoder().decode(sealed.nonceBase64)
        val ctBytes = java.util.Base64.getDecoder().decode(sealed.ciphertextBase64)
        val combined = nonceBytes + ctBytes
        val newWrappedUmkB64 = java.util.Base64.getEncoder().encodeToString(combined)
        val wrappedHashHex = sha256Hex(combined)

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
                msg.contains("412") -> "Your device list changed in the background. Refresh and try again."
                msg.contains("429") -> "Wipe rate-limited (1 per hour). Try again later."
                msg.contains("409") -> "Another rotation completed first. Your account is fine — refresh and check Activity for the audit trail."
                else -> "Couldn't reach the server: $msg"
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
        } catch (e: Throwable) {
            _phase.value = WipeRestartPhase.Failed(
                "Server committed but local install failed: ${e.message}. Open the app fresh to recover.",
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
