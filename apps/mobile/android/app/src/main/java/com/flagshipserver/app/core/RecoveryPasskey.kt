package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * What `.com` needs to check the recovery passkey itself (SEC-REPAIR-001). Wire parity with
 * packages/control-plane/src/passkeyAssertion.ts; pinned by
 * packages/protocol/test-vectors/recovery-passkey/vectors.json.
 *
 * Enrolment: send `response.attestationObject` from CredentialManager's registration JSON as
 * `passkeyAttestationObject` beside the signed record. Recovery: `POST
 * /api/recovery/by-username/<u>/challenge`, put that challenge string itself in the get request's
 * `challenge` (CredentialManager takes base64url), and send `passkey: fetchPasskeyField(...)` built
 * from the authentication response JSON with the `/fetch` body.
 */
object RecoveryPasskey {
    fun base64url(b: ByteArray): String = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b)

    fun decode(s: String): ByteArray = java.util.Base64.getUrlDecoder().decode(s.trimEnd('='))

    private fun obj(json: String) = Json.parseToJsonElement(json).jsonObject

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content

    /** The enrolment field from CredentialManager's `registrationResponseJson`. */
    fun attestationField(registrationResponseJson: String): String =
        base64url(decode(obj(registrationResponseJson)["response"]!!.jsonObject.s("attestationObject")))

    /** The `/fetch` body's `passkey` field from CredentialManager's `authenticationResponseJson`. */
    fun fetchPasskeyField(challenge: String, authenticationResponseJson: String): JsonObject {
        val j = obj(authenticationResponseJson)
        val r = j["response"]!!.jsonObject
        val id = (j["rawId"] ?: j["id"])!!.jsonPrimitive.content
        return buildJsonObject {
            put("challenge", challenge)
            put("assertion", buildJsonObject {
                put("credentialId", base64url(decode(id)))
                put("authenticatorData", base64url(decode(r.s("authenticatorData"))))
                put("clientDataJSON", base64url(decode(r.s("clientDataJSON"))))
                put("signature", base64url(decode(r.s("signature"))))
            })
        }
    }
}
