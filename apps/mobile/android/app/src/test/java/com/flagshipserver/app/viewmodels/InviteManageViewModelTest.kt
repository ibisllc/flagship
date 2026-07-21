// P6 — InviteManageViewModel state machine + revoke happy path +
// idempotency. Mirrors FlagshipMobileTests/InviteManageViewModelTests.swift 1:1.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppInviteAccessResponse
import com.flagshipserver.app.api.AppInviteAccessSummary
import com.flagshipserver.app.api.AppInviteListResponse
import com.flagshipserver.app.api.AppInvitePendingSummary
import com.flagshipserver.app.api.AppInviteRevokeRequest
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.core.InMemoryInviteLabelBook
import com.flagshipserver.app.core.InviteLabel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class InviteManageViewModelTest {

    private fun makePending(opaqueTag: String, inviteId: String, role: String = "member") =
        AppInvitePendingSummary(opaqueTag, inviteId, role, 1_800_000_000_000L)

    private fun makeAccess(opaqueTag: String, irkPubHex: String, role: String = "member") =
        AppInviteAccessSummary(opaqueTag, irkPubHex, role, 1_700_000_000_000L)

    @Test fun load_idleToLoaded_withEmptyDefaults() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = InviteManageViewModel(
            serviceId = "harry--plants",
            client = client,
            labelBook = InMemoryInviteLabelBook(),
            scope = backgroundScope,
        )
        vm.load().join()
        val s = vm.state.first() as LoadingState.Loaded
        assertTrue(s.value.pending.isEmpty())
        assertTrue(s.value.access.isEmpty())
    }

    @Test fun load_pinnedFixtures_areReturnedVerbatim() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0).apply {
            appInviteListFixture = AppInviteListResponse(
                pending = listOf(
                    makePending("aa".repeat(16), "inv-1", "admin"),
                    makePending("bb".repeat(16), "inv-2", "reader"),
                ),
            )
            appInviteAccessFixture = AppInviteAccessResponse(
                access = listOf(
                    makeAccess("cc".repeat(16), "ee".repeat(32), "member"),
                ),
            )
        }
        val book = InMemoryInviteLabelBook().apply {
            put(
                "harry--plants",
                "aa".repeat(16),
                InviteLabel("John (work)", "imessage", "x", "", 1),
            )
        }
        val vm = InviteManageViewModel(
            serviceId = "harry--plants",
            client = client,
            labelBook = book,
            scope = backgroundScope,
        )
        vm.load().join()
        val s = vm.state.first() as LoadingState.Loaded
        assertEquals(2, s.value.pending.size)
        assertEquals(1, s.value.access.size)
        assertEquals("inv-1", s.value.pending[0].inviteId)
        assertEquals("admin", s.value.pending[0].role)

        assertEquals("John (work)", vm.label("aa".repeat(16))?.displayName)
        assertNull(vm.label("bb".repeat(16)))
    }

    @Test fun revokeInvite_sendsScopeInviteAndPurgesLocalLabel() = runTest {
        val tag = "ab".repeat(16)
        val client = MockScreensClient(simulatedLatencyMs = 0).apply {
            appInviteListFixture = AppInviteListResponse(pending = listOf(makePending(tag, "inv-99")))
            appInviteAccessFixture = AppInviteAccessResponse(access = emptyList())
        }
        val book = InMemoryInviteLabelBook().apply {
            put(
                "harry--plants",
                tag,
                InviteLabel("x", "other", "", "", 1),
            )
        }
        val vm = InviteManageViewModel(
            serviceId = "harry--plants",
            client = client,
            labelBook = book,
            scope = backgroundScope,
        )
        vm.load().join()
        vm.revokeInvite("inv-99", tag).join()

        assertEquals(1, client.appInviteRevokeCalls.size)
        val revoke = client.appInviteRevokeCalls[0]
        assertEquals("invite", revoke.scope)
        assertEquals("harry--plants", revoke.serviceId)
        assertEquals("inv-99", revoke.inviteId)
        assertNull(revoke.irkPubKey)

        assertNull(book.get("harry--plants", tag))
        assertEquals("revoked", vm.lastRevokeOutcome.first())
    }

    @Test fun revokeAccess_sendsScopeAccessWithIrkPubKey() = runTest {
        val irk = "11".repeat(32)
        val client = MockScreensClient(simulatedLatencyMs = 0).apply {
            appInviteListFixture = AppInviteListResponse(pending = emptyList())
            appInviteAccessFixture = AppInviteAccessResponse(
                access = listOf(makeAccess("cd".repeat(16), irk)),
            )
        }
        val vm = InviteManageViewModel(
            serviceId = "harry--plants",
            client = client,
            labelBook = InMemoryInviteLabelBook(),
            scope = backgroundScope,
        )
        vm.load().join()
        vm.revokeAccess(irk, "cd".repeat(16)).join()

        assertEquals(1, client.appInviteRevokeCalls.size)
        val revoke = client.appInviteRevokeCalls[0]
        assertEquals("access", revoke.scope)
        assertEquals(irk, revoke.irkPubKey)
        assertNull(revoke.inviteId)
    }

    @Test fun revokeInvite_idempotentReportsAlreadyRevoked() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = InviteManageViewModel(
            serviceId = "harry--plants",
            client = client,
            labelBook = InMemoryInviteLabelBook(),
            scope = backgroundScope,
        )
        vm.load().join()
        vm.revokeInvite("inv-1", null).join()
        vm.revokeInvite("inv-1", null).join()
        assertEquals("already revoked", vm.lastRevokeOutcome.first())
    }

    @Test fun load_clientFailure_landsInFailed() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0).apply { shouldFail = true }
        val vm = InviteManageViewModel(
            serviceId = "harry--plants",
            client = client,
            labelBook = InMemoryInviteLabelBook(),
            scope = backgroundScope,
        )
        vm.load().join()
        val s = vm.state.first()
        assertTrue("expected Failed, was $s", s is LoadingState.Failed)
    }

    @Test fun appInviteRevokeRequest_serializesUnionShape() {
        val json = Json { encodeDefaults = true; explicitNulls = false }
        val req = AppInviteRevokeRequest.invite("harry--plants", "inv-7")
        val encoded = json.encodeToString(AppInviteRevokeRequest.serializer(), req)
        assertTrue(encoded.contains("\"scope\":\"invite\""))
        assertTrue(encoded.contains("\"inviteId\":\"inv-7\""))
        // No null `irkPubKey` should bleed through — explicitNulls = false.
        assertTrue("expected no irkPubKey in $encoded", !encoded.contains("\"irkPubKey\""))
    }
}
