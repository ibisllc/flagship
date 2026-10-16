// Adding a server to the account (create, co-manage, take over, import a
// backup) is for the account's admin devices only, and recipe minting never
// mints an admin root: only opening the account does. Mirrors iOS
// AddServerGateTests and the webapp's webappAddServerGate.test.ts.

package com.flagshipserver.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.screens.mintRecipeBundle
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class AddServerGateTest {

    @Before
    fun setUp() {
        val ctx: Context = ApplicationProvider.getApplicationContext()
        Keystore.attachForTest(ctx.getSharedPreferences("add-server-gate-test", Context.MODE_PRIVATE))
        Keystore.wipeAllProfiles()
        Keystore.setActiveProfile("harry")
    }

    @After
    fun tearDown() {
        Keystore.wipeAllProfiles()
    }

    @Test
    fun onlyAnAdminDeviceOrADemoAccountMayAddServers() {
        assertTrue(AddServerGate.allows(holdsAdminRoot = true, isDemoAccount = false))
        assertFalse(AddServerGate.allows(holdsAdminRoot = false, isDemoAccount = false))
        assertTrue(AddServerGate.allows(holdsAdminRoot = false, isDemoAccount = true))
        assertEquals("Only an admin device of this account can add servers.", AddServerGate.ADMIN_ONLY)
    }

    @Test
    fun everyHomeRouteThatAddsAServerIsGated() {
        assertTrue(AddServerGate.addsServer("create-server"))
        assertTrue(AddServerGate.addsServer("create-server?builder={builder}"))
        assertTrue(AddServerGate.addsServer("share-accept?s={s}&k={k}"))
        assertTrue(AddServerGate.addsServer("transfer-acquirer?offer={offer}"))
        assertFalse(AddServerGate.addsServer("server-detail/{podId}"))
        assertFalse(AddServerGate.addsServer("shared-server/{shareId}"))
        assertFalse(AddServerGate.addsServer("install-progress/{serial}"))
        assertFalse(AddServerGate.addsServer(null))
    }

    @Test
    fun recipePinsTheDevicesAdminRoot_refusesWithout_demoPinsNone() {
        assertEquals("ab", AddServerGate.recipeAdminRootPin("ab", isDemoAccount = false))
        assertNull(AddServerGate.recipeAdminRootPin(null, isDemoAccount = true))
        try {
            AddServerGate.recipeAdminRootPin(null, isDemoAccount = false)
            fail("a device without the admin root must be refused")
        } catch (e: AddServerRefused) {
            assertEquals(AddServerGate.ADMIN_ONLY, e.message)
        }
        assertEquals(AddServerGate.ADMIN_ONLY, NetworkErrorHumanizer.humanize(AddServerRefused()))
    }

    /** The stray-mint case: a device of an existing account (UMK, no admin
     *  root) must be refused, and must NOT come out holding a fresh root. */
    @Test
    fun aNonAdminDeviceIsRefused_andNoAdminRootIsMinted() = runTest {
        Keystore.loadOrCreateUmkSeed()
        assertFalse("precondition: a non-admin device", Keystore.hasAdminRoot())
        try {
            mintRecipeBundle(username = "harry", serverName = "home")
            fail("a non-admin device must not mint a recipe")
        } catch (e: AddServerRefused) {
            assertEquals("Only an admin device of this account can add servers.", e.message)
        }
        assertFalse("minting must never create an admin root", Keystore.hasAdminRoot())
        assertNull(Keystore.adminRootPubHex())
    }

    @Test
    fun anAdminDevicePinsTheRootItAlreadyHolds() {
        Keystore.loadOrCreateUmkSeed()
        val pub = Keystore.generateAdminRoot()
        assertEquals(pub, AddServerGate.recipeAdminRootPin(Keystore.adminRootPubHex(), isDemoAccount = false))
    }
}
