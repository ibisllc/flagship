// Inbound URL → DeepLink resolution, the entry point MainActivity calls on
// every launch intent. Kept as its own seam so it's reachable from unit
// tests without instantiating the activity.

package com.flagshipserver.app.core

import android.net.Uri

object AppLink {
    /**
     * Translate any inbound URI we recognize into a [DeepLink], or null if
     * it isn't ours. [DeepLink.parse] owns every form:
     *
     *   1. `https://flagshipserver.com/app/<route>[/<more>][?<params>]` — the
     *      in-app App Link (auto-verified via assetlinks.json), read as
     *      `flagship://<route>[/<more>][?<params>]`.
     *   2. The control-host App Links (`/join`, `/remote`, `/builder`,
     *      `/access`, `/invite-accept`, `/transfer`, `/share`) and a box's
     *      `/invite#<secret>`.
     *   3. Older builds' `flagship://<route>?<params>`.
     */
    fun resolve(uri: Uri): DeepLink? = DeepLink.parse(uri)
}
