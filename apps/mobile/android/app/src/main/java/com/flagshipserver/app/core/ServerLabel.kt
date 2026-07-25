package com.flagshipserver.app.core

/**
 * Validates a server (pod) subdomain — the leftmost `<server>` label of
 * `<server>.<user>.flagship.services`. Mirror of the authoritative server-side
 * check `packages/control-plane/src/labels.ts` (`validateServerLabel`) and the
 * iOS `ServerLabel`: a standard RFC-1123 DNS label (1–63 lowercase
 * letters/digits, interior hyphens, no leading/trailing hyphen) minus a small
 * reserved set.
 *
 * The create flow validates + REJECTS non-conforming input rather than silently
 * slugifying it — what the user types IS the subdomain, so there is no hidden
 * transform and no false expectation that a free-text name is preserved.
 */
object ServerLabel {
    /** `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` — identical to labels.ts LABEL_RE. */
    private val PATTERN = Regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")

    /** FULL reserved set from labels.ts (the webapp's inline copy omits the
     *  last three gossip-fan-out words). */
    val reserved: Set<String> = setOf(
        "www", "api", "admin", "flagship", "flagshipserver", "services",
        "ns1", "ns2", "mail", "tunnel", "control", "status",
        "broadcast", "servers", "all",
    )

    /** True iff `input` is a syntactically valid, non-reserved subdomain. */
    fun isValid(input: String): Boolean {
        val norm = input.trim().lowercase()
        return PATTERN.matches(norm) && !reserved.contains(norm)
    }

    /** The validation message for a NON-empty invalid input, else null (an empty
     *  field shows no error, and a valid one clears it). */
    fun errorMessage(input: String): String? {
        val norm = input.trim().lowercase()
        if (norm.isEmpty()) return null
        if (!PATTERN.matches(norm)) {
            return "lowercase letters, digits, and hyphens (not at the start or end)"
        }
        if (reserved.contains(norm)) return "\"$norm\" is reserved — pick another"
        return null
    }

    /** The normalized (lowercased) label; the caller validates before minting. */
    fun normalized(input: String): String = input.trim().lowercase()
}
