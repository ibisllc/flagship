package com.flagshipserver.app.core

import com.flagshipserver.app.R
import java.util.Locale

/**
 * Byte sizes in the reader's language: the number with the locale's decimal mark ("3,4") and the unit from the
 * string table ("Go" / "Mo" / "Ko" in French), never a fixed "3.4 GB" (store review: French screens showed "GB").
 */
object ByteSize {
    private const val KIB = 1024.0
    private const val MIB = KIB * 1024
    private const val GIB = MIB * 1024

    private fun number(v: Double, decimals: Int): String = "%.${decimals}f".format(FSStrings.locale(), v)

    fun gb(n: Long, decimals: Int): String = FSStrings.get(R.string.gb, number(n / GIB, decimals))
    fun mb(n: Long, decimals: Int): String = FSStrings.get(R.string.mb, number(n / MIB, decimals))
    fun kb(n: Long, decimals: Int): String = FSStrings.get(R.string.kb, number(n / KIB, decimals))

    /** One decimal under 10 GB, none above (the box's own `formatGb`). */
    fun gbAuto(n: Long): String = gb(n, if (n < 10 * GIB) 1 else 0)

    /** KB, MB or GB with one decimal for GB (the server page's meters). */
    fun meter(n: Long): String = when {
        n >= GIB -> gb(n, 1)
        n >= MIB -> mb(n, 0)
        n >= KIB -> kb(n, 0)
        else -> "$n B"
    }
}
