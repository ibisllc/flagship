// Pins the phone-side STK derivation (UMK → SWK → STK) to the
// cross-platform vector in packages/protocol/tests/daemonStatus.test.ts —
// the trust anchor for verifying STK-signed daemon-status reports without
// trusting `.com`'s identityPubKey echo.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ServerKeysTest {

    @Test fun derivesThePinnedStkPubFromThePinnedUmkAndServerId() {
        val pub = ServerKeys.deriveStkPub(
            DaemonStatusVector.UMK_SEED, DaemonStatusVector.SERVER_ID,
        )
        assertEquals(DaemonStatusVector.STK_PUB_HEX, HexUtil.encode(pub))
    }

    @Test fun derivedStkSeedReproducesThePinnedSignatures() {
        // End-to-end HKDF + Ed25519 determinism: signing the pinned canonical
        // bytes with the derived STK private seed yields the pinned signature.
        val seed = ServerKeys.deriveStkSeed(
            DaemonStatusVector.UMK_SEED, DaemonStatusVector.SERVER_ID,
        )
        val signer = Ed25519Sign(seed)
        assertEquals(
            DaemonStatusVector.SIG_HEX,
            HexUtil.encode(signer.sign(DaemonStatusReport.canonicalBytes(DaemonStatusVector.REPORT))),
        )
        assertEquals(
            DaemonStatusVector.NULL_SIG_HEX,
            HexUtil.encode(signer.sign(DaemonStatusReport.canonicalBytes(DaemonStatusVector.NULL_REPORT))),
        )
    }

    @Test fun differentServerIdYieldsADifferentStk() {
        val a = ServerKeys.deriveStkPub(DaemonStatusVector.UMK_SEED, DaemonStatusVector.SERVER_ID)
        val b = ServerKeys.deriveStkPub(DaemonStatusVector.UMK_SEED, "other.harry1.flagship.services")
        assertNotEquals(HexUtil.encode(a), HexUtil.encode(b))
    }

    @Test fun differentUmkYieldsADifferentStk() {
        val a = ServerKeys.deriveStkPub(DaemonStatusVector.UMK_SEED, DaemonStatusVector.SERVER_ID)
        val b = ServerKeys.deriveStkPub(ByteArray(32) { 0x08 }, DaemonStatusVector.SERVER_ID)
        assertNotEquals(HexUtil.encode(a), HexUtil.encode(b))
    }

    @Test fun rejectsANon32ByteUmkSeed() {
        assertThrows(IllegalArgumentException::class.java) {
            ServerKeys.deriveSwk(ByteArray(31), DaemonStatusVector.SERVER_ID)
        }
        assertThrows(IllegalArgumentException::class.java) {
            ServerKeys.deriveStkPub(ByteArray(33), DaemonStatusVector.SERVER_ID)
        }
    }
}
