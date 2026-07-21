// Slice D — the sensitive-order signing GATE (docs/device-admin-tier-spec.md
// §8.3, task step 4): Keystore.adminSigningKey signs with the ADMIN MASTER ROOT
// when this device holds one, else falls back to the owner IRK (legacy accounts
// that never minted a root). Only the signing KEY changes — the canonical bytes
// a sensitive order signs are byte-identical, and the box/.com resolve the
// signer by trial. This pins that gate.

package com.flagshipserver.app.keystore

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.core.HexUtil
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.security.GeneralSecurityException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class AdminRootSigningGateTest {

    @Before
    fun setUp() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        Keystore.attachForTest(ctx.getSharedPreferences("keystore-test", Context.MODE_PRIVATE))
        Keystore.wipe()
    }

    /** Robust membership-IRK pubkey — derives the active-version IRK then reads
     *  the cached versioned seed (the path OpenAccount uses), avoiding the
     *  fragile un-versioned irkPubHex fallback in the test harness. */
    private fun irkPub(): ByteArray = runBlocking {
        Keystore.deriveIRK("test")
        val seed = Keystore.requireIrkSeedForVersion(Keystore.currentIrkVersion())
        Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
    }

    /** No admin root on this device (legacy account) ⇒ the gate signs with the
     *  owner IRK, so the signature verifies under the IRK pub. */
    @Test
    fun gate_fallsBackToIrk_whenNoAdminRoot() {
        Keystore.loadOrCreateUmkSeed()
        val irkPub = irkPub()
        val msg = "flagship/test/sensitive-order".toByteArray()

        val sig = runBlocking { Keystore.adminSigningKey("test").sign(msg) }

        // Verifies under the membership IRK (the legacy fallback).
        Ed25519Verify(irkPub).verify(sig, msg)
    }

    /** Admin root present ⇒ the gate signs with the ADMIN ROOT: the signature
     *  verifies under the admin-root pub and NOT under the membership IRK (the
     *  whole authority split). */
    @Test
    fun gate_usesAdminRoot_whenPresent() {
        Keystore.loadOrCreateUmkSeed()
        val irkPub = irkPub()
        Keystore.generateAdminRoot()
        val adminPub = HexUtil.decode(Keystore.adminRootPubHex()!!)!!
        val msg = "flagship/test/sensitive-order".toByteArray()

        val sig = runBlocking { Keystore.adminSigningKey("test").sign(msg) }

        // Verifies under the admin root...
        Ed25519Verify(adminPub).verify(sig, msg)
        // ...and does NOT verify under the membership IRK.
        assertThrows(GeneralSecurityException::class.java) {
            Ed25519Verify(irkPub).verify(sig, msg)
        }
    }
}
