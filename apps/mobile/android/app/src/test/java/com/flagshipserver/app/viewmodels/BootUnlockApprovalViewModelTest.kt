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

        override suspend fun approvePendingUnlock(serverDomain: String, depositAutoLease: Boolean): String? {
            approveError?.let { throw it }
            approveCalls.add(serverDomain to depositAutoLease)
            return leaseId
        }
    }

    private fun vm(
        source: FakeSource,
        sourceOrNull: Boolean = true,
        autoLease: Boolean = true,
    ) = BootUnlockApprovalViewModel(
        serverDomain = domain,
        makeSource = { if (sourceOrNull) source else null },
        depositAutoLease = { autoLease },
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
        assertEquals("Sign in to approve this box.", (s as BootUnlockApprovalViewModel.State.Failed).message)
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
