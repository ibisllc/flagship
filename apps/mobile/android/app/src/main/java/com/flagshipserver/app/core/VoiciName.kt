// Custom voi.ci names for services (docs/named-links.md). Kotlin mirror of
// packages/protocol/src/voiciName.ts, pinned by the shared vectors in
// packages/protocol/test-vectors/voici-name (VoiciNameVectorsTest).
//
// A service always has its random code; an admin may also give it ONE custom
// name. The order that sets or clears it is signed with the sensitive-order key
// (admin root when pinned, else the IRK); `.com` stays the authority on what is
// taken, reserved or held for a .com owner.

package com.flagshipserver.app.core

object VoiciName {
    const val CANONICAL_TAG = "flagship/voici-name/v1"
    const val OP_SET = "set"
    const val OP_CLEAR = "clear"

    /** Shortest and longest a name may be, as typed (hyphens included). */
    const val MIN = 4
    const val MAX = 40

    enum class Problem { TooShort, TooLong, Characters }

    private val GRAMMAR = Regex("^[a-z0-9]+(-[a-z0-9]+)*$")

    /**
     * What a client can check alone. Upper case is folded, not refused. The length
     * that counts for "too short" is the one without hyphens (`a-b-c-d` is `abcd`).
     */
    fun problem(typed: String): Problem? {
        val name = typed.lowercase()
        if (!GRAMMAR.matches(name)) return Problem.Characters
        if (name.length > MAX) return Problem.TooLong
        if (name.replace("-", "").length < MIN) return Problem.TooShort
        return null
    }

    /** The key two names are compared by: lower case, hyphens removed. */
    fun key(typed: String): String = typed.lowercase().replace("-", "")

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
