package com.flagshipserver.app.viewmodels

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyfileRuleTest {
    @Test fun twelveOfOneKindIsTooWeakAndTheMessageSaysWhy() {
        assertFalse(KeyfileExportViewModel.isStrong("alllowercase"))
        assertTrue(KeyfileExportViewModel.RULE_ERROR.contains("three of"))
    }

    @Test fun twelveWithThreeKindsPasses() {
        assertTrue(KeyfileExportViewModel.isStrong("Caracal-keyfile-1016x"))
    }
}
