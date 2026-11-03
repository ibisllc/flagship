// M6 on a real Keystore: on Android 10 with a fingerprint enrolled, the PQ session key is made per
// use (no validity window) and opens only through the unlock prompt's CryptoObject answered with
// that fingerprint; a window key made before a fingerprint was enrolled moves to per use at the
// next unlock without losing the KEK.
//
// Needs a secure lock screen and an enrolled fingerprint, and someone touching the sensor while it
// runs. On the emulator:
//   adb shell locksettings set-pin 1234, enroll a fingerprint in Settings (adb emu finger touch 1),
//   then run the test while a loop sends `adb -e emu finger touch 1` every second or two.

package com.flagshipserver.app.keystore

import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.flagshipserver.app.core.AndroidVersionPolicy.KeyBinding
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore
import javax.crypto.SecretKey

@RunWith(AndroidJUnit4::class)
class PerUseBiometricDeviceTest {
    private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val aliases = listOf("test.m6.kek", "test.m6.kek.per-use", "test.m6.kek2", "test.m6.kek2.per-use")

    @Before fun needsLockAndFingerprint() {
        val km = ctx.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        assumeTrue("needs a secure lock screen", km.isDeviceSecure)
        assumeTrue("needs an enrolled strong biometric", KeyAuthSpec.strongBiometricEnrolled(ctx))
        cleanup()
    }

    @After fun cleanup() {
        KeyAuthSpec.strongBiometricOverride = null
        PqSessionKek.vault = null
        PqSessionKek.clear()
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        aliases.forEach { runCatching { ks.deleteEntry(it) } }
        val prefs = ctx.getSharedPreferences("flagship.pqkeys.v1", Context.MODE_PRIVATE)
        prefs.edit().apply { prefs.all.keys.filter { k -> aliases.any { k.endsWith(".$it") } }.forEach { remove(it) } }.commit()
    }

    private fun key(alias: String): SecretKey = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey(alias, null) as SecretKey

    private fun unlock() {
        ActivityScenario.launch(PromptHostTestActivity::class.java).use { scenario ->
            lateinit var activity: PromptHostTestActivity
            scenario.onActivity { activity = it }
            runBlocking { BiometricGate.evaluateUnlockingPq(activity, "M6 device test", "Touch the sensor") }
        }
    }

    @Test fun perUseKekOpensOnlyThroughTheFingerprintPrompt() {
        val vault = KeystorePqKekVault(ctx, alias = "test.m6.kek")
        PqSessionKek.vault = vault
        assertEquals(PqKekPlan.CREATE_PER_USE, vault.plan(strongBiometric = true))

        unlock()
        val kek = PqSessionKek.current()
        assertNotNull("the prompt's CryptoObject opened the KEK", kek)
        val binding = KeyAuthSpec.binding(key("test.m6.kek"))
        if (Build.VERSION.SDK_INT < 30) assertEquals(KeyBinding.PER_USE_BIOMETRIC_ONLY, binding)
        assertEquals(PqKekPlan.OPEN_PER_USE, vault.plan(strongBiometric = true))

        // Seconds after a successful strong authentication, the key still refuses an operation that
        // no prompt carried: there is no window any unlock (the app's or the lock screen's) opens.
        val p = vault.begin(strongBiometric = true)
        val refused = runCatching { vault.finish(p, p.cipher) }
        assertTrue("per-use key worked without its own prompt: ${refused.getOrNull()?.size}", refused.isFailure)

        PqSessionKek.clear()
        unlock()
        assertArrayEquals("the same KEK opens at the next unlock", kek, PqSessionKek.current())
    }

    @Test fun aWindowKeyMadeWithoutAFingerprintMovesToPerUseKeepingTheKek() {
        assumeTrue("Android 10 only", Build.VERSION.SDK_INT < 30)
        val vault = KeystorePqKekVault(ctx, alias = "test.m6.kek2")
        PqSessionKek.vault = vault

        // As if no fingerprint were enrolled: the KEK is made under a 15 s window key.
        KeyAuthSpec.strongBiometricOverride = false
        assertEquals(PqKekPlan.CREATE_WINDOW, vault.plan(strongBiometric = false))
        unlock()
        val kek = PqSessionKek.current()
        assertNotNull("the window opened by the prompt made the KEK", kek)
        assertEquals(KeyBinding.WINDOW, KeyAuthSpec.binding(key("test.m6.kek2")))

        // A fingerprint is enrolled now: the next unlock carries a new per-use key and moves the KEK.
        KeyAuthSpec.strongBiometricOverride = null
        PqSessionKek.clear()
        assertEquals(PqKekPlan.UPGRADE_WINDOW, vault.plan(strongBiometric = true))
        unlock()
        assertArrayEquals("the KEK survived the move", kek, PqSessionKek.current())
        assertEquals(KeyBinding.PER_USE_BIOMETRIC_ONLY, KeyAuthSpec.binding(key("test.m6.kek2.per-use")))
        assertEquals(PqKekPlan.OPEN_PER_USE, vault.plan(strongBiometric = true))
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertTrue("the window key is gone", !ks.containsAlias("test.m6.kek2"))

        PqSessionKek.clear()
        unlock()
        assertArrayEquals(kek, PqSessionKek.current())
    }
}
