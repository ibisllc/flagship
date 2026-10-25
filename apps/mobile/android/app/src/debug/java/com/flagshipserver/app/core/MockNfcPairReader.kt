// Debug builds and unit tests only: a tag reader that returns a fixed result.

package com.flagshipserver.app.core

import androidx.activity.ComponentActivity

/**
 * Returns a pre-baked Result on every readPair call without touching
 * any Android NFC API. The activity argument is ignored — view-model
 * tests pass an empty stand-in.
 */
class MockNfcPairReader(
    private val outcome: Result<ReadPairResult>,
) : NfcPairReader {
    /** Number of times readPair has been called. Tests use this to
     *  confirm the VM only kicks off a read on startTap. */
    @Volatile var callCount: Int = 0
        private set

    override suspend fun readPair(activity: ComponentActivity): Result<ReadPairResult> {
        callCount += 1
        return outcome
    }
}
