// Mirror of FlagshipMobileTests/ActiveOperationsCenterTests.swift.
//
// The global operations sliver is a thin render of ActiveOperationsCenter,
// so the logic that matters — what shows, in what order, and where a tap
// goes — is all here: label shapes, churn-free deploy reconciliation, the
// build lifecycle, and primary/ordering across mixed operations.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ActiveOperationsCenterTest {

    private fun pendingPod(id: String, name: String) = PodInfo(
        podId = id, name = name, fqdn = "${name.lowercase()}.u",
        status = PodInfo.Status.PENDING, pendingAuthCodeSerial = "serial-$id",
    )

    private fun onlinePod(id: String, name: String) = PodInfo(
        podId = id, name = name, fqdn = "${name.lowercase()}.u",
        status = PodInfo.Status.ONLINE,
    )

    private fun ops(center: ActiveOperationsCenter) = center.operations.value

    // ── Empty ──────────────────────────────────────────────────────

    @Test fun empty_hasNoPrimary() {
        val c = ActiveOperationsCenter()
        assertNull(c.primary)
        assertEquals(0, c.additionalCount)
        assertTrue(ops(c).isEmpty())
    }

    // ── Deploy operations (Bug-3: SUPPRESSED for pending pods) ──────

    @Test fun pendingPod_doesNotShowDeployOperation() {
        // Bug 3: a freshly-created server is PENDING while it is merely AWAITING
        // A BURN — there is no reliable on-model signal distinguishing that from
        // "actually installing", so we never emit a spinning "deploying server
        // <name>" op for a pending pod.
        val c = ActiveOperationsCenter()
        c.syncDeployOperations(listOf(pendingPod("p1", "Home")))
        assertTrue(ops(c).isEmpty())
        assertNull(c.primary)
        assertEquals(0, c.additionalCount)
    }

    @Test fun nonPendingPods_produceNoDeployOperations() {
        val c = ActiveOperationsCenter()
        c.syncDeployOperations(listOf(onlinePod("p1", "Home"), onlinePod("p2", "Work")))
        assertTrue(ops(c).isEmpty())
        assertNull(c.primary)
    }

    @Test fun manyPendingPods_stillEmitNoDeployOps() {
        val c = ActiveOperationsCenter()
        c.syncDeployOperations(listOf(pendingPod("p1", "Home"), pendingPod("p2", "Work")))
        assertTrue(ops(c).isEmpty())
        // Idempotent: a steady re-sync stays empty.
        c.syncDeployOperations(listOf(pendingPod("p1", "Home"), pendingPod("p2", "Work")))
        assertTrue(ops(c).isEmpty())
    }

    // ── Build operations (imperative) ──────────────────────────────

    @Test fun buildOperation_labelWithAndWithoutServer() {
        val c = ActiveOperationsCenter()
        c.upsertBuild("s1", "blog", "Home", DeepLink.VibeCodeChat("s1"))
        assertEquals("building blog on Home", c.primary?.label)
        assertEquals(DeepLink.VibeCodeChat("s1"), c.primary?.target)

        c.upsertBuild("s1", "blog", null, DeepLink.VibeCodeChat("s1"))
        assertEquals("building blog", c.primary?.label)
        assertEquals("re-upserting the same id must not duplicate", 1, ops(c).size)
    }

    @Test fun buildUpsertTwice_keepsOrder() {
        val c = ActiveOperationsCenter()
        c.upsertBuild("s1", "blog", "Home", DeepLink.VibeCodeChat("s1"))
        val seqBefore = ops(c).first().seq
        c.upsertBuild("s1", "blog renamed", "Home", DeepLink.VibeCodeChat("s1"))
        assertEquals(1, ops(c).size)
        assertEquals(seqBefore, ops(c).first().seq)
        assertEquals("blog renamed", ops(c).first().subject)
    }

    @Test fun removeBuild_clearsIt() {
        val c = ActiveOperationsCenter()
        c.upsertBuild("s1", "blog", "Home", DeepLink.VibeCodeChat("s1"))
        c.removeBuild("s1")
        assertTrue(ops(c).isEmpty())
        assertNull(c.primary)
    }

    // ── Mixing: builds survive deploy reconciliation, pending stays hidden ──

    @Test fun buildIsPrimary_andDeploySyncNeverAddsPending() {
        val c = ActiveOperationsCenter()
        c.upsertBuild("s1", "blog", "Home", DeepLink.VibeCodeChat("s1"))
        assertEquals("build ops still drive the sliver", ActiveOperation.Kind.BUILD, c.primary?.kind)
        assertEquals(0, c.additionalCount)
    }

    @Test fun deploySync_preservesBuildOperations_andAddsNothingForPending() {
        val c = ActiveOperationsCenter()
        c.upsertBuild("s1", "blog", "Home", DeepLink.VibeCodeChat("s1"))
        c.syncDeployOperations(listOf(pendingPod("p1", "Home")))
        assertEquals(
            "reconciling deploys must not wipe build ops nor add pending ops",
            1, ops(c).size,
        )
        assertTrue(ops(c).all { it.kind == ActiveOperation.Kind.BUILD })
    }

    @Test fun mixedOperations_onlyBuildsCount() {
        val c = ActiveOperationsCenter()
        c.syncDeployOperations(listOf(pendingPod("p1", "Home"), pendingPod("p2", "Work")))
        c.upsertBuild("s1", "blog", "Home", DeepLink.VibeCodeChat("s1"))
        assertEquals(1, ops(c).size)
        assertEquals(0, c.additionalCount)
    }
}
