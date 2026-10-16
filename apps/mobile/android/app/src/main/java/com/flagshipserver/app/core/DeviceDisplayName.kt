package com.flagshipserver.app.core

import android.content.Context
import android.os.Build
import android.provider.Settings

/** The name the owner sees for this phone in Android Settings ("Harry's
 *  Galaxy S26"), not the raw model ("SM-S948U1"), as the default device name. */
object DeviceDisplayName {
    fun suggested(context: Context): String? {
        val global = runCatching {
            Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
        }.getOrNull()
        return pick(global, Build.MODEL)
    }

    /** The Settings name when set, else the model; null when neither is. */
    fun pick(settingsName: String?, model: String?): String? =
        settingsName?.trim()?.takeIf { it.isNotEmpty() }
            ?: model?.trim()?.takeIf { it.isNotEmpty() }
}
