package com.flagshipserver.app.core

/**
 * Which server the Home list shows when the install-progress screen is left.
 *
 * The screen used to guess `slugify(name).<apex>` when the route carried no
 * name or domain, which made a ghost "server.<apex>" row that held another
 * server's order number and could not be cancelled. A domain is only ever one
 * the order really named, so the choice is made here, and a domain without a
 * `<server>.<user>` part in front of the apex is never shown.
 */
object InstallFinishTarget {

    /** `<server>.<user>.<apex>`: at least two labels in front of the data apex. */
    fun isWellFormed(fqdn: String, apex: String = Endpoints.dataApex): Boolean {
        val lower = fqdn.lowercase()
        val suffix = ".${apex.lowercase()}"
        if (!lower.endsWith(suffix)) return false
        val front = lower.removeSuffix(suffix).split('.')
        return front.size >= 2 && front.all { it.isNotEmpty() }
    }

    /** The domain to list, or null when none can be named safely. */
    fun fqdn(
        resolved: String?,
        fromRoute: String,
        serial: String,
        pods: List<PodInfo>,
        apex: String = Endpoints.dataApex,
    ): String? {
        val byOrder = pods.firstOrNull { it.pendingAuthCodeSerial == serial }?.fqdn
        return listOf(resolved.orEmpty(), fromRoute, byOrder.orEmpty())
            .firstOrNull { it.isNotBlank() && isWellFormed(it, apex) }
    }
}
