package com.flagshipserver.app.core

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager

/** The two launcher-icon variants, each backed by an <activity-alias> in the
 *  manifest. CLASSIC (teal + white circle, brand-consistent with iOS) is the
 *  default; LEGACY is the original hexagon. */
enum class AppIconVariant(val alias: String) {
    CLASSIC("com.flagshipserver.app.ClassicLauncher"),
    LEGACY("com.flagshipserver.app.LegacyLauncher"),
}

/**
 * Switches the launcher icon by toggling which activity-alias is enabled
 * (PackageManager.setComponentEnabledSetting). Exactly one alias is ever
 * enabled — the target is enabled BEFORE the others are disabled, so the app
 * never momentarily loses its launcher entry. DONT_KILL_APP keeps the current
 * process alive; the launcher re-reads the icon shortly after (some launchers
 * take a few seconds, and the app may briefly drop from the drawer — standard
 * Android icon-switch behavior).
 */
object AppIconSwitcher {
    fun current(context: Context): AppIconVariant {
        val pm = context.packageManager
        val legacy = ComponentName(context, AppIconVariant.LEGACY.alias)
        // Only LEGACY is explicitly-enabled when chosen; DEFAULT/DISABLED ⇒ the
        // manifest default (classic on, legacy off) stands.
        return if (pm.getComponentEnabledSetting(legacy) ==
            PackageManager.COMPONENT_ENABLED_STATE_ENABLED
        ) {
            AppIconVariant.LEGACY
        } else {
            AppIconVariant.CLASSIC
        }
    }

    fun set(context: Context, variant: AppIconVariant) {
        if (current(context) == variant) return
        val pm = context.packageManager
        // Enable the target FIRST so there is never a window with no launcher.
        pm.setComponentEnabledSetting(
            ComponentName(context, variant.alias),
            PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
            PackageManager.DONT_KILL_APP,
        )
        for (v in AppIconVariant.entries) {
            if (v == variant) continue
            pm.setComponentEnabledSetting(
                ComponentName(context, v.alias),
                PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP,
            )
        }
    }
}
