// P2 — trademark-claim mailto builder. Asserts the subject + body are
// byte-identical to the canonical webapp helper
// (apps/web/public/webapp/lib/trademarkClaim.js) + the iOS helper
// (apps/mobile/ios/Sources/FlagshipCore/TrademarkClaim.swift) and that
// the mailto string encodes them the way JS `encodeURIComponent` does.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TrademarkClaimTest {

    @Test fun email_isTheTrademarksDesk() {
        assertEquals("trademarks@flagshipserver.com", TrademarkClaim.EMAIL)
    }

    @Test fun subject_matchesCanonical() {
        assertEquals(
            "Trademark claim for the name \"harry\"",
            TrademarkClaim.subject("harry"),
        )
    }

    @Test fun body_matchesCanonicalTemplate() {
        val expected = listOf(
            "Hello,",
            "",
            "I'm requesting the Flagship account name \"harry\" on the basis",
            "that I hold a registered trademark covering it.",
            "",
            "Trademark holder / company: [your name or company]",
            "Trademark registration number: [registration number]",
            "Jurisdiction / registry: [e.g. USPTO, EUIPO]",
            "Goods/services class(es): [class numbers]",
            "Link or attachment to the registration: [URL or note that it's attached]",
            "",
            "Requested name: harry",
            "",
            "Thank you.",
        ).joinToString("\n")
        assertEquals(expected, TrademarkClaim.body("harry"))
    }

    @Test fun mailto_encodesSubjectAndBodyAndPrefixesTheTrademarksDesk() {
        val s = TrademarkClaim.mailto("harry")
        assertTrue(s, s.startsWith("mailto:trademarks@flagshipserver.com?subject="))
        assertTrue(s, s.contains("&body="))
        // Subject "Trademark claim for the name "harry"" — spaces → %20,
        // quotes → %22.
        assertTrue(s, s.contains("Trademark%20claim%20for%20the%20name%20%22harry%22"))
        // Body newlines encode as %0A; the body starts with "Hello,\n\nI'm requesting".
        assertTrue(s, s.contains("Hello%2C%0A%0AI'm%20requesting"))
    }

    @Test fun encodeURIComponent_matchesJsUnreservedSet() {
        // encodeURIComponent leaves A-Za-z0-9 and -_.!~*'() unescaped and
        // escapes everything else (notably space, quotes, slash, colon).
        assertEquals("-_.!~*'()", TrademarkClaim.encodeURIComponent("-_.!~*'()"))
        assertEquals("a%20b", TrademarkClaim.encodeURIComponent("a b"))
        assertEquals("%22q%22", TrademarkClaim.encodeURIComponent("\"q\""))
        assertEquals("a%2Fb%3Ac", TrademarkClaim.encodeURIComponent("a/b:c"))
    }

    @Test fun mailto_usernameIsUsedVerbatim() {
        val s = TrademarkClaim.mailto("acme42")
        assertTrue(s, s.contains("%22acme42%22"))
    }

    @Test fun encodeURIComponent_matchesJsForMultiByteUtf8() {
        // Foundation/JS both percent-encode each UTF-8 BYTE, uppercase
        // hex. The Kotlin port walks UTF-8 bytes the same way; pinning a
        // multi-byte char here catches any future regression to a
        // codepoint-based encoder.
        // U+00E9 "é" → C3 A9
        assertEquals("caf%C3%A9", TrademarkClaim.encodeURIComponent("café"))
    }
}
