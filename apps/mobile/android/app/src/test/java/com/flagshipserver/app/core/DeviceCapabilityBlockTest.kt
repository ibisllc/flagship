// v2 device-addressing — pin the `/api/users/check` extension
// contract on Android for the `deviceCapability` block, plus the
// AppState session-state + DemoFixtures activation paths.
//
// Mirror of the Worker behaviour
// (docs/v2-device-addressing-and-real-ticket.md §5.1):
//   - When the typed string is `<u>.<label>` and a matching active
//     grant exists, the response carries a `deviceCapability` block
//     alongside the `demoServer` block from the underlying user-part
//     row. DemoFixtures.activate installs the capability so the home
//     screen renders the chip + greys out actions absent from `scopes`.
//   - When the typed string has NO dot, the legacy path runs and the
//     `deviceCapability` field is null.
//   - Unknown future scope strings decode to null and are silently
//     dropped (forward-compat — a newer Worker emitting a scope this
//     binary doesn't know about doesn't crash the client).

package com.flagshipserver.app.core

import com.flagshipserver.app.api.DemoServerBlock
import com.flagshipserver.app.api.DeviceCapabilityBlock
import com.flagshipserver.app.api.DeviceScope
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.UsernameAvailabilityResponse
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import com.flagshipserver.app.core.HttpException

class DeviceCapabilityBlockTest {

    private val json = Json { ignoreUnknownKeys = true }

    // ─── Wire decode ───────────────────────────────────────────────

    @Test fun decodesFromWorkerWireShape_withBrowseOnlyScopes() {
        val wire = """
            {
              "username": "demo-alice.reviewer",
              "available": false,
              "reason": "device capability",
              "demoServer": {
                "fqdn": "home.demo-alice.flagship.services",
                "status": "up",
                "ttlIdleMinutes": 30
              },
              "deviceCapability": {
                "label": "reviewer",
                "devicePubKey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                "scopes": ["browse"],
                "grantId": "00000000-0000-4000-8000-000000000001",
                "expiresAt": 9999999999999,
                "signature": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
              }
            }
        """.trimIndent()
        val resp = json.decodeFromString(UsernameAvailabilityResponse.serializer(), wire)
        assertEquals("reviewer", resp.deviceCapability?.label)
        assertEquals(listOf("browse"), resp.deviceCapability?.scopes)
        assertEquals(setOf(DeviceScope.BROWSE), resp.deviceCapability?.scopeSet)
        assertEquals(false, resp.deviceCapability?.isFullyScoped)
        assertEquals("home.demo-alice.flagship.services", resp.demoServer?.fqdn)
    }

    @Test fun decodesElevatedDeviceCapabilityWithMultipleScopes() {
        val wire = """
            {
              "username": "demo-alice.work-laptop",
              "available": false,
              "reason": "device capability",
              "deviceCapability": {
                "label": "work-laptop",
                "devicePubKey": "deadbeef0123456789abcdef0123456789abcdef0123456789abcdef00000000",
                "scopes": ["browse", "install-service", "vibe-code"],
                "grantId": "00000000-0000-4000-8000-000000000002",
                "expiresAt": 9999999999999,
                "signature": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
              }
            }
        """.trimIndent()
        val resp = json.decodeFromString(UsernameAvailabilityResponse.serializer(), wire)
        assertEquals(3, resp.deviceCapability?.scopes?.size)
        assertEquals(
            setOf(DeviceScope.BROWSE, DeviceScope.INSTALL_SERVICE, DeviceScope.VIBE_CODE),
            resp.deviceCapability?.scopeSet,
        )
        assertFalse(resp.deviceCapability!!.isFullyScoped)
    }

    @Test fun unknownScopeStringsAreDroppedForwardCompat() {
        // A newer Worker emitting a scope this binary doesn't know
        // MUST NOT crash the client — scopeSet compactMaps unknown
        // wire strings to null so they silently disappear.
        val wire = """
            {
              "username": "demo-alice.reviewer",
              "available": false,
              "reason": "device capability",
              "deviceCapability": {
                "label": "reviewer",
                "devicePubKey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                "scopes": ["browse", "new-future-scope-this-binary-cannot-parse"],
                "grantId": "00000000-0000-4000-8000-000000000003",
                "expiresAt": 9999999999999,
                "signature": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
              }
            }
        """.trimIndent()
        val resp = json.decodeFromString(UsernameAvailabilityResponse.serializer(), wire)
        // Raw list still carries the unknown string — that's fine, the
        // wire-shape round-trip is preserved.
        assertEquals(2, resp.deviceCapability?.scopes?.size)
        // The typed scopeSet drops it.
        assertEquals(setOf(DeviceScope.BROWSE), resp.deviceCapability?.scopeSet)
    }

    @Test fun legacyResponseWithoutCapabilityFieldDecodes() {
        // Backward compat — a pre-v2 Worker / a non-dot username
        // produces a response with no `deviceCapability` field at all.
        val wire = """
            {
              "username": "demo-alice",
              "available": false,
              "reason": "test account",
              "testAccount": {"display":"Demo Alice","ttlHours":24}
            }
        """.trimIndent()
        val resp = json.decodeFromString(UsernameAvailabilityResponse.serializer(), wire)
        assertNull(resp.deviceCapability)
    }

    // ─── Mock branch (mirror-the-Worker-wire-format invariant) ────

    @Test fun mockEmitsDeviceCapabilityForDotForm() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0).apply {
            demoServers = mutableMapOf(
                "demo-alice" to DemoServerBlock(
                    fqdn = "home.demo-alice.flagship.services",
                    status = "up",
                    ttlIdleMinutes = 30,
                )
            )
            deviceCapabilities = mutableMapOf(
                "demo-alice.reviewer" to DeviceCapabilityBlock(
                    label = "reviewer",
                    devicePubKey = "0".repeat(64),
                    scopes = listOf("browse"),
                    grantId = "00000000-0000-4000-8000-000000000010",
                    expiresAt = 9_999_999_999_999L,
                    signature = "0".repeat(128),
                )
            )
        }
        val r = mock.usernameAvailable("demo-alice.reviewer")
        assertEquals(false, r.available)
        assertEquals("reviewer", r.deviceCapability?.label)
        assertEquals(setOf(DeviceScope.BROWSE), r.deviceCapability?.scopeSet)
        // Same underlying demo server is surfaced — the device-restricted
        // pod is the same VPS as the primary device sees.
        assertEquals("home.demo-alice.flagship.services", r.demoServer?.fqdn)
    }

    @Test fun mockReturns404ForUnknownDotForm() = runTest {
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        try {
            mock.usernameAvailable("demo-alice.no-such-device")
            fail("expected HttpException(404)")
        } catch (e: HttpException) {
            assertEquals(404, e.status)
        }
    }

    // ─── DemoFixtures activation ──────────────────────────────────

    @Test fun activateWithDeviceCapability_installsRestrictedSession() = runTest {
        val app = AppState()
        val demo = DemoServerBlock(
            fqdn = "home.demo-alice.flagship.services",
            status = "up",
            ttlIdleMinutes = 30,
        )
        val cap = DeviceCapabilityBlock(
            label = "reviewer",
            devicePubKey = "0".repeat(64),
            scopes = listOf("browse"),
            grantId = "00000000-0000-4000-8000-000000000020",
            expiresAt = 9_999_999_999_999L,
            signature = "0".repeat(128),
        )
        DemoFixtures.activate(
            app,
            username = "demo-alice.reviewer",
            demoServer = demo,
            deviceCapability = cap,
        )
        assertEquals(1, app.pods.value.size)
        assertEquals("home.demo-alice.flagship.services", app.pods.value.first().fqdn)
        assertEquals("reviewer", app.deviceCapability.value?.label)
        assertTrue(app.isRestrictedDevice())
        assertTrue(app.hasScope(DeviceScope.BROWSE))
        assertFalse(app.hasScope(DeviceScope.INSTALL_SERVICE))
        assertFalse(app.hasScope(DeviceScope.VIBE_CODE))
    }

    @Test fun activateWithoutDeviceCapability_leavesScopesOpen() = runTest {
        val app = AppState()
        val demo = DemoServerBlock(
            fqdn = "home.demo-alice.flagship.services",
            status = "up",
            ttlIdleMinutes = 30,
        )
        DemoFixtures.activate(app, username = "demo-alice", demoServer = demo)
        assertNull(app.deviceCapability.value)
        assertFalse(app.isRestrictedDevice())
        // Legacy single-IRK path holds every scope implicitly.
        assertTrue(app.hasScope(DeviceScope.INSTALL_SERVICE))
        assertTrue(app.hasScope(DeviceScope.VIBE_CODE))
    }

    @Test fun signOutClearsDeviceCapability() = runTest {
        val app = AppState()
        val cap = DeviceCapabilityBlock(
            label = "reviewer",
            devicePubKey = "0".repeat(64),
            scopes = listOf("browse"),
            grantId = "00000000-0000-4000-8000-000000000021",
            expiresAt = 9_999_999_999_999L,
            signature = "0".repeat(128),
        )
        val demo = DemoServerBlock(
            fqdn = "home.demo-alice.flagship.services",
            status = "up",
            ttlIdleMinutes = 30,
        )
        DemoFixtures.activate(
            app,
            username = "demo-alice.reviewer",
            demoServer = demo,
            deviceCapability = cap,
        )
        assertNotNull(app.deviceCapability.value)
        app.signOut()
        assertNull(
            app.deviceCapability.value,
            // "signOut must wipe device capability — otherwise the
            //  next account inherits it"
        )
    }
}
