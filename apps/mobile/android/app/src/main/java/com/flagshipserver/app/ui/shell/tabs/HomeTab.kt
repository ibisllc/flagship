// Home tab: account-wide overview + drill-down into individual servers.
// Each NavHost is per-tab so the bottom-bar selection doesn't blow away
// the back-stack of the other tabs (matches iOS's per-tab
// NavigationStack(path:) behavior).

package com.flagshipserver.app.ui.shell.tabs

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
import com.flagshipserver.app.core.DeepLink
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalDeepLinker
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.screens.AddServerChooserScreen
import com.flagshipserver.app.ui.screens.AddServerMode
import com.flagshipserver.app.ui.screens.HomeScreen
import com.flagshipserver.app.ui.screens.PendingServerScreen
import com.flagshipserver.app.ui.screens.PodPairScreen
import com.flagshipserver.app.ui.screens.ServerDetailScreen
import com.flagshipserver.app.ui.screens.CreateServerScreen
import com.flagshipserver.app.ui.screens.InstallProgressScreen
import com.flagshipserver.app.viewmodels.HomeViewModel
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

    // Consume any deep link the shell already steered at this tab.
    val deepLinker = LocalDeepLinker.current
    val pending by deepLinker.pending.collectAsState()
    LaunchedEffect(pending) {
        when (val link = pending) {
            is DeepLink.ServerDetail -> {
                deepLinker.consume()
                nav.navigate("server-detail/${link.podId}")
            }
            DeepLink.CreateServer -> {
                deepLinker.consume()
                nav.navigate("create-server")
            }
            else -> { /* not for this tab */ }
        }
    }

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
                onAddServer = { nav.navigate("add-server-chooser") },
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
            if (pod.status == com.flagshipserver.app.core.PodInfo.Status.PENDING) {
                PendingServerScreen(pod = pod, onCancel = {
                    app.removePod(pod.podId)
                    nav.popBackStack()
                })
            } else {
                ServerDetailScreen(podId = podId, onBack = { nav.popBackStack() })
            }
        }
        composable("add-server-chooser") {
            AddServerChooserScreen(
                mode = AddServerMode.IN_APP,
                onProvision = { nav.navigate("create-server") },
                onPair = { nav.navigate("pod-pair") },
                onCancel = { nav.popBackStack() },
            )
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
        composable("pod-pair") {
            PodPairScreen(
                onSubmit = { code, name, description ->
                    val slug = com.flagshipserver.app.core.SlugUtil.slugify(name)
                    val user = app.currentUser.value ?: "you"
                    val pod = com.flagshipserver.app.core.PodInfo(
                        podId = "pod-" + java.util.UUID.randomUUID().toString().take(6),
                        name = name,
                        description = description.ifEmpty { null },
                        fqdn = "$slug.$user.flagship.services",
                        status = com.flagshipserver.app.core.PodInfo.Status.PENDING,
                        pendingAuthCodeSerial = code,
                    )
                    app.addPod(pod)
                    nav.popBackStack(route = "home-root", inclusive = false)
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
                    val slug = com.flagshipserver.app.core.SlugUtil.slugify(name)
                    val pod = com.flagshipserver.app.core.PodInfo(
                        podId = "pod-" + java.util.UUID.randomUUID().toString().take(6),
                        name = name,
                        fqdn = final.ifEmpty { "$slug.flagship.services" },
                        status = com.flagshipserver.app.core.PodInfo.Status.ONLINE,
                    )
                    app.addPod(pod)
                    nav.popBackStack(route = "home-root", inclusive = false)
                },
            )
        }
    }
}
