// Approve is a decision the owner makes on this watch, so it counts only from the Approve page on
// screen, naming the server, while the watch is on the wrist and unlocked. The phone key that then
// answers needs no presence of its own (the phone may be locked in a pocket), so this is the
// presence. Tiles, complications and the data service only show state; none of them approves.

package com.flagshipserver.wear

import android.app.KeyguardManager
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

object WatchPresence {
    /** Why Approve can't be sent now, or null when it can. [onBody] is null when the watch can't tell. */
    fun refusal(visible: Boolean, screenLockSet: Boolean, locked: Boolean, onBody: Boolean?): String? = when {
        !visible -> FSStrings.get(R.string.open_the_approve_page_on_this_watch)
        !screenLockSet -> FSStrings.get(R.string.set_a_screen_lock_on_this_watch)
        locked -> FSStrings.get(R.string.unlock_this_watch_to_approve)
        onBody == false -> FSStrings.get(R.string.put_this_watch_on_your_wrist)
        else -> null
    }

    /** The live check: the page's own visibility, the keyguard and the off-body sensor. */
    suspend fun refusal(ctx: Context, visible: Boolean): String? {
        val kg = ctx.getSystemService(KeyguardManager::class.java)
        return refusal(visible, kg?.isDeviceSecure == true, kg?.isDeviceLocked != false, onBody(ctx))
    }

    /** The low-latency off-body sensor reports its state on registration: 1 on the wrist, 0 off. */
    private suspend fun onBody(ctx: Context): Boolean? {
        val sm = ctx.getSystemService(SensorManager::class.java) ?: return null
        val sensor = sm.getDefaultSensor(Sensor.TYPE_LOW_LATENCY_OFFBODY_DETECT) ?: return null
        return withTimeoutOrNull(1_500) {
            suspendCancellableCoroutine { cont ->
                val listener = object : SensorEventListener {
                    override fun onSensorChanged(event: SensorEvent) {
                        sm.unregisterListener(this)
                        if (cont.isActive) cont.resume(event.values.firstOrNull()?.let { it >= 1f })
                    }
                    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
                }
                sm.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_NORMAL)
                cont.invokeOnCancellation { sm.unregisterListener(listener) }
            }
        }
    }
}
