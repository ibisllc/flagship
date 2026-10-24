package com.flagshipserver.app.keystore

import com.flagshipserver.app.core.pq.PqHex
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

/**
 * The PQ seeds under the session KEK (pq-suites.md §18): one unlock prompt opens them for the
 * whole session, so a hybrid signature made long after it never needs a second prompt.
 */
class PqSessionKekTest {
    /** The old Keystore wrapping, with a 300 s window the test can open and close. */
    private class WindowWrapper : PqSeedWrapper {
        var windowOpen = true
        override val label = PqCustodyLabel.HARDWARE_WRAPPED
        override fun wrap(seed: ByteArray): ByteArray = ByteArray(12) { 7 } + seed + ByteArray(16)
        override fun unwrap(blob: ByteArray): ByteArray {
            if (!windowOpen) throw IllegalStateException("UserNotAuthenticatedException")
            return blob.copyOfRange(12, blob.size - 16)
        }
    }

    private class MapStore : PqKeyStore.Persistence {
        val m = HashMap<String, String>()
        override fun load(key: String) = m[key]
        override fun save(key: String, value: String) { m[key] = value }
        override fun remove(key: String) { m.remove(key) }
        override fun keys() = m.keys.toSet()
    }

    /** A vault whose "Keystore" key is a plain AES key; the test stands in for the prompt. */
    private class FakeVault : PqKekVault {
        val key = SecretKeySpec(ByteArray(32) { 3 }, "AES")
        var blob: ByteArray? = null
        override fun begin(): PqKekVault.Pending {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            val b = blob
            return if (b != null) {
                c.init(Cipher.DECRYPT_MODE, key, javax.crypto.spec.GCMParameterSpec(128, b.copyOfRange(0, 12)))
                PqKekVault.Pending(c, creating = false)
            } else {
                c.init(Cipher.ENCRYPT_MODE, key)
                PqKekVault.Pending(c, creating = true)
            }
        }
        override fun finish(p: PqKekVault.Pending, authenticated: Cipher): ByteArray {
            if (!p.creating) return authenticated.doFinal(blob!!.copyOfRange(12, blob!!.size))
            val kek = ByteArray(32) { 9 }
            blob = authenticated.iv + authenticated.doFinal(kek)
            return kek
        }
    }

    private val kp = com.google.crypto.tink.subtle.Ed25519Sign.KeyPair.newKeyPair()
    private val edHex = PqHex.encode(kp.publicKey)
    private val edSign: (ByteArray) -> ByteArray = { m -> com.google.crypto.tink.subtle.Ed25519Sign(kp.privateKey).sign(m) }

    @After fun tearDown() {
        PqSessionKek.vault = null
        PqSessionKek.onOpened = null
        PqSessionKek.clear()
    }

    private fun unlock() {
        val p = PqSessionKek.begin()!!
        PqSessionKek.finish(p, p.cipher)
    }

    @Test fun oneUnlockOpensTheSeedsForTheWholeSessionWithoutTheWindow() {
        val legacy = WindowWrapper()
        PqSessionKek.vault = FakeVault()
        val store = PqKeyStore(MapStore(), SessionKekPqSeedWrapper(legacy), profile = { "p" })
        unlock()
        val e = store.getOrCreate("device", "d1", edHex, now = 1)
        assertTrue(SessionKekPqSeedWrapper.isV2(PqHex.decode(e.wrappedSeedHex)!!))
        // Long after the prompt: the old 300 s window has closed, the session is still unlocked.
        legacy.windowOpen = false
        val sig = store.sign(e, "flagship/pq-key-binding/v1", "x".toByteArray(), edSign)
        assertEquals(3373, sig.size)
    }

    @Test fun locking_the_session_locks_the_seeds_and_the_next_unlock_opens_them_again() {
        val vault = FakeVault()
        PqSessionKek.vault = vault
        val w = SessionKekPqSeedWrapper(WindowWrapper())
        unlock()
        val blob = w.wrap(ByteArray(32) { 5 })
        PqSessionKek.clear()
        assertThrows(IllegalStateException::class.java) { w.unwrap(blob) }
        unlock()
        assertArrayEquals(ByteArray(32) { 5 }, w.unwrap(blob))
        assertTrue(vault.blob != null)
    }

    @Test fun seedsUnderTheOldWrappingMoveUnderTheKekRightAfterTheUnlock() {
        val legacy = WindowWrapper()
        val persistence = MapStore()
        val old = PqKeyStore(persistence, legacy, profile = { "p" }).getOrCreate("admin-root", "alice", edHex, now = 1)
        assertFalse(SessionKekPqSeedWrapper.isV2(PqHex.decode(old.wrappedSeedHex)!!))
        PqSessionKek.vault = FakeVault()
        val store = PqKeyStore(persistence, SessionKekPqSeedWrapper(legacy), profile = { "p" })
        PqSessionKek.onOpened = { store.rewrapUnderSessionKek() }
        unlock()
        val moved = store.entry("admin-root", "alice")!!
        assertTrue(SessionKekPqSeedWrapper.isV2(PqHex.decode(moved.wrappedSeedHex)!!))
        assertEquals(old.mldsaPubHex, moved.mldsaPubHex)
        legacy.windowOpen = false
        assertEquals(3373, store.sign(moved, "flagship/server-order/v1", "y".toByteArray(), edSign).size)
    }

    @Test fun withoutAVaultTheOldWrappingStays() {
        val legacy = WindowWrapper()
        val w = SessionKekPqSeedWrapper(legacy)
        assertTrue(PqSessionKek.begin() == null)
        val blob = w.wrap(ByteArray(32) { 1 })
        assertTrue(w.isLegacy(blob))
        assertArrayEquals(ByteArray(32) { 1 }, w.unwrap(blob))
    }
}
