// flagship/app-egress/v1 — the owner's signed approval for a live app's
// internet hosts. Pins the canonical bytes and both golden signatures shared
// with packages/protocol/tests/appEgress.test.ts, the approval flow, and when
// the app page shows the card.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.AppEgress
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.viewmodels.AppEgressViewModel
import com.flagshipserver.app.viewmodels.EgressCardState
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppEgressGrantTest {

    // The protocol fixture signs with the IRK derived from a UMK of 32×0x2a.
    private val seed = ServerKeys.deriveProtocolIrkSeed(ByteArray(32) { 0x2a })
    private val domain = "home.harry.flagship.services"
    private val service = "harry-weather"
    private val hosts = listOf("api.open-meteo.com", "*.tile.openstreetmap.org", "api.github.com")
    private val issuedAt = 1_700_000_000_000L

    @Test fun goldenVector_publicKey() {
        assertEquals(
            "c49775473bf9dcf5ad1608c8e66823d55dc6889be27e42a029fd9de195c8d7e4",
            HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey),
        )
    }

    @Test fun goldenVector_canonicalBytesAndSignature() {
        val bytes = AppEgressGrant.canonicalBytes(domain, service, hosts, issuedAt)
        assertEquals(
            "flagship/app-egress/v1|home.harry.flagship.services|harry-weather|" +
                "*.tile.openstreetmap.org,api.github.com,api.open-meteo.com|1700000000000",
            String(bytes, Charsets.UTF_8),
        )
        assertEquals(
            "a3788a82b718af70e81db6b319229d1d469944a999dd7fbe1b77fa1da58c22bc" +
                "c0d58241d7cbdd9c8954234d03f8d8cdf1e42ef24510eb100a373fdb1ba8f703",
            HexUtil.encode(Ed25519Sign(seed).sign(bytes)),
        )
    }

    @Test fun goldenVector_revoke() {
        val bytes = AppEgressGrant.canonicalBytes(domain, service, emptyList(), issuedAt)
        assertEquals(
            "flagship/app-egress/v1|home.harry.flagship.services|harry-weather||1700000000000",
            String(bytes, Charsets.UTF_8),
        )
        assertEquals(
            "332195add8c4f75eb5c472500c8b4d253c5024b58fab3dc81b7e84261fabd9f2" +
                "78c5b348991d20e08b7c4799e950b6ece4af2018cd897797de35e8aa3e6e3901",
            HexUtil.encode(Ed25519Sign(seed).sign(bytes)),
        )
    }

    @Test fun hostsAreDistinctLowercaseAndSortedByCodeUnit() {
        assertEquals(
            listOf("*.tile.openstreetmap.org", "API.example".lowercase(), "api.github.com"),
            AppEgressGrant.normalizeHosts(listOf("api.github.com", "API.example", "*.tile.openstreetmap.org", "api.github.com")),
        )
        // Order of the input never changes the bytes.
        assertEquals(
            String(AppEgressGrant.canonicalBytes(domain, service, hosts, issuedAt)),
            String(AppEgressGrant.canonicalBytes(domain, service, hosts.reversed(), issuedAt)),
        )
    }

    // ---- the approval flow ----

    private fun vm(mock: MockScreensClient, initial: AppEgress?) = AppEgressViewModel(
        serviceId = "bright-maple--plants",
        client = mock,
        initial = initial,
        fallbackServerDomain = { null },
        signer = { Ed25519Sign(seed) },
        now = { issuedAt },
    )

    @Test fun allow_signsTheDeclaredHosts_andShowsThemApproved() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        mock.egressFixture["bright-maple--plants"] = AppEgress(declared = listOf("api.open-meteo.com", "api.github.com"))
        val vm = vm(mock, mock.egressFixture["bright-maple--plants"])
        assertTrue(vm.allow())

        val (id, req) = mock.egressCalls.single()
        assertEquals("bright-maple--plants", id)
        assertEquals("home.bright-maple.flagship.services", req.grant.serverDomain)
        assertEquals("bright-maple--plants", req.grant.serviceId)
        assertEquals(listOf("api.github.com", "api.open-meteo.com"), req.grant.hosts)
        assertEquals(issuedAt, req.grant.issuedAt)
        assertEquals(128, req.signature.length)
        Ed25519Verify(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey).verify(
            HexUtil.decode(req.signature)!!,
            AppEgressGrant.canonicalBytes(req.grant.serverDomain, req.grant.serviceId, req.grant.hosts, req.grant.issuedAt),
        )
        assertEquals(emptyList<String>(), vm.egress.value?.pending)
        assertNull(vm.error.value)
    }

    @Test fun stopAccess_signsAnEmptyList() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        mock.egressFixture["bright-maple--plants"] = AppEgress(declared = listOf("api.open-meteo.com"), approved = listOf("api.open-meteo.com"))
        val vm = vm(mock, mock.egressFixture["bright-maple--plants"])
        assertTrue(vm.stopAccess())
        assertEquals(emptyList<String>(), mock.egressCalls.single().second.grant.hosts)
        assertEquals(listOf("api.open-meteo.com"), vm.egress.value?.pending)
    }

    @Test fun refusalsAreShownPlainly() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val vm = vm(mock, mock.egressFixture["bright-maple--plants"])
        mock.egressError = ScreensError.Http(403, """{"error":"stale grant"}""")
        assertFalse(vm.allow())
        assertEquals("The server refused this approval: stale grant. Check this phone's clock and try again.", vm.error.value)

        mock.egressError = ScreensError.Http(422, """{"error":"not declared in the app's network.egress: evil.example"}""")
        assertFalse(vm.allow())
        assertEquals("not declared in the app's network.egress: evil.example", vm.error.value)

        mock.egressError = ScreensError.Http(409, """{"error":"a newer grant is already applied"}""")
        assertFalse(vm.allow())
        assertEquals("A newer approval is already in place. Reload the page and try again.", vm.error.value)

        mock.egressError = ScreensError.Http(404, """{"error":"no such service"}""")
        assertFalse(vm.allow())
        assertEquals("This app is no longer installed on the server.", vm.error.value)
    }

    @Test fun aKeyThatWontUnlock_sendsNothing() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val vm = AppEgressViewModel(
            "bright-maple--plants", mock, mock.egressFixture["bright-maple--plants"],
            fallbackServerDomain = { null },
            signer = { throw IllegalStateException("cancelled") },
        )
        assertFalse(vm.allow())
        assertTrue(mock.egressCalls.isEmpty())
        assertEquals("Couldn't access your account key: cancelled", vm.error.value)
    }

    // ---- when the page shows it ----

    @Test fun cardVisibility() {
        // Older box: no egress field → nothing.
        assertNull(EgressCardState.from(null, restricted = false))
        // Declares nothing → nothing.
        assertNull(EgressCardState.from(AppEgress(), restricted = false))

        val pending = EgressCardState.from(AppEgress(declared = listOf("a.example", "b.example")), restricted = false)!!
        assertTrue(pending.showsPending)
        assertFalse(pending.showsApproved)
        assertEquals(listOf("a.example", "b.example"), pending.pending)
        assertTrue(pending.canSign)

        val approved = EgressCardState.from(AppEgress(listOf("a.example"), listOf("a.example")), restricted = false)!!
        assertFalse(approved.showsPending)
        assertTrue(approved.showsApproved)

        val both = EgressCardState.from(AppEgress(listOf("a.example", "b.example"), listOf("a.example")), restricted = false)!!
        assertEquals(listOf("b.example"), both.pending)
        assertEquals(listOf("a.example"), both.approved)

        // A restricted (companion) profile sees the hosts but can't sign.
        val companion = EgressCardState.from(AppEgress(listOf("a.example"), emptyList()), restricted = true)!!
        assertTrue(companion.showsPending)
        assertFalse(companion.canSign)
    }

    @Test fun listBadge() {
        assertTrue(EgressCardState.showsBadge(AppEgress(listOf("a.example"), emptyList())))
        assertFalse(EgressCardState.showsBadge(AppEgress(listOf("a.example"), listOf("a.example"))))
        assertFalse(EgressCardState.showsBadge(AppEgress()))
        assertFalse(EgressCardState.showsBadge(null))
    }

    @Test fun appsListDecodesEgress_andAnOlderBoxHasNone() {
        val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
        val row = """{"serviceId":"me--w","creator":"me","slug":"w","urlLabel":"w","url":"https://w","status":"running","installedAt":1"""
        val list = json.decodeFromString(
            com.flagshipserver.app.api.AppsListResponse.serializer(),
            """{"apps":[$row,"egress":{"declared":["api.example.com"],"approved":[]}},$row}]}""",
        )
        assertEquals(listOf("api.example.com"), list.apps[0].egress?.pending)
        assertNull(list.apps[1].egress)
    }

    @Test fun copy() {
        assertEquals("This app wants to reach the internet", AppEgressViewModel.PENDING_TITLE)
        assertEquals(
            "Until you allow them, the app can't reach any of these. Only allow hosts you expect this app to need.",
            AppEgressViewModel.PENDING_NOTE,
        )
        assertEquals("Allow", AppEgressViewModel.ALLOW)
        assertEquals("Stop access", AppEgressViewModel.STOP)
    }
}
