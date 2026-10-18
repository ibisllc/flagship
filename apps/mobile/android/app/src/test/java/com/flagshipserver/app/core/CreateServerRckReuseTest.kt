// Device report 2026-10-18: "Pair with the builder" failed with
// `HTTP 409: subdomain already controlled by a different RCK` because every
// mint made a new routing key and `.com` pins a name to the first one it saw.
// A second mint for the same pending name must carry the same key.

package com.flagshipserver.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.screens.mintRecipeBundle
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class CreateServerRckReuseTest {
    private lateinit var ctx: Context
    private var clock = 1_000_000L

    @Before fun setUp() {
        ctx = ApplicationProvider.getApplicationContext()
        Keystore.attachForTest(ctx.getSharedPreferences("create-rck-reuse-test", Context.MODE_PRIVATE))
        Keystore.wipeAllProfiles()
        Keystore.setActiveProfile("harry")
        Keystore.loadOrCreateUmkSeed()
        Keystore.generateAdminRoot()
    }

    @After fun tearDown() = Keystore.wipeAllProfiles()

    private fun store() = PendingRckStore(
        ctx.getSharedPreferences("create-rck-reuse-store", Context.MODE_PRIVATE).also { it.edit().clear().commit() },
        now = { clock },
    )

    @Test fun aSecondMintForTheSamePendingNameReusesTheRck() = runTest {
        val rck = store()
        val first = mintRecipeBundle(username = "harry", serverName = "home", rckStore = rck)
        val second = mintRecipeBundle(username = "harry", serverName = "home", rckStore = rck)
        assertEquals(first.bundle.blob.rckPubKey, second.bundle.blob.rckPubKey)
        // Still a new order each time: only the routing claim is the same.
        assertNotEquals(first.serial, second.serial)
    }

    @Test fun anotherNameGetsItsOwnKey() = runTest {
        val rck = store()
        val home = mintRecipeBundle(username = "harry", serverName = "home", rckStore = rck)
        val home2 = mintRecipeBundle(username = "harry", serverName = "home2", rckStore = rck)
        assertNotEquals(home.bundle.blob.rckPubKey, home2.bundle.blob.rckPubKey)
    }

    @Test fun aCancelledOrderOrAStaleOneStartsFresh() = runTest {
        val rck = store()
        val first = mintRecipeBundle(username = "harry", serverName = "home", rckStore = rck)
        rck.clear(first.serverDomain)
        val afterCancel = mintRecipeBundle(username = "harry", serverName = "home", rckStore = rck)
        assertNotEquals(first.bundle.blob.rckPubKey, afterCancel.bundle.blob.rckPubKey)
        clock += PendingRckStore.TTL_MS + 1
        val afterDay = mintRecipeBundle(username = "harry", serverName = "home", rckStore = rck)
        assertNotEquals(afterCancel.bundle.blob.rckPubKey, afterDay.bundle.blob.rckPubKey)
    }
}
