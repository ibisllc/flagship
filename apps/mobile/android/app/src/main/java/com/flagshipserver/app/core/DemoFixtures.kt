// Demo-mode fixtures.
//
// Typing the magic username `demo` on the ChooseUsername screen
// short-circuits the real claim + biometric + create-server flow,
// pre-populating AppState with believable pods so a Play Store
// reviewer (or a curious user) can explore the full app surface
// without provisioning real hardware.
//
// Critically, demo mode never:
//   - Talks to flagshipserver.com (no auth-code mint, no DNS publish)
//   - Talks to a real pod (no /api/screens/* against a live daemon)
//   - Registers an FCM push token
//   - Touches the AndroidKeyStore (no UMK seed materialized)
//
// Everything renders against MockScreensClient + the in-memory
// AppState. Sign-out clears the demo flag the same way it clears
// everything else.

package com.flagshipserver.app.core

import java.util.UUID

object DemoFixtures {
    /// The single username Play Console + onboarding recognize as a
    /// demo trigger. Reserved on the .com side too so nobody can ever
    /// register it as a real account.
    const val DEMO_USERNAME = "demo"

    /** Returns true when the typed username matches the demo trigger. */
    fun isDemoUsername(s: String): Boolean = s.trim().lowercase() == DEMO_USERNAME

    /// Pods the demo user starts with. The names + descriptions are
    /// chosen to be obviously sample data ("Home, Office, Music
    /// projects") so a reviewer can't confuse them for real pods, but
    /// realistic enough that the Home / Apps / Activity tabs all
    /// render meaningfully.
    fun samplePods(): List<PodInfo> = listOf(
        PodInfo(
            podId = "demo-home-${UUID.randomUUID().toString().take(6)}",
            name = "Home",
            description = "Living-room mini-PC. Everyday workloads.",
            fqdn = "home.demo.flagship.services",
            status = PodInfo.Status.ONLINE,
        ),
        PodInfo(
            podId = "demo-office-${UUID.randomUUID().toString().take(6)}",
            name = "Office",
            description = "Office tower. Failover for work projects.",
            fqdn = "office.demo.flagship.services",
            status = PodInfo.Status.ONLINE,
        ),
        PodInfo(
            podId = "demo-music-${UUID.randomUUID().toString().take(6)}",
            name = "Music",
            description = "Garage rack. Music production projects.",
            fqdn = "music.demo.flagship.services",
            status = PodInfo.Status.OFFLINE,
        ),
    )

    /** Apply demo state to AppState. Called from the username screen
     *  after the user types `demo` + taps Continue. */
    fun activate(appState: AppState) {
        appState.completeOnboarding(
            username = DEMO_USERNAME,
            pods = samplePods(),
        )
    }
}
