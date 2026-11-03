// The calm sliver on Android 10 to 12: this phone no longer gets security updates, and updating
// Android (or a newer phone) keeps the account's key safer. On Android 10 with no fingerprint it
// adds that enrolling one makes approvals stronger (per-use keys need one there, KeyAuthSpec). Nothing is restricted; "Not now" hides
// it for 30 days, and Settings keeps a line about it for good (AndroidVersionPolicy).

package com.flagshipserver.app.ui.components

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.R
import com.flagshipserver.app.core.AndroidVersionPolicy
import com.flagshipserver.app.keystore.KeyAuthSpec
import com.flagshipserver.app.ui.theme.FS

object OutdatedAndroidNotice {
    const val SNOOZE_MS = 30L * 24 * 3_600_000
    private const val PREFS = "flagship.os-support"
    private const val KEY = "snoozedUntil"

    /** Pure: show the sliver on this API level at [now], given when "Not now" last ran out. */
    fun shows(sdk: Int, now: Long, snoozedUntil: Long): Boolean =
        AndroidVersionPolicy.warnOutdatedAndroid(sdk) && now >= snoozedUntil

    fun snoozedUntil(ctx: Context): Long =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY, 0L)

    fun snooze(ctx: Context, now: Long = System.currentTimeMillis()) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(KEY, now + SNOOZE_MS).apply()
    }
}

/** Opens the phone's fingerprint setup (Android 9 and 10), else its security settings. */
fun openFingerprintSettings(ctx: Context): Boolean {
    @Suppress("DEPRECATION")
    val intents = listOf(Intent(Settings.ACTION_FINGERPRINT_ENROLL), Intent(Settings.ACTION_SECURITY_SETTINGS), Intent(Settings.ACTION_SETTINGS))
    for (i in intents) {
        try {
            ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return true
        } catch (_: ActivityNotFoundException) {
        } catch (_: SecurityException) {
        }
    }
    return false
}

/** Opens the phone's system-update screen where the maker provides one, else About phone. */
fun openSystemUpdateSettings(ctx: Context): Boolean {
    val intents = listOf(
        Intent("android.settings.SYSTEM_UPDATE_SETTINGS"),
        Intent(Settings.ACTION_DEVICE_INFO_SETTINGS),
        Intent(Settings.ACTION_SETTINGS),
    )
    for (i in intents) {
        try {
            ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return true
        } catch (_: ActivityNotFoundException) {
        } catch (_: SecurityException) {
        }
    }
    return false
}

@Composable
fun OutdatedAndroidSliver() {
    val ctx = LocalContext.current
    var visible by remember {
        mutableStateOf(OutdatedAndroidNotice.shows(Build.VERSION.SDK_INT, System.currentTimeMillis(), OutdatedAndroidNotice.snoozedUntil(ctx)))
    }
    if (!visible) return
    Surface(
        color = FS.colors.surface,
        contentColor = FS.colors.text,
        modifier = Modifier
            .fillMaxWidth()
            .testTag("outdated-android-sliver")
            .semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        Row(Modifier.height(IntrinsicSize.Min)) {
            Box(Modifier.width(4.dp).fillMaxHeight().background(FS.colors.accent))
            Column(
                Modifier.weight(1f).padding(horizontal = FS.space.s4, vertical = FS.space.s3),
                verticalArrangement = Arrangement.spacedBy(FS.space.s2),
            ) {
                Text(stringResource(R.string.android_version_no_longer_gets_updates), style = MaterialTheme.typography.bodyMedium)
                if (AndroidVersionPolicy.suggestAddingFingerprint(Build.VERSION.SDK_INT, KeyAuthSpec.strongBiometricEnrolled(ctx))) {
                    Text(
                        stringResource(R.string.add_fingerprint_for_stronger_approvals),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.testTag("outdated-android-fingerprint"),
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), verticalAlignment = Alignment.CenterVertically) {
                    FSSecondaryButton(
                        label = stringResource(R.string.check_for_android_updates),
                        onClick = { openSystemUpdateSettings(ctx) },
                        modifier = Modifier.heightIn(min = 48.dp).testTag("outdated-android-check"),
                    )
                    FSGhostButton(
                        label = stringResource(R.string.not_now),
                        onClick = {
                            OutdatedAndroidNotice.snooze(ctx)
                            visible = false
                        },
                        modifier = Modifier.heightIn(min = 48.dp).testTag("outdated-android-dismiss"),
                    )
                }
            }
        }
    }
}
