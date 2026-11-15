// The foreground service of an answered voi.ci call (docs/voici-calls.md §4): type phoneCall, plus microphone and
// camera only once their permission is granted (Android 14 refuses a type whose permission is missing). It keeps the
// call alive with the screen off and carries the ongoing-call notification with Hang up.

package com.flagshipserver.app.calls

import android.Manifest
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

class VoiciCallService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        VoiciCallCenter.ensureChannel(this)
        var types = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL else 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (granted(Manifest.permission.RECORD_AUDIO)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            if (granted(Manifest.permission.CAMERA) && VoiciCallCenter.ui.value.cameraOn) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        }
        runCatching { ServiceCompat.startForeground(this, VoiciCallCenter.NOTIF_ID + 1, VoiciCallCenter.ongoingNotification(this), types) }
            .onFailure { stopSelf() }
        return START_NOT_STICKY
    }

    private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    companion object {
        fun start(context: Context) {
            runCatching { ContextCompat.startForegroundService(context, Intent(context, VoiciCallService::class.java)) }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, VoiciCallService::class.java))
        }
    }
}
