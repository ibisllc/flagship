package com.flagshipserver.app

import android.app.Application
import com.flagshipserver.app.core.FSStrings

/** Gives non-UI code (view models, push handlers, notification builders) access to string resources. */
class FlagshipApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        FSStrings.init(this)
    }
}
