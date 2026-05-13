// Home tab: account-wide overview + drill-down into individual servers.
// Each NavHost is per-tab so the bottom-bar selection doesn't blow away
// the back-stack of the other tabs (matches iOS's per-tab
// NavigationStack(path:) behavior).

package com.flagship.ui.shell.tabs

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.flagship.core.LocalAppState
import com.flagship.core.LocalScreensClient
import com.flagship.ui.screens.HomeScreen
import com.flagship.ui.screens.PendingServerScreen
import com.flagship.ui.screens.ServerDetailScreen
import com.flagship.ui.screens.CreateServerScreen
import com.flagship.ui.screens.InstallProgressScreen
import com.flagship.viewmodels.HomeViewModel
import kotlinx.coroutines.launch
import java.net.URLEncoder
import java.net.URLDecoder

@Composable
fun HomeTab() {
    val nav = rememberNavController()
    val app = LocalAppState.current
    val client = LocalScreensClient.current
    val pods by app.pods.collectAsState()
    val scope = rememberCoroutineScope()
    val vm = remember { HomeViewModel(client) }

    LaunchedEffect(app.currentPodId.value) { vm.load() }

    NavHost(navController = nav, startDestination = "home-root") {
        composable("home-root") {
            HomeScreen(
                state = vm.state.collectAsState().value,
                username = app.currentUser.collectAsState().value ?: "",
                pods = pods,
                leaderPodId = app.leaderPodId.collectAsState().value,
                onOpenPod = { pod ->
                    nav.navigate("server-detail/${pod.podId}")
                },
                onAddServer = { nav.navigate("create-server") },
                onSetLeader = { app.setLeader(it.podId) },
                onRefresh = { scope.launch { vm.load() } },
            )
        }
        composable("server-detail/{podId}") { entry ->
            val podId = entry.arguments?.getString("podId") ?: return@composable
            val pod = pods.firstOrNull { it.podId == podId }
            if (pod == null) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                return@composable
            }
            if (pod.status == com.flagship.core.PodInfo.Status.PENDING) {
                PendingServerScreen(pod = pod, onCancel = {
                    app.removePod(pod.podId)
                    nav.popBackStack()
                })
            } else {
                ServerDetailScreen(podId = podId, onBack = { nav.popBackStack() })
            }
        }
        composable("create-server") {
            CreateServerScreen(
                onDelivered = { serverDomain, serial, name, description ->
                    val encoded = URLEncoder.encode(name, "UTF-8")
                    nav.navigate("install-progress/$serial?name=$encoded&fqdn=${URLEncoder.encode(serverDomain, "UTF-8")}")
                },
                onCancel = { nav.popBackStack() },
            )
        }
        composable("install-progress/{serial}") { entry ->
            val serial = entry.arguments?.getString("serial") ?: return@composable
            val name = URLDecoder.decode(entry.arguments?.getString("name") ?: "", "UTF-8")
            val fqdn = URLDecoder.decode(entry.arguments?.getString("fqdn") ?: "", "UTF-8")
            InstallProgressScreen(
                serial = serial,
                onFinish = { resolvedFqdn ->
                    val final = resolvedFqdn ?: fqdn
                    val slug = com.flagship.core.SlugUtil.slugify(name)
                    val pod = com.flagship.core.PodInfo(
                        podId = "pod-" + java.util.UUID.randomUUID().toString().take(6),
                        name = name,
                        fqdn = final.ifEmpty { "$slug.flagship.services" },
                        status = com.flagship.core.PodInfo.Status.ONLINE,
                    )
                    app.addPod(pod)
                    nav.popBackStack(route = "home-root", inclusive = false)
                },
            )
        }
    }
}
