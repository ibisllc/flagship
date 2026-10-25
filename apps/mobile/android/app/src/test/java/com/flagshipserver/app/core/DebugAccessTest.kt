package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The sentences and edges of DebugAccess beyond the shared vectors. */
class DebugAccessTest {
    private val key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINBKsjJ0K7SrOhNovUYV5ObQIkq3GgFrr4UgozLJd4c3"
    private val grant = DebugAccess.Grant("home.alice.flagship.services", key, 1_000L, 1_000L + DebugAccess.DEFAULT_MS)

    @Test fun saysWhyAGrantCantBeSigned() {
        assertEquals("Debug access needs an SSH public key.", DebugAccess.grantProblem(grant.copy(sshPublicKey = "")))
        assertEquals("That isn't an SSH public key this server can use.", DebugAccess.grantProblem(grant.copy(sshPublicKey = "$key me@laptop")))
        assertEquals("Debug access has to end after it starts.", DebugAccess.grantProblem(grant.copy(expiresAt = 1_000L)))
        assertEquals(
            "Debug access can be on for at most 7 days at a time.",
            DebugAccess.grantProblem(grant.copy(expiresAt = 1_000L + DebugAccess.MAX_MS + 1)),
        )
        assertNull(DebugAccess.grantProblem(grant.copy(expiresAt = 1_000L + DebugAccess.MAX_MS)))
    }

    @Test fun durationsAreOneHourOneDayOneWeek() {
        assertEquals(listOf(3_600_000L, 86_400_000L, 604_800_000L), DebugAccess.Duration.values().map { it.ms })
    }

    @Test fun aRevokeSignatureIsNotAGrantSignature() {
        val signer = Ed25519Sign(ByteArray(32) { 7 })
        val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 7 }).publicKey
        val revokeSig = DebugAccess.signRevoke(DebugAccess.Revoke(grant.serverDomain, grant.issuedAt), signer)
        assertFalse(DebugAccess.verify(grant, revokeSig, pub))
        assertTrue(DebugAccess.verify(grant, DebugAccess.sign(grant, signer), pub))
    }
}
