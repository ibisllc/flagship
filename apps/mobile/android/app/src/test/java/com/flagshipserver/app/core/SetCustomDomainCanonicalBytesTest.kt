// #79A/#80 — pin the Android canonical-bytes computation for the
// flagship/custom-domain/v1 envelope against the Worker's encoding
// (@flagship/protocol canonicalSetCustomDomain) + the iOS encoding.
// Client/server drift here is the most common shape of the
// "signed-by-IRK but .com rejects the attach" bug, so this is the
// one piece that MUST stay byte-identical across all three clients.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Test

class SetCustomDomainCanonicalBytesTest {

    @Test fun matchesDocumentedFieldOrder() {
        val bytes = SetCustomDomainClaim.canonicalBytes(
            username = "alice",
            appId = "meta-scratchpad",
            fqdn = "shop.example.com",
            issuedAt = 1700000000000L,
        )
        // tag | username | appId | fqdn(lowercased) | issuedAt
        assertEquals(
            "flagship/custom-domain/v1|alice|meta-scratchpad|shop.example.com|1700000000000",
            String(bytes, Charsets.UTF_8),
        )
    }

    @Test fun lowercasesFqdnOnly() {
        // The Worker preserves username + appId casing; only the fqdn
        // is lowercased on its way through canonical-bytes (auth.ts
        // canonicalSetCustomDomain: r.fqdn.toLowerCase()).
        val bytes = SetCustomDomainClaim.canonicalBytes(
            username = "Alice",
            appId = "Meta--Scratchpad",
            fqdn = "Shop.Example.COM",
            issuedAt = 1L,
        )
        assertEquals(
            "flagship/custom-domain/v1|Alice|Meta--Scratchpad|shop.example.com|1",
            String(bytes, Charsets.UTF_8),
        )
    }

    @Test fun matchesIosAndWorkerByteForByte() {
        val bytes = SetCustomDomainClaim.canonicalBytes(
            username = "alice",
            appId = "app-id",
            fqdn = "www.example.com",
            issuedAt = 9L,
        )
        assertEquals(
            "flagship/custom-domain/v1|alice|app-id|www.example.com|9",
            String(bytes, Charsets.UTF_8),
        )
    }
}
