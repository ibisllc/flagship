// The ring of an incoming voi.ci call. A self-managed Telecom connection never rings by itself (Android leaves the
// ringtone to the app), so this plays the phone's own ringtone, looping, and vibrates, the way the phone app would:
// silent mode rings nothing, vibrate mode only vibrates, and Do Not Disturb or a muted Calls channel rings nothing.

package com.flagshipserver.app.calls

import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings

object CallRinger {
    private val attributes: AudioAttributes by lazy {
        AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
    }
    private val pattern = longArrayOf(0, 1_000, 1_000)

    private var ringtone: Ringtone? = null
    private var vibrator: Vibrator? = null

    /** What a ring may do on this phone right now. */
    data class Plan(val sound: Boolean, val vibrate: Boolean)

    fun plan(ringerMode: Int, interruptionFilter: Int, channelOn: Boolean, vibrateWhenRinging: Boolean): Plan {
        val dndQuiet = interruptionFilter != NotificationManager.INTERRUPTION_FILTER_ALL &&
            interruptionFilter != NotificationManager.INTERRUPTION_FILTER_UNKNOWN
        if (!channelOn || dndQuiet) return Plan(sound = false, vibrate = false)
        return when (ringerMode) {
            AudioManager.RINGER_MODE_NORMAL -> Plan(sound = true, vibrate = vibrateWhenRinging)
            AudioManager.RINGER_MODE_VIBRATE -> Plan(sound = false, vibrate = true)
            else -> Plan(sound = false, vibrate = false)
        }
    }

    @Synchronized
    fun start(context: Context) {
        if (ringtone != null || vibrator != null) return
        val app = context.applicationContext
        val audio = app.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val notifications = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = notifications.getNotificationChannel(VoiciCallCenter.CHANNEL_ID)
        val p = plan(
            ringerMode = audio.ringerMode,
            interruptionFilter = notifications.currentInterruptionFilter,
            channelOn = channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE,
            // Phones without the setting (most of them now) vibrate while ringing.
            vibrateWhenRinging = runCatching { Settings.System.getInt(app.contentResolver, "vibrate_when_ringing", 1) == 1 }.getOrDefault(true),
        )
        if (p.sound) runCatching {
            val uri = RingtoneManager.getActualDefaultRingtoneUri(app, RingtoneManager.TYPE_RINGTONE)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            RingtoneManager.getRingtone(app, uri)?.apply {
                audioAttributes = attributes
                isLooping = true
                play()
            }
        }.getOrNull()?.let { ringtone = it }
        if (p.vibrate) runCatching {
            val v = if (Build.VERSION.SDK_INT >= 31) {
                (app.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                app.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            }
            if (v.hasVibrator()) {
                @Suppress("DEPRECATION")
                v.vibrate(VibrationEffect.createWaveform(pattern, 0), attributes)
                v
            } else {
                null
            }
        }.getOrNull()?.let { vibrator = it }
    }

    @Synchronized
    fun stop() {
        runCatching { ringtone?.stop() }
        runCatching { vibrator?.cancel() }
        ringtone = null
        vibrator = null
    }
}
