// "I hold a trademark to this name" — prefilled mailto builder.
//
// Byte-for-byte mirror of the canonical webapp helper
// (apps/web/public/webapp/lib/trademarkClaim.js) + the iOS
// FlagshipCore/TrademarkClaim.swift so the iOS, Android, and webapp
// "name taken" states all open the exact same message. A user who
// holds a registered trademark to an already-claimed name can email the
// flagship trademarks desk to start a claim.

package com.flagshipserver.app.core

import android.net.Uri

object TrademarkClaim {
    /** Where trademark claims go. */
    const val EMAIL = "trademarks@flagshipserver.com"

    /** Subject line for a trademark claim on [username]. */
    fun subject(username: String): String =
        "Trademark claim for the name \"$username\""

    /** Plain-text body template. Leaves bracketed placeholders for the
     *  user to fill in. Joined with `\n` to match the JS array template. */
    fun body(username: String): String =
        listOf(
            "Hello,",
            "",
            "I'm requesting the Flagship account name \"$username\" on the basis",
            "that I hold a registered trademark covering it.",
            "",
            "Trademark holder / company: [your name or company]",
            "Trademark registration number: [registration number]",
            "Jurisdiction / registry: [e.g. USPTO, EUIPO]",
            "Goods/services class(es): [class numbers]",
            "Link or attachment to the registration: [URL or note that it's attached]",
            "",
            "Requested name: $username",
            "",
            "Thank you.",
        ).joinToString("\n")

    /** Build the full `mailto:` string (subject + body URL-encoded the
     *  same way JS `encodeURIComponent` does, so the produced string is
     *  byte-identical to the webapp's `trademarkClaimMailto`). */
    fun mailto(username: String): String {
        val s = encodeURIComponent(subject(username))
        val b = encodeURIComponent(body(username))
        return "mailto:$EMAIL?subject=$s&body=$b"
    }

    /** Parsed Android Uri for the mailto — fed to an ACTION_VIEW /
     *  ACTION_SENDTO intent. */
    fun mailtoUri(username: String): Uri = Uri.parse(mailto(username))

    /** Faithful port of JavaScript's `encodeURIComponent`: percent-encode
     *  every character EXCEPT the unreserved set `A-Za-z0-9` and
     *  `- _ . ! ~ * ' ( )`. Hand-rolled over the UTF-8 bytes so the output
     *  matches the webapp + iOS byte-for-byte. */
    fun encodeURIComponent(value: String): String {
        val unreserved =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
        val sb = StringBuilder()
        for (byte in value.toByteArray(Charsets.UTF_8)) {
            val ch = (byte.toInt() and 0xFF).toChar()
            if (ch in unreserved) {
                sb.append(ch)
            } else {
                sb.append('%')
                sb.append("0123456789ABCDEF"[(byte.toInt() ushr 4) and 0xF])
                sb.append("0123456789ABCDEF"[byte.toInt() and 0xF])
            }
        }
        return sb.toString()
    }
}
