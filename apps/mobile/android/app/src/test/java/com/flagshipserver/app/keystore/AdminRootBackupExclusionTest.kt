// Slice D custody regression (docs/device-admin-tier-spec.md §9.6) — the admin
// master root MUST be device-local. It lives in the "flagship-keystore"
// EncryptedSharedPreferences file under `admin.root.seed` (Keystore.kt); if
// Android Auto Backup / device-to-device transfer ever replicated that file, a
// restored device would silently hold the root — re-collapsing the
// membership-vs-authority split (the exact iOS bug class the spec calls out
// for the synchronizable keychain attribute).
//
// Today the app's stance is android:allowBackup="false" (AndroidManifest.xml),
// which opts the ENTIRE app out of cloud backup AND d2d transfer — no
// per-file exclusion rules are needed while that holds. This test pins the
// merged manifest so a future edit can't silently start syncing the root: if
// allowBackup ever flips to true, this fails and the fixer must add
// fullBackupContent/dataExtractionRules excluding "flagship-keystore.xml"
// (and re-point this test at those rules).
//
// Defense-in-depth even if a backup escaped: EncryptedSharedPreferences wraps
// values under an AndroidKeyStore master key that is hardware-bound and never
// leaves the device, so a copied prefs file is undecryptable elsewhere. That
// is NOT a reason to allow the copy — the exclusion stance stays load-bearing.

package com.flagshipserver.app.keystore

import android.content.Context
import android.content.pm.ApplicationInfo
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class AdminRootBackupExclusionTest {

    @Test
    fun appOptsOutOfBackup_soAdminRootPrefsNeverLeaveTheDevice() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        assertEquals(
            "android:allowBackup must stay false — the admin master root " +
                "(admin.root.seed in the flagship-keystore prefs) is device-local " +
                "authority material; if backup is ever enabled, exclusion rules for " +
                "the prefs file MUST be added instead.",
            0,
            ctx.applicationInfo.flags and ApplicationInfo.FLAG_ALLOW_BACKUP,
        )
    }
}
