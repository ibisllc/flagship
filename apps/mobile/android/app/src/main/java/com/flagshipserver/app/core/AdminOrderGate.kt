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

import com.flagshipserver.app.R

object AdminOrderGate {
    fun allows(holdsAdminRoot: Boolean, isDemoAccount: Boolean): Boolean =
        AddServerGate.allows(holdsAdminRoot, isDemoAccount)

    fun allows(app: AppState): Boolean = AddServerGate.allows(app)

    val UNINSTALL get() = FSStrings.get(R.string.only_an_admin_device_can_remove)
    val RUNS_ON get() = FSStrings.get(R.string.only_an_admin_device_can_change)
    val ACCESS_LIST get() = FSStrings.get(R.string.only_an_admin_device_can_change_2)
    val API_KEYS get() = FSStrings.get(R.string.only_an_admin_device_can_create)
    val DATABASE_WRITE get() = FSStrings.get(R.string.only_an_admin_device_can_change_3)
    /** The server page's orders (the webapp's SERVER_ADMIN_ONLY). */
    val SERVER get() = FSStrings.get(R.string.only_an_admin_device_can_change_4)
    /** `.com` checks the server order under the admin root (serverOrder.ts). */
    val SERVER_ORDER get() = FSStrings.get(R.string.only_an_admin_device_can_change_5)
    val SHARE get() = FSStrings.get(R.string.only_an_admin_device_can_share)
}
