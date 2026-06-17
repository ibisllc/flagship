// android.net.Uri lives in android.jar — Robolectric or instrumented
// run would be needed for the full URI form. Until that's wired we
// exercise the DeepLinker queue behavior which is pure Kotlin.

package com.flagshipserver.app.core

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

    // W10 — the `vibecode-needs-you` push enqueues a VibeCodeChat link; the
    // APPS tab consumes it and opens vibe-code-chat/<id>. Lock the queue
    // contract the routing depends on.
    @Test fun vibeCodeChat_enqueueThenConsume() = runTest {
        val d = DeepLinker()
        d.enqueue(DeepLink.VibeCodeChat("sess-9"))
        assertEquals(DeepLink.VibeCodeChat("sess-9"), d.pending.first())
        assertEquals(DeepLink.VibeCodeChat("sess-9"), d.consume())
        assertNull(d.consume())
    }

    // M8 — a git/mcp build's sliver tap target is its journal, carried as the
    // internal-only BuildJournal link (not URI-parsed), routed on the APPS tab.
    @Test fun buildJournal_enqueueThenConsume() = runTest {
        val d = DeepLinker()
        d.enqueue(DeepLink.BuildJournal("build-7"))
        assertEquals(DeepLink.BuildJournal("build-7"), d.pending.first())
        assertEquals(DeepLink.BuildJournal("build-7"), d.consume())
        assertNull(d.consume())
    }
}
