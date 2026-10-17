// The API key flows (docs/app-apis.md §3) against the mock box: list, create
// (signed grant, key shown once), revoke, refusals, and the hidden section on
// a box without API keys.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppApiKeyInfo
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.AppApiKey
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.ServerKeys
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

class AppApiKeysFlowTest {
    private val seed = ServerKeys.deriveProtocolIrkSeed(ByteArray(32) { 0x2a })
    private val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
    private val issuedAt = 1_700_000_000_000L
    private val plants = "bright-maple--plants"

    private fun vm(
        mock: MockScreensClient,
        serviceId: String = plants,
        reasons: MutableList<String> = mutableListOf(),
        keyIds: ArrayDeque<String> = ArrayDeque(listOf("0123456789abcdef")),
        fallback: () -> String? = { null },
    ) = AppApiKeysViewModel(
        serviceId = serviceId,
        client = mock,
        appName = "Plants",
        fallbackServerDomain = fallback,
        signer = { r -> reasons += r; Ed25519Sign(seed) },
        now = { issuedAt },
        newKeyId = { keyIds.removeFirst() },
    )

    private fun loadedKeys(vm: AppApiKeysViewModel): List<AppApiKeyInfo> =
        (vm.phase.value as AppApiKeysViewModel.Phase.Loaded).keys

    @Test fun loadListsTheKeys() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val vm = vm(mock)
        vm.load()
        assertEquals(listOf("Garden sensor"), loadedKeys(vm).map { it.label })
    }

    @Test fun aBoxWithoutApiKeysHidesTheSection() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val vm = vm(mock, serviceId = "trent--scratchpad")
        vm.load()
        assertEquals(AppApiKeysViewModel.Phase.Unsupported, vm.phase.value)
    }

    @Test fun otherLoadFailuresAreShown() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0, shouldFail = true)
        val vm = vm(mock)
        vm.load()
        assertTrue(vm.phase.value is AppApiKeysViewModel.Phase.Failed)
    }

    @Test fun createSignsTheGrantForThisBoxAndShowsTheKeyOnce() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val reasons = mutableListOf<String>()
        val vm = vm(mock, reasons = reasons)
        vm.load()

        assertTrue(vm.create("  Home Assistant ", AppApiKey.SCOPE_WRITE))
        val (id, req) = mock.apiKeyCreates.single()
        assertEquals(plants, id)
        val g = req.grant
        assertEquals("home.bright-maple.flagship.services", g.serverDomain)
        assertEquals(plants, g.serviceId)
        assertEquals("0123456789abcdef", g.keyId)
        assertEquals("write", g.scope)
        assertEquals(issuedAt, g.issuedAt)
        assertEquals(0L, g.expiresAt)
        assertEquals("Home Assistant", req.label)
        Ed25519Verify(pub).verify(
            HexUtil.decode(req.signature)!!,
            AppApiKey.canonicalBytes(g.serverDomain, g.serviceId, g.keyId, g.scope, g.expiresAt, g.issuedAt),
        )
        assertEquals(listOf("Create an API key for Plants"), reasons)

        val created = vm.created.value!!
        assertEquals("Home Assistant", created.label)
        assertTrue(created.key.startsWith("fsk_0123456789abcdef_"))
        assertEquals("Authorization: Bearer ${created.key}", AppApiKeysViewModel.usageLine(created.key))
        assertEquals(listOf("Garden sensor", "Home Assistant"), loadedKeys(vm).map { it.label })
        // The list never carries the secret, and closing the dialog forgets it.
        vm.dismissCreated()
        assertNull(vm.created.value)
    }

    @Test fun keysNeverExpire_aReadKeySendsZero() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val vm = vm(mock)
        assertTrue(vm.create("Sensor", AppApiKey.SCOPE_READ))
        assertEquals(0L, mock.apiKeyCreates.single().second.grant.expiresAt)
        assertEquals("read", mock.apiKeyCreates.single().second.grant.scope)
    }

    @Test fun aBlankLabelSendsNothing() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val vm = AppApiKeysViewModel(plants, mock, signer = { error("must not sign") })
        assertFalse(vm.create("   ", AppApiKey.SCOPE_READ))
        assertEquals(AppApiKeysViewModel.LABEL_REQUIRED, vm.error.value)
        assertTrue(mock.apiKeyCreates.isEmpty())
    }

    /** The box this client talks to can't name itself: the fallback is the paired box. */
    private class NamelessBox(val inner: MockScreensClient = MockScreensClient(simulatedLatencyMs = 0)) :
        com.flagshipserver.app.api.ScreensClient by inner {
        override suspend fun boxFqdn(): String? = null
    }

    @Test fun theGrantNamesThePairedBoxNotTheLeader() = runTest {
        val box = NamelessBox()
        val vm = AppApiKeysViewModel(
            plants, box, "Plants",
            fallbackServerDomain = { "box2.bright-maple.flagship.services" },
            signer = { Ed25519Sign(seed) }, now = { issuedAt }, newKeyId = { "00000000000000aa" },
        )
        // The mock box refuses a grant for another server, so check what was sent.
        assertFalse(vm.create("k", AppApiKey.SCOPE_READ))
        assertEquals("box2.bright-maple.flagship.services", box.inner.apiKeyCreates.single().second.grant.serverDomain)

        val none = AppApiKeysViewModel(plants, box, fallbackServerDomain = { null }, signer = { error("must not sign") })
        assertFalse(none.create("k", AppApiKey.SCOPE_READ))
        assertEquals("Couldn't tell which server this app is on.", none.error.value)
        assertEquals(1, box.inner.apiKeyCreates.size)
    }

    @Test fun aKeyIdClashRetriesOnceWithAFreshId() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        mock.apiKeysFixture[plants]!!.add(AppApiKeyInfo("0123456789abcdef", "Old", "read", 1, null, 0))
        val reasons = mutableListOf<String>()
        val vm = vm(mock, reasons = reasons, keyIds = ArrayDeque(listOf("0123456789abcdef", "fedcba9876543210")))
        assertTrue(vm.create("New", AppApiKey.SCOPE_READ))
        assertEquals(listOf("0123456789abcdef", "fedcba9876543210"), mock.apiKeyCreates.map { it.second.grant.keyId })
        val g = mock.apiKeyCreates.last().second.grant
        Ed25519Verify(pub).verify(
            HexUtil.decode(mock.apiKeyCreates.last().second.signature)!!,
            AppApiKey.canonicalBytes(g.serverDomain, g.serviceId, g.keyId, g.scope, g.expiresAt, g.issuedAt),
        )
        assertEquals(0L, g.expiresAt)
        // One biometric prompt covers the retry.
        assertEquals(1, reasons.size)
        assertTrue(vm.created.value!!.key.startsWith("fsk_fedcba9876543210_"))
    }

    @Test fun aReplyWithoutTheKeyIsReported() = runTest {
        val box = object : com.flagshipserver.app.api.ScreensClient by MockScreensClient(simulatedLatencyMs = 0) {
            var reply: String? = null
            override suspend fun serviceApiKeyCreate(
                serviceId: String,
                req: com.flagshipserver.app.api.AppApiKeyCreateRequest,
            ) = com.flagshipserver.app.api.AppApiKeyCreateResponse(ok = true, key = reply)
        }
        for (reply in listOf(null, "", "fsk_ffffffffffffffff_abc", "fsk_0123456789abcdef_", "fsk_0123456789abcdef_a b")) {
            box.reply = reply
            val vm = AppApiKeysViewModel(plants, box, signer = { Ed25519Sign(seed) }, newKeyId = { "0123456789abcdef" })
            assertFalse(reply.toString(), vm.create("k", AppApiKey.SCOPE_READ))
            assertEquals(AppApiKeysViewModel.NO_KEY_RETURNED, vm.error.value)
            assertNull(vm.created.value)
        }
    }

    @Test fun labelsAreOneTo64CharactersAfterTrimming() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val ids = ArrayDeque(listOf("00000000000000a1", "00000000000000a2"))
        val vm = vm(mock, keyIds = ids)
        assertFalse(vm.create("x".repeat(65), AppApiKey.SCOPE_READ))
        assertEquals(AppApiKeysViewModel.LABEL_TOO_LONG, vm.error.value)
        assertTrue(mock.apiKeyCreates.isEmpty())
        assertTrue(vm.create("  " + "x".repeat(64) + "  ", AppApiKey.SCOPE_READ))
        assertEquals("x".repeat(64), mock.apiKeyCreates.single().second.label)
    }

    @Test fun theFormPreselectsRead() {
        assertEquals(AppApiKey.SCOPE_READ, AppApiKeysViewModel.DEFAULT_SCOPE)
    }

    @Test fun refusalsAreShownPlainly() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val vm = vm(mock, keyIds = ArrayDeque(List(5) { "0123456789abcde$it" }))
        mock.apiKeysError = ScreensError.Http(403, """{"error":"issuedAt too far off"}""")
        assertFalse(vm.create("k", AppApiKey.SCOPE_READ))
        assertEquals("The server refused this key: issuedAt too far off.", vm.error.value)
        assertNull(vm.created.value)

        mock.apiKeysError = ScreensError.Http(409, """{"error":"key id exists"}""")
        val before = mock.apiKeyCreates.size
        assertFalse(vm.create("k", AppApiKey.SCOPE_READ))
        assertEquals("Couldn't pick a free key id. Try again.", vm.error.value)
        assertEquals(before + 2, mock.apiKeyCreates.size)

        mock.apiKeysError = ScreensError.Http(404, """{"error":"not found"}""")
        assertFalse(vm.create("k", AppApiKey.SCOPE_READ))
        assertEquals("This app is no longer installed on the server.", vm.error.value)

        mock.apiKeysError = null
        assertTrue(vm.create("k", AppApiKey.SCOPE_READ))
        assertNull(vm.error.value)
    }

    @Test fun aSigningFailureSendsNothing() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val vm = AppApiKeysViewModel(plants, mock, signer = { throw IllegalStateException("cancelled") })
        assertFalse(vm.create("k", AppApiKey.SCOPE_READ))
        assertEquals("Couldn't access your account key: cancelled", vm.error.value)
        assertTrue(mock.apiKeyCreates.isEmpty())
    }

    @Test fun revokeDeletesWithoutSigning() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val vm = AppApiKeysViewModel(plants, mock, signer = { error("must not sign") })
        vm.load()
        val key = loadedKeys(vm).single()
        assertTrue(vm.revoke(key.keyId))
        assertEquals(listOf(plants to key.keyId), mock.apiKeyRevokes)
        assertTrue(loadedKeys(vm).isEmpty())
        assertTrue(mock.apiKeysFixture[plants]!!.isEmpty())
    }

    @Test fun revokingAKeyAlreadyGoneSucceeds_otherRefusalsKeepIt() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val vm = vm(mock)
        vm.load()
        val key = loadedKeys(vm).single()

        mock.apiKeysError = ScreensError.Http(403, """{"error":"read-only session"}""")
        assertFalse(vm.revoke(key.keyId))
        assertEquals("This device can't revoke keys: read-only session.", vm.error.value)
        assertEquals(1, loadedKeys(vm).size)

        mock.apiKeysError = ScreensError.Http(404, """{"error":"no such key"}""")
        assertTrue(vm.revoke(key.keyId))
        assertTrue(loadedKeys(vm).isEmpty())
    }

    @Test fun rowText() {
        val now = 1_760_000_000_000L
        val day = 86_400_000L
        val utc = ZoneOffset.UTC
        assertEquals("Read", AppApiKeysViewModel.scopeText("read"))
        assertEquals("Read & write", AppApiKeysViewModel.scopeText("write"))

        val fresh = AppApiKeyInfo("0123456789abcdef", "", "read", now - day, null, 0)
        assertEquals("0123456789abcdef", AppApiKeysViewModel.displayLabel(fresh))
        assertEquals("Never used", AppApiKeysViewModel.lastUsedText(fresh, now, utc))
        // No expiry line unless a box reports a lapsed key.
        assertNull(AppApiKeysViewModel.expiredText(fresh, now, utc))
        assertNull(AppApiKeysViewModel.expiredText(fresh.copy(expiresAt = null), now, utc))
        assertFalse(AppApiKeysViewModel.isExpired(fresh, now))
        assertEquals(2, AppApiKeysViewModel.detailText(fresh, now, utc).split(" · ").size)

        val used = fresh.copy(lastUsedAt = now - 3 * 60 * 60_000L, expiresAt = now + 30 * day)
        assertEquals("Last used 3 hr ago", AppApiKeysViewModel.lastUsedText(used, now, utc))
        assertNull(AppApiKeysViewModel.expiredText(used, now, utc))
        assertFalse(AppApiKeysViewModel.detailText(used, now, utc).contains("xpire"))

        val expired = fresh.copy(expiresAt = now - day)
        assertTrue(AppApiKeysViewModel.isExpired(expired, now))
        assertTrue(AppApiKeysViewModel.expiredText(expired, now, utc)!!.startsWith("Expired "))
        assertEquals(3, AppApiKeysViewModel.detailText(expired, now, utc).split(" · ").size)
    }
}
