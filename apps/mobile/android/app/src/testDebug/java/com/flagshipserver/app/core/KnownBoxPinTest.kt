package com.flagshipserver.app.core

import com.flagshipserver.app.api.PodDirectoryEntry
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.net.ssl.SSLPeerUnverifiedException

class KnownBoxPinTest {
    private val domain = "home.alice.flagship.services"
    private val pin = "ab".repeat(32)

    private fun registryWith(vararg domains: String, revoked: Set<String> = emptySet()): CertPinRegistry {
        val reg = CertPinRegistry()
        reg.update(
            domains.map { d ->
                PodDirectoryEntry(serverDomain = d, identityPubKey = "00".repeat(32), revokedAt = if (d in revoked) 1L else null)
            },
            ByteArray(32),
        )
        return reg
    }

    @Test fun aKnownBoxWithoutAPinIsRefusedAndAnythingElseKeepsOrdinaryTrust() {
        assertFalse(CertPinDecision.accept(pin, domain, { null }, { true }))
        assertFalse(CertPinDecision.accept(null, domain, { null }, { true }))
        assertTrue(CertPinDecision.accept(pin, "flagshipserver.com", { null }, { false }))
        assertTrue(CertPinDecision.accept(pin, domain, { pin }, { true }))
        assertFalse(CertPinDecision.accept("cd".repeat(32), domain, { pin }, { true }))
        // The old three-argument form still means "no pin, no opinion".
        assertTrue(CertPinDecision.accept(pin, domain, { null }))
    }

    @Test fun theRegistryKnowsABoxAndEverythingUnderItsWildcard() {
        val reg = registryWith(domain)
        assertTrue(reg.isKnownBox(domain))
        assertTrue(reg.isKnownBox("Chess.$domain."))
        assertFalse(reg.isKnownBox("evil$domain"))
        assertFalse(reg.isKnownBox("alice.flagship.services"))
        assertFalse(reg.isKnownBox("flagshipserver.com"))
        assertFalse(CertPinRegistry().isKnownBox(domain))
    }

    @Test fun aRevokedOrAbsentBoxIsForgotten() {
        val reg = registryWith(domain, "home2.alice.flagship.services", revoked = setOf("home2.alice.flagship.services"))
        assertTrue(reg.isKnownBox(domain))
        assertFalse(reg.isKnownBox("home2.alice.flagship.services"))
        reg.update(emptyList(), ByteArray(32))
        assertFalse(reg.isKnownBox(domain))
    }

    @Test fun enrollmentIsOneNamedBoxForAShortTime() {
        val reg = registryWith(domain, "home2.alice.flagship.services")
        reg.allowUnpinnedEnrollment(domain, forSeconds = 60, nowMs = 1_000)
        assertFalse(reg.isKnownBox(domain, nowMs = 2_000))
        assertTrue(reg.isKnownBox(domain, nowMs = 1_000 + 61_000))
        assertTrue(reg.isKnownBox("home2.alice.flagship.services", nowMs = 2_000))
        reg.allowUnpinnedEnrollment(domain, forSeconds = 100_000, nowMs = 0)
        assertTrue("the window is capped at five minutes", reg.isKnownBox(domain, nowMs = 301_000))
    }

    @Test fun whatTheLastRunLearnedSurvivesARestart() {
        val store = object : CertPinRegistry.Persistence {
            var pins: Map<String, String> = emptyMap()
            var known: Set<String> = emptySet()
            override fun load() = pins to known
            override fun save(pins: Map<String, String>, known: Set<String>) { this.pins = pins; this.known = known }
        }
        val first = CertPinRegistry().also { it.attach(store) }
        first.update(listOf(PodDirectoryEntry(serverDomain = domain, identityPubKey = "00".repeat(32))), ByteArray(32))
        assertEquals(setOf(domain), store.known)
        val second = CertPinRegistry().also { it.attach(store) }
        assertTrue("a cold start already knows the box", second.isKnownBox(domain))
        assertThrows(SSLPeerUnverifiedException::class.java) { CertPinInterceptor.enforce(domain, byteArrayOf(1), second::pinFor, { second.isKnownBox(it) }) }
    }

    @Test fun theSharedClientIsWiredToRefuseAKnownUnpinnedBox() {
        val client: OkHttpClient = HttpClientFactory.build()
        assertTrue(client.networkInterceptors.any { it is CertPinInterceptor })
        CertPinRegistry.shared.clear()
        CertPinRegistry.shared.update(listOf(PodDirectoryEntry(serverDomain = domain, identityPubKey = "00".repeat(32))), ByteArray(32))
        val interceptor = client.networkInterceptors.filterIsInstance<CertPinInterceptor>().single()
        assertThrows(SSLPeerUnverifiedException::class.java) {
            CertPinInterceptor.enforce(domain, byteArrayOf(1), CertPinRegistry.shared::pinFor, { CertPinRegistry.shared.isKnownBox(it) })
        }
        assertTrue(interceptor != null)
        CertPinRegistry.shared.clear()
    }
}
