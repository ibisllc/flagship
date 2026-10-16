// Orders only an admin device can sign (owner rule 2026-10-15;
// docs/service-access-gating.md "Account members"): uninstall, "Runs on"
// ticking and unticking, an app's access list, API keys, database writes,
// ranks and the access mode. An admin-pinned box checks each one under the
// admin root and refuses the IRK, so a device without the root is shown the
// control read-only with one of these lines instead of sending an order the
// box will refuse. A demo account's device stands in for its owner (its box
// pins no root). The same rule as adding a server ([AddServerGate]) and the
// webapp's lib/addServerGate.js.

package com.flagshipserver.app.core

object AdminOrderGate {
    fun allows(holdsAdminRoot: Boolean, isDemoAccount: Boolean): Boolean =
        AddServerGate.allows(holdsAdminRoot, isDemoAccount)

    fun allows(app: AppState): Boolean = AddServerGate.allows(app)

    const val UNINSTALL = "Only an admin device can remove an app."
    const val RUNS_ON = "Only an admin device can change where this app runs."
    const val ACCESS_LIST = "Only an admin device can change this app's internet access."
    const val API_KEYS = "Only an admin device can create or revoke API keys."
    const val DATABASE_WRITE = "Only an admin device can change this app's data."
    /** The server page's orders (the webapp's SERVER_ADMIN_ONLY). */
    const val SERVER = "Only an admin device can change this server. This device can see it."
}
