// Test-account / demo-mode fixtures.
//
// Two coexisting modes drive demo accounts (mirror of iOS
// DemoFixtures.swift):
//
//   1. Legacy fixtures-only (`testAccount`-only). The Worker
//      returns a `testAccount` block but no `demoServer` block.
//      `activate(_:username:)` materialises three obviously-fake
//      sample pods so a reviewer can explore the surface without
//      provisioning real hardware. This is the v1.0 behaviour and
//      stays available so already-shipped binaries continue to work.
//
//   2. On-connect Hetzner (Plan A, Phase D). The Worker
//      additionally returns a `demoServer` block describing one real
//      VPS — its FQDN and lifecycle state (`none` / `provisioning` /
//      `up`). `activate(_:username:demoServer:)` materialises ONE
//      pod backed by that FQDN; tapping connect calls the
//      `/api/dev/sample-user/{u}/connect` endpoint and polls until
//      the lifecycle flips to `up`. See docs/sample-users.md §3.
//
// The list of test-account usernames LIVES OFF THE OPEN SOURCE —
// it's stored as env.TEST_ACCOUNTS (legacy) plus a `demo_users` D1
// row (live) on the Worker. Mobile clients learn that the typed
// string is a demo only by asking the Worker; we never bake
// usernames into the app itself.
//
// Demo mode (legacy) never:
//   - talks to flagshipserver.com (no auth-code mint, no DNS publish)
//   - talks to a real pod (no /api/screens/* against a live daemon)
//   - registers an FCM push token
//   - touches the AndroidKeyStore (no UMK seed materialized)
//
// Demo mode (Plan A) DOES talk to a real pod, but only after the
// user explicitly taps "Connect" on the single rendered device.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.DemoServerBlock
import com.flagshipserver.app.api.DeviceCapabilityBlock
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
        ),
    )

    /** Plan A — build ONE pod from a server-supplied [block]. Used by
     *  the live demo flow: `/api/users/check` returned a `demoServer`
     *  block and we render that single device instead of the three
     *  legacy fixtures.
     *
     *  Status mapping:
     *    - `none`         → PENDING (user hasn't tapped connect yet)
     *    - `provisioning` → PENDING
     *    - `up`           → ONLINE
     */
    fun samplePodFromDemoServer(block: DemoServerBlock, username: String): PodInfo {
        val label = labelFromFqdn(block.fqdn) ?: "Home"
        return PodInfo(
            podId = "demo-server-$username",
            name = label.replaceFirstChar { it.uppercaseChar() },
            description = "Live demo on Hetzner",
            fqdn = block.fqdn,
            status = mapStatus(block.lifecycle),
        )
    }

    /** Map the demoServer lifecycle enum to the Android pod-status
     *  enum. Both NONE and Provisioning surface as PENDING so the
     *  home-screen renders the same "waiting" affordance. */
    fun mapStatus(lifecycle: DemoServerBlock.Lifecycle): PodInfo.Status = when (lifecycle) {
        DemoServerBlock.Lifecycle.Up -> PodInfo.Status.ONLINE
        DemoServerBlock.Lifecycle.None,
        DemoServerBlock.Lifecycle.Provisioning -> PodInfo.Status.PENDING
    }

    /** Apply demo state for [username] to [appState]. Called from the
     *  username screen after the Worker confirms the typed name is a
     *  test account.
     *
     *  When [demoServer] is non-null (Plan A), materialise ONE pod
     *  with the server-supplied FQDN + lifecycle. When null (legacy),
     *  fall back to the three-fixture path so already-shipped
     *  binaries (and reviewers who don't want a live pod) keep
     *  working.
     *
     *  When [deviceCapability] is non-null (v2 device-addressing),
     *  the session inherits its scope set — the chip + the "this
     *  device cannot install services" tooltip render. Legacy
     *  callers omit it and get the implicit full scope set. */
    fun activate(
        appState: AppState,
        username: String,
        demoServer: DemoServerBlock? = null,
        deviceCapability: DeviceCapabilityBlock? = null,
    ) {
        val pods = if (demoServer != null) {
            listOf(samplePodFromDemoServer(demoServer, username))
        } else {
            samplePods(username)
        }
        appState.completeOnboarding(username = username, pods = pods)
        // Install AFTER completeOnboarding so the capability survives;
        // completeOnboarding intentionally does NOT touch this field.
        appState.setDeviceCapability(deviceCapability)
    }

    private fun labelFromFqdn(fqdn: String): String? = fqdn.split(".").firstOrNull()
}
