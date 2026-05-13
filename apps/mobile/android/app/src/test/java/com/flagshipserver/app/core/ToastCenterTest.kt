// Validates the dedup + auto-dismiss behavior of ToastCenter.

package com.flagshipserver.app.core

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

@OptIn(ExperimentalCoroutinesApi::class)
class ToastCenterTest {
    @Test fun info_enqueuesOnce_dedupedBy_message() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val scope = TestScope(dispatcher)
        val tc = ToastCenter(scope)
        tc.info("hello")
        tc.info("hello")     // dedup
        tc.success("hello")  // different kind, allowed
        assertEquals(2, tc.queue.first().size)
    }

    @Test fun toast_autoDismissesAfterDuration() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val scope = TestScope(dispatcher)
        val tc = ToastCenter(scope)
        tc.info("hi", duration = 500.milliseconds)
        assertEquals(1, tc.queue.first().size)
        dispatcher.scheduler.advanceTimeBy(2.seconds)
        assertEquals(0, tc.queue.first().size)
    }

    @Test fun dismiss_removesById() = runTest {
        val tc = ToastCenter()
        tc.info("a")
        val id = tc.queue.first().first().id
        tc.dismiss(id)
        assertTrue(tc.queue.first().isEmpty())
    }
}
