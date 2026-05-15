// Test-account / demo-mode fixtures.
//
// A typed username that the Worker confirms as a test account (via
// /api/users/check returning a non-null testAccount field) short-
// circuits the real claim + biometric + create-server flow and pre-
// populates AppState with believable sample pods so an app reviewer
// (or curious user) can explore the full surface without provisioning
// real hardware.
//
// The list of test-account usernames LIVES OFF THE OPEN SOURCE —
// it's stored as env.TEST_ACCOUNTS on the Worker. Mobile clients
// learn that the typed string is a test account only by asking the
// Worker; we never bake usernames into the app itself.
//
// Demo mode never:
//   - talks to flagshipserver.com (no auth-code mint, no DNS publish)
//   - talks to a real pod (no /api/screens/* against a live daemon)
//   - registers an FCM push token
//   - touches the AndroidKeyStore (no UMK seed materialized)
//
// Everything renders against MockScreensClient + the in-memory
// AppState. Sign-out clears the demo flag the same way it clears
// everything else.

package com.flagshipserver.app.core

import java.util.UUID

object DemoFixtures {
    /// Pods the demo user starts with. The names + descriptions are
    /// obviously sample data so a reviewer can't confuse them for real
    /// pods, but realistic enough that Home / Apps / Activity / Settings
    /// all render meaningfully.
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
        ),
    )

    /** Apply demo state for [username] to [appState]. Called from the
     *  username screen after the Worker confirms the typed name is a
     *  test account. The username itself comes from the user; the
     *  mobile app never assumes a specific one. */
    fun activate(appState: AppState, username: String) {
        appState.completeOnboarding(
            username = username,
            pods = samplePods(username),
        )
    }
}
