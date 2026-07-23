package com.flagshipserver.app.api

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PostRecoveryVisibilityTest {
    @Test
    fun pendingUnobjectedReattachIsActive() {
        assertTrue(snapshot(lastSwapTo = null, objectedAt = null).hasActiveReattach)
    }

    @Test
    fun objectedReattachIsNotActive() {
        assertFalse(snapshot(lastSwapTo = null, objectedAt = 300).hasActiveReattach)
    }

    @Test
    fun completedReattachIsNotActive() {
        assertFalse(snapshot(lastSwapTo = "new-key", objectedAt = null).hasActiveReattach)
    }

    private fun snapshot(lastSwapTo: String?, objectedAt: Long?): PostRecoverySnapshot =
        PostRecoverySnapshot(
            currentIrkPubHex = "aa",
            state = WatcherState(
                lastSeen = PendingRePair(
                    newIrkPub = "new-key",
                    oldIrkPub = "old-key",
                    initiatedAt = 100,
                    completesAt = 200,
                    objectedAt = objectedAt,
                ),
                lastSwapTo = lastSwapTo,
                lastPolledAt = 400,
            ),
        )
}
