// Tests for MockFlagshipServerClient.listDevices + the ETag invariants
// the Worker enforces on its side. Mirror of FlagshipMobileTests'
// listDevices coverage on iOS.

package com.flagshipserver.app.api

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TrustedDevicesTest {
    private fun make() = MockFlagshipServerClient(simulatedLatencyMs = 0)

    private fun device(
        tokenId: String, label: String = "iPhone",
        platform: String = "fcm", addedAt: Long = 1L,
        lastSeenAt: Long = addedAt,
    ) = TrustedDevice(
        tokenId = tokenId, tokenPrefix = tokenId.take(8),
        label = label, platform = platform,
        addedAt = addedAt, lastSeenAt = lastSeenAt,
    )

    @Test fun listDevices_unknownUserReturnsEmptyWithEtag() = runTest {
        val c = make()
        val r = c.listDevices("ghost")
        assertTrue(r.devices.isEmpty())
        assertNotNull(r.etag)
    }

    @Test fun listDevices_sortsByAddedAt() = runTest {
        val c = make()
        c.devicesByUser = mapOf(
            "harry" to listOf(
                device("tokB", "iPad",   addedAt = 200),
                device("tokA", "iPhone", addedAt = 100),
            ),
        )
        val r = c.listDevices("harry")
        assertEquals(listOf("iPhone", "iPad"), r.devices.map { it.label })
    }

    @Test fun etag_stableUnderSameData() = runTest {
        val c = make()
        c.devicesByUser = mapOf("harry" to listOf(device("t1")))
        val a = c.listDevices("harry").etag
        val b = c.listDevices("harry").etag
        assertEquals(a, b)
    }

    @Test fun etag_changesWhenLabelRotates() = runTest {
        val c = make()
        c.devicesByUser = mapOf("harry" to listOf(device("t1", "First")))
        val a = c.listDevices("harry").etag
        c.devicesByUser = mapOf("harry" to listOf(device("t1", "Renamed")))
        val b = c.listDevices("harry").etag
        assertNotEquals(a, b)
    }

    @Test fun etag_doesNotChangeWhenOnlyLastSeenChanges() = runTest {
        // Mirror of the Worker + iOS invariant: lastSeenAt is excluded
        // from the ETag input. Otherwise a fresh push delivery would
        // flutter the ETag and break If-Match flows in flight.
        val c = make()
        c.devicesByUser = mapOf("harry" to listOf(device("t1", lastSeenAt = 5)))
        val a = c.listDevices("harry").etag
        c.devicesByUser = mapOf("harry" to listOf(device("t1", lastSeenAt = 999)))
        val b = c.listDevices("harry").etag
        assertEquals(a, b)
    }

    @Test fun etag_format_isWeakSlashQuoted16Hex() = runTest {
        val c = make()
        c.devicesByUser = mapOf("harry" to listOf(device("t1")))
        val etag = c.listDevices("harry").etag ?: ""
        assertTrue(etag.startsWith("W/\""))
        assertTrue(etag.endsWith("\""))
    }

    @Test fun listDevices_doesNotLeakAcrossUsers() = runTest {
        val c = make()
        c.devicesByUser = mapOf(
            "harry" to listOf(device("h1", "Harry's iPhone")),
            "alice" to listOf(device("a1", "Alice's iPad")),
        )
        val r = c.listDevices("harry")
        assertEquals(listOf("h1"), r.devices.map { it.tokenId })
    }
}
