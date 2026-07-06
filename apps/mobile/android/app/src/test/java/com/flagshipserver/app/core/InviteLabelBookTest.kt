// P6 — InviteLabelBook persistence + opaque-tag minter + share-URL
// builder. Mirrors FlagshipMobileTests/InviteLabelBookTests.swift 1:1.

package com.flagshipserver.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class InviteLabelBookTest {

    private fun makeLabel(name: String, ms: Long = 1L) = InviteLabel(
        displayName = name,
        channel = "other",
        sentTo = "",
        notes = "",
        sentAt = ms,
    )

    @Test fun putGet_roundTripsAnEntry() {
        val book = InMemoryInviteLabelBook()
        book.put(
            serviceId = "harry--plants",
            opaqueTagHex = "AABBCCDD11223344".repeat(2),
            label = InviteLabel("John (work)", "imessage", "+1 555 0142", "", 1_700_000_000_000),
        )
        val got = book.get("harry--plants", "aabbccdd11223344".repeat(2))
        assertEquals("John (work)", got?.displayName)
        assertEquals("imessage", got?.channel)
        assertEquals("+1 555 0142", got?.sentTo)
    }

    @Test fun get_returnsNullForMissingTag() {
        val book = InMemoryInviteLabelBook()
        assertNull(book.get("harry--plants", "00".repeat(16)))
    }

    @Test fun get_isPerService() {
        val book = InMemoryInviteLabelBook()
        book.put("harry--plants", "ab".repeat(16), makeLabel("John"))
        assertNotNull(book.get("harry--plants", "ab".repeat(16)))
        assertNull(book.get("harry--wiki", "ab".repeat(16)))
    }

    @Test fun list_returnsRowsForOneServiceSortedNewestFirst() {
        val book = InMemoryInviteLabelBook()
        book.put("harry--plants", "01".repeat(16), makeLabel("A", 1))
        book.put("harry--plants", "02".repeat(16), makeLabel("B", 3))
        book.put("harry--plants", "03".repeat(16), makeLabel("C", 2))
        book.put("harry--wiki", "04".repeat(16), makeLabel("Z", 99))
        val rows = book.list("harry--plants")
        assertEquals(3, rows.size)
        assertEquals(listOf("B", "C", "A"), rows.map { it.label.displayName })
    }

    @Test fun remove_isIdempotent() {
        val book = InMemoryInviteLabelBook()
        book.put("harry--plants", "ab".repeat(16), makeLabel("x"))
        book.remove("harry--plants", "ab".repeat(16))
        book.remove("harry--plants", "ab".repeat(16))
        assertNull(book.get("harry--plants", "ab".repeat(16)))
    }

    @Test fun sharedPrefsBacked_roundTripsAcrossInstances() {
        val app = ApplicationProvider.getApplicationContext<Context>()
        val prefs = app.getSharedPreferences(
            "fs-invite-test-${System.nanoTime()}",
            Context.MODE_PRIVATE,
        )
        val key = "test-storage"
        val book1 = SharedPreferencesInviteLabelBook(prefs, key)
        book1.put(
            "harry--plants",
            "ab".repeat(16),
            InviteLabel("Persisted", "imessage", "x", "n", 42),
        )
        val book2 = SharedPreferencesInviteLabelBook(prefs, key)
        val got = book2.get("harry--plants", "ab".repeat(16))
        assertEquals("Persisted", got?.displayName)
        assertEquals(42L, got?.sentAt)
    }

    // MARK: - InviteUtil

    @Test fun generateOpaqueTag_returnsLowercase32HexChars() {
        repeat(32) {
            val tag = InviteUtil.generateOpaqueTag()
            assertEquals(32, tag.length)
            assertTrue(tag.all { it.isDigit() || it in 'a'..'f' })
            assertFalse(tag.any { it.isUpperCase() })
        }
    }

    @Test fun buildShareUrl_includesSecretAndServiceIdFragment() {
        val url = InviteUtil.buildShareUrl(
            appUrl = "https://plants.harry.flagship.services/",
            secretHex = "abc123",
            serviceId = "harry--plants",
        )
        assertEquals(
            "https://plants.harry.flagship.services/invite#k=abc123&a=harry--plants",
            url,
        )
    }

    @Test fun buildShareUrl_stripsTrailingSlash() {
        val url = InviteUtil.buildShareUrl(
            appUrl = "https://x.flagship.services//",
            secretHex = "deadbeef",
            serviceId = "x",
        )
        assertTrue(url.startsWith("https://x.flagship.services/invite#"))
    }
}
