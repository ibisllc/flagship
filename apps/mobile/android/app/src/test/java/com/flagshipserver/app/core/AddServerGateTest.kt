// Adding a server to the account (create, co-manage, take over, import a
// backup) is for the account's admin devices only, and recipe minting never
// mints an admin root: only opening the account does. Mirrors iOS
// AddServerGateTests and the webapp's webappAddServerGate.test.ts.

package com.flagshipserver.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.ui.screens.mintRecipeBundle
import com.flagshipserver.app.ui.screens.registerControlPlane
import com.google.crypto.tink.subtle.Ed25519Verify
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

    /** `.com` enforces the rule too: the issue carries the admin root's
     *  approval of the AuthCode that pins it, and the RCK is the root's. */
    @Test
    fun theAuthCodeIssueCarriesTheAdminRootsApproval() = runTest {
        Keystore.loadOrCreateUmkSeed()
        val pub = Keystore.generateAdminRoot()
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val hex32 = "ab".repeat(32)
        val domain = "home.harry.flagship.services"
        val bundle = InstallBlobBundle(
            blob = WireBlob(
                serverDomain = domain, username = "harry", serverName = "home",
                phoneDelegatedPubKey = hex32,
                authCode = WireAuthCode(
                    serial = "S1", username = "harry", serverName = "home", serverDomain = domain,
                    delegatedPubKey = hex32, userPubKey = hex32, issuedAt = 0L, expiresAt = 1L,
                    adminRootPubKey = pub,
                ),
                authCodeUserSignature = "00".repeat(64),
                rckPubKey = hex32,
            ),
            blobSignature = "00".repeat(64),
        )
        registerControlPlane(server, bundle, bundle.blob.authCodeUserSignature)

        val wire = server.issuedAuthCodes.getValue("S1")
        assertEquals(pub, wire.adminRootPubKey)
        val approval = server.issuedAdminSignatures["S1"] ?: error("no admin approval on the issue")
        val code = AuthCode(
            version = wire.version, serial = wire.serial, username = wire.username,
            serverName = wire.serverName, serverDomain = wire.serverDomain,
            delegatedPubKey = HexUtil.decode(wire.delegatedPubKey)!!,
            userPubKey = HexUtil.decode(wire.userPubKey)!!,
            issuedAt = wire.issuedAt, expiresAt = wire.expiresAt,
            adminRootPubKey = HexUtil.decode(pub)!!,
        )
        Ed25519Verify(HexUtil.decode(pub)!!).verify(HexUtil.decode(approval)!!, code.adminCanonicalBytes())
    }

    @Test
    fun theServersRefusalShowsTheSameSentence() {
        val refusal = HttpException(403, """{"error":"Only an admin device of this account can add servers.","code":"add-server-admin-only"}""")
        assertTrue(AddServerGate.isServerRefusal(refusal))
        assertEquals(AddServerGate.ADMIN_ONLY, NetworkErrorHumanizer.humanize(refusal))
        assertFalse(AddServerGate.isServerRefusal(HttpException(403, """{"error":"invalid signature"}""")))
        assertFalse(AddServerGate.isServerRefusal(HttpException(400, """{"code":"add-server-admin-only"}""")))
    }
}
