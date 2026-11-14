// A new server asks twice on its first boot: "Unlock device", then about 80 s later "Authorize device to join your
// cloud" (the creating device checks the box's first-contact code on that second request). The second arrived with
// nothing on screen, so the owner had to find it in Activity → Server approvals (Windows acceptance, 2026-11-06).
// After a first-boot unlock is approved the server is watched for a while; when its entitlement request shows up in the
// Box Request Inbox the app brings the approvals back. Mirror of iOS SecondStepWatch and the webapp's secondStepWatch.

package com.flagshipserver.app.core

class SecondStepWatch(private val windowMs: Long = WINDOW_MS) {
    private val armed = mutableMapOf<String, Long>()

    /** The owner just approved [server]'s first-boot unlock: its next request is the second step. */
    @Synchronized
    fun arm(server: String, now: Long = System.currentTimeMillis()) {
        armed[server.lowercase()] = now + windowMs
    }

    /** The watched servers whose entitlement request is now waiting ([awaitingEntitlement], lowercased fqdns).
     *  Each is reported once; a watch past its window is dropped. */
    @Synchronized
    fun arrived(awaitingEntitlement: Set<String>, now: Long = System.currentTimeMillis()): List<String> {
        armed.entries.removeAll { it.value < now }
        val hits = armed.keys.filter { it in awaitingEntitlement }.sorted()
        hits.forEach { armed.remove(it) }
        return hits
    }

    companion object {
        const val WINDOW_MS = 10 * 60_000L
        val shared = SecondStepWatch()

        /** The Home row of a server that has never come online (a fresh order) and is waiting for an approval opens
         *  the approvals, not the install screen. A running server keeps its page (its own Approve card). */
        fun opensApprovals(fqdn: String, neverOnline: Boolean, inbox: Map<String, List<BoxRequest>>): Boolean =
            neverOnline && inbox[fqdn.lowercase()]?.isNotEmpty() == true
    }
}
