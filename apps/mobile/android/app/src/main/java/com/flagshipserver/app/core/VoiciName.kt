// Custom voi.ci names for services (docs/named-links.md). Kotlin mirror of
// packages/protocol/src/voiciName.ts, pinned by the shared vectors in
// packages/protocol/test-vectors/voici-name (VoiciNameVectorsTest).
//
// A service always has its random code; an admin may also give it ONE custom
// name. The order that sets or clears it is signed with the sensitive-order key
// (admin root when pinned, else the IRK); `.com` stays the authority on what is
// taken, reserved or held for a .com owner.

package com.flagshipserver.app.core

import com.flagshipserver.app.R

object VoiciName {
    const val CANONICAL_TAG = "flagship/voici-name/v1"
    const val OP_SET = "set"
    const val OP_CLEAR = "clear"

    /** Shortest and longest a username or link name may be, hyphens included (docs/voici-namespace-spec.md D12). */
    const val MIN = 3
    const val MAX = 63

    /** Wire names: too-short, too-long, characters, hyphens. */
    enum class Problem(val wire: String) { TooShort("too-short"), TooLong("too-long"), Characters("characters"), Hyphens("hyphens");
        companion object { fun of(wire: String?): Problem? = entries.firstOrNull { it.wire == wire } }
    }

    private val CHARS = Regex("^[a-z0-9-]*$")

    /**
     * What a client can check alone, for a username or a custom link name (one format, D12). Upper case is folded,
     * not refused. Checked in this order: characters, then hyphens, then length (hyphens counted).
     */
    fun problem(typed: String): Problem? {
        val name = typed.lowercase()
        if (!CHARS.matches(name)) return Problem.Characters
        if (name.startsWith("-") || name.endsWith("-") || "--" in name) return Problem.Hyphens
        if (name.length < MIN) return Problem.TooShort
        if (name.length > MAX) return Problem.TooLong
        return null
    }

    /** The format message for a username or link name, the same words on every platform. */
    fun problemText(p: Problem): String = when (p) {
        Problem.Characters -> FSStrings.get(R.string.letters_numbers_and_hyphens_only)
        Problem.Hyphens -> FSStrings.get(R.string.no_hyphen_at_the_start_or_end_or_two_in_a_row)
        Problem.TooShort -> FSStrings.get(R.string.at_least_3_characters)
        Problem.TooLong -> FSStrings.get(R.string.at_most_63_characters)
    }

    /** `.com`'s one answer for a name that is taken, held, reserved or a look-alike of one (D9): nothing more is said. */
    fun takenText(): String = FSStrings.get(R.string.taken_or_too_similar_to_an_existing_name)

    /** The safety key every claim is unique on (D9): lower case, hyphens removed, 0 read as o, 1 as l. */
    fun key(typed: String): String = typed.lowercase().replace("-", "").replace('0', 'o').replace('1', 'l')

    private fun field(label: String, v: String) {
        require(v.none { it == '|' || it.code < 0x20 || it.code == 0x7f }) { "bad $label" }
    }

    /** `name` is "" for a clear. Throws IllegalArgumentException on anything the TS reference refuses. */
    fun canonicalBytes(user: String, serviceId: String, name: String, op: String, issuedAt: Long, nonce: String): ByteArray {
        field("user", user)
        field("serviceId", serviceId)
        field("name", name)
        field("nonce", nonce)
        return listOf(CANONICAL_TAG, user, serviceId, name, op, issuedAt.toString(), nonce)
            .joinToString("|")
            .toByteArray(Charsets.UTF_8)
    }
}
