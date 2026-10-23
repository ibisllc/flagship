package com.flagshipserver.app.core

import android.content.Context

/** Keeps the box pins (public values: a certificate fingerprint per box) and the known-box list on the phone. */
class CertPinPrefs(context: Context) : CertPinRegistry.Persistence {
    private val prefs = context.getSharedPreferences("flagship.certpin.v1", Context.MODE_PRIVATE)

    override fun load(): Pair<Map<String, String>, Set<String>> {
        val pins = prefs.getStringSet("pins", emptySet()).orEmpty()
            .mapNotNull { e -> e.split("=", limit = 2).takeIf { it.size == 2 }?.let { it[0] to it[1] } }
            .toMap()
        return pins to prefs.getStringSet("known", emptySet()).orEmpty().toSet()
    }

    override fun save(pins: Map<String, String>, known: Set<String>) {
        prefs.edit()
            .putStringSet("pins", pins.map { "${it.key}=${it.value}" }.toSet())
            .putStringSet("known", known)
            .apply()
    }
}
