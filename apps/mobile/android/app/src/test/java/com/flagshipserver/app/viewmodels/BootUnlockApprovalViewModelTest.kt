// BootUnlockApprovalViewModel is DIRECTORY-DRIVEN: the pod's cheap
// `awaitingUnlock` flag (no biometric) arms the Approve/Deny prompt, and the
// biometric fires only when the owner taps Approve (a single one-ceremony
// approvePendingUnlock). These tests drive the VM through a fake ApprovalSource
// (no network / biometric), covering the surfacing logic, approve
// success/failure + auto-lease passthrough, Deny latching, and retry. Kotlin
// mirror of iOS BootUnlockApprovalViewModelTests.

package com.flagshipserver.app.viewmodels

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BootUnlockApprovalViewModelTest {

    private val domain = "home.demo1234.flagship.services"

    /** Fake source: records the one-ceremony approve calls and can be told to
     *  throw. */
    private class FakeSource : ApprovalSource {
        var approveError: Throwable? = null
        var leaseId: String? = "lease-1"
        val approveCalls = mutableListOf<Pair<String, Boolean>>()
        val entitlementCalls = mutableListOf<String>()

        /** The key a first sight names; approving another (or none) is answered with its look. */
        var firstSight: com.flagshipserver.app.core.FirstLook? = null
        val acceptedKeys = mutableListOf<String?>()

        override suspend fun approvePendingUnlock(serverDomain: String, depositAutoLease: Boolean, acceptFirstSightKey: String?): String? {
            acceptedKeys += acceptFirstSightKey
            firstSight?.let { if (it.stkPubHex != acceptFirstSightKey) throw com.flagshipserver.app.core.SecretRequestCoordinator.CoordinatorException.FirstLookRequired(it) }
            approveError?.let { throw it }
            approveCalls.add(serverDomain to depositAutoLease)
            return leaseId
        }

        override suspend fun approvePendingEntitlement(serverDomain: String, acceptFirstSightKey: String?): String? {
            approveError?.let { throw it }
            entitlementCalls.add(serverDomain)
            return null
        }
    }

    private fun vm(
        source: FakeSource,
        sourceOrNull: Boolean = true,
        autoLease: Boolean = true,
        purpose: com.flagshipserver.app.core.SecretPurpose = com.flagshipserver.app.core.SecretPurpose.UNLOCK_KEY,
    ) = BootUnlockApprovalViewModel(
        serverDomain = domain,
        makeSource = { if (sourceOrNull) source else null },
        depositAutoLease = { autoLease },
        purpose = purpose,
    )

    // ---- Directory-driven surfacing (NO biometric) ----------------------

    @Test fun awaitingTrue_armsRequestPending() {
        val m = vm(FakeSource())
        m.setAwaitingUnlock(true)
        assertEquals(BootUnlockApprovalViewModel.State.RequestPending, m.state.value)
    }

    @Test fun awaitingFalse_isIdle() {
        val m = vm(FakeSource())
        m.setAwaitingUnlock(true)
        m.setAwaitingUnlock(false)
        assertEquals(BootUnlockApprovalViewModel.State.Idle, m.state.value)
    }

    /** Box Request Inbox parity: an ENTITLEMENT card dispatches to
     *  approvePendingEntitlement (NOT the unlock path), so a box stuck on
     *  serve-authorization is approvable from the same card. Closes the
     *  silent-box hole (mobile had no entitlement surfacing). */
    @Test fun entitlementPurpose_dispatchesToEntitlementApproval() = runTest {
        val source = FakeSource()
        val m = vm(source, purpose = com.flagshipserver.app.core.SecretPurpose.ENTITLEMENT)
        m.approve()
        assertEquals(BootUnlockApprovalViewModel.State.Approved, m.state.value)
        assertEquals(listOf(domain), source.entitlementCalls)
        assertTrue("entitlement must NOT take the unlock path", source.approveCalls.isEmpty())
    }

    // ---- First contact (docs/first-contact.md) --------------------------

    /** A first sight shows the code computed on the phone, and Approve then pins that very key. */
    @Test fun firstSight_showsTheCodeThenApprovesThatKey() = runTest {
        val key = "ab".repeat(32)
        val look = com.flagshipserver.app.core.FirstLook(domain, key, com.flagshipserver.app.core.Enrollment.serverCode(key)!!, studioConfirmed = false, proven = false)
        val source = FakeSource().apply { firstSight = look }
        val m = vm(source)
        m.setAwaitingUnlock(true)
        m.approve()
        assertEquals(BootUnlockApprovalViewModel.State.ConfirmCode(look), m.state.value)
        assertTrue(source.approveCalls.isEmpty())
        m.setAwaitingUnlock(true)
        assertEquals("the code stays up while the box waits", BootUnlockApprovalViewModel.State.ConfirmCode(look), m.state.value)
        m.approveShownKey()
        assertEquals(BootUnlockApprovalViewModel.State.Approved, m.state.value)
        assertEquals(listOf(null, key), source.acceptedKeys)
    }

    @Test fun refusal_isShownInItsOwnWords() = runTest {
        val source = FakeSource().apply {
            approveError = com.flagshipserver.app.core.SecretRequestCoordinator.CoordinatorException.Refused(com.flagshipserver.app.core.FirstContactRefusal.KEY_CHANGED)
        }
        val m = vm(source)
        m.approve()
        assertEquals(
            BootUnlockApprovalViewModel.State.Failed("This server's key changed. If you did not rebuild it, do not approve anything for it."),
            m.state.value,
        )
    }

    // ---- approve() — one ceremony ---------------------------------------

    @Test fun approve_autoServer_passesDepositTrue_andApproves() = runTest {
        val source = FakeSource()
        val m = vm(source, autoLease = true)
        m.setAwaitingUnlock(true)
        m.approve()
        assertEquals(BootUnlockApprovalViewModel.State.Approved, m.state.value)
        assertEquals(1, source.approveCalls.size)
        assertEquals(domain, source.approveCalls[0].first)
        assertTrue("auto server must deposit a lease", source.approveCalls[0].second)
    }

    @Test fun approve_approveModeServer_passesDepositFalse() = runTest {
        val source = FakeSource()
        val m = vm(source, autoLease = false)
        m.setAwaitingUnlock(true)
        m.approve()
        assertEquals(BootUnlockApprovalViewModel.State.Approved, m.state.value)
        assertEquals(false, source.approveCalls[0].second)
    }

    @Test fun approve_failure_setsFailed() = runTest {
        val source = FakeSource().apply { approveError = RuntimeException("nope") }
        val m = vm(source)
        m.setAwaitingUnlock(true)
        m.approve()
        assertTrue(m.state.value is BootUnlockApprovalViewModel.State.Failed)
    }

    @Test fun approve_noSource_failsWithSignInMessage() = runTest {
        val m = vm(FakeSource(), sourceOrNull = false)
        m.setAwaitingUnlock(true)
        m.approve()
        val s = m.state.value
        assertTrue(s is BootUnlockApprovalViewModel.State.Failed)
        assertEquals("Sign in to approve this server.", (s as BootUnlockApprovalViewModel.State.Failed).message)
    }

    @Test fun approved_terminal_lateAwaitingFalseDoesNotUndo() = runTest {
        val source = FakeSource()
        val m = vm(source)
        m.setAwaitingUnlock(true)
        m.approve()
        assertEquals(BootUnlockApprovalViewModel.State.Approved, m.state.value)
        // The box answered; the directory flag clears — must not undo success.
        m.setAwaitingUnlock(false)
        assertEquals(BootUnlockApprovalViewModel.State.Approved, m.state.value)
    }

    // ---- Deny + retry ---------------------------------------------------

    @Test fun deny_latches_staysIdleWhileStillAwaiting() {
        val m = vm(FakeSource())
        m.setAwaitingUnlock(true)
        m.deny()
        assertEquals(BootUnlockApprovalViewModel.State.Idle, m.state.value)
        // Directory still says awaiting, but the user denied this session.
        m.setAwaitingUnlock(true)
        assertEquals(BootUnlockApprovalViewModel.State.Idle, m.state.value)
    }

    @Test fun retry_afterFailure_rearmsPending() = runTest {
        val source = FakeSource().apply { approveError = RuntimeException("blip") }
        val m = vm(source)
        m.setAwaitingUnlock(true)
        m.approve()
        assertTrue(m.state.value is BootUnlockApprovalViewModel.State.Failed)
        m.retry()
        assertEquals(BootUnlockApprovalViewModel.State.RequestPending, m.state.value)
    }

    @Test fun failedThenAwaitingFalse_clearsToIdle() = runTest {
        val source = FakeSource().apply { approveError = RuntimeException("blip") }
        val m = vm(source)
        m.setAwaitingUnlock(true)
        m.approve()
        assertTrue(m.state.value is BootUnlockApprovalViewModel.State.Failed)
        // Box gave up — the moot failure clears.
        m.setAwaitingUnlock(false)
        assertEquals(BootUnlockApprovalViewModel.State.Idle, m.state.value)
    }
}
