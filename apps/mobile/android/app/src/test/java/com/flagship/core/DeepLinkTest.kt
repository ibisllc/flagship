// android.net.Uri lives in android.jar — Robolectric or instrumented
// run would be needed for the full URI form. Until that's wired we
// exercise the DeepLinker queue behavior which is pure Kotlin.

package com.flagship.core

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeepLinkerTest {
    @Test fun enqueueThenConsume() = runTest {
        val d = DeepLinker()
        assertNull(d.pending.first())
        d.enqueue(DeepLink.ServerDetail("pod-abc"))
        assertEquals(DeepLink.ServerDetail("pod-abc"), d.pending.first())
        val taken = d.consume()
        assertEquals(DeepLink.ServerDetail("pod-abc"), taken)
        assertNull(d.consume())
    }

    @Test fun consumeWhenEmptyReturnsNull() = runTest {
        val d = DeepLinker()
        assertNull(d.consume())
    }
}
