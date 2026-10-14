package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Test

/** Pins the CGK derivation to the TS vector
 *  (`packages/protocol/tests/cloudGossipVectors.test.ts`). */
class CloudGossipVectorTest {
    @Test
    fun cgkPinnedVector() {
        assertEquals(
            "1d8e3bc393a91de22edec0b862a0539856bdc73b42ab60a26d7d51fbb091badd",
            HexUtil.encode(CloudGossip.deriveCGK(ByteArray(32) { 0x07 })),
        )
    }
}
