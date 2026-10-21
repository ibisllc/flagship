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

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import android.app.Activity
import android.content.Context
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import kotlinx.coroutines.delay
import com.flagshipserver.app.core.HexUtil
import org.json.JSONObject
import java.security.SecureRandom

/** The two CredentialManager calls the recovery ceremony makes; tests pass
 *  a fake passkey app. */
interface CredentialCalls {
    suspend fun create(activity: Activity, request: CreatePublicKeyCredentialRequest): CreateCredentialResponse
    suspend fun get(activity: Activity, request: GetCredentialRequest): GetCredentialResponse
}

class CredentialManagerCalls(context: Context) : CredentialCalls {
    private val manager = CredentialManager.create(context)
    override suspend fun create(activity: Activity, request: CreatePublicKeyCredentialRequest) =
        manager.createCredential(activity, request)
    override suspend fun get(activity: Activity, request: GetCredentialRequest) =
        manager.getCredential(activity, request)
}

class PasskeyRecoveryManager(
    private val calls: CredentialCalls,
    /** Pause before re-asking a passkey app that wasn't ready right after a create. */
    private val retryDelayMs: Long = 700,
) {
    constructor(context: Context) : this(
        com.flagshipserver.app.core.Variant.credentialCalls() ?: CredentialManagerCalls(context),
    )

    private val rng = SecureRandom()

    /** Outcome of a successful create — the relying party uses
     *  credentialId (LOWERCASE HEX of the raw credential-id bytes) as the
     *  key into the recovery-envelope store. The Worker requires hex
     *  (`^[0-9a-fA-F]{16,512}$`) and the webapp sends `bytesToHex(rawId)`;
     *  CredentialManager hands back base64url, so we decode → hex here so
     *  the on-wire id matches the webapp byte-for-byte. */
    data class CreatedPasskey(
        val credentialId: String,
        val prfSecret: ByteArray,
        /** The passkey app that saved it, when its AAGUID is a known one. */
        val provider: String? = null,
    )

    sealed class RecoveryError(msg: String) : RuntimeException(msg) {
        object PrfUnavailable : RecoveryError(FSStrings.get(R.string.authenticator_doesnt_support_prf_use_offline))
        data class CreateFailed(val cause0: Throwable) : RecoveryError("Couldn't create passkey: ${cause0.message}")
        data class GetFailed(val cause0: Throwable) : RecoveryError("Couldn't assert passkey: ${cause0.message}")
        data class ProtocolError(val reason: String) : RecoveryError("Recovery protocol error: $reason")
        /** The passkey was saved, but the passkey app never handed back the
         *  key Flagship derives from it (neither on create nor on the check
         *  right after). */
        data class KeyNotReturned(val credentialId: String, val cause0: Throwable?) :
            RecoveryError("Passkey saved but no PRF output: ${cause0?.javaClass?.simpleName ?: "none"}")
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
        /** Called just before the second passkey prompt, when the passkey app
         *  didn't return the key on create, so the screen can say why. */
        onSecondPrompt: () -> Unit = {},
    ): CreatedPasskey {
        val challenge = ByteArray(32).also(rng::nextBytes)
        val userId = username.toByteArray()
        val request = buildCreateRequest(
            username = username,
            challenge = challenge,
            userId = userId,
            prfEvalInput = prfEvalInput,
        )
        val resp = try {
            calls.create(activity, request)
        } catch (e: CreateCredentialException) {
            throw RecoveryError.CreateFailed(e)
        }
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
        val provider = providerName(obj)

        // Some passkey apps return the PRF output on create (the same value a
        // later assertion gives for this input): no second prompt then.
        prfFirst(obj)?.let { return CreatedPasskey(credentialIdHex, it, provider) }

        // Many (Samsung Pass among them) return it only on an assertion, and
        // some aren't ready to answer one the instant the create sheet closes:
        // ask again after a short pause before giving up.
        onSecondPrompt()
        var last: Throwable? = null
        repeat(CREATE_ASSERT_ATTEMPTS) { attempt ->
            if (attempt > 0) delay(retryDelayMs)
            try {
                return CreatedPasskey(credentialIdHex, assertPrf(activity, credentialIdHex, prfEvalInput), provider)
            } catch (e: RecoveryError.GetFailed) {
                if (e.cause0 is GetCredentialCancellationException) throw e
                last = e
            } catch (e: RecoveryError.PrfUnavailable) {
                last = e
            }
        }
        throw RecoveryError.KeyNotReturned(credentialIdHex, last)
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
        val resp = try {
            calls.get(activity, req)
        } catch (e: GetCredentialException) {
            throw RecoveryError.GetFailed(e)
        }
        val pkc = resp.credential as? PublicKeyCredential
            ?: throw RecoveryError.ProtocolError("non-publickey credential returned")
        return prfFirst(JSONObject(pkc.authenticationResponseJson)) ?: throw RecoveryError.PrfUnavailable
    }

    /** `clientExtensionResults.prf.results.first`, decoded, or null. */
    private fun prfFirst(obj: JSONObject): ByteArray? {
        val first = obj.optJSONObject("clientExtensionResults")
            ?.optJSONObject("prf")
            ?.optJSONObject("results")
            ?.optString("first")
            .orEmpty()
        return if (first.isEmpty()) null else decodeB64Url(first)
    }

    /** The passkey app's name from the registration's AAGUID (authenticator
     *  data bytes 37..52), when it is one we know. */
    private fun providerName(obj: JSONObject): String? {
        val authData = obj.optJSONObject("response")?.optString("authenticatorData").orEmpty()
        if (authData.isEmpty()) return null
        val bytes = runCatching { decodeB64Url(authData) }.getOrNull() ?: return null
        if (bytes.size < 53) return null
        return KNOWN_PROVIDERS[HexUtil.encode(bytes.copyOfRange(37, 53))]
    }

    companion object {
        /** One assertion right after the create, then retries for a passkey
         *  app that wasn't ready yet. */
        const val CREATE_ASSERT_ATTEMPTS = 3

        /** Passkey apps by AAGUID (the community passkey-aaguids list). */
        val KNOWN_PROVIDERS get() = mapOf(
            "ea9b8d664d011d213ce4b6b48cb575d4" to FSStrings.get(R.string.google_password_manager),
            "53414d53554e47000000000000000000" to FSStrings.get(R.string.samsung_pass),
            "bada5566a7aa401fbd9645619a55120d" to "1Password",
            "d548826e79b4db40a3d811116f7e8349" to "Bitwarden",
            "531126d6e717415c93203d9aa6981239" to "Dashlane",
            "fbfc3007154e4ecc8c0b6e020557d7bd" to "iCloud Keychain",
        )
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
                put("id", com.flagshipserver.app.core.Endpoints.controlHost)
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
            put("rpId", com.flagshipserver.app.core.Endpoints.controlHost)
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
    /** Before a second passkey prompt right after a create (see createPasskey). */
    private val onSecondPrompt: () -> Unit = {},
) : CloudRecoveryEnrollment.PasskeyCeremony {
    /** The passkey app the last create saved to, when known. */
    var lastProvider: String? = null
        private set

    override suspend fun create(username: String, prfEvalInput: ByteArray): Pair<String, ByteArray> {
        val created = manager.createPasskey(activity, username, prfEvalInput, onSecondPrompt)
        lastProvider = created.provider
        return created.credentialId to created.prfSecret
    }

    override suspend fun assert(credentialId: String, prfEvalInput: ByteArray): ByteArray =
        manager.assertPrf(activity, credentialId, prfEvalInput)
}
