package com.flagshipserver.app.core

import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import com.flagshipserver.app.api.AppSummary
import com.flagshipserver.app.api.BuildClient
import com.flagshipserver.app.api.InMemorySessionStore
import com.flagshipserver.app.api.LiveBuildClient
import com.flagshipserver.app.api.LiveScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.SessionStoring
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import okhttp3.OkHttpClient

/** The same clients for every server (mock mode, tests). */
class FixedPodClients(
    private val screens: ScreensClient,
    private val build: BuildClient,
) : PodClients {
    override fun screens(pod: PodInfo): ScreensClient {
        // The mock answers as whichever box it was last pointed at (iOS's
        // HomeViewModel does the same), so each server page shows its own box,
        // and a box that isn't online doesn't answer, as a real one wouldn't.
        (screens as? com.flagshipserver.app.api.MockScreensClient)?.let { mock ->
            val label = pod.fqdn.substringBefore('.')
            mock.podContext = label
            if (pod.status == PodInfo.Status.ONLINE) mock.unreachablePodContexts -= label
            else mock.unreachablePodContexts += label
        }
        return screens
    }
    override fun build(pod: PodInfo): BuildClient = build
}
