// Pins the flagship/server-unrevoke/v1 envelope to the golden vector shared
// with @flagship/protocol (packages/protocol/tests/serverUnrevocation.test.ts)
// and the iOS + webapp clients. Any byte drift breaks Un-revoke.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ServerUnrevocationCanonicalBytesTest {

    private val seedHex = "ae7204fc0384c689bfb676523656b66d804cb51c262c7552b03e51bba8767ac3"
    private val pubHex = "c49775473bf9dcf5ad1608c8e66823d55dc6889be27e42a029fd9de195c8d7e4"
    private val sigHex =
        "669bfc297531e634d70af2ec4c846aa0eb249bf5c00ce5e6e065a63ce5c86c17" +
            "5f4b930894e45b68ef858f4d397c4442a0faf12ef8c35e2b3d2c949a6b3bbe03"

    private fun golden() = ServerUnrevocation.canonicalBytes(
        username = "harry",
        serverDomain = "home.harry.flagship.services",
        issuedAt = 1700000000000L,
    )

    @Test fun tag_isPinnedToTheProtocolConstant() {
        assertEquals("flagship/server-unrevoke/v1", ServerUnrevocation.CANONICAL_TAG)
    }

    @Test fun canonicalBytes_matchGoldenVector() {
        assertEquals(
            "flagship/server-unrevoke/v1|harry|home.harry.flagship.services|1700000000000",
            String(golden(), Charsets.UTF_8),
        )
    }

    @Test fun signature_matchesGoldenVector() {
        val seed = HexUtil.decode(seedHex)!!
        assertEquals(pubHex, HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey))
        val sig = Ed25519Sign(seed).sign(golden())
        assertEquals(sigHex, HexUtil.encode(sig))
        Ed25519Verify(HexUtil.decode(pubHex)!!).verify(HexUtil.decode(sigHex)!!, golden())
    }

    @Test fun differsFromRevokeAndRelease() {
        // A revoke or release signature must never verify as an un-revoke.
        val unrevoke = String(golden(), Charsets.UTF_8)
        val release = String(
            ReleaseServerName.canonicalBytes("harry", "home.harry.flagship.services", 1700000000000L),
            Charsets.UTF_8,
        )
        assertNotEquals(release, unrevoke)
        assertFalse(unrevoke.startsWith(ServerRevocationClaim.CANONICAL_TAG + "|"))
    }
}
