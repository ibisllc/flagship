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
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.flagshipserver.app.core.DeepLink
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalDeepLinker
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalSecretMailboxClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.BootApprovalWatcher
import com.flagshipserver.app.core.PendingApprovalSets
import com.flagshipserver.app.core.PendingServerReconciler
import com.flagshipserver.app.core.decommissionServer
import com.flagshipserver.app.core.RecoveryBannerStore
import com.flagshipserver.app.ui.screens.AddServerChooserScreen
import com.flagshipserver.app.ui.screens.AddServerMode
import com.flagshipserver.app.ui.screens.DemoInstallProgressScreen
import com.flagshipserver.app.ui.screens.HomeScreen
import com.flagshipserver.app.ui.screens.PendingServerScreen
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
    val server = LocalFlagshipServerClient.current
    val toasts = LocalToastCenter.current
    val pods by app.pods.collectAsState()
    val scope = rememberCoroutineScope()
    val vm = remember { HomeViewModel(client) }
    val mailbox = LocalSecretMailboxClient.current
    // #56 — reconcile the server list against ONE unauthenticated `/pods`
    // fetch (registered servers + active orders). Surfaces in-flight orders
    // (the never-ported "home2" fix) and ages out dead pending ghosts. A pure
    // read — NO biometric prompt; Face ID stays only on mutations.
    val reconciler = remember(mailbox) { PendingServerReconciler(app, mailbox) }
    // Account-level "which boxes are waiting for my unlock approval?" poller.
    // Populates app.serversAwaitingApproval so the list / detail / checklist
    // read a per-server waiting state from ONE fetch (no N pollers).
    val approvalWatcher = remember(mailbox) {
        BootApprovalWatcher(
            app = app,
            // DIRECTORY-DRIVEN, no biometric: read the cheap `awaitingUnlock`
            // flag straight from the unauthenticated `/pods` directory. (The old
            // path derived the IRK to read the mailbox, firing Face ID on a
            // timer.) Best-effort: a blip returns the prior set.
            pollAwaiting = pollAwaiting@{
                val prior = PendingApprovalSets(
                    app.serversAwaitingApproval.value,
                    app.serversAwaitingEntitlement.value,
                )
                val user = app.currentUser.value
                if (user.isNullOrEmpty()) return@pollAwaiting prior
                val dir = runCatching { mailbox.fetchPods(user) }.getOrElse { return@pollAwaiting prior }
                PendingApprovalSets(
                    unlock = dir.pods.filter { it.awaitingUnlock }.map { it.serverDomain.lowercase() }.toSet(),
                    entitlement = dir.pods.filter { it.awaitingEntitlement }.map { it.serverDomain.lowercase() }.toSet(),
                )
            },
        )
    }
    val awaitingApproval by app.serversAwaitingApproval.collectAsState()
    val ctx = LocalContext.current
    // Persistent dismiss for the post-creation backup-reminder banner
    // (mirror of webapp's flagship.recovery.banner.dismissed.v1). The
    // StateFlow is collected below so toggling `setDismissed(true)`
    // from "Not now" recomposes Home and the banner disappears.
    val recoveryBannerStore = remember { RecoveryBannerStore.fromContext(ctx) }

    LaunchedEffect(app.currentPodId.value) { vm.load() }

    // Reconcile the server list against `/pods` on first appearance and
    // whenever the signed-in account changes. Best-effort + silent.
    LaunchedEffect(app.currentUser.value) { reconciler.reconcile() }

    // Account-level approval poll: keep app.serversAwaitingApproval fresh so a
    // box waiting for unlock surfaces its Approve affordance on the list /
    // checklist without a push or a per-card poller. 5s cadence, matching iOS.
    LaunchedEffect(app.currentUser.value) {
        while (true) {
            approvalWatcher.pollOnce()
            kotlinx.coroutines.delay(5_000)
        }
    }

    // Refresh cloud-recovery enrolment state AND E7 account-reset
    // detection when the tab first appears AND whenever a pod
    // transitions to online. Mirrors iOS HomeTab.refreshRecoveryStatus.
    // Silent on failure — we'd rather under-nudge / under-warn than
    // flash a banner on a transient network blip.
    val hasOnlinePod = pods.any { it.status == com.flagshipserver.app.core.PodInfo.Status.ONLINE }
    LaunchedEffect(hasOnlinePod, app.currentUser.value) {
        val u = app.currentUser.value
        if (!u.isNullOrEmpty()) {
            runCatching { server.hasCloudRecovery(u) }
                .onSuccess { app.setHasCloudRecovery(it) }
            // E7 — check whether our local push tokenId is still in
            // the trusted-devices list. Absent = another device
            // ran Disconnect/Replace/Wipe and we're orphaned.
            runCatching { server.listDevices(u).devices }
                .onSuccess { devices ->
                    val localToken = com.flagshipserver.app.keystore.Keystore.pushTokenId()
                    if (!localToken.isNullOrEmpty()) {
                        val present = devices.any { it.tokenId == localToken }
                        if (!present) {
                            app.setAccountWasReset(true)
                        } else if (app.accountWasReset.value) {
                            // Recovered — clear the flag so the
                            // banner disappears.
                            app.setAccountWasReset(false)
                        }
                    }
                }
        }
    }

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
            // shouldShowRecoveryNudgeNow is a pure getter off
            // AppState; the StateFlows it reads are subscribed to via
            // collectAsState here so a transition (e.g. an enrolment
            // completing on another tab) re-renders Home.
            val hasRecovery by app.hasCloudRecovery.collectAsState()
            val dismissed by app.recoveryNudgeDismissedThisSession.collectAsState()
            val reset by app.accountWasReset.collectAsState()
            val capability by app.deviceCapability.collectAsState()
            val bannerDismissed by recoveryBannerStore.dismissed.collectAsState()
            val showNudge = !hasRecovery && !dismissed && pods.any { it.status == com.flagshipserver.app.core.PodInfo.Status.ONLINE }
            val showBackupBanner = RecoveryBannerStore.shouldShow(
                hasCloudRecovery = hasRecovery,
                dismissed = bannerDismissed,
            )
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
                onDeleteServer = { pod ->
                    // Decommission a pending or registered-but-dead server via
                    // the shared release flow (frees the name). The IRK
                    // biometric fires when signing; the confirm dialog lives in
                    // the PodCard. On success removePod updates the list; on
                    // failure the pod is kept so the name never strands.
                    scope.launch { decommissionServer(pod, app, server, toasts) }
                },
                onRefresh = { scope.launch { vm.load(); reconciler.reconcile(); approvalWatcher.pollOnce() } },
                showRecoveryNudge = showNudge,
                onSetUpRecovery = { deepLinker.enqueue(DeepLink.RecoverySetup) },
                onDismissRecoveryNudge = { app.dismissRecoveryNudgeForSession() },
                showRecoveryBackupBanner = showBackupBanner,
                onDismissRecoveryBackupBanner = { recoveryBannerStore.setDismissed(true) },
                accountWasReset = reset,
                onSignInAgain = { app.signOut() },
                deviceCapability = capability,
                awaitingApproval = awaitingApproval,
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
                // A demo server still installing gets the install-progress
                // detail (bar + step list + device info + "Cancel this
                // device"); a QR-relay order gets the pending placeholder.
                if (pod.demoServer != null) {
                    DemoInstallProgressScreen(
                        podId = podId,
                        onAfterCancel = { nav.popBackStack() },
                    )
                } else {
                    PendingServerScreen(
                        pod = pod,
                        // Needed only for the serial-less directory fallback
                        // (a pod surfaced from `/pods` on a non-creating
                        // device polls pending[].phase by username + fqdn).
                        username = app.currentUser.collectAsState().value,
                        onCancel = {
                            app.removePod(pod.podId)
                            nav.popBackStack()
                        },
                    )
                }
            } else {
                // The Box Request Inbox's entitlement lane (account-level set,
                // refreshed by the watcher) — collected so the serve-auth card
                // arms/clears on its own.
                val awaitingEnt by app.serversAwaitingEntitlement.collectAsState()
                ServerDetailScreen(
                    podId = podId,
                    // The directory's cheap `awaitingUnlock` flag (no biometric)
                    // arms the inline Approve-unlock card so a rebooted box
                    // waiting to release its disk key is actionable from its own
                    // page even when its BFF can't load (a locked box can't
                    // answer its daemon).
                    awaitingUnlock = pod.awaitingUnlock,
                    awaitingEntitlement = awaitingEnt.contains(pod.fqdn.lowercase()),
                    serverFqdn = pod.fqdn,
                    onBack = { nav.popBackStack() },
                )
            }
        }
        composable("add-server-chooser") {
            AddServerChooserScreen(
                mode = AddServerMode.IN_APP,
                onProvision = { nav.navigate("create-server") },
                // Pairing an existing box is done by opening it from Home, not
                // from this chooser — surface the same guidance toast iOS shows
                // (HomeTab.swift) instead of a silent no-op.
                onPair = {
                    toasts.info(
                        "Servers you already own show up on Home — open one to pair this device. Choose “Provision a new box” to set up brand-new hardware.",
                    )
                },
                onCancel = { nav.popBackStack() },
            )
        }
        composable("create-server") {
            CreateServerScreen(
                onDelivered = { serverDomain, serial, name, description ->
                    // QR-relay delivered. Surface the pod on Home RIGHT NOW
                    // (pending, keyed on the fqdn, carrying this device's
                    // serial) — waiting for the progress screen to finish
                    // left a just-created server invisible until a
                    // pull-down reconcile, which also stranded it
                    // serial-less. The upsert also re-attaches the serial
                    // to a serial-less twin the reconciler may have
                    // surfaced first.
                    app.upsertPendingPod(
                        name = name,
                        description = description,
                        fqdn = serverDomain,
                        serial = serial,
                    )
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
                onFinish = { resolvedFqdn, live ->
                    // The pod is already on Home (upserted at delivery).
                    // Leaving the screen just re-upserts idempotently —
                    // registration is authoritative for online, so only a
                    // canonical `live` flips it; "Run in background" keeps
                    // it pending (no more fake-ONLINE random-id pod) and
                    // the reconciler flips it when the box registers.
                    val final = (resolvedFqdn ?: fqdn).ifEmpty {
                        com.flagshipserver.app.core.SlugUtil.slugify(name) +
                            ".${com.flagshipserver.app.core.Endpoints.dataApex}"
                    }
                    if (live) {
                        app.upsertRegisteredPod(fqdn = final, name = name)
                    } else {
                        app.upsertPendingPod(name = name, fqdn = final, serial = serial)
                    }
                    nav.popBackStack(route = "home-root", inclusive = false)
                },
            )
        }
    }
}
