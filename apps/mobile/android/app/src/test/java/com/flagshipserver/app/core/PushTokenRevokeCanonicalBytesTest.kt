// Kotlin↔TS↔Swift↔webapp byte-identity for the IRK-signed push-token-revoke
// canonical bytes. A fixed 0x11×32 Ed25519 seed signing the Kotlin canonical
// bytes MUST produce the SAME signature + public key the TS vector pins
// (packages/protocol/tests/pushTokenRevoke.test.ts) and the iOS pin
// (InstallBlobTests.test_pushTokenRevoke_pinnedSignatureVector). Ed25519 is
// deterministic so this is exact — proving .com (verifyPushTokenRevoke) accepts
// what this client signs.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import org.junit.Assert.assertEquals
import org.junit.Test

class PushTokenRevokeCanonicalBytesTest {

    private val tokenId = "0123456789abcdef0123456789abcdef"
    private val issuedAt = 1_700_000_000_000L

    @Test fun canonicalBytes_followsV1Format() {
        val s = String(PushTokenRevoke.canonicalBytes(tokenId, issuedAt), Charsets.UTF_8)
        assertEquals(
            "flagship/push-token-revoke/v1|0123456789abcdef0123456789abcdef|1700000000000",
            s,
        )
    }

    @Test fun pinnedSignatureVector_matchesTsAndSwift() {
        val seed = ByteArray(32) { 0x11 }
        val kp = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed)
        // Same public key the TS + Swift vectors pin.
        assertEquals(
            "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737",
            HexUtil.encode(kp.publicKey),
        )
        val sig = Ed25519Sign(seed).sign(PushTokenRevoke.canonicalBytes(tokenId, issuedAt))
        assertEquals(
            "46dde40edd081692a6412539bbb5e1a27f978a0bfdd27bbbd7cd4911501f5c27" +
                "3948f78248c70199ccb27905720a5a22fe5dc9d7c4bbff2b936663a467f2980b",
            HexUtil.encode(sig),
        )
    }
}
