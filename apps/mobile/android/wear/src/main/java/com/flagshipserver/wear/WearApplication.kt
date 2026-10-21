package com.flagshipserver.wear

import android.app.Application

/** Gives code outside a Composable (the tile, the complication, the phone approver) access to string resources. */
class WearApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        FSStrings.init(this)
    }
}
