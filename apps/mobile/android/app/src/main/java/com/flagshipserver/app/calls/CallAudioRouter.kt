// Where a call's sound goes (docs/voici-calls.md "Call screen"): the phone's earpiece, the speaker, a Bluetooth
// headset or wired headphones. A call answered here runs as a self-managed Telecom connection, so Telecom owns the
// route: we read its CallAudioState and ask it to change. A call this app places has no connection, so the router
// sets the communication mode itself and picks the device through AudioManager (setCommunicationDevice from
// Android 12, the speakerphone and SCO switches before).

package com.flagshipserver.app.calls

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.telecom.CallAudioState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class CallAudioRoute { Earpiece, Speaker, Bluetooth, Wired }

data class CallAudioRoutes(val current: CallAudioRoute = CallAudioRoute.Earpiece, val available: List<CallAudioRoute> = listOf(CallAudioRoute.Earpiece, CallAudioRoute.Speaker)) {
    /** More than the earpiece and the speaker: the Audio button opens a menu instead of switching between the two. */
    val needsMenu: Boolean get() = available.any { it == CallAudioRoute.Bluetooth || it == CallAudioRoute.Wired }

    /** The route the Audio button's tap goes to when there is no menu. */
    val toggled: CallAudioRoute get() = if (current == CallAudioRoute.Speaker) available.firstOrNull { it != CallAudioRoute.Speaker } ?: CallAudioRoute.Earpiece else CallAudioRoute.Speaker
}

object CallAudioRouter {
    private val _routes = MutableStateFlow(CallAudioRoutes())
    val routes: StateFlow<CallAudioRoutes> = _routes.asStateFlow()

    @Volatile private var ownsMode = false
    @Volatile private var savedMode = AudioManager.MODE_NORMAL

    /** Telecom's view of the call's audio (VoiciConnection.onCallAudioStateChanged). */
    @Suppress("DEPRECATION")
    fun onTelecom(state: CallAudioState?) {
        if (state == null) return
        _routes.value = fromTelecom(state.route, state.supportedRouteMask)
    }

    /** Telecom's route bits as our routes (pure, so the unit tests can pin it). */
    fun fromTelecom(route: Int, supported: Int): CallAudioRoutes {
        val order = listOf(
            CallAudioState.ROUTE_EARPIECE to CallAudioRoute.Earpiece,
            CallAudioState.ROUTE_WIRED_HEADSET to CallAudioRoute.Wired,
            CallAudioState.ROUTE_BLUETOOTH to CallAudioRoute.Bluetooth,
            CallAudioState.ROUTE_SPEAKER to CallAudioRoute.Speaker,
        )
        val available = order.filter { (bit, _) -> supported and bit != 0 }.map { it.second }.ifEmpty { listOf(CallAudioRoute.Earpiece, CallAudioRoute.Speaker) }
        val current = order.firstOrNull { (bit, _) -> route and bit != 0 }?.second ?: available.first()
        return CallAudioRoutes(current, available)
    }

    private fun telecomRoute(r: CallAudioRoute): Int = when (r) {
        CallAudioRoute.Earpiece -> CallAudioState.ROUTE_EARPIECE
        CallAudioRoute.Speaker -> CallAudioState.ROUTE_SPEAKER
        CallAudioRoute.Bluetooth -> CallAudioState.ROUTE_BLUETOOTH
        CallAudioRoute.Wired -> CallAudioState.ROUTE_WIRED_HEADSET
    }

    private fun audio(context: Context) = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

    /** A call this app placed starts: the voice-call mode, so the earpiece and headsets are offered. */
    fun startOwnCall(context: Context) {
        val am = audio(context) ?: return
        if (!ownsMode) {
            savedMode = am.mode
            ownsMode = true
        }
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        refresh(context)
    }

    /** The placed call ended: the device and mode go back to what they were. */
    @Suppress("DEPRECATION")
    fun stopOwnCall(context: Context) {
        if (!ownsMode) return
        ownsMode = false
        val am = audio(context) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice()
        else {
            am.isSpeakerphoneOn = false
            if (am.isBluetoothScoOn) {
                am.isBluetoothScoOn = false
                am.stopBluetoothSco()
            }
        }
        am.mode = savedMode
        _routes.value = CallAudioRoutes()
    }

    /** Reads the routes again (a call with a Telecom connection gets them from Telecom instead). */
    @Suppress("DEPRECATION")
    fun refresh(context: Context) {
        if (VoiciCallCenter.connection != null) return
        val am = audio(context) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val devices = am.availableCommunicationDevices
            val available = devices.mapNotNull { routeOf(it.type) }.distinct().sortedBy { it.ordinal }
            val current = am.communicationDevice?.let { routeOf(it.type) } ?: available.firstOrNull() ?: CallAudioRoute.Earpiece
            _routes.value = CallAudioRoutes(current, available.ifEmpty { listOf(CallAudioRoute.Earpiece, CallAudioRoute.Speaker) })
        } else {
            val outputs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).mapNotNull { routeOf(it.type) }.toSet()
            val available = buildList {
                add(if (CallAudioRoute.Wired in outputs) CallAudioRoute.Wired else CallAudioRoute.Earpiece)
                if (CallAudioRoute.Bluetooth in outputs) add(CallAudioRoute.Bluetooth)
                add(CallAudioRoute.Speaker)
            }
            val current = when {
                am.isSpeakerphoneOn -> CallAudioRoute.Speaker
                am.isBluetoothScoOn -> CallAudioRoute.Bluetooth
                else -> available.first()
            }
            _routes.value = CallAudioRoutes(current, available)
        }
    }

    private fun routeOf(type: Int): CallAudioRoute? = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> CallAudioRoute.Earpiece
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> CallAudioRoute.Speaker
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> CallAudioRoute.Bluetooth
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET -> CallAudioRoute.Wired
        else -> null
    }

    /** The person picked [route] on the call screen. */
    @Suppress("DEPRECATION")
    fun select(context: Context, route: CallAudioRoute) {
        val c = VoiciCallCenter.connection
        if (c != null) {
            c.setAudioRoute(telecomRoute(route))
            return
        }
        val am = audio(context) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            am.availableCommunicationDevices.firstOrNull { routeOf(it.type) == route }?.let { am.setCommunicationDevice(it) }
        } else {
            when (route) {
                CallAudioRoute.Speaker -> {
                    if (am.isBluetoothScoOn) {
                        am.isBluetoothScoOn = false
                        am.stopBluetoothSco()
                    }
                    am.isSpeakerphoneOn = true
                }
                CallAudioRoute.Bluetooth -> {
                    am.isSpeakerphoneOn = false
                    am.startBluetoothSco()
                    am.isBluetoothScoOn = true
                }
                CallAudioRoute.Earpiece, CallAudioRoute.Wired -> {
                    if (am.isBluetoothScoOn) {
                        am.isBluetoothScoOn = false
                        am.stopBluetoothSco()
                    }
                    am.isSpeakerphoneOn = false
                }
            }
        }
        refresh(context)
    }

    /** A call answered here ended: Telecom's routes no longer apply. */
    fun reset() {
        if (!ownsMode) _routes.value = CallAudioRoutes()
    }

    /** A video call starts on the speaker unless a headset is in use, as the leading apps do. */
    fun preferSpeakerForVideo(context: Context) {
        if (routes.value.current == CallAudioRoute.Earpiece) select(context, CallAudioRoute.Speaker)
    }
}
