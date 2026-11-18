package com.flagshipserver.app.api

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** Privacy policy §2.12: the call-back request addresses name no account. Mirrors iOS VoiciCallPathsTests. */
class VoiciCallPathsTest {
    private fun body(ringId: String) = JsonObject(mapOf("ring" to JsonObject(mapOf("ringId" to JsonPrimitive(ringId))), "signature" to JsonPrimitive("00")))

    @Test
    fun theRingAddressNamesOnlyTheRing() {
        val path = VoiciCallPaths.ring(body("0123456789abcdef0123456789abcdef"))
        assertEquals("/api/voici/rings/0123456789abcdef0123456789abcdef", path)
    }

    @Test
    fun aMalformedRingIdIsRefused() {
        assertNull(VoiciCallPaths.ring(body("../alice/ring")))
        assertNull(VoiciCallPaths.ring(body("0123456789ABCDEF0123456789ABCDEF")))
        assertNull(VoiciCallPaths.ring(JsonObject(emptyMap())))
    }

    @Test
    fun theRingBackAddressHasNoQuery() {
        assertEquals("/api/voici/web/ring-back", VoiciCallPaths.RING_BACK)
        assertFalse(VoiciCallPaths.RING_BACK.contains("?"))
    }
}
