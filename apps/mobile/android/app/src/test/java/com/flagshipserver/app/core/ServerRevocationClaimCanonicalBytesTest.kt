// P13 — pin the Android canonical-bytes computation for the
// flagship/revoke/v1 envelope against the Worker's encoding
// (@flagship/protocol auth.ts canonicalRevoke) + the iOS
// ServerRevocationClaim.canonicalBytes + the webapp canonicalRevokeBytes.
// Any byte drift on this signed message breaks the kill-switch on .com.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ServerRevocationClaimCanonicalBytesTest {

    @Test fun tag_isPinnedToTheProtocolConstant() {
        assertEquals("flagship/revoke/v1", ServerRevocationClaim.CANONICAL_TAG)
    }

    @Test fun reasonVocabulary_isFixedToTheProtocolEnum() {
        assertEquals(listOf("lost", "stolen", "decommissioned"), ServerRevocationClaim.REASONS)
    }

    @Test fun matchesDocumentedFieldOrder() {
        val bytes = ServerRevocationClaim.canonicalBytes(
            userId = "alice",
            revokedServerId = "home.alice.flagship.services",
            reason = "stolen",
            issuedAt = 1700000000000L,
        )
        // tag | userId | revokedServerId | reason | issuedAt
        assertEquals(
            "flagship/revoke/v1|alice|home.alice.flagship.services|stolen|1700000000000",
            String(bytes, Charsets.UTF_8),
        )
    }

    @Test fun preservesCasingInUserIdAndServerId() {
        // The Worker echoes the request unchanged into canonical-bytes (no
        // lowercasing) — names that survive `usernameAvailable`
        // normalization arrive here verbatim, so we must NOT silently
        // mutate them either.
        val bytes = ServerRevocationClaim.canonicalBytes(
            userId = "Alice",
            revokedServerId = "Home.Alice.Flagship.Services",
            reason = "lost",
            issuedAt = 1L,
        )
        assertEquals(
            "flagship/revoke/v1|Alice|Home.Alice.Flagship.Services|lost|1",
            String(bytes, Charsets.UTF_8),
        )
    }

    @Test fun eachReasonChangesTheCanonicalBytes() {
        val a = ServerRevocationClaim.canonicalBytes("u", "s", "lost", 1)
        val b = ServerRevocationClaim.canonicalBytes("u", "s", "stolen", 1)
        val c = ServerRevocationClaim.canonicalBytes("u", "s", "decommissioned", 1)
        assertNotEquals(String(a), String(b))
        assertNotEquals(String(b), String(c))
        assertNotEquals(String(a), String(c))
    }

    @Test fun issuedAtIsBase10NotHex() {
        val bytes = ServerRevocationClaim.canonicalBytes(
            userId = "bob",
            revokedServerId = "x.bob.flagship.services",
            reason = "decommissioned",
            issuedAt = 256L,
        )
        // 256 → "256" not "0x100" / "FF".
        assertEquals(
            "flagship/revoke/v1|bob|x.bob.flagship.services|decommissioned|256",
            String(bytes, Charsets.UTF_8),
        )
    }
}
