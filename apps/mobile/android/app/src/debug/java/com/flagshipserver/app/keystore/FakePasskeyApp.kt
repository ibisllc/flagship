// GYM-only stand-in for a passkey app (debug builds): saves passkeys at once
// and, like Samsung Pass, returns the PRF key only on an assertion, never on
// create. The key is a hash of the PRF input, so the same passphrase always
// yields the same key, as a real authenticator's hmac-secret would.

package com.flagshipserver.app.keystore

import android.app.Activity
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import org.json.JSONObject
import java.security.MessageDigest
import java.util.Base64

class FakePasskeyApp : CredentialCalls {
    private val id = ByteArray(16) { (it + 1).toByte() }
    private fun b64(b: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(b)

    override suspend fun create(activity: Activity, request: CreatePublicKeyCredentialRequest): CreateCredentialResponse {
        val json = JSONObject().apply {
            put("id", b64(id))
            put("clientExtensionResults", JSONObject().apply {
                put("prf", JSONObject().apply { put("enabled", true) })
            })
        }
        return CreatePublicKeyCredentialResponse(json.toString())
    }

    override suspend fun get(activity: Activity, request: GetCredentialRequest): GetCredentialResponse {
        val option = request.credentialOptions.filterIsInstance<GetPublicKeyCredentialOption>().first()
        val input = JSONObject(option.requestJson).getJSONObject("extensions")
            .getJSONObject("prf").getJSONObject("eval").getString("first")
        val key = MessageDigest.getInstance("SHA-256").digest(("fake-passkey|$input").toByteArray())
        val json = JSONObject().apply {
            put("id", b64(id))
            put("clientExtensionResults", JSONObject().apply {
                put("prf", JSONObject().apply { put("results", JSONObject().apply { put("first", b64(key)) }) })
            })
        }
        return GetCredentialResponse(PublicKeyCredential(json.toString()))
    }
}
