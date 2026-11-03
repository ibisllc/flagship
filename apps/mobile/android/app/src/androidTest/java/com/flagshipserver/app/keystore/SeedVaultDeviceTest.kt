// The account seed under the session key on a real AndroidKeyStore (SeedVault): an install from
// before the change keeps its seed in the old storage; the first unlock (one prompt whose
// CryptoObject opens the session key) moves it there, read back and checked, and deletes the old
// copy; with the session locked the seed can't be read or minted over; the next unlock opens the
// same seed; and a session key that is gone (as after the screen lock is removed) leaves the seed
// reported lost, never silently replaced.
//
// Needs a secure lock screen (`adb shell locksettings set-pin 1234`) and someone answering the
// prompt while it runs: with a fingerprint enrolled, a loop sending `adb -e emu finger touch 1`;
// without one (Android 10 window key, or Android 11+ PIN), a loop typing the PIN
// (`adb shell input text 1234 && adb shell input keyevent 66`).

package com.flagshipserver.app.keystore

import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.flagshipserver.app.core.AndroidVersionPolicy.KeyBinding
import com.flagshipserver.app.core.HexUtil
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore

@RunWith(AndroidJUnit4::class)
class SeedVaultDeviceTest {
    private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val alias = "test.seedvault.kek"
    private val aliases = listOf(alias, "$alias.per-use")
    private val prefsName = "seedvault-device-test"
    private val umk = ByteArray(32) { (it * 7 + 1).toByte() }
    private val root = ByteArray(32) { (it * 3 + 5).toByte() }

    @Before fun setUp() {
        val km = ctx.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        assumeTrue("needs a secure lock screen", km.isDeviceSecure)
        cleanup()
        val prefs = ctx.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
        Keystore.attachForTest(prefs)
        Keystore.setActiveProfileInMemory(null)
        PqSessionKek.vault = KeystorePqKekVault(ctx, alias = alias)
    }

    @After fun cleanup() {
        PqSessionKek.vault = null
        PqSessionKek.clear()
        SeedVault.markLost(false)
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        aliases.forEach { runCatching { ks.deleteEntry(it) } }
        val pq = ctx.getSharedPreferences("flagship.pqkeys.v1", Context.MODE_PRIVATE)
        pq.edit().apply { pq.all.keys.filter { k -> aliases.any { k.endsWith(".$it") } }.forEach { remove(it) } }.commit()
        ctx.getSharedPreferences(prefsName, Context.MODE_PRIVATE).edit().clear().commit()
    }

    private fun unlock() {
        ActivityScenario.launch(PromptHostTestActivity::class.java).use { scenario ->
            lateinit var activity: PromptHostTestActivity
            scenario.onActivity { activity = it }
            runBlocking { BiometricGate.evaluateUnlockingPq(activity, "Seed vault device test", "Touch the sensor or enter the PIN") }
        }
    }

    private fun prefs() = ctx.getSharedPreferences(prefsName, Context.MODE_PRIVATE)

    @Test fun upgradedInstallMovesItsSeedAtTheFirstUnlock_andLockedReadsRefuse() {
        // A versionCode 9 install: the seed and the admin root in the old storage.
        prefs().edit().putString("umk.seed", HexUtil.encode(umk)).putString("admin.root.seed", HexUtil.encode(root)).commit()
        assertArrayEquals(umk, Keystore.currentUmkSeed())

        unlock()
        assertTrue("the prompt opened the session key", PqSessionKek.isOpen())
        assertTrue("sealed under it", Keystore.seedsAreSealed())
        assertNull("old copy deleted", prefs().getString("umk.seed", null))
        assertNull(prefs().getString("admin.root.seed", null))
        assertArrayEquals(umk, Keystore.currentUmkSeed())
        assertArrayEquals(root, Keystore.adminRootSeed())
        val key = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey(alias, null) as javax.crypto.SecretKey
        val binding = KeyAuthSpec.binding(key)
        // Android 10 with a fingerprint: per use, unless this phone's Keystore refused a per-use key
        // (the Android 10 emulator does, checking the biometric itself), which the vault records and
        // answers with the window key (KeystorePqKekVault).
        val perUseRefused = ctx.getSharedPreferences("flagship.pqkeys.v1", Context.MODE_PRIVATE)
            .getBoolean("pq.kek.v2.per-use-refused.$alias", false)
        when {
            Build.VERSION.SDK_INT >= 30 -> assertEquals(KeyBinding.PER_USE_BIOMETRIC_OR_PIN, binding)
            KeyAuthSpec.strongBiometricEnrolled(ctx) && !perUseRefused -> assertEquals(KeyBinding.PER_USE_BIOMETRIC_ONLY, binding)
            else -> assertEquals(KeyBinding.WINDOW, binding)
        }

        // Locked (the app went to the background): nothing opens the seed, nothing mints over it.
        PqSessionKek.clear()
        val sealed = prefs().getString("sealed.umk.seed", null)
        assertThrows(SessionLockedException::class.java) { Keystore.loadOrCreateUmkSeed() }
        assertThrows(SessionLockedException::class.java) { runBlocking { Keystore.deriveIRK("background") } }
        assertEquals(sealed, prefs().getString("sealed.umk.seed", null))
        assertTrue(Keystore.hasUmkSeed())
        assertNotNull(Keystore.adminRootPubHex())

        unlock()
        assertArrayEquals("the same seed at the next unlock", umk, Keystore.currentUmkSeed())
    }

    /**
     * The real thing: the screen lock is removed while the seed is sealed, then set again. Android
     * invalidates the session key's Keystore key; the next unlock makes a new one and finds the seed
     * unreadable. Changes the device's lock, so it runs only when asked with the current PIN:
     * `-Pandroid.testInstrumentationRunnerArguments.seedVaultClearsLockPin=1234`.
     */
    @Test fun removingTheScreenLockLeavesTheSeedLost() {
        val pin = InstrumentationRegistry.getArguments().getString("seedVaultClearsLockPin")
        assumeTrue("opt-in: it removes and restores the screen lock", !pin.isNullOrEmpty())
        prefs().edit().putString("umk.seed", HexUtil.encode(umk)).commit()
        unlock()
        assertTrue(Keystore.seedsAreSealed())
        PqSessionKek.clear()

        shell("locksettings clear --old $pin")
        shell("locksettings set-pin $pin")
        unlock()
        assertTrue("the unlock made a new session key", PqSessionKek.isOpen())
        assertTrue("the seed is reported lost", SeedVault.lost.value)
        assertThrows(AccountKeyUnreadableException::class.java) { Keystore.currentUmkSeed() }
        assertNotNull("kept until the person chooses", prefs().getString("sealed.umk.seed", null))
    }

    private fun shell(cmd: String) {
        val pfd = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(cmd)
        android.os.ParcelFileDescriptor.AutoCloseInputStream(pfd).use { it.readBytes() }
    }

    @Test fun aSessionKeyThatIsGoneLeavesTheSeedLost_notReplaced() {
        prefs().edit().putString("umk.seed", HexUtil.encode(umk)).commit()
        unlock()
        assertTrue(Keystore.seedsAreSealed())
        PqSessionKek.clear()

        // As after the screen lock was removed: the Keystore key is gone for good.
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        aliases.forEach { runCatching { ks.deleteEntry(it) } }
        unlock()
        assertTrue("a new session key opened", PqSessionKek.isOpen())
        assertTrue("the seed is reported lost", SeedVault.lost.value)
        assertThrows(AccountKeyUnreadableException::class.java) { Keystore.currentUmkSeed() }
        assertNotNull("nothing deleted until the person chooses", prefs().getString("sealed.umk.seed", null))

        assertTrue(Keystore.forgetUnreadableSeeds())
        assertFalse(Keystore.hasUmkSeed())
        assertFalse(SeedVault.lost.value)
    }
}
