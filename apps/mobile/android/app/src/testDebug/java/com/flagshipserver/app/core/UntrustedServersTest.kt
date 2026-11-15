package com.flagshipserver.app.core

import com.flagshipserver.app.api.PodDirectoryEntry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** A server marked untrusted after the retail alarm (docs/retail-box-setup.md §7.7): no
 *  connection, nothing sealed to it, no re-pin, until it is deleted. */
class UntrustedServersTest {
    private val domain = "home.alice.flagship.services"
    private val stk = "ab".repeat(32)
    private var before: UntrustedServers = UntrustedServers.shared
    private lateinit var untrusted: UntrustedServers

    @Before fun setUp() {
        before = UntrustedServers.shared
        untrusted = UntrustedServers(InMemoryUntrustedServerStore())
        UntrustedServers.shared = untrusted
    }

    @After fun tearDown() { UntrustedServers.shared = before }

    @Test fun anUntrustedServerIsBlockedEverywhere() {
        val keys = ServerKeyPins(InMemoryServerKeyPinStore(), untrusted)
        val pins = BoxKeyPins(keys)
        val registry = CertPinRegistry { untrusted }
        pins.repin("alice", domain, stk)
        registry.update(listOf(PodDirectoryEntry(serverDomain = domain, identityPubKey = stk)), { ByteArray(32) })
        assertEquals(stk, pins.require("alice", domain, stk))

        untrusted.mark("Home.Alice.flagship.services.")
        assertTrue(untrusted.contains("blog.$domain"))
        assertFalse(untrusted.contains("other.alice.flagship.services"))
        try { pins.require("alice", domain, stk); fail("sealed to an untrusted server") } catch (e: ServerUntrustedException) {
            assertEquals(domain, e.serverDomain)
        }
        assertNull("Nothing is sealed to it.", keys.pinnedStk(domain))
        assertEquals("It can't be re-pinned.", ServerKeyPins.Record.Mismatch, keys.recordFirstSeen(domain, "cd".repeat(32)))
        assertTrue(registry.isKnownBox("blog.$domain"))
        assertNull("No pin: every connection is refused as a known box.", registry.pinFor(domain))
        assertFalse(CertPinDecision.accept("00".repeat(32), domain, registry::pinFor) { registry.isKnownBox(it) })

        untrusted.forget(domain)
        assertEquals(stk, keys.pinnedHex(domain))
        assertTrue(untrusted.all().isEmpty())
    }
}
