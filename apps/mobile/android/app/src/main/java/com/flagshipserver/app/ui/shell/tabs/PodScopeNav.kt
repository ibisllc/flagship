// Which server a screen on the Apps tab works on (docs/app-placement.md).
//
// A screen opened on a particular server (an app page from a server's list,
// a creation flow pinned to a server, or a creation flow whose server the
// owner picked) carries a mark in its back-stack entry's saved state. Every
// screen above it inherits that server: its LocalScreensClient and
// LocalBuildClient are bound to that server's own base URL and session.
// Without a mark, an ordinary screen keeps the current server's clients, and
// a creation screen defaults to the leader.

package com.flagshipserver.app.ui.shell.tabs

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavController
import com.flagshipserver.app.core.CreationPlacement
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalBuildClient
import com.flagshipserver.app.core.LocalPodClients
import com.flagshipserver.app.core.LocalPodScope
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.PodScope

private const val KEY_POD = "placement.pod"
private const val KEY_PINNED = "placement.pinned"

/** Bumped when a creation flow's choice changes, so scoped screens re-read it. */
class PlacementNavState {
    var version by mutableIntStateOf(0)
}

/** Navigate to [route] with the new screen working on [podId]. */
fun NavController.navigateOnPod(route: String, podId: String?, pinned: Boolean = false) {
    navigate(route)
    if (podId.isNullOrEmpty()) return
    markOnPod(podId, pinned)
}

/** Mark the screen just navigated to as working on [podId]. */
fun NavController.markOnPod(podId: String, pinned: Boolean = false) {
    currentBackStackEntry?.savedStateHandle?.let {
        it[KEY_POD] = podId
        it[KEY_PINNED] = pinned
    }
}

private fun NavBackStackEntry.mark(): CreationPlacement.Mark? = runCatching {
    val id = savedStateHandle.get<String>(KEY_POD) ?: return@runCatching null
    CreationPlacement.Mark(id, savedStateHandle.get<Boolean>(KEY_PINNED) == true)
}.getOrNull()

/**
 * Runs [content] on the server [entry] works on. [creation]: a screen of the
 * creation flow, which defaults to the leader and may change the choice (on
 * the flow's "Build a service" entry, so every step shares it).
 */
@Composable
fun PodScoped(
    nav: NavController,
    state: PlacementNavState,
    entry: NavBackStackEntry,
    creation: Boolean = false,
    content: @Composable () -> Unit,
) {
    val app = LocalAppState.current
    val podClients = LocalPodClients.current
    val globalScreens = LocalScreensClient.current
    val globalBuild = LocalBuildClient.current
    val pods by app.pods.collectAsState()
    val leaderId by app.leaderPodId.collectAsState()
    val stack by nav.currentBackStack.collectAsState()
    @Suppress("UNUSED_VARIABLE") val version = state.version

    // While this screen animates out it has left the back stack: keep the
    // chain it had.
    val memo = remember(entry.id) { arrayOfNulls<List<NavBackStackEntry>>(1) }
    val i = stack.indexOfFirst { it.id == entry.id }
    val chain = if (i >= 0) stack.subList(0, i + 1).toList().also { memo[0] = it } else memo[0] ?: listOf(entry)

    val isAvailable: (PodInfo) -> Boolean = { podClients.screens(it) != null }
    val resolved = CreationPlacement.scope(chain.map { it.mark() }, creation, pods, leaderId, isAvailable)
    if (resolved == null) {
        content()
        return
    }
    val (pod, pinned) = resolved
    val root = chain.lastOrNull { it.destination.route == BUILD_CHOOSER_ROUTE } ?: entry
    val choose: ((String) -> Unit)? = if (creation && !pinned) {
        { podId ->
            runCatching {
                root.savedStateHandle[KEY_POD] = podId
                root.savedStateHandle[KEY_PINNED] = false
            }
            state.version += 1
        }
    } else {
        null
    }
    CompositionLocalProvider(
        LocalScreensClient provides (podClients.screens(pod) ?: globalScreens),
        LocalBuildClient provides (podClients.build(pod) ?: globalBuild),
        LocalPodScope provides PodScope(pod = pod, pinned = pinned, creation = creation, choose = choose),
    ) {
        content()
    }
}
