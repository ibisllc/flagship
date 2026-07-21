package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

/**
 * Pins the Kotlin canonical bytes for the `account-self-delete` +
 * `servers-self-delete` envelopes to the EXACT cross-platform vector. `.com`
 * re-derives these bytes to verify the owner-IRK signature, so any drift in
 * the tag, `|` separator, field order, or lowercasing breaks account deletion.
 *
 * Mirror of the TS pin (`packages/protocol/tests/accountDeletionVectors.test.ts`)
 * and the Swift pin (`AccountDeletionCanonicalTests.swift`).
 */
class AccountDeletionVectorTest {
    @Test
    fun accountSelfDeleteCanonicalBytes() {
        assertEquals(
            "flagship/account-self-delete/v1|alice|1700",
            String(AccountSelfDeleteOrder.canonicalBytes("alice", 1700L), Charsets.UTF_8),
        )
    }

    @Test
    fun accountSelfDeleteLowercasesUsername() {
        assertEquals(
            "flagship/account-self-delete/v1|alice|42",
            String(AccountSelfDeleteOrder.canonicalBytes("Alice", 42L), Charsets.UTF_8),
        )
    }

    @Test
    fun serversSelfDeleteCanonicalBytes() {
        assertEquals(
            "flagship/servers-self-delete/v1|alice|1700",
            String(ServersSelfDeleteOrder.canonicalBytes("alice", 1700L), Charsets.UTF_8),
        )
    }

    @Test
    fun signVerifyRoundTrip() {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val signer = Ed25519Sign(kp.privateKey)
        val verifier = Ed25519Verify(kp.publicKey)

        val acct = AccountSelfDeleteOrder.canonicalBytes("bob", 5L)
        val asig = signer.sign(acct)
        verifier.verify(asig, acct) // throws on mismatch — reaching here = ok

        val servers = ServersSelfDeleteOrder.canonicalBytes("bob", 5L)
        val ssig = signer.sign(servers)
        verifier.verify(ssig, servers)

        // A captured account-self-delete sig must NOT verify as servers-self-delete.
        try {
            verifier.verify(asig, servers)
            fail("account-self-delete sig must not verify as servers-self-delete")
        } catch (_: Throwable) {
            // expected
        }
    }
}
