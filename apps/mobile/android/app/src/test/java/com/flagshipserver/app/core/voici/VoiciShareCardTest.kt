// The share card's rules (docs/voici-and-messages.md §2.10): when it is drawn, when it is carried, what it may be.
package com.flagshipserver.app.core.voici

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiciShareCardTest {
    private val jpeg = byteArrayOf(
        0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe0.toByte(), 0, 4, 0, 0,
        0xff.toByte(), 0xda.toByte(), 0, 2, 1, 2, 3, 0xff.toByte(), 0xd9.toByte(),
    )
    private val profile = VoiciProfile("Aya", "", null, "classic", emptyList())
    private fun state(p: VoiciProfile = profile) = VoiciPageState(p, 1, emptyList(), 0)

    @Test fun aFirstPublishDrawsTheCard() {
        var drawn = 0
        var kept: ByteArray? = null
        val p = VoiciShareCards.plan(state(), "aya", null, null, { _, _, _ -> drawn++; jpeg }, { null }, { kept = it })
        assertNotNull(p)
        assertEquals("share", p!!.role)
        assertEquals(WebEnvelopes.sha256Hex(jpeg), p.sha256)
        assertEquals("image/jpeg", p.contentType)
        assertEquals(1, drawn)
        assertTrue(kept!!.contentEquals(jpeg))
    }

    @Test fun anUnchangedLookCarriesTheListedCard() {
        val ref = VoiciPieceRef("share", WebEnvelopes.sha256Hex(jpeg), jpeg.size.toLong())
        var drawn = 0
        val carried = VoiciShareCards.plan(state(profile.copy(bio = "new bio")), "aya", ref, profile, { _, _, _ -> drawn++; jpeg }, { jpeg })
        assertEquals(0, drawn)
        assertEquals(ref, carried!!.ref)
        assertTrue(carried.bytes!!.contentEquals(jpeg))
        // Bytes this device never kept: still carried by reference (already stored on `.com`).
        val byRef = VoiciShareCards.plan(state(), "aya", ref, profile, null, { null })
        assertEquals(ref, byRef!!.ref)
        assertNull(byRef.bytes)
    }

    @Test fun aNewNamePhotoOrThemeDrawsAgain() {
        val ref = VoiciPieceRef("share", "aa".repeat(32), 10)
        for (changed in listOf(profile.copy(displayName = "Aya K"), profile.copy(avatar = "bb".repeat(32)), profile.copy(theme = "ink"))) {
            var drawn = 0
            VoiciShareCards.plan(state(changed), "aya", ref, profile, { _, _, _ -> drawn++; jpeg }, { null })
            assertEquals(1, drawn)
        }
    }

    @Test fun aCardWithMetadataOrOverTheCapIsDropped() {
        val exif = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe1.toByte(), 0, 2, 0xff.toByte(), 0xd9.toByte())
        assertFalse(VoiciShareCards.acceptable(exif))
        assertNull(VoiciShareCards.plan(state(), "aya", null, null, { _, _, _ -> exif }, { null }))
        val big = jpeg + ByteArray(VoiciPage.VOICI_SHARE_IMAGE_MAX_BYTES)
        assertFalse(VoiciShareCards.acceptable(big))
        assertNull(VoiciShareCards.plan(state(), "aya", null, null, { _, _, _ -> error("boom") }, { null }))
        assertNull(VoiciShareCards.plan(state(), "aya", null, null, null, { null }))
        assertTrue(VoiciShareCards.acceptable(jpeg))
    }

    @Test fun paletteAndInitial() {
        assertEquals(0xFF0A0A09.toInt(), VoiciShareCards.palette("ink").canvas)
        assertEquals(0xFFF3F6F7.toInt(), VoiciShareCards.palette("sea").canvas)
        assertEquals(0xFFF7F6F2.toInt(), VoiciShareCards.palette("classic").canvas)
        assertEquals("É", VoiciShareCards.initial(" éloïse"))
        assertEquals("😀", VoiciShareCards.initial("😀 smile"))
        assertEquals("", VoiciShareCards.initial(""))
    }
}
