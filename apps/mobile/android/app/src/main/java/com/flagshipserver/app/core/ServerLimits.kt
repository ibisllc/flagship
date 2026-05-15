package com.flagshipserver.app.core

/**
 * Repo-wide limits for user-authored server metadata.
 *
 * The one-line server description is phone-held display text — it never
 * reaches flagshipserver.com (that's the privacy model). It renders in
 * tight rows (pod picker, Home cards), so an over-long string wraps and
 * breaks the layout. Capping it short keeps every surface single-line.
 *
 * Mirror constant on iOS: `ServerLimits.maxDescription`.
 */
object ServerLimits {
    const val MAX_DESCRIPTION = 30
}

/** Trim to [ServerLimits.MAX_DESCRIPTION]. No-op once within bounds. */
fun String.clampedServerDescription(): String =
    if (length <= ServerLimits.MAX_DESCRIPTION) this
    else substring(0, ServerLimits.MAX_DESCRIPTION)
