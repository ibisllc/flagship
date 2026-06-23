// P6 — InviteIssueViewModel state machine + wire-shape parity. Mirrors
// FlagshipMobileTests/InviteIssueViewModelTests.swift 1:1.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppInviteIssueResponse
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.core.InMemoryInviteLabelBook
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class InviteIssueViewModelTest {

    @Test fun issue_happyPath_sendsWireShapeAndPersistsLabel() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0).apply {
            appInviteIssueFixture = AppInviteIssueResponse(
                secret = "deadbeefcafebabe1234567890abcdef".repeat(2),
                expiresAt = 1_800_000_000_000L,
            )
        }
        val book = InMemoryInviteLabelBook()
        val vm = InviteIssueViewModel(
            serviceId = "harry--plants",
            appUrl = "https://plants.harry.flagship.services",
            client = client,
            labelBook = book,
            tagMint = { "00112233445566778899aabbccddeeff" },
            now = { 1_700_000_000_000L },
            scope = backgroundScope,
        )
        vm.displayName.value = "John (work)"
        vm.role.value = "admin"
        vm.channel.value = "imessage"
        vm.sentTo.value = "+1 555 0142"
        vm.contextNote.value = "from harry's phone"

        vm.issue().join()
        val phase = vm.phase.first()
        assertTrue("expected Issued, was $phase", phase is InviteIssueViewModel.Phase.Issued)
        val issued = phase as InviteIssueViewModel.Phase.Issued
        assertEquals("deadbeefcafebabe1234567890abcdef".repeat(2), issued.secret)
        assertEquals(1_800_000_000_000L, issued.expiresAt)
        assertEquals(
            "https://plants.harry.flagship.services/invite#k=${issued.secret}&a=harry--plants",
            issued.shareUrl,
        )

        assertEquals(1, client.appInviteIssueCalls.size)
        val req = client.appInviteIssueCalls[0]
        assertEquals("harry--plants", req.serviceId)
        assertEquals("admin", req.role)
        assertEquals("00112233445566778899aabbccddeeff", req.opaqueTag)
        assertEquals("from harry's phone", req.contextNote)

        val row = book.get("harry--plants", "00112233445566778899aabbccddeeff")
        assertEquals("John (work)", row?.displayName)
        assertEquals("imessage", row?.channel)
        assertEquals("+1 555 0142", row?.sentTo)
    }

    @Test fun issue_emptyContext_sendsNullOnTheWire() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = InviteIssueViewModel(
            serviceId = "harry--plants",
            appUrl = "https://x.flagship.services",
            client = client,
            labelBook = InMemoryInviteLabelBook(),
            scope = backgroundScope,
        )
        vm.displayName.value = "John"
        vm.contextNote.value = "   "
        vm.issue().join()
        assertEquals(1, client.appInviteIssueCalls.size)
        assertNull(client.appInviteIssueCalls[0].contextNote)
    }

    @Test fun issue_emptyDisplayName_failsLocallyAndSkipsWire() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = InviteIssueViewModel(
            serviceId = "harry--plants",
            appUrl = "https://x.flagship.services",
            client = client,
            labelBook = InMemoryInviteLabelBook(),
            scope = backgroundScope,
        )
        vm.displayName.value = "   "
        vm.issue().join()
        val phase = vm.phase.first()
        assertTrue("expected Failed, was $phase", phase is InviteIssueViewModel.Phase.Failed)
        assertTrue(
            (phase as InviteIssueViewModel.Phase.Failed).message.lowercase().contains("label"),
        )
        assertEquals(0, client.appInviteIssueCalls.size)
    }

    @Test fun issue_tagIsDistinctPerCall() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = InviteIssueViewModel(
            serviceId = "harry--plants",
            appUrl = "https://x.flagship.services",
            client = client,
            labelBook = InMemoryInviteLabelBook(),
            scope = backgroundScope,
        )
        vm.displayName.value = "A"
        vm.issue().join()
        val first = vm.lastOpaqueTag.first()
        assertNotNull(first)
        vm.reset()
        vm.displayName.value = "B"
        vm.issue().join()
        val second = vm.lastOpaqueTag.first()
        assertNotNull(second)
        assertNotEquals(first, second)
        assertEquals(2, client.appInviteIssueCalls.size)
    }

    @Test fun issue_clientFailure_landsInFailed() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0).apply { shouldFail = true }
        val vm = InviteIssueViewModel(
            serviceId = "harry--plants",
            appUrl = "https://x.flagship.services",
            client = client,
            labelBook = InMemoryInviteLabelBook(),
            scope = backgroundScope,
        )
        vm.displayName.value = "John"
        vm.issue().join()
        val phase = vm.phase.first()
        assertTrue("expected Failed, was $phase", phase is InviteIssueViewModel.Phase.Failed)
    }
}
