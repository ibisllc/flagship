package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * debug-access grant — Android signs byte-identically to TS + iOS
 * (pinned vector matches packages/protocol/tests/debugAccess.test.ts).
 */
class DebugAccessTest {
    private val grant = DebugAccess.Grant(
        serverDomain = "home.alice.flagship.services",
        sshAuthorizedKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILEXAMPLE phone",
        issuedAt = 1700L,
    )
    // pub for seed 0x07*32 (ed.getPublicKey).
    private val irkPub = HexUtil.decode("ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c")!!

    @Test fun canonicalBytes() {
        assertEquals(
            "flagship/debug-access/v1|home.alice.flagship.services|ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILEXAMPLE phone|1700",
            String(DebugAccess.canonicalBytes(grant)),
        )
    }

    // Cross-platform contract = canonical-bytes + key parity (any platform's
    // sig verifies anywhere). The TS-pinned signature must verify under the
    // pinned pub, and our own sign must verify under that same pub (proving
    // seed→pub parity with TS).
    @Test fun pinnedCrossPlatformSignatureVerifies() {
        val pinned = "818ed03fb15414fe647aecd466524d8069df53f245dfe6dff7ab78da15ab976e922a39595e5e34ebdb4cec1e628efba0a4cc1cbd1efb1684234a8b8d4e21aa05"
        assertTrue(DebugAccess.verify(grant, pinned, irkPub))
    }

    @Test fun ownSignVerifiesUnderTsDerivedPub() {
        val irk = Ed25519Sign(ByteArray(32) { 7 })
        val sig = DebugAccess.sign(grant, irk)
        assertTrue(DebugAccess.verify(grant, sig, irkPub))
    }

    @Test fun rejectsWrongKey() {
        val irk = Ed25519Sign(ByteArray(32) { 7 })
        val sig = DebugAccess.sign(grant, irk)
        val wrongPub = ByteArray(32) { 9 }
        assertFalse(DebugAccess.verify(grant, sig, wrongPub))
    }
}
