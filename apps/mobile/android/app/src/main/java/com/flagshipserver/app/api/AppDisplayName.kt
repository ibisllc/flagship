package com.flagshipserver.app.api

/**
 * The name an app is shown under. The box sends a `name` only on some rows (a copy still underway);
 * otherwise the name comes from the slug, a DNS label, so "chess-club" reads "Chess Club" rather than
 * "Chess-club". Mirrors iOS `AppDisplayName`.
 */
object AppDisplayName {
    fun fromSlug(slug: String): String {
        val joined = slug.split('-', '_').filter { it.isNotEmpty() }
            .joinToString(" ") { w -> w.replaceFirstChar { it.uppercase() } }
        return joined.ifEmpty { slug }
    }

    /** `<account>--<slug>` → the slug's name; an id without `--` is taken as the slug. */
    fun fromServiceId(serviceId: String): String = fromSlug(serviceId.substringAfterLast("--"))

    /**
     * The name an access request or draft is shown under. The box's `appName` is often just the slug
     * (older boxes send nothing better), so an empty one, or one equal to the slug of [serviceId],
     * reads as the slug in words; anything else is the box's real display name and is kept.
     */
    fun forAccessRequest(serviceId: String, appName: String?): String {
        val name = appName?.trim().orEmpty()
        return if (name.isEmpty() || name == serviceId.substringAfterLast("--")) fromServiceId(serviceId) else name
    }
}

/** The box's own `name` when it sends one, else the slug as words. */
val AppSummary.displayName: String
    get() = name?.trim()?.takeIf { it.isNotEmpty() } ?: AppDisplayName.fromSlug(slug)
