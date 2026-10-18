// GYM / debug-only demo fixtures: obviously-fake sample servers the no-backend
// UI gym seeds (SmokeMode). Never in a release build (src/debug). The live demo
// account path is DemoAccount (src/main).

package com.flagshipserver.app.core

import java.util.UUID

object DemoFixtures {
    /// Pods the legacy demo user starts with. Three obviously-fake
    /// sample pods so a reviewer can explore Home / Apps / Activity /
    /// Settings.
    fun samplePods(username: String): List<PodInfo> = listOf(
        PodInfo(
            podId = "demo-home-${UUID.randomUUID().toString().take(6)}",
            name = "Home",
            description = "Living-room mini-PC",
            fqdn = "home.$username.flagship.services",
            status = PodInfo.Status.ONLINE,
        ),
        PodInfo(
            podId = "demo-office-${UUID.randomUUID().toString().take(6)}",
            name = "Office",
            description = "Office tower, work failover",
            fqdn = "office.$username.flagship.services",
            status = PodInfo.Status.ONLINE,
        ),
        PodInfo(
            podId = "demo-music-${UUID.randomUUID().toString().take(6)}",
            name = "Music",
            description = "Garage rack, music studio",
            fqdn = "music.$username.flagship.services",
            status = PodInfo.Status.OFFLINE,
            // Was live, stopped reporting a few hours ago: the honest
            // "offline, last seen" state, not "never came online".
            liveness = PodInfo.Liveness.UNREACHABLE,
            lastSeenMsAgo = 3L * 60 * 60 * 1000,
        ),
    )

    /** GYM (§10 Phase-5) — sample pods with the "Cabin" box awaiting a
     *  boot-unlock approval. Mirror of iOS DemoFixtures.samplePodsWithAwaitingUnlock:
     *  the legacy three plus a fourth box that registered + came online before
     *  but is now offline AND has a live unlock request, so its row classifies
     *  WAITING_FOR_APPROVAL and renders the `pod-card-waiting-approval` pill.
     *  Drives the D5 server-event seed scenario with NO backend. */
    fun samplePodsWithAwaitingUnlock(username: String): List<PodInfo> =
        samplePods(username) + PodInfo(
            podId = "demo-cabin-${UUID.randomUUID().toString().take(6)}",
            name = "Cabin",
            description = "Cabin mini-PC, just rebooted",
            fqdn = "cabin.$username.flagship.services",
            status = PodInfo.Status.OFFLINE,
            cameOnline = true,
            registeredAt = System.currentTimeMillis() - 60L * 60L * 1000L,
            awaitingUnlock = true,
        )

    /** GYM (§10 Phase-5) — sample pods with a "Cabin" box that registered but
     *  NEVER came online (no check-in, past the coming-online grace), so its row
     *  classifies DEAD and renders the `pod-card-never-online` pill. Mirror of
     *  iOS DemoFixtures.samplePodsWithDeadServer. Drives the D5 dead-server seed
     *  scenario with NO backend. */
    fun samplePodsWithDeadServer(username: String): List<PodInfo> =
        samplePods(username) + PodInfo(
            podId = "demo-cabin-${UUID.randomUUID().toString().take(6)}",
            name = "Cabin",
            description = "Cabin mini-PC, install stalled",
            fqdn = "cabin.$username.flagship.services",
            status = PodInfo.Status.OFFLINE,
            cameOnline = false,
            registeredAt = System.currentTimeMillis() - 24L * 60L * 60L * 1000L,
            awaitingUnlock = false,
        )

    /** The serial of the pending order [samplePodsWithPendingGhost] makes. */
    const val GHOST_ORDER_SERIAL = "GYMSERIAL0002"

    /** GYM, device report 2026-10-18 (A-2): a real pending order "Home2" and the
     *  ghost row an old install-progress exit made beside it ("server.<apex>",
     *  holding Home2's order number). Home must show only the real one. */
    fun samplePodsWithPendingGhost(username: String): List<PodInfo> =
        samplePods(username) + listOf(
            PodInfo(
                podId = PodInfo.podId("home2.$username.flagship.services"),
                name = "Home2",
                fqdn = "home2.$username.flagship.services",
                status = PodInfo.Status.PENDING,
                pendingAuthCodeSerial = GHOST_ORDER_SERIAL,
            ),
            PodInfo(
                podId = PodInfo.podId("server.flagship.services"),
                name = "",
                fqdn = "server.flagship.services",
                status = PodInfo.Status.PENDING,
                pendingAuthCodeSerial = GHOST_ORDER_SERIAL,
            ),
        )
}
