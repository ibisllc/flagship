// Phase 3b — DeviceAdmit canonical-bytes + sign/verify parity with the
// Worker (packages/protocol/src/auth.ts). The canonical bytes MUST be
// "flagship/device-admit/v1|username|newDevicePubHex|issuedAt" so the
// .com verifier accepts an admit signed on Android.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceAdmitTest {

    private val admit = DeviceAdmit(
        username = "hilton",
        deviceId = "00".repeat(16),
        newDevicePubHex = "aa".repeat(32),
        issuedAt = 1_700_000_000_000L,
    )

    @Test fun canonicalBytes_matchWorkerLayout() {
        val expected =
            "flagship/device-admit/v2|hilton|${"00".repeat(16)}|${"aa".repeat(32)}|1700000000000"
        assertArrayEquals(
            expected.toByteArray(Charsets.UTF_8),
            DeviceAdmitClaim.canonicalBytes(admit),
        )
    }

    @Test fun signThenVerify_roundTrips() {
        val keyPair = Ed25519Sign.KeyPair.newKeyPair()
        val signer = Ed25519Sign(keyPair.privateKey)
        val sig = DeviceAdmitClaim.sign(admit, signer)
        assertEquals(64, sig.size)
        assertTrue(DeviceAdmitClaim.verify(admit, sig, keyPair.publicKey))
    }

    @Test fun verify_rejectsWrongKey() {
        val signer = Ed25519Sign(Ed25519Sign.KeyPair.newKeyPair().privateKey)
        val sig = DeviceAdmitClaim.sign(admit, signer)
        val otherPub = Ed25519Sign.KeyPair.newKeyPair().publicKey
        assertFalse(DeviceAdmitClaim.verify(admit, sig, otherPub))
    }

    @Test fun verify_rejectsTamperedDevicePub() {
        val keyPair = Ed25519Sign.KeyPair.newKeyPair()
        val sig = DeviceAdmitClaim.sign(admit, Ed25519Sign(keyPair.privateKey))
        // A captured admit can't be re-aimed at a different device key.
        val tampered = admit.copy(newDevicePubHex = "bb".repeat(32))
        assertFalse(DeviceAdmitClaim.verify(tampered, sig, keyPair.publicKey))
    }

    @Test fun verify_doesNotThrowOnMalformedKey() {
        // Worker verifier is try/catch; ours mirrors that — a bad pubkey
        // is a clean `false`, never a crash.
        val keyPair = Ed25519Sign.KeyPair.newKeyPair()
        val sig = DeviceAdmitClaim.sign(admit, Ed25519Sign(keyPair.privateKey))
        assertFalse(DeviceAdmitClaim.verify(admit, sig, byteArrayOf(0x01, 0x02)))
        assertFalse(DeviceAdmitClaim.verify(admit, byteArrayOf(0x00), keyPair.publicKey))
    }
}
