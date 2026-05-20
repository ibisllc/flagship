// v1.2 Phase 4 — pure-logic tests for the quarantine indicator surface.
// We don't drive Compose rendering, but we do cover the observable
// contract:
//
//   - TrustedDevice.isQuarantined(now) returns true iff
//     quarantineUntil > now (and false on absent / 0 / past).
//   - The JSON round-trip preserves the field on both presence and
//     absence (matches the Worker shape).

package com.flagshipserver.app.api

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QuarantineIndicatorTest {

    private fun row(quarantineUntil: Long? = null): TrustedDevice = TrustedDevice(
        tokenId = "ab",
        tokenPrefix = "ab",
        label = "Test",
        platform = "fcm",
        addedAt = 1L,
        lastSeenAt = 2L,
        quarantineUntil = quarantineUntil,
    )

    @Test fun isQuarantined_absent_returnsFalse() {
        assertFalse(row().isQuarantined())
    }

    @Test fun isQuarantined_zero_returnsFalse() {
        assertFalse(row(0L).isQuarantined())
    }

    @Test fun isQuarantined_past_returnsFalse() {
        val past = System.currentTimeMillis() - 1000L
        assertFalse(row(past).isQuarantined())
    }

    @Test fun isQuarantined_future_returnsTrue() {
        val future = System.currentTimeMillis() + 14L * 86_400_000L
        assertTrue(row(future).isQuarantined())
    }

    @Test fun isQuarantined_acceptsExplicitNow() {
        val d = row(500L)
        assertTrue(d.isQuarantined(now = 100L))
        assertFalse(d.isQuarantined(now = 600L))
    }

    @Test fun decodingWireWithQuarantineUntil() {
        val json = """
            {
              "tokenId": "ab",
              "tokenPrefix": "ab",
              "label": "Test",
              "platform": "fcm",
              "addedAt": 1,
              "lastSeenAt": 2,
              "quarantineUntil": 1234567890123
            }
        """.trimIndent()
        val d = Json.decodeFromString(TrustedDevice.serializer(), json)
        assertEquals(1_234_567_890_123L, d.quarantineUntil)
    }

    @Test fun decodingWireWithoutQuarantineUntil() {
        val json = """
            {
              "tokenId": "ab",
              "tokenPrefix": "ab",
              "label": "Test",
              "platform": "fcm",
              "addedAt": 1,
              "lastSeenAt": 2
            }
        """.trimIndent()
        val d = Json { ignoreUnknownKeys = true }.decodeFromString(TrustedDevice.serializer(), json)
        assertNull(d.quarantineUntil)
        assertFalse(d.isQuarantined())
    }

    /** Acceptance criterion from the spec: when a user taps Remove on a
     *  quarantined row, the toast must mention "Quarantined until
     *  <date>. Use another device." — we exercise the same helper the
     *  Settings screen uses so a stray comma / extra word doesn't slip
     *  past review. */
    @Test fun quarantineMessageFormat() {
        val future = System.currentTimeMillis() + 14L * 86_400_000L
        val d = row(future)
        val msg = com.flagshipserver.app.ui.screens.quarantineToast(d)
        assertTrue(msg.startsWith("Quarantined until "))
        assertTrue(msg.endsWith("Use another device."))
        assertTrue(d.isQuarantined())
    }

    @Test fun quarantineMessage_fallsBackWhenFieldAbsent() {
        // No quarantineUntil at all — the screen still surfaces a
        // sensible default that mentions quarantine + suggests the
        // user pick another device.
        val msg = com.flagshipserver.app.ui.screens.quarantineToast(row(null))
        assertTrue(msg.contains("quarantine"))
        assertTrue(msg.contains("another device"))
    }
}
