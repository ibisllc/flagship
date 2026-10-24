package com.flagshipserver.app.core.pq

/** Lowercase, even-length hex only: the shape every PQ wire field uses. */
object PqHex {
    private val HEX = Regex("^(?:[0-9a-f]{2})*$")
    private const val DIGITS = "0123456789abcdef"

    fun isHex(s: String): Boolean = HEX.matches(s)

    fun decode(s: String): ByteArray? {
        if (!isHex(s)) return null
        val out = ByteArray(s.length / 2)
        for (i in out.indices) out[i] = ((Character.digit(s[2 * i], 16) shl 4) or Character.digit(s[2 * i + 1], 16)).toByte()
        return out
    }

    fun encode(b: ByteArray): String {
        val sb = StringBuilder(b.size * 2)
        for (x in b) {
            val v = x.toInt() and 0xff
            sb.append(DIGITS[v shr 4]).append(DIGITS[v and 0x0f])
        }
        return sb.toString()
    }
}
