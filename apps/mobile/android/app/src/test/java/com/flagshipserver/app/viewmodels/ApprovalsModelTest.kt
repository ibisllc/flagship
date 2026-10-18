package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.HttpException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The Server approvals list: an answer clears its card at once, "already
// answered" (409) is not an error, and any other failure keeps the card and
// says why.
class ApprovalsModelTest {
    private val raw = """{"error":"already answered"}"""

    private class Fixture(initial: List<String>, scope: TestScope, val respond: suspend (String) -> Unit) {
        var server = initial.toMutableList()
        var fetchFails: Throwable? = null
        var fetches = 0
        val model = ApprovalsModel<String>(
            scope = scope,
            idOf = { it },
            fetch = { fetches++; fetchFails?.let { throw it }; server.toList() },
            respond = { respond(it) },
            loadFailure = { "load failed: ${it.message}" },
            answerFailure = { item, t -> "Couldn't approve $item. ${t.message}" },
        )
        fun loaded() = (model.state.value as LoadingState.Loaded).value
    }

    @Test fun loadsTheWaitingRequestsAndCountsThem() = runTest(StandardTestDispatcher()) {
        val f = Fixture(listOf("a", "b"), this) {}
        assertTrue(f.model.state.value is LoadingState.Idle)
        f.model.reload(); advanceUntilIdle()
        assertEquals(listOf("a", "b"), f.loaded())
        assertEquals(2, f.model.count)
    }

    @Test fun anEmptyListIsLoadedAndEmpty() = runTest(StandardTestDispatcher()) {
        val f = Fixture(emptyList(), this) {}
        f.model.reload(); advanceUntilIdle()
        assertEquals(emptyList<String>(), f.loaded())
        assertEquals(0, f.model.count)
    }

    @Test fun aFailedLoadSaysSoAndTryAgainLoads() = runTest(StandardTestDispatcher()) {
        val f = Fixture(listOf("a"), this) {}
        f.fetchFails = RuntimeException("down")
        f.model.reload(); advanceUntilIdle()
        assertEquals("load failed: down", (f.model.state.value as LoadingState.Failed).message)
        f.fetchFails = null
        f.model.reload(); advanceUntilIdle()
        assertEquals(listOf("a"), f.loaded())
    }

    @Test fun aRefreshThatFailsKeepsTheListOnScreen() = runTest(StandardTestDispatcher()) {
        val f = Fixture(listOf("a"), this) {}
        f.model.reload(); advanceUntilIdle()
        f.fetchFails = RuntimeException("blip")
        f.model.reload(); advanceUntilIdle()
        assertEquals(listOf("a"), f.loaded())
    }

    @Test fun approvingClearsTheCardAtOnceBeforeTheRefetch() = runTest(StandardTestDispatcher()) {
        val f = Fixture(listOf("a", "b"), this) { }
        f.model.reload(); advanceUntilIdle()
        // The server still lists "a" (the refetch is slow to catch up): the card is gone anyway.
        var seen: List<String>? = null
        f.model.approve("a") { seen = f.loaded() }
        advanceUntilIdle()
        assertEquals(listOf("b"), seen)
    }

    @Test fun anApprovalAnsweredElsewhereIsDoneNotAnError() = runTest(StandardTestDispatcher()) {
        val f = Fixture(listOf("a"), this) { throw HttpException(409, raw) }
        f.model.reload(); advanceUntilIdle()
        f.server.clear()
        var outcome: ApprovalsModel.Outcome? = null
        f.model.approve("a") { outcome = it }
        advanceUntilIdle()
        assertEquals(ApprovalsModel.Outcome.AlreadyAnswered, outcome)
        assertEquals(emptyList<String>(), f.loaded())
        assertEquals(null, f.model.inFlightId.value)
    }

    @Test fun anotherFailureKeepsTheCardAndSaysWhy() = runTest(StandardTestDispatcher()) {
        val f = Fixture(listOf("a"), this) { throw HttpException(500, "boom") }
        f.model.reload(); advanceUntilIdle()
        val fetchesBefore = f.fetches
        var outcome: ApprovalsModel.Outcome? = null
        f.model.approve("a") { outcome = it }
        advanceUntilIdle()
        assertTrue(outcome is ApprovalsModel.Outcome.Failed)
        assertTrue((outcome as ApprovalsModel.Outcome.Failed).message.startsWith("Couldn't approve a."))
        assertEquals(listOf("a"), f.loaded())
        assertEquals(fetchesBefore, f.fetches)
    }

    @Test fun aSecondTapWhileOneIsRunningDoesNothing() = runTest(StandardTestDispatcher()) {
        val gate = CompletableDeferred<Unit>()
        var responded = 0
        val f = Fixture(listOf("a"), this) { responded++; gate.await() }
        f.model.reload(); advanceUntilIdle()
        f.model.approve("a"); advanceUntilIdle()
        f.model.approve("a"); advanceUntilIdle()
        assertEquals("a", f.model.inFlightId.value)
        gate.complete(Unit); advanceUntilIdle()
        assertEquals(1, responded)
    }

    @Test fun onlyA409CountsAsAlreadyAnswered() {
        assertTrue(ApprovalsModel.isAlreadyAnswered(HttpException(409, raw)))
        assertTrue(ApprovalsModel.isAlreadyAnswered(RuntimeException("x", HttpException(409, raw))))
        assertFalse(ApprovalsModel.isAlreadyAnswered(HttpException(500, "boom")))
        assertFalse(ApprovalsModel.isAlreadyAnswered(RuntimeException("HTTP 409")))
    }
}
