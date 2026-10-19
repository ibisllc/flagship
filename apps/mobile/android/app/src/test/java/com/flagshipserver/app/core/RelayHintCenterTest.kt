// The relay hint's fetch, store and use end to end with a throwaway authority
// (the baked pin is never involved): a verified hint puts its addresses first
// when DNS has failed, and a forged one, a failed fetch, junk, an older hint and
// an expired one change nothing (docs/relay-hints.md).

package com.flagshipserver.app.core

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress

class RelayHintCenterTest {
    private val t0 = 1_792_000_000_000L
    private val day = 86_400_000L
    private val a = NoticeGymAuthority(seedByte = 0x77, now = t0)
    private val other = NoticeGymAuthority(seedByte = 0x78, now = t0)

    private var clock = t0 + day
    private var served: NoticeFetch = NoticeFetch.NoNotice
    private val backend = MemoryNoticeStoreBackend()

    private val seed = listOf(InetAddress.getByName("149.248.216.86"), InetAddress.getByName("2a09:8280:1::110:d2b6:0"))
    private val seedText = seed.map { it.hostAddress }

    private fun center(b: NoticeStoreBackend = backend, pin: String = a.pin) = RelayHintCenter(
        backend = b,
        fetcher = { NoticeFetcher { served } },
        pin = { pin },
        clock = { clock },
    )

    private fun hint(seq: Long = 1, addresses: List<String> = listOf("203.0.113.7", "149.248.216.86"), auth: NoticeGymAuthority = a,
                     from: Long = t0, until: Long = t0 + 90 * day) = auth.relayHint(seq, from, until, addresses)

    private fun serve(auth: NoticeGymAuthority, h: kotlinx.serialization.json.JsonElement) {
        served = NoticeFetch.Document(auth.hintResponse(h))
    }

    private fun texts(c: RelayHintCenter) = c.addresses(seed).map { it.hostAddress }

    @Test fun withNothingStoredTheSeedIsUsed() {
        assertEquals(seedText, texts(center()))
    }

    @Test fun aVerifiedHintComesFirstAndIsRemembered() = runBlocking {
        val c = center()
        serve(a, hint())
        assertNull(c.refresh())
        assertEquals(
            listOf("203.0.113.7", "149.248.216.86", "2a09:8280:1::110:d2b6:0").map { InetAddress.getByName(it) },
            c.addresses(seed),
        )
        assertEquals(1L, c.load().highestSeq)
        assertTrue(c.load().tip > 0)
        // A fresh process decides the same from the store alone.
        assertEquals(texts(c), texts(center()))
    }

    @Test fun aHintSignedByAnotherChainChangesNothing() = runBlocking {
        val c = center()
        serve(other, hint(auth = other))
        assertEquals("unauthorized-signer", c.refresh())
        assertEquals(seedText, texts(c))
        assertEquals(0L, c.load().highestSeq)
    }

    @Test fun aFailedFetchAndJunkChangeNothing() = runBlocking {
        val c = center()
        serve(a, hint())
        c.refresh()
        val before = texts(c)
        served = NoticeFetch.Failed
        assertNull(c.refresh())
        served = NoticeFetch.NoNotice
        assertNull(c.refresh())
        served = NoticeFetch.Document("not json {")
        assertEquals(null, runCatching { c.refresh() }.getOrNull())
        served = NoticeFetch.Document("""{"version":1,"hint":{"type":"RelayHint"},"mandates":[]}""")
        assertEquals("malformed", c.refresh())
        assertEquals(before, texts(c))
    }

    @Test fun anOlderHintCannotReplaceANewerOne() = runBlocking {
        val c = center()
        serve(a, hint(seq = 2, addresses = listOf("203.0.113.9")))
        c.refresh()
        serve(a, hint(seq = 1, addresses = listOf("203.0.113.7")))
        assertEquals("stale", c.refresh())
        assertEquals("203.0.113.9", texts(c).first())
    }

    @Test fun anExpiredOrNotYetValidHintIsIgnored() = runBlocking {
        val c = center()
        serve(a, hint())
        c.refresh()
        clock = t0 + 91 * day
        assertEquals(seedText, texts(c))
        clock = t0 - 1
        assertEquals(seedText, texts(c))
    }

    @Test fun aStoredHintIsIgnoredWhenTheAuthorityIsNoLongerTrusted() = runBlocking {
        serve(a, hint())
        center().refresh()
        assertEquals(seedText, texts(center(pin = other.pin)))
    }

    @Test fun aCorruptStoreIsAnEmptyOne() {
        val b = MemoryNoticeStoreBackend("{{{")
        assertEquals(seedText, texts(center(b)))
    }

    @Test fun theFallbackAsksTheSignedHintBeforeTheSeed() = runBlocking {
        val c = center()
        serve(a, hint(addresses = listOf("203.0.113.7")))
        c.refresh()
        val resolver = object : okhttp3.Dns {
            override fun lookup(hostname: String): List<InetAddress> = throw java.net.UnknownHostException(hostname)
        }
        val dns = RelayFallbackDns(resolver, { "flagship.services" }, { }, { _ -> c.addresses(seed) })
        assertEquals("203.0.113.7", dns.lookup("home.alice.flagship.services").first().hostAddress)
    }
}
