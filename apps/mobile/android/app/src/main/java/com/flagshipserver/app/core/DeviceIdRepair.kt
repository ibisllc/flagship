package com.flagshipserver.app.core

/**
 * Finds the device ID `.com` registered for this phone when the app lost it. Builds before the
 * ID was saved invented a new one on every cold start, so every device-signed request named a
 * device `.com` never saw (403). The registered ID is one the phone made keys for: try each with
 * a signed directory read until one is accepted.
 */
object DeviceIdRepair {
    /** Outcome of one signed read under a candidate ID. */
    enum class Verdict { ACCEPTED, REFUSED, UNREACHABLE }

    /** Candidates, most likely first: the current ID, IDs whose PQ key `.com` bound, then the rest. */
    fun candidates(current: String?, boundPq: List<String>, otherPq: List<String>, kept: List<String>): List<String> =
        (listOfNotNull(current) + boundPq + otherPq + kept)
            .map { it.lowercase() }
            .filter { AccountMetadata.deviceIdPattern.matches(it) }
            .distinct()

    /** The first accepted ID; null when none is, or when `.com` can't be reached (try again later). */
    suspend fun find(candidates: List<String>, read: suspend (String) -> Verdict): String? {
        for (id in candidates) {
            when (read(id)) {
                Verdict.ACCEPTED -> return id
                Verdict.REFUSED -> continue
                Verdict.UNREACHABLE -> return null
            }
        }
        return null
    }
}
