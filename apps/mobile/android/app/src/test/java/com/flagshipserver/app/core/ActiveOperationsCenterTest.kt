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

    // ── Deploy operations (derived from pods) ──────────────────────

    @Test fun pendingPod_becomesDeployOperation_withCanonicalLabelAndTarget() {
        val c = ActiveOperationsCenter()
        c.syncDeployOperations(listOf(pendingPod("p1", "Home")))
        val op = c.primary!!
        assertEquals(ActiveOperation.Kind.DEPLOY, op.kind)
        assertEquals("deploying server Home", op.label)
        assertEquals(DeepLink.ServerDetail("p1"), op.target)
        assertEquals(1, ops(c).size)
        assertEquals(0, c.additionalCount)
    }

    @Test fun nonPendingPods_produceNoDeployOperations() {
        val c = ActiveOperationsCenter()
        c.syncDeployOperations(listOf(onlinePod("p1", "Home"), onlinePod("p2", "Work")))
        assertTrue(ops(c).isEmpty())
        assertNull(c.primary)
    }

    @Test fun syncDeploy_isIdempotent_andDoesNotReorder() {
        val c = ActiveOperationsCenter()
        val pods = listOf(pendingPod("p1", "Home"), pendingPod("p2", "Work"))
        c.syncDeployOperations(pods)
        val first = ops(c)
        // A steady re-sync with the same pods must not churn the list (same
        // ids AND same seq) so the sliver never flickers or reorders.
        c.syncDeployOperations(pods)
        assertEquals(first, ops(c))
    }

    @Test fun podLeavingPending_dropsItsDeployOperation() {
        val c = ActiveOperationsCenter()
        c.syncDeployOperations(listOf(pendingPod("p1", "Home")))
        assertEquals(1, ops(c).size)
        // The box came online → the deploy op disappears.
        c.syncDeployOperations(listOf(onlinePod("p1", "Home")))
        assertTrue(ops(c).isEmpty())
    }

    @Test fun deployRename_updatesLabel_butKeepsOrder() {
        val c = ActiveOperationsCenter()
        c.syncDeployOperations(listOf(pendingPod("p1", "Home"), pendingPod("p2", "Work")))
        val seqBefore = ops(c).first { it.id == "deploy:p2" }.seq
        c.syncDeployOperations(listOf(pendingPod("p1", "Home"), pendingPod("p2", "Workstation")))
        val renamed = ops(c).first { it.id == "deploy:p2" }
        assertEquals("deploying server Workstation", renamed.label)
        assertEquals("a rename must not jump the op's position", seqBefore, renamed.seq)
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

    // ── Ordering & mixing the two feeders ──────────────────────────

    @Test fun primaryIsMostRecentlyStarted() {
        val c = ActiveOperationsCenter()
        c.syncDeployOperations(listOf(pendingPod("p1", "Home"))) // seq 1
        c.upsertBuild("s1", "blog", "Home", DeepLink.VibeCodeChat("s1")) // seq 2
        assertEquals("the newest op is the one the sliver shows", ActiveOperation.Kind.BUILD, c.primary?.kind)
        assertEquals(1, c.additionalCount)

        // When the build finishes the deploy is primary again.
        c.removeBuild("s1")
        assertEquals(ActiveOperation.Kind.DEPLOY, c.primary?.kind)
        assertEquals(0, c.additionalCount)
    }

    @Test fun deploySync_preservesBuildOperations() {
        val c = ActiveOperationsCenter()
        c.upsertBuild("s1", "blog", "Home", DeepLink.VibeCodeChat("s1"))
        c.syncDeployOperations(listOf(pendingPod("p1", "Home")))
        assertEquals("reconciling deploys must not wipe build ops", 2, ops(c).size)
        assertTrue(ops(c).any { it.kind == ActiveOperation.Kind.BUILD })
        assertTrue(ops(c).any { it.kind == ActiveOperation.Kind.DEPLOY })
    }

    @Test fun mixedOperations_countAndAdditional() {
        val c = ActiveOperationsCenter()
        c.syncDeployOperations(listOf(pendingPod("p1", "Home"), pendingPod("p2", "Work")))
        c.upsertBuild("s1", "blog", "Home", DeepLink.VibeCodeChat("s1"))
        assertEquals(3, ops(c).size)
        assertEquals(2, c.additionalCount)
    }

    @Test fun deployAndBuildIds_neverCollide() {
        // A pod and a build session could share a raw id; the center
        // namespaces them so both ops coexist.
        val c = ActiveOperationsCenter()
        c.syncDeployOperations(listOf(pendingPod("x", "Home")))
        c.upsertBuild("x", "blog", "Home", DeepLink.VibeCodeChat("x"))
        assertEquals(2, ops(c).size)
    }
}
