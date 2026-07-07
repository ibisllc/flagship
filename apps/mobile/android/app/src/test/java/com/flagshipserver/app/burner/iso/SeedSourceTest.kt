package com.flagshipserver.app.burner.iso

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the seed-source selection (task #22): a local seed wins only on a
 * developer-unlocked build; every other combination uses the managed download,
 * so a shipped build can never be steered to an unpinned local seed.
 */
class SeedSourceTest {
    @Test
    fun localSeedIsUsedOnlyWhenDevUnlockedAndPresent() {
        val src = SeedSource.resolve("content://seed.iso", devUnlocked = true)
        assertTrue(src is SeedSource.LocalFile)
        assertEquals("content://seed.iso", (src as SeedSource.LocalFile).uri)
    }

    @Test
    fun localSeedIsIgnoredOnAReleaseBuild() {
        assertEquals(SeedSource.Managed, SeedSource.resolve("content://seed.iso", devUnlocked = false))
    }

    @Test
    fun blankOrNullLocalSeedFallsBackToManaged() {
        assertEquals(SeedSource.Managed, SeedSource.resolve(null, devUnlocked = true))
        assertEquals(SeedSource.Managed, SeedSource.resolve("", devUnlocked = true))
        assertEquals(SeedSource.Managed, SeedSource.resolve("   ", devUnlocked = true))
    }
}
