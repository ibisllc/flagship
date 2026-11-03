// On a real Keystore: Android 10 keys open for a window after a prompt, Android 11+ per-use keys
// ride in the prompt (KeyAuthSpec). Needs a secure lock screen (`adb shell locksettings set-pin 1234`).

package com.flagshipserver.app.keystore

import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.flagshipserver.app.core.AndroidVersionPolicy
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

@RunWith(AndroidJUnit4::class)
class KeyAuthSpecDeviceTest {
    private fun make(alias: String, seconds: Int): SecretKey {
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        val b = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
        gen.init(KeyAuthSpec.require(b, seconds).build())
        return gen.generateKey()
    }

    @Test fun keysMatchThePolicyOnThisApiLevel() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val km = ctx.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        assumeTrue("needs a secure lock screen", km.isDeviceSecure)
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        try {
            val perUse = make("test.keyauth.peruse", 0)
            val window = make("test.keyauth.window", 300)
            val windowed = !AndroidVersionPolicy.promptCanCarryKey(Build.VERSION.SDK_INT)
            assertEquals("per-use key on API ${Build.VERSION.SDK_INT}", windowed, KeyAuthSpec.isWindowKey(perUse))
            assertEquals(true, KeyAuthSpec.isWindowKey(window))
        } finally {
            ks.deleteEntry("test.keyauth.peruse")
            ks.deleteEntry("test.keyauth.window")
        }
    }
}
