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
import com.flagshipserver.app.core.HexUtil
import org.json.JSONObject
import java.security.SecureRandom

class PasskeyRecoveryManager(private val context: Context) {
    private val manager = CredentialManager.create(context)
    private val rng = SecureRandom()

    /** Outcome of a successful create — the relying party uses
     *  credentialId (LOWERCASE HEX of the raw credential-id bytes) as the
     *  key into the recovery-envelope store. The Worker requires hex
     *  (`^[0-9a-fA-F]{16,512}$`) and the webapp sends `bytesToHex(rawId)`;
     *  CredentialManager hands back base64url, so we decode → hex here so
     *  the on-wire id matches the webapp byte-for-byte. */
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
     *
     * @param prfEvalInput the WebAuthn `prf.eval.first` input. Pass the
     *   passphrase-derived `prfSalt` (RecoveryDerivation) for the gated
     *   cloud-recovery flow; defaults to the legacy fixed [Recovery.PRF_SALT]
     *   for callers that haven't adopted the passphrase gate yet.
     */
    suspend fun createPasskey(
        activity: Activity,
        username: String,
        prfEvalInput: ByteArray = Recovery.PRF_SALT,
    ): CreatedPasskey {
        val challenge = ByteArray(32).also(rng::nextBytes)
        val userId = username.toByteArray()
        val request = buildCreateRequest(
            username = username,
            challenge = challenge,
            userId = userId,
            prfEvalInput = prfEvalInput,
        )
        try {
            val resp = manager.createCredential(activity, request)
            val raw = (resp as? androidx.credentials.CreatePublicKeyCredentialResponse)
                ?.registrationResponseJson
                ?: throw RecoveryError.ProtocolError("no registration response JSON")
            val obj = JSONObject(raw)
            // CredentialManager returns the credential id base64url-encoded
            // (WebAuthn JSON wire format). The Worker requires hex, so decode
            // → hex right here; everything downstream (envelope key, upload,
            // re-assert) carries the hex form, matching the webapp.
            val rawIdB64u = obj.optString("id")
            if (rawIdB64u.isEmpty()) throw RecoveryError.ProtocolError("missing credential id")
            val credentialIdHex = HexUtil.encode(decodeB64Url(rawIdB64u))
            // Immediately run an assertion with the new credential to harvest the PRF secret.
            val prfSecret = assertPrf(activity, credentialIdHex, prfEvalInput)
            return CreatedPasskey(credentialId = credentialIdHex, prfSecret = prfSecret)
        } catch (e: CreateCredentialException) {
            throw RecoveryError.CreateFailed(e)
        }
    }

    /**
     * Run a PRF assertion against an already-registered credential to
     * re-derive the same 32-byte secret. Used by the recovery flow on
     * a new device.
     *
     * @param credentialId LOWERCASE HEX of the raw credential id (the form
     *   stored + carried on the wire). Re-encoded to base64url internally
     *   for the WebAuthn `allowCredentials[].id` field.
     * @param prfEvalInput the WebAuthn `prf.eval.first` input — must match
     *   the value used at create time (passphrase `prfSalt` or the legacy
     *   fixed salt).
     */
    suspend fun assertPrf(
        activity: Activity,
        credentialId: String,
        prfEvalInput: ByteArray = Recovery.PRF_SALT,
    ): ByteArray {
        val challenge = ByteArray(32).also(rng::nextBytes)
        val getOption = buildGetOption(
            challenge = challenge,
            allowedCredentialId = credentialId,
            prfEvalInput = prfEvalInput,
        )
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
            return decodeB64Url(first)
        } catch (e: GetCredentialException) {
            throw RecoveryError.GetFailed(e)
        }
    }

    // ── request builders ────────────────────────────────────────────

    private fun buildCreateRequest(
        username: String,
        challenge: ByteArray,
        userId: ByteArray,
        prfEvalInput: ByteArray,
    ): CreatePublicKeyCredentialRequest {
        val challengeB64u = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(challenge)
        val userIdB64u = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(userId)
        // PRF eval input is per-credential. For the passphrase-gated flow
        // this is the Argon2id-derived prfSalt (matching the webapp's
        // prf.eval.first); legacy callers pass the fixed Recovery.PRF_SALT.
        val prfEvalB64u = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(prfEvalInput)
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
        prfEvalInput: ByteArray,
    ): GetPublicKeyCredentialOption {
        val challengeB64u = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(challenge)
        val prfEvalB64u = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(prfEvalInput)
        // allowedCredentialId arrives as hex (the stored / on-wire form);
        // WebAuthn's allowCredentials[].id wants base64url, so re-encode.
        val idBytes = HexUtil.decode(allowedCredentialId)
            ?: throw RecoveryError.ProtocolError("credentialId is not valid hex")
        val allowedIdB64u = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(idBytes)
        val json = JSONObject().apply {
            put("challenge", challengeB64u)
            put("rpId", "flagshipserver.com")
            put("userVerification", "required")
            put("allowCredentials", org.json.JSONArray().apply {
                put(JSONObject().apply {
                    put("type", "public-key")
                    put("id", allowedIdB64u)
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

    /** Decode a base64url string (CredentialManager omits padding). Falls
     *  back through the padded decoder for robustness. */
    private fun decodeB64Url(s: String): ByteArray =
        try {
            java.util.Base64.getUrlDecoder().decode(s)
        } catch (_: IllegalArgumentException) {
            java.util.Base64.getUrlDecoder().decode(s.trim().replace("=", ""))
        }
}

/** Bridges the live [PasskeyRecoveryManager] (which needs an Activity to
 *  drive CredentialManager) to the Activity-free
 *  [CloudRecoveryEnrollment.PasskeyCeremony] seam the shared enroll/restore
 *  logic talks to. Tests substitute their own [CloudRecoveryEnrollment.
 *  PasskeyCeremony] instead. */
class PasskeyCeremonyAdapter(
    private val manager: PasskeyRecoveryManager,
    private val activity: android.app.Activity,
) : CloudRecoveryEnrollment.PasskeyCeremony {
    override suspend fun create(username: String, prfEvalInput: ByteArray): Pair<String, ByteArray> {
        val created = manager.createPasskey(activity, username, prfEvalInput)
        return created.credentialId to created.prfSecret
    }

    override suspend fun assert(credentialId: String, prfEvalInput: ByteArray): ByteArray =
        manager.assertPrf(activity, credentialId, prfEvalInput)
}
