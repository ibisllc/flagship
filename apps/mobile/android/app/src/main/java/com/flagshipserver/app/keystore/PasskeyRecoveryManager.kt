// Passkey-PRF cloud recovery wrapper around androidx.credentials.
// Creates a discoverable passkey for flagshipserver.com on setup,
// then runs a PRF-extension assertion on every wrap/unwrap to get
// the 32-byte secret used to seal the UMK.
//
// Android's CredentialManager surfaces the PRF extension only on
// API 33+ (Android 13) with Google Play Services >= 22.x. Below
// that, this class throws PrfUnavailable and the caller falls back
// to the offline 10-word recovery codes.
//
// MIRRORS: apps/mobile/ios/Sources/Flagship/Recovery.swift +
// FlagshipUI/Components/PlatformWebAuthnProvider.swift.

package com.flagshipserver.app.keystore

import android.app.Activity
import android.content.Context
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialException
import org.json.JSONObject
import java.security.SecureRandom

class PasskeyRecoveryManager(private val context: Context) {
    private val manager = CredentialManager.create(context)
    private val rng = SecureRandom()

    /** Outcome of a successful create — the relying party uses
     *  credentialId as the key into the recovery-envelope store. */
    data class CreatedPasskey(val credentialId: String, val prfSecret: ByteArray)

    sealed class RecoveryError(msg: String) : RuntimeException(msg) {
        object PrfUnavailable : RecoveryError("Authenticator doesn't support PRF; use offline codes instead.")
        data class CreateFailed(val cause0: Throwable) : RecoveryError("Couldn't create passkey: ${cause0.message}")
        data class GetFailed(val cause0: Throwable) : RecoveryError("Couldn't assert passkey: ${cause0.message}")
        data class ProtocolError(val reason: String) : RecoveryError("Recovery protocol error: $reason")
    }

    /**
     * Register a new discoverable passkey for the user, embed a PRF
     * extension request so the same passkey can derive a stable
     * 32-byte secret on assertion.
     */
    suspend fun createPasskey(activity: Activity, username: String): CreatedPasskey {
        val challenge = ByteArray(32).also(rng::nextBytes)
        val userId = username.toByteArray()
        val request = buildCreateRequest(username = username, challenge = challenge, userId = userId)
        try {
            val resp = manager.createCredential(activity, request)
            val raw = (resp as? androidx.credentials.CreatePublicKeyCredentialResponse)
                ?.registrationResponseJson
                ?: throw RecoveryError.ProtocolError("no registration response JSON")
            val obj = JSONObject(raw)
            val credentialId = obj.optString("id")
            if (credentialId.isEmpty()) throw RecoveryError.ProtocolError("missing credential id")
            // Immediately run an assertion with the new credential to harvest the PRF secret.
            val prfSecret = assertPrf(activity, credentialId)
            return CreatedPasskey(credentialId = credentialId, prfSecret = prfSecret)
        } catch (e: CreateCredentialException) {
            throw RecoveryError.CreateFailed(e)
        }
    }

    /**
     * Run a PRF assertion against an already-registered credential to
     * re-derive the same 32-byte secret. Used by the recovery flow on
     * a new device.
     */
    suspend fun assertPrf(activity: Activity, credentialId: String): ByteArray {
        val challenge = ByteArray(32).also(rng::nextBytes)
        val getOption = buildGetOption(challenge = challenge, allowedCredentialId = credentialId)
        val req = GetCredentialRequest(credentialOptions = listOf(getOption))
        try {
            val resp = manager.getCredential(activity, req)
            val pkc = resp.credential as? PublicKeyCredential
                ?: throw RecoveryError.ProtocolError("non-publickey credential returned")
            val obj = JSONObject(pkc.authenticationResponseJson)
            val ext = obj.optJSONObject("clientExtensionResults")
                ?.optJSONObject("prf")
                ?.optJSONObject("results")
                ?: throw RecoveryError.PrfUnavailable
            val first = ext.optString("first")
            if (first.isEmpty()) throw RecoveryError.PrfUnavailable
            return java.util.Base64.getUrlDecoder().decode(first)
        } catch (e: GetCredentialException) {
            throw RecoveryError.GetFailed(e)
        }
    }

    // ── request builders ────────────────────────────────────────────

    private fun buildCreateRequest(
        username: String,
        challenge: ByteArray,
        userId: ByteArray,
    ): CreatePublicKeyCredentialRequest {
        val challengeB64u = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(challenge)
        val userIdB64u = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(userId)
        // PRF eval input is per-credential; we use the same salt the
        // daemon side checks for so multiple devices converge on the
        // same secret for the same passkey.
        val prfEvalB64u = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(Recovery.PRF_SALT)
        val json = JSONObject().apply {
            put("rp", JSONObject().apply {
                put("name", "Flagship")
                put("id", "flagshipserver.com")
            })
            put("user", JSONObject().apply {
                put("id", userIdB64u)
                put("name", username)
                put("displayName", username)
            })
            put("challenge", challengeB64u)
            put("pubKeyCredParams", org.json.JSONArray().apply {
                put(JSONObject().apply { put("type", "public-key"); put("alg", -7) })
                put(JSONObject().apply { put("type", "public-key"); put("alg", -257) })
            })
            put("attestation", "none")
            put("authenticatorSelection", JSONObject().apply {
                put("residentKey", "required")
                put("userVerification", "required")
            })
            put("extensions", JSONObject().apply {
                put("prf", JSONObject().apply {
                    put("eval", JSONObject().apply {
                        put("first", prfEvalB64u)
                    })
                })
            })
        }
        return CreatePublicKeyCredentialRequest(json.toString())
    }

    private fun buildGetOption(
        challenge: ByteArray,
        allowedCredentialId: String,
    ): GetPublicKeyCredentialOption {
        val challengeB64u = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(challenge)
        val prfEvalB64u = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(Recovery.PRF_SALT)
        val json = JSONObject().apply {
            put("challenge", challengeB64u)
            put("rpId", "flagshipserver.com")
            put("userVerification", "required")
            put("allowCredentials", org.json.JSONArray().apply {
                put(JSONObject().apply {
                    put("type", "public-key")
                    put("id", allowedCredentialId)
                })
            })
            put("extensions", JSONObject().apply {
                put("prf", JSONObject().apply {
                    put("eval", JSONObject().apply {
                        put("first", prfEvalB64u)
                    })
                })
            })
        }
        return GetPublicKeyCredentialOption(json.toString())
    }
}
