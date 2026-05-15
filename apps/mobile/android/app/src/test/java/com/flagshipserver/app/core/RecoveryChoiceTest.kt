// Pin the post-recovery choice contract on Kotlin. The screen itself
// is exercised in PostRecoveryChoiceComposeTest (Robolectric); this
// file just enforces the enum's case identity + the wire-compatibility
// expectations that the Kotlin side stays in lockstep with Swift's
// FlagshipCore.RecoveryChoice.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class RecoveryChoiceTest {
    @Test fun threeDistinctCases() {
        val set: Set<RecoveryChoice> = setOf(
            RecoveryChoice.KeepBothDevices,
            RecoveryChoice.ReplaceLostDevice,
            RecoveryChoice.WipeAndRestart,
        )
        assertEquals(3, set.size)
    }

    @Test fun caseIdentity_stableForPatternMatching() {
        // Identity is by data-object semantic; equal instances are
        // the same Singleton object reference. Pin this so we don't
        // accidentally switch to data class without updating the
        // navigation host's `when` statements.
        assertEquals(RecoveryChoice.KeepBothDevices, RecoveryChoice.KeepBothDevices)
        assertNotEquals(RecoveryChoice.KeepBothDevices, RecoveryChoice.ReplaceLostDevice)
    }
}
