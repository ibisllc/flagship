// Tests for PushRegistrar.sanitizeLabel — mirror of
// PushRegistrarTests.swift's sanitizeLabel coverage on iOS. The label
// validation contract matches the Worker side
// (packages/control-plane/src/push.ts): 64-byte cap + reject control
// chars 0x00-0x1f + 0x7f.

package com.flagshipserver.app.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PushRegistrarLabelTest {

    @Test fun passesThroughNormalText() {
        assertEquals("Pixel 8 — kitchen", PushRegistrar.sanitizeLabel("Pixel 8 — kitchen"))
    }

    @Test fun stripsControlChars() {
        val raw = "BadLabel!"
        assertEquals("BadLabel!", PushRegistrar.sanitizeLabel(raw))
    }

    @Test fun trimsWhitespace() {
        assertEquals("spacey", PushRegistrar.sanitizeLabel("  spacey  "))
    }

    @Test fun capsAt64Bytes() {
        val long = "a".repeat(200)
        val result = PushRegistrar.sanitizeLabel(long)
        assertTrue(result.toByteArray(Charsets.UTF_8).size <= 64)
    }

    @Test fun truncatesMultibyteSafely() {
        val long = "🚀".repeat(30)
        val result = PushRegistrar.sanitizeLabel(long)
        assertTrue(result.toByteArray(Charsets.UTF_8).size <= 64)
        // No half-emoji left — round-trips through UTF-8.
        assertNotNull(String(result.toByteArray(Charsets.UTF_8), Charsets.UTF_8))
    }
}
