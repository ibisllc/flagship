package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Owner-authorized debug-access grant (Kotlin mirror of
 * packages/protocol/src/debugAccess.ts + the iOS DebugAccess). The phone
 * signs this behind biometric when the user approves the burner's "Debug
 * mode" toggle over the live pairing session; the box verifies it against
 * the owner IRK before enabling the debug console user / SSH.
 *
 * Canonical bytes (byte-identical to TS + Swift, pinned vector):
 *   flagship/debug-access/v1|<serverDomain>|<sshAuthorizedKey>|<issuedAt>
 */
object DebugAccess {
    data class Grant(val serverDomain: String, val sshAuthorizedKey: String, val issuedAt: Long)

    fun canonicalBytes(g: Grant): ByteArray =
        "flagship/debug-access/v1|${g.serverDomain}|${g.sshAuthorizedKey}|${g.issuedAt}".toByteArray()

    fun sign(g: Grant, irk: Ed25519Sign): String = HexUtil.encode(irk.sign(canonicalBytes(g)))

    fun verify(g: Grant, signatureHex: String, irkPub: ByteArray): Boolean = try {
        Ed25519Verify(irkPub).verify(HexUtil.decode(signatureHex), canonicalBytes(g))
        true
    } catch (_: Throwable) {
        false
    }

    /** The on-wire `consent-result` payload: {grant:{...}, signatureHex}. */
    fun envelopeJson(g: Grant, signatureHex: String): String {
        val grant: JsonObject = buildJsonObject {
            put("serverDomain", g.serverDomain)
            put("sshAuthorizedKey", g.sshAuthorizedKey)
            put("issuedAt", g.issuedAt)
        }
        return buildJsonObject {
            put("grant", grant)
            put("signatureHex", signatureHex)
        }.toString()
    }
}
