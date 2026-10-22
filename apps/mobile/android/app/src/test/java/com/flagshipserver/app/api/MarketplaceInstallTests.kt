// Mirror of FlagshipMobileTests/MarketplaceInstallTests.swift. Runs on the
// JVM (no Robolectric) — Mock / models / canonical bytes are all pure Kotlin.
//
// Wire-shape must match the webapp's `canonicalInstallService` /
// `installFromMarketplace` in `apps/web/public/webapp/lib/installService.js`
// AND the iOS `installServiceCanonicalBytes` byte-for-byte: same `request`
// fields, same canonical-bytes prefix, same `{request, signature}` envelope,
// same daemon endpoint `<pod>/api/services`.
//
// These tests pin:
//   - the canonical-bytes format (the exact `flagship/install-service/v1|…` string),
//   - that the Mock records the install envelope on the wire shape the daemon expects,
//   - error propagation, and that browse maps listings.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.HexUtil
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class MarketplaceInstallTests {

    private fun makeClient() = MockScreensClient(simulatedLatencyMs = 0)

    // ── Canonical-bytes parity with the webapp + iOS ────────────────

    @Test fun canonicalBytes_shapeMatchesWebapp() {
        val r = InstallServiceRequest(
            serverId = "home.harry.flagship.services",
            creator = "trent",
            slug = "scratchpad",
            manifestJson = """{"name":"scratchpad","version":"1.0.0"}""",
            addOwnerToMembership = true,
            issuedAt = 1_700_000_000_000L,
        )
        val canonical = String(installServiceCanonicalBytes(r), Charsets.UTF_8)
        // Hard-code the exact expected string — the daemon recomputes this
        // byte-for-byte and verifies the signature against it.
        assertEquals(
            "flagship/install-service/v1|home.harry.flagship.services|trent|scratchpad|" +
                """{"name":"scratchpad","version":"1.0.0"}|1|1700000000000""",
            canonical,
        )
        // 7 pipe-separated fields, in this exact order.
        val parts = canonical.split("|")
        assertEquals(7, parts.size)
        assertEquals("flagship/install-service/v1", parts[0])
        assertEquals("home.harry.flagship.services", parts[1])
        assertEquals("trent", parts[2])
        assertEquals("scratchpad", parts[3])
        assertEquals("""{"name":"scratchpad","version":"1.0.0"}""", parts[4])
        assertEquals("1", parts[5])   // addOwnerToMembership = true ⇒ "1"
        assertEquals("1700000000000", parts[6])
    }

    @Test fun canonicalBytes_encodesFalseMembershipAsZero() {
        val r = InstallServiceRequest(
            serverId = "x.flagship.services",
            creator = "a", slug = "b",
            manifestJson = "{}",
            addOwnerToMembership = false,
            issuedAt = 1L,
        )
        val parts = String(installServiceCanonicalBytes(r), Charsets.UTF_8).split("|")
        assertEquals("0", parts[5])
    }

    // ── Mock records the install envelope ───────────────────────────

    @Test fun mock_recordsInstallEnvelopeOnSuccess() = runTest {
        val c = makeClient()
        val request = InstallServiceRequest(
            serverId = "home.harry.flagship.services",
            creator = "trent",
            slug = "scratchpad",
            manifestJson = """{"name":"scratchpad"}""",
            addOwnerToMembership = true,
            issuedAt = 1_700_000_000_000L,
        )
        // Real-ish signature over the canonical bytes (not the request JSON);
        // the Mock doesn't verify it, but the test demonstrates the call site
        // signed the canonical bytes.
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val sig = Ed25519Sign(kp.privateKey).sign(installServiceCanonicalBytes(request))
        val envelope = InstallServiceEnvelope(request = request, signature = HexUtil.encode(sig))

        val resp = c.installFromMarketplace(envelope)
        assertEquals(1, c.installCalls.size)
        val recorded = c.installCalls[0]
        assertEquals(request, recorded.request)
        // Hex-encoded 64-byte Ed25519 signature ⇒ 128 chars.
        assertEquals(128, recorded.signature.length)
        // The recorded signature verifies against the canonical bytes.
        Ed25519Verify(kp.publicKey).verify(HexUtil.decode(recorded.signature)!!, installServiceCanonicalBytes(request))
        // Response shape mirrors the daemon's `installService` body.
        assertTrue(resp.ok)
        assertEquals("trent--scratchpad", resp.serviceId)
        assertEquals("scratchpad", resp.urlLabel)
    }

    @Test fun mock_fetchListingRecordsCallAndReturnsManifestJson() = runTest {
        val c = makeClient()
        val detail = c.marketplaceFetchListing("trent", "scratchpad")
        assertEquals(1, c.listingFetches.size)
        assertEquals("trent", c.listingFetches[0].creator)
        assertEquals("scratchpad", c.listingFetches[0].slug)
        assertTrue(detail.manifestJson.isNotEmpty())
        assertEquals("trent", detail.creator)
        assertEquals("scratchpad", detail.slug)
    }

    @Test fun mock_surfacesErrorOnFailureFlag() = runTest {
        val c = makeClient()
        c.installShouldFail = true
        c.installFailureMessage = "manifest signature invalid"
        val envelope = InstallServiceEnvelope(
            request = InstallServiceRequest(
                serverId = "x", creator = "a", slug = "b",
                manifestJson = "{}", addOwnerToMembership = true, issuedAt = 1L,
            ),
            signature = "00",
        )
        try {
            c.installFromMarketplace(envelope)
            fail("expected throw")
        } catch (e: ScreensError.Http) {
            assertEquals(400, e.status)
            assertEquals("manifest signature invalid", e.body)
        }
    }

    // ── Browse maps listings ────────────────────────────────────────

    @Test fun browse_mapsListings() = runTest {
        val listings = makeClient().marketplaceBrowse().listings
        assertEquals(listOf("trent", "wendy", "peggy"), listings.map { it.creator })
        val scratchpad = listings.first { it.slug == "scratchpad" }
        assertEquals("Scratchpad", scratchpad.title)
        assertTrue(scratchpad.alreadyInstalled)
        assertTrue(listings.first { it.slug == "feed-reader" }.requiresLlmKey)
    }

    // ── Envelope round-trips through JSON unchanged ─────────────────

    @Test fun envelope_roundTripsThroughJson() {
        val json = Json { encodeDefaults = true; explicitNulls = false }
        val request = InstallServiceRequest(
            serverId = "home.harry.flagship.services",
            creator = "wendy",
            slug = "wishlist",
            manifestJson = """{"name":"wishlist","version":"0.1.0"}""",
            addOwnerToMembership = true,
            issuedAt = 1_700_000_000_000L,
        )
        val envelope = InstallServiceEnvelope(request = request, signature = "ab".repeat(64))
        val encoded = json.encodeToString(InstallServiceEnvelope.serializer(), envelope)
        val decoded = json.decodeFromString(InstallServiceEnvelope.serializer(), encoded)
        assertEquals(envelope, decoded)
        // The encoded JSON carries the same top-level keys as the webapp wire
        // body: `{ "request": {...}, "signature": "..." }`.
        assertTrue(encoded.contains("\"request\""))
        assertTrue(encoded.contains("\"signature\""))
        assertTrue(encoded.contains("\"manifestJson\""))
        assertTrue(encoded.contains("\"addOwnerToMembership\""))
    }
}
