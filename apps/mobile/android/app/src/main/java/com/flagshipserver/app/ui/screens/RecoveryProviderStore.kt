package com.flagshipserver.app.ui.screens

import android.content.Context

/** This device's own note of its cloud recovery set-up: that it finished, and
 *  which passkey app saved the passkey when its AAGUID told us. Only an app
 *  name and a flag; the escrow itself lives on `.com` and in Block Store. */
internal object RecoveryProviderStore {
    private const val FILE = "flagship.recovery"
    private const val KEY_PROVIDER = "passkeyProvider"
    private const val KEY_CONFIGURED = "configured"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun read(ctx: Context): String? = runCatching { prefs(ctx).getString(KEY_PROVIDER, null) }.getOrNull()

    fun isConfigured(ctx: Context): Boolean = runCatching { prefs(ctx).getBoolean(KEY_CONFIGURED, false) }.getOrDefault(false)

    /** Set-up finished; [provider] is the passkey app's name or null. */
    fun write(ctx: Context, provider: String?) {
        runCatching {
            prefs(ctx).edit().apply {
                putBoolean(KEY_CONFIGURED, true)
                if (provider == null) remove(KEY_PROVIDER) else putString(KEY_PROVIDER, provider)
            }.apply()
        }
    }
}
