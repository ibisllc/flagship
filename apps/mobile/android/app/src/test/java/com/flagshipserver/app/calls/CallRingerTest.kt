package com.flagshipserver.app.calls

import android.app.NotificationManager.INTERRUPTION_FILTER_ALL
import android.app.NotificationManager.INTERRUPTION_FILTER_PRIORITY
import android.media.AudioManager.RINGER_MODE_NORMAL
import android.media.AudioManager.RINGER_MODE_SILENT
import android.media.AudioManager.RINGER_MODE_VIBRATE
import org.junit.Assert.assertEquals
import org.junit.Test

/** The ring follows the phone's own ring settings, as the phone app's would. */
class CallRingerTest {
    private fun plan(mode: Int, filter: Int = INTERRUPTION_FILTER_ALL, channelOn: Boolean = true, vibrate: Boolean = true) =
        CallRinger.plan(mode, filter, channelOn, vibrate)

    @Test fun ringModeRingsAndVibrates() = assertEquals(CallRinger.Plan(sound = true, vibrate = true), plan(RINGER_MODE_NORMAL))
    @Test fun ringModeWithoutVibrateWhenRinging() = assertEquals(CallRinger.Plan(sound = true, vibrate = false), plan(RINGER_MODE_NORMAL, vibrate = false))
    @Test fun vibrateModeOnlyVibrates() = assertEquals(CallRinger.Plan(sound = false, vibrate = true), plan(RINGER_MODE_VIBRATE))
    @Test fun silentModeIsSilent() = assertEquals(CallRinger.Plan(sound = false, vibrate = false), plan(RINGER_MODE_SILENT))
    @Test fun doNotDisturbIsSilent() = assertEquals(CallRinger.Plan(sound = false, vibrate = false), plan(RINGER_MODE_NORMAL, filter = INTERRUPTION_FILTER_PRIORITY))
    @Test fun aMutedCallsChannelIsSilent() = assertEquals(CallRinger.Plan(sound = false, vibrate = false), plan(RINGER_MODE_NORMAL, channelOn = false))
}
