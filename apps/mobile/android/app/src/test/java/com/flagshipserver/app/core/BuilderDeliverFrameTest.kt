package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** First contact's Studio confirm key rides beside the recipe in the deliver frame. */
class BuilderDeliverFrameTest {
    @Test fun theConfirmKeyIsBesideTheRecipeNeverInside() {
        val plain = Json.parseToJsonElement(BuilderOutbound.Deliver("c", "n").toJson()).jsonObject
        assertFalse("confirmKeyCiphertext" in plain)
        val f = Json.parseToJsonElement(BuilderOutbound.Deliver("c", "n", "kc", "kn").toJson()).jsonObject
        assertEquals("deliver", f["kind"]!!.jsonPrimitive.content)
        assertEquals("kc", f["confirmKeyCiphertext"]!!.jsonPrimitive.content)
        assertEquals("kn", f["confirmKeyNonce"]!!.jsonPrimitive.content)
    }

    @Test fun theConfirmKeyIsSealedWithTheSessionKeyAsThirtyTwoBytes() {
        val phone = QrSession.fresh()
        phone.pair(QrSession.fresh().phonePubKey)
        val sealed = phone.seal(ByteArray(32) { 0x51 })
        // AES-256-GCM: ciphertext || 16-byte tag, under a fresh 12-byte nonce.
        assertEquals(48, Base64URL.decode(sealed.ciphertextB64u).size)
        assertEquals(12, Base64URL.decode(sealed.nonceB64u).size)
        assertFalse(sealed.nonceB64u == phone.seal(ByteArray(32)).nonceB64u)
    }
}
