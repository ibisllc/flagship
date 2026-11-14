// Which service delivers this phone's pushes. A phone with a UnifiedPush
// distributor (ntfy, NextPush, Sunup, ...) uses it even when Google Play
// Services are also there: installing a distributor is a deliberate choice,
// and on a de-Googled phone FCM can't deliver at all. Without a distributor
// the phone uses FCM when Play Services exist, and otherwise has no push.
// One transport at a time: `.com` replaces the device's FCM token with its
// UnifiedPush one (and back), so a notification never arrives twice.

package com.flagshipserver.app.push

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class PushTransport(val platform: String?) {
    UNIFIEDPUSH("unifiedpush"),
    FCM("fcm"),
    NONE(null);

    companion object {
        fun choose(hasDistributor: Boolean, hasPlayServices: Boolean): PushTransport = when {
            hasDistributor -> UNIFIEDPUSH
            hasPlayServices -> FCM
            else -> NONE
        }

        fun fromName(name: String?): PushTransport? = entries.firstOrNull { it.name == name }
    }
}

/**
 * A UnifiedPush endpoint as `.com`'s Web Push token: the subscription JSON
 * `{"endpoint","keys":{"p256dh","auth"}}`, signed as this exact string by the
 * push registration. Null for an endpoint `.com` would refuse anyway (not
 * https, or characters the canonical bytes or this hand-written JSON can't carry).
 */
object UnifiedPushSubscription {
    private val B64URL = Regex("^[A-Za-z0-9_-]+$")
    private const val MAX_ENDPOINT = 1024

    fun providerToken(endpoint: String, p256dh: String?, auth: String?): String? {
        if (p256dh == null || auth == null) return null
        if (!B64URL.matches(p256dh) || !B64URL.matches(auth)) return null
        if (endpoint.length > MAX_ENDPOINT || !endpoint.startsWith("https://")) return null
        if (endpoint.any { it == '"' || it == '\\' || it == '|' || it.code < 0x20 || it.code == 0x7f || it.code > 0x7e }) return null
        val host = runCatching { java.net.URI(endpoint).host }.getOrNull()
        if (host.isNullOrEmpty()) return null
        return """{"endpoint":"$endpoint","keys":{"p256dh":"$p256dh","auth":"$auth"}}"""
    }
}

data class PushTransportStatus(
    val transport: PushTransport?,
    /** The distributor app's package, when [transport] is UnifiedPush. */
    val distributor: String? = null,
)

/** What this phone delivers through, the UnifiedPush endpoint it holds and the last token `.com` took. */
class PushTransportStore(private val prefs: SharedPreferences) {
    private val _status = MutableStateFlow(
        PushTransportStatus(
            PushTransport.fromName(prefs.getString(KEY_TRANSPORT, null)),
            prefs.getString(KEY_DISTRIBUTOR, null),
        ),
    )
    val status: StateFlow<PushTransportStatus> = _status.asStateFlow()

    val transport: PushTransport? get() = _status.value.transport

    fun setTransport(transport: PushTransport, distributor: String?) {
        val d = distributor.takeIf { transport == PushTransport.UNIFIEDPUSH }
        prefs.edit().putString(KEY_TRANSPORT, transport.name).putString(KEY_DISTRIBUTOR, d).apply()
        _status.value = PushTransportStatus(transport, d)
    }

    var unifiedPushToken: String?
        get() = prefs.getString(KEY_UP_TOKEN, null)
        set(value) { prefs.edit().putString(KEY_UP_TOKEN, value).apply() }

    var vapidPublicKey: String?
        get() = prefs.getString(KEY_VAPID, null)
        set(value) { prefs.edit().putString(KEY_VAPID, value).apply() }

    /** `<platform>|<providerToken>` of the last registration `.com` accepted. */
    var lastRegistered: String?
        get() = prefs.getString(KEY_LAST_REGISTERED, null)
        set(value) { prefs.edit().putString(KEY_LAST_REGISTERED, value).apply() }

    companion object {
        private const val PREFS = "flagship.push-transport"
        private const val KEY_TRANSPORT = "transport"
        private const val KEY_DISTRIBUTOR = "distributor"
        private const val KEY_UP_TOKEN = "unifiedPushToken"
        private const val KEY_VAPID = "vapidPublicKey"
        private const val KEY_LAST_REGISTERED = "lastRegistered"

        @Volatile private var shared: PushTransportStore? = null

        fun from(context: Context): PushTransportStore =
            shared ?: synchronized(this) {
                shared ?: PushTransportStore(
                    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE),
                ).also { shared = it }
            }
    }
}
