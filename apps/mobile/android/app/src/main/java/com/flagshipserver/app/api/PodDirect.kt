// Which transport the clients that talk to a box directly (power, dead-man,
// journal, front page) use: OkHttp, or a debug gym run's mock box
// (MockBoxDirect, installed by the gym launch). A release build never changes it.
//
// The real transport is the app's shared client, not a bare OkHttpClient: a box name the phone's
// resolver can't find is then reached through the relay, and the box's certificate pin applies.
// With a bare client these calls failed ("Couldn't reach the server") while Home, which uses the
// shared client, showed the same box online.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.OkHttpJsonTransport

object PodDirect {
    private val shared by lazy { OkHttpJsonTransport(com.flagshipserver.app.core.HttpClientFactory.build()) }

    @Volatile var transport: () -> JsonHttpTransport = { shared }
}
