// Endpoints (G2) — the single Android apex accessor. Pins the prod-default
// invariant (no override ⇒ today's literal byte-for-byte, so the live app is
// unchanged) and the gym test-build override (one knob retargets the whole
// stack, control + data + sub-origins).

package com.flagshipserver.app.core

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EndpointsTest {
    @After fun reset() = Endpoints.setOverride(null) // never leak across tests

    @Test fun prodDefaultIsTodaysLiteral() {
        Endpoints.setOverride(null)
        assertEquals("flagshipserver.com", Endpoints.controlHost)
        assertEquals("https://flagshipserver.com", Endpoints.controlBaseUrl)
        assertEquals("flagship.services", Endpoints.dataApex)
        assertEquals("https://boot.flagshipserver.com", Endpoints.bootBaseUrl)
        assertEquals("https://recovery.flagshipserver.com", Endpoints.recoveryBaseUrl)
        assertEquals("https://web.flagshipserver.com/", Endpoints.webappOrigin)
        assertEquals("https://flagshipserver.com/api/server/register", Endpoints.registrationUrl)
        assertEquals("home.harry.flagship.services", Endpoints.serverFqdn("home", "harry"))
        assertEquals("harry.flagship.services", Endpoints.userZoneHost("harry"))
        assertTrue(Endpoints.isProdControlApex)
    }

    @Test fun gymOverrideRetargetsTheWholeStack() {
        Endpoints.setOverride(controlHost = "gym.flagshipserver.com")
        assertEquals("gym.flagshipserver.com", Endpoints.controlHost)
        assertEquals("https://gym.flagshipserver.com", Endpoints.controlBaseUrl)
        // Data plane mirrors the gym prefix.
        assertEquals("gym.flagship.services", Endpoints.dataApex)
        assertEquals("home.harry.gym.flagship.services", Endpoints.serverFqdn("home", "harry"))
        assertEquals("harry.gym.flagship.services", Endpoints.userZoneHost("harry"))
        // Sub-origins ride the gym apex.
        assertEquals("https://boot.gym.flagshipserver.com", Endpoints.bootBaseUrl)
        assertEquals("https://recovery.gym.flagshipserver.com", Endpoints.recoveryBaseUrl)
        assertEquals("https://web.gym.flagshipserver.com/", Endpoints.webappOrigin)
        // NOT the prod apex ⇒ cert pinning is skipped for this build.
        assertFalse(Endpoints.isProdControlApex)
    }

    @Test fun dataApexForMapsControlHostToSiblingDataApex() {
        assertEquals("flagship.services", Endpoints.dataApexFor("flagshipserver.com"))
        assertEquals("gym.flagship.services", Endpoints.dataApexFor("gym.flagshipserver.com"))
        assertEquals("flagship.services", Endpoints.dataApexFor("example.com"))
    }

    @Test fun setOverrideNullRestoresProdDefault() {
        Endpoints.setOverride(controlHost = "gym.flagshipserver.com")
        Endpoints.setOverride(null)
        assertEquals("flagshipserver.com", Endpoints.controlHost)
        assertEquals("flagship.services", Endpoints.dataApex)
        assertTrue(Endpoints.isProdControlApex)
    }

    @Test fun clientAndCoreDefaultsFollowEndpoints() {
        Endpoints.setOverride(null)
        assertEquals("https://flagshipserver.com",
            com.flagshipserver.app.api.LiveFlagshipServerClient.DEFAULT_BASE_URL)
        assertEquals("https://flagshipserver.com",
            com.flagshipserver.app.api.LiveSecretMailboxClient.DEFAULT_BASE_URL)
        assertEquals("https://boot.flagshipserver.com",
            com.flagshipserver.app.api.LiveSecretMailboxClient.DEFAULT_BOOT_BASE_URL)
        assertEquals("flagshipserver.com", QrRelay.QR_HOST)
        assertEquals("flagshipserver.com", LiveQrRelayClient.DEFAULT_HOST)
        assertEquals("flagshipserver.com", JoinLink.HOST)

        Endpoints.setOverride(controlHost = "gym.flagshipserver.com")
        assertEquals("https://gym.flagshipserver.com",
            com.flagshipserver.app.api.LiveFlagshipServerClient.DEFAULT_BASE_URL)
        assertEquals("https://boot.gym.flagshipserver.com",
            com.flagshipserver.app.api.LiveSecretMailboxClient.DEFAULT_BOOT_BASE_URL)
        assertEquals("gym.flagshipserver.com", QrRelay.QR_HOST)
        assertEquals("gym.flagshipserver.com", JoinLink.HOST)
    }
}
