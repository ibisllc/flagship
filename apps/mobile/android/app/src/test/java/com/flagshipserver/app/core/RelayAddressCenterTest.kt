// What `.com` recommends for the relay when DNS fails (docs/relay-addresses.md):
// a usable answer is kept and tried before the compiled-in seed; a failed fetch,
// junk, or an address that points at the local network changes nothing.

package com.flagshipserver.app.core

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress

class RelayAddressCenterTest {
    private var served: NoticeFetch = NoticeFetch.Failed
    private val backend = MemoryNoticeStoreBackend()
    private val seed = listOf(InetAddress.getByName("149.248.216.86"), InetAddress.getByName("2a09:8280:1::110:d2b6:0"))

    private fun center(b: NoticeStoreBackend = backend) = RelayAddressCenter(b, { NoticeFetcher { served } }, { 1_000L })

    private fun endpoints(v4: String?, v6: String?) = NoticeFetch.Document(
        """{"version":1,"tunnelHub":"wss://x/tunnel","passthroughIPv4":${v4?.let { "\"$it\"" } ?: "null"},"passthroughIPv6":${v6?.let { "\"$it\"" } ?: "null"},"siblings":[]}""",
    )

    private fun ip(s: String) = InetAddress.getByName(s)

    @Test fun withNothingStoredTheSeedIsUsed() {
        assertEquals(seed, center().addresses(seed))
    }

    @Test fun aRecommendationIsKeptAndTriedBeforeTheSeed() = runBlocking {
        val c = center()
        served = endpoints("203.0.113.7", "2001:db8::7")
        assertTrue(c.refresh())
        assertEquals(listOf(ip("203.0.113.7"), ip("2001:db8::7")) + seed, c.addresses(seed))
        // A fresh process decides the same from the store alone.
        assertEquals(c.addresses(seed), center().addresses(seed))
    }

    @Test fun anAddressAlsoInTheSeedIsNotRepeated() = runBlocking {
        val c = center()
        served = endpoints("149.248.216.86", "2a09:8280:1::110:d2b6:0")
        assertTrue(c.refresh())
        assertEquals(seed, c.addresses(seed))
    }

    @Test fun aFailedFetchJunkAndEmptyAnswersChangeNothing() = runBlocking {
        val c = center()
        served = endpoints("203.0.113.7", null)
        c.refresh()
        val before = c.addresses(seed)
        for (bad in listOf(
            NoticeFetch.Failed,
            NoticeFetch.NoNotice,
            NoticeFetch.Document("not json {"),
            NoticeFetch.Document("[]"),
            endpoints(null, null),
        )) {
            served = bad
            assertFalse(c.refresh())
            assertEquals(before, c.addresses(seed))
        }
    }

    @Test fun anAddressThatPointsAtTheLocalNetworkIsRefused() = runBlocking {
        for (bad in listOf("10.0.0.7", "192.168.1.2", "172.16.0.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "224.0.0.1", "0.0.0.0")) {
            assertNull(bad, RelayAddressRules.parse(bad))
        }
        for (bad in listOf("::1", "fd00::1", "fe80::1", "ff02::1", "::")) {
            assertNull(bad, RelayAddressRules.parse(bad))
        }
        val c = center()
        served = endpoints("192.168.1.2", "fd00::1")
        assertFalse(c.refresh())
        assertEquals(seed, c.addresses(seed))
    }

    @Test fun aHostnameIsNeverLookedUp() {
        assertNull(RelayAddressRules.parse("relay.example.com"))
        assertNull(RelayAddressRules.parse("localhost"))
        assertNull(RelayAddressRules.parse("1.2.3"))
        assertEquals(ip("149.248.216.86"), RelayAddressRules.parse(" 149.248.216.86 "))
    }

    @Test fun aCorruptStoreIsAnEmptyOne() {
        assertEquals(seed, center(MemoryNoticeStoreBackend("{{{")).addresses(seed))
    }

    @Test fun theFallbackTriesWhatComRecommendsBeforeTheSeed() = runBlocking {
        val c = center()
        served = endpoints("203.0.113.7", null)
        c.refresh()
        val resolver = object : okhttp3.Dns {
            override fun lookup(hostname: String): List<InetAddress> = throw java.net.UnknownHostException(hostname)
        }
        val dns = RelayFallbackDns(resolver, { "flagship.services" }, { }, { _ -> c.addresses(seed) })
        assertEquals(ip("203.0.113.7"), dns.lookup("home.alice.flagship.services").first())
    }

    @Test fun aStoredAddressIsRecheckedWhenRead() {
        val b = MemoryNoticeStoreBackend("""{"addresses":["192.168.1.2","203.0.113.7"],"at":1}""")
        assertEquals(listOf(ip("203.0.113.7")) + seed, center(b).addresses(seed))
    }
}
