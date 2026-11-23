package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.HttpException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Security report F3: `.com`'s coded re-pair refusals each get their own sentence. */
class RePairRefusalTextTest {
    private fun refused(status: Int, code: String) = HttpException(status, """{"error":"x","code":"$code"}""")

    @Test fun wordsEachCode() {
        assertEquals(RePairRefusalText.vetoedRecently, RePairRefusalText.refusal(refused(409, "re-pair-vetoed-recently")))
        assertEquals(RePairRefusalText.replay, RePairRefusalText.refusal(refused(409, "re-pair-replay")))
        assertEquals(RePairRefusalText.replay, RePairRefusalText.refusal(refused(409, "re-pair-cancelled-replay")))
        assertEquals(RePairRefusalText.credentialUsed, RePairRefusalText.refusal(refused(409, "re-pair-credential-used")))
        assertEquals(RePairRefusalText.stale, RePairRefusalText.refusal(refused(403, "re-pair-stale")))
        assertEquals(
            "An admin of this account rejected a recovery with this device less than a day ago. You can try again after a day, or ask the admin.",
            RePairRefusalText.vetoedRecently,
        )
    }

    @Test fun leavesOtherErrorsToTheirOwnWording() {
        assertNull(RePairRefusalText.refusal(HttpException(409, """{"error":"re-pair already pending"}""")))
        assertNull(RePairRefusalText.refusal(HttpException(409, "not json")))
        assertNull(RePairRefusalText.refusal(IllegalStateException("409 already-pending")))
    }
}
