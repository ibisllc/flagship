package com.flagshipserver.app.core

import com.flagshipserver.app.api.ServiceEnvSetEnvelope
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pins the SetServiceEnv canonical bytes to the SAME cross-surface vector the
 * webapp (`canonicalSetServiceEnv` in service-env.js) and `@flagship/protocol`
 * produce. The daemon re-derives these bytes to verify the owner-IRK signature,
 * so any drift in field order, the `|` separator, key sorting, the `key=value`
 * pair shape, or the pair-count / issuedAt stringification would break live
 * service-env writes. The previous production signer returned 128 zeros.
 */
class EnvSignerCanonicalTest {
    @Test
    fun canonicalBytesMatchCrossSurfaceVector() {
        val env = ServiceEnvSetEnvelope(
            serverId = "srv1",
            creator = "alice",
            slug = "blog",
            // Deliberately unsorted insertion order to prove keys are sorted.
            env = mapOf("B" to "2", "A" to "1"),
            issuedAt = 1700000000L,
        )
        val expected = "flagship/set-service-env/v1|srv1|alice|blog|2|A=1|B=2|1700000000"
        assertEquals(expected, canonicalSetServiceEnv(env).toString(Charsets.UTF_8))
    }

    @Test
    fun emptyEnvHasZeroPairCount() {
        val env = ServiceEnvSetEnvelope(
            serverId = "s",
            creator = "c",
            slug = "g",
            env = emptyMap(),
            issuedAt = 42L,
        )
        assertEquals(
            "flagship/set-service-env/v1|s|c|g|0|42",
            canonicalSetServiceEnv(env).toString(Charsets.UTF_8),
        )
    }
}
