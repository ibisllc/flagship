// V3 — pin the Android canonical-bytes computation for the
// flagship/app-rename/v1 envelope against the Worker's encoding +
// the iOS encoding. Drift between client + server is the most
// common shape of "signed-by-IRK but server rejects" bug.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Test

class AppRenameCanonicalBytesTest {

    @Test fun matchesDocumentedFieldOrder() {
        val bytes = AppRenameClaim.canonicalBytes(
            username = "alice",
            appId = "meta--scratchpad",
            newDisplayLabel = "MyNotes",
            issuedAt = 1700000000000L,
        )
        // tag | username | appId | newDisplayLabel(lowercased) | issuedAt
        assertEquals(
            "flagship/app-rename/v1|alice|meta--scratchpad|mynotes|1700000000000",
            String(bytes, Charsets.UTF_8),
        )
    }

    @Test fun lowercasesDisplayLabelOnly() {
        // The Worker preserves the username + appId casing; only the
        // displayLabel is lowercased on its way through canonical-bytes.
        val bytes = AppRenameClaim.canonicalBytes(
            username = "Alice",
            appId = "Meta--Scratchpad",
            newDisplayLabel = "MYNOTES",
            issuedAt = 1L,
        )
        assertEquals(
            "flagship/app-rename/v1|Alice|Meta--Scratchpad|mynotes|1",
            String(bytes, Charsets.UTF_8),
        )
    }

    @Test fun matchesIosByteForByte() {
        // Mirror exactly the iOS AppRenameClaim.canonicalBytes output
        // for the same inputs — cross-platform sign + verify requires
        // byte-identical canonical bytes on both sides.
        val bytes = AppRenameClaim.canonicalBytes(
            username = "alice",
            appId = "app--id",
            newDisplayLabel = "stem",
            issuedAt = 9L,
        )
        assertEquals(
            "flagship/app-rename/v1|alice|app--id|stem|9",
            String(bytes, Charsets.UTF_8),
        )
    }

    @Test fun voiciShortenWithoutAppId_usesEmptyString() {
        // VoiciShortenClaim uses "" in the appId slot when null is
        // passed — the Worker's canonicalVoiciShorten does the same.
        val bytes = VoiciShortenClaim.canonicalBytes(
            username = "alice",
            appId = null,
            targetUrl = "https://example.com/",
            issuedAt = 1L,
        )
        assertEquals(
            "flagship/voici-shorten/v1|alice||https://example.com/|1",
            String(bytes, Charsets.UTF_8),
        )
    }
}
