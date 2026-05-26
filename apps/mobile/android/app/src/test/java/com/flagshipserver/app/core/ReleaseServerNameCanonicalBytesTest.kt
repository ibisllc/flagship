// P3 — pin the Android canonical-bytes computation for the
// flagship/release-server-name/v1 envelope against the Worker's encoding
// (@flagship/protocol auth.ts canonicalReleaseServerName) + the iOS
// ReleaseServerName.canonicalBytes. The phone-vs-.com signing surface
// here is identical in shape to the auth-code-revoke + custom-domain
// envelopes — any byte drift on this signed message breaks cancel.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Test

class ReleaseServerNameCanonicalBytesTest {

    @Test fun tag_isPinnedToTheProtocolConstant() {
        assertEquals(
            "flagship/release-server-name/v1",
            ReleaseServerName.CANONICAL_TAG,
        )
    }

    @Test fun matchesDocumentedFieldOrder() {
        val bytes = ReleaseServerName.canonicalBytes(
            username = "alice",
            serverDomain = "home.alice.flagship.services",
            issuedAt = 1700000000000L,
        )
        // tag | username | serverDomain | issuedAt
        assertEquals(
            "flagship/release-server-name/v1|alice|home.alice.flagship.services|1700000000000",
            String(bytes, Charsets.UTF_8),
        )
    }

    @Test fun preservesCasingInUsernameAndServerDomain() {
        // The Worker echoes the request unchanged into canonical-bytes (no
        // lowercasing) — names that survive `usernameAvailable`
        // normalization arrive here verbatim, so we must NOT silently
        // mutate them either.
        val bytes = ReleaseServerName.canonicalBytes(
            username = "Alice",
            serverDomain = "Home.Alice.Flagship.Services",
            issuedAt = 1L,
        )
        assertEquals(
            "flagship/release-server-name/v1|Alice|Home.Alice.Flagship.Services|1",
            String(bytes, Charsets.UTF_8),
        )
    }

    @Test fun issuedAtIsBase10NotHex() {
        val bytes = ReleaseServerName.canonicalBytes(
            username = "bob",
            serverDomain = "x.bob.flagship.services",
            issuedAt = 256L,
        )
        // 256 → "256" not "0x100" / "FF".
        assertEquals(
            "flagship/release-server-name/v1|bob|x.bob.flagship.services|256",
            String(bytes, Charsets.UTF_8),
        )
    }
}
