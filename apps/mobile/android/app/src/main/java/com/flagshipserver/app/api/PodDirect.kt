// Which transport the clients that talk to a box directly (power, dead-man,
// journal, front page) use: OkHttp, or a debug gym run's mock box
// (MockBoxDirect, installed by the gym launch). A release build never changes it.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.OkHttpJsonTransport

object PodDirect {
    @Volatile var transport: () -> JsonHttpTransport = { OkHttpJsonTransport() }
}
