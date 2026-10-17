// A demo (test) account (docs/sample-users.md §3). The Worker says a typed
// name is a demo by returning a `demoServer` block describing one real VPS
// (its FQDN and lifecycle `none` / `provisioning` / `up`). The app shows that
// one server and talks to it like any other once it is up; nothing here is
// fixture data. The list of demo usernames lives on the Worker (env +
// `demo_users`), never in the app.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.DemoServerBlock
import com.flagshipserver.app.api.DeviceCapabilityBlock

object DemoAccount {
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
            description = "Live demo server",
            fqdn = block.fqdn,
            status = mapStatus(block.lifecycle),
            demoServer = block,
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
     *  When [demoServer] is non-null, materialise ONE pod with the
     *  server-supplied FQDN + lifecycle. Without one the account starts
     *  with no servers, like any new account.
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
        val pods = if (demoServer != null) listOf(samplePodFromDemoServer(demoServer, username)) else emptyList()
        appState.completeOnboarding(username = username, pods = pods, demoServer = demoServer)
        // Install AFTER completeOnboarding so the capability survives;
        // completeOnboarding intentionally does NOT touch this field.
        appState.setDeviceCapability(deviceCapability)
    }

    private fun labelFromFqdn(fqdn: String): String? = fqdn.split(".").firstOrNull()
}
