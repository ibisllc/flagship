// The result encoding of flagship-turn-ffi (rust/crates/flagship-turn-ffi/include/flagship_turn.h), as TurnResponder
// reads it. The bytes are the Rust crate's own `encodes_peer_datagrams` case.

package com.flagshipserver.app.calls

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TurnResponderResultTest {
    @Test
    fun decodesClientBytesAndPeerDatagrams() {
        val r = TurnResponder.Result.decode(byteArrayOf(0, 0, 0, 0, 2, 'a'.code.toByte(), 'b'.code.toByte(), 0, 1, 0, 5, 0, 3, 9, 9, 9))!!
        assertEquals(0, r.status)
        assertArrayEquals("ab".toByteArray(), r.client)
        assertEquals(1, r.peers.size)
        assertEquals(5, r.peers[0].first)
        assertArrayEquals(byteArrayOf(9, 9, 9), r.peers[0].second)
    }

    @Test
    fun refusesATruncatedResult() {
        assertNull(TurnResponder.Result.decode(byteArrayOf(0, 0, 0, 0, 9, 1)))
        assertNull(TurnResponder.Result.decode(byteArrayOf(0, 0, 0, 0, 0, 0, 1, 0, 5, 0, 3, 9)))
    }

    @Test
    fun aClosingStatusCarriesNothing() {
        val r = TurnResponder.Result.decode(byteArrayOf(1, 0, 0, 0, 0, 0, 0))!!
        assertEquals(1, r.status)
        assertEquals(0, r.client.size)
    }
}
