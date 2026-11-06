// Import-flow contract for the `.flagshipkey` account backup. Wraps a
// known seed with the canonical Keyfile writer, then drives the import
// VM end-to-end:
//   - unwrap installs the recovered UMK into the active per-profile slot
//   - re-pair is INITIATED (no totpProof — keyfile import is single-
//     device proof) and the VM lands in Grace with the deadline
//   - completeImport pairs the account as the imported user + labels the
//     device "admin"
// Wrong passphrase / non-keyfile map to the approved copy and never
// install anything.

package com.flagshipserver.app.viewmodels

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.api.UsernameClaimRequest
import com.flagshipserver.app.keystore.IrkLineage
import com.flagshipserver.app.keystore.Keyfile
import com.flagshipserver.app.keystore.Keystore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class KeyfileImportFlowTest {

    private val seed = ByteArray(32) { (it + 1).toByte() }
    private val passphrase = "correct horse battery staple"
    private val fast = Keyfile.ArgonParams(m = 256, t = 1, p = 1)

    @Before
    fun setUp() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        Keystore.attachForTest(ctx.getSharedPreferences("keyfile-import-test", Context.MODE_PRIVATE))
        Keystore.wipeAllProfiles()
    }

    @After
    fun tearDown() {
        Keystore.wipeAllProfiles()
    }

    private fun keyfileFor(username: String): String {
        val meta = Keyfile.Meta(username = username, accountId = null, createdAt = "2026-05-25T12:00:00.000Z")
        return Keyfile.wrap(seed, passphrase, meta, fast)
    }

    private fun vm(server: MockFlagshipServerClient, app: AppState) =
        KeyfileImportViewModel(server = server, app = app, now = { 1_000L })

    /** `.com` holds [username] under the IRK its creating client registered. */
    private suspend fun registered(
        server: MockFlagshipServerClient,
        username: String,
        scheme: IrkLineage.Scheme = IrkLineage.Scheme.ANDROID,
        version: Int = 1,
        umk: ByteArray = seed,
    ): String {
        val pub = IrkLineage.key(umk, scheme, version).pubHex
        server.claimUsername(UsernameClaimRequest(UsernameClaimRequest.Inner(username, pub, 1L), signature = ""))
        return pub
    }

    @Test
    fun import_installsRecoveredUmk_andInitiatesRePair() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        registered(server, "harry")
        val app = AppState()
        val m = vm(server, app)
        m.setPassphrase(passphrase)

        m.importBackup(keyfileFor("harry"))

        // Landed in grace with the re-pair deadline.
        val phase = m.phase.first()
        assertTrue("expected Grace, got $phase", phase is KeyfileImportPhase.Grace)
        assertEquals("harry", (phase as KeyfileImportPhase.Grace).username)

        // The recovered UMK is installed into the active (imported) slot.
        Keystore.setActiveProfile("harry")
        assertArrayEquals(seed, Keystore.currentUmkSeed())

        // Re-pair initiated for the imported user, NO totpProof.
        val last = server.lastRePairInitiate
        assertNotNull(last)
        assertEquals("harry", last!!.first)
        assertNull("keyfile import is single-device proof — no totpProof", last.second.totpProof)
        // Not paired yet — pairing happens on completion.
        assertFalse(app.isPaired.first())
    }

    @Test
    fun completeImport_pairsAccount_andLabelsAdmin() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        registered(server, "harry")
        val app = AppState()
        val m = vm(server, app)
        m.setPassphrase(passphrase)

        m.importBackup(keyfileFor("harry"))
        m.completeImport()

        assertEquals(KeyfileImportPhase.Opened("harry"), m.phase.first())
        assertTrue(app.isPaired.first())
        assertEquals("harry", app.currentUser.first())
        assertNull(
            "a recovered device is NOT named locally: administrator status is a "
                + "capability in its signed grant, and any display name is an "
                + "encrypted self-profile its owner writes later",
            app.activeProfile?.deviceDisplayName,
        )
    }

    @Test
    fun import_wrongPassphrase_mapsToApprovedCopy_andInstallsNothing() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val app = AppState()
        val m = vm(server, app)
        m.setPassphrase("not-the-passphrase")

        m.importBackup(keyfileFor("harry"))

        val phase = m.phase.first()
        assertTrue(phase is KeyfileImportPhase.Failed)
        assertEquals("That passphrase didn't open the file.", (phase as KeyfileImportPhase.Failed).message)
        assertNull("a failed unwrap must not initiate re-pair", server.lastRePairInitiate)
        assertFalse(app.isPaired.first())
    }

    @Test
    fun import_notAKeyfile_mapsToApprovedCopy() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val app = AppState()
        val m = vm(server, app)
        m.setPassphrase(passphrase)

        m.importBackup("{\"hello\":\"world\"}")

        val phase = m.phase.first()
        assertTrue(phase is KeyfileImportPhase.Failed)
        assertEquals("This isn't a Flagship key file.", (phase as KeyfileImportPhase.Failed).message)
        assertNull(server.lastRePairInitiate)
    }

    @Test
    fun export_thenImport_roundTripsThroughKeystore() = runTest {
        // Stand up an account, export it via the export VM, then import
        // it on a "fresh" device and confirm the UMK matches.
        Keystore.setActiveProfile("origin")
        Keystore.installUmk(seed)

        val exportVm = KeyfileExportViewModel(
            username = "origin",
            readUmkSeed = { Keystore.currentUmkSeed() },
            nowIso = { "2026-05-25T12:00:00.000Z" },
        )
        exportVm.setPassphrase("StrongPass123!")
        exportVm.setConfirmPassphrase("StrongPass123!")
        exportVm.setAckControl(true)
        assertTrue(exportVm.canCreate)
        exportVm.createBackupNow()
        val ready = exportVm.phase.first()
        assertTrue(ready is KeyfileExportPhase.Ready)
        val keyfileText = (ready as KeyfileExportPhase.Ready).text

        // Wipe to simulate a fresh device, then import.
        Keystore.wipeAllProfiles()
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        registered(server, "origin")
        val app = AppState()
        val importVm = vm(server, app)
        importVm.setPassphrase("StrongPass123!")
        importVm.importBackup(keyfileText)

        Keystore.setActiveProfile("origin")
        assertArrayEquals(seed, Keystore.currentUmkSeed())
    }

    // ── Failure 4 (Windows acceptance 2026-11-05): the key file of an account another client made ──

    @Test
    fun import_accountMadeOnTheWebapp_signsWithItsRegisteredKey_andRotatesToAndroid() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val webPub = registered(server, "harry", IrkLineage.Scheme.WEB, 1)
        val m = vm(server, AppState())
        m.setPassphrase(passphrase)

        m.importBackup(keyfileFor("harry"))

        assertTrue("expected Grace, got ${m.phase.first()}", m.phase.first() is KeyfileImportPhase.Grace)
        val req = server.lastRePairInitiate!!.second
        assertEquals(webPub, req.request.oldIrkPub)
        assertEquals(IrkLineage.key(seed, IrkLineage.Scheme.ANDROID, 2).pubHex, req.request.newIrkPub)
        val canonical = com.flagshipserver.app.core.RePairInitiateClaim.canonicalBytes(
            username = "harry", newIrkPubHex = req.request.newIrkPub, oldIrkPubHex = req.request.oldIrkPub, issuedAt = 1_000L,
        )
        com.google.crypto.tink.subtle.Ed25519Verify(HexUtil.decode(webPub)!!).verify(HexUtil.decode(req.oldIrkSignature!!)!!, canonical)
        Keystore.setActiveProfile("harry")
        assertEquals(2, Keystore.pendingIrkRotationVersion())
    }

    @Test
    fun import_aRotatedAccount_rotatesPastItsVersion() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val iosPub = registered(server, "harry", IrkLineage.Scheme.IOS, 3)
        val m = vm(server, AppState())
        m.setPassphrase(passphrase)
        m.importBackup(keyfileFor("harry"))
        val req = server.lastRePairInitiate!!.second
        assertEquals(iosPub, req.request.oldIrkPub)
        assertEquals(IrkLineage.key(seed, IrkLineage.Scheme.ANDROID, 4).pubHex, req.request.newIrkPub)
    }

    @Test
    fun import_anotherAccountsKeyFile_isRefusedWithASentence_andChangesNothing() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        registered(server, "harry", umk = ByteArray(32) { 0x55 })
        val m = vm(server, AppState())
        m.setPassphrase(passphrase)

        m.importBackup(keyfileFor("harry"))

        val phase = m.phase.first() as KeyfileImportPhase.Failed
        assertTrue(phase.message, phase.message.contains("harry") && !phase.message.contains("IRK"))
        assertNull("nothing is sent for a key that isn't the account's", server.lastRePairInitiate)
        Keystore.setActiveProfile("harry")
        assertFalse("nothing is installed", Keystore.hasUmkSeed())
    }

    @Test
    fun keystoreRegistersTheAndroidScheme() = runTest {
        // What OpenAccountViewModel registers at creation is Keystore's v1: the lineage's android key.
        Keystore.setActiveProfile("creator")
        Keystore.installUmk(seed)
        Keystore.deriveIRK("test", 1)
        for (v in 1..3) {
            val pub = com.google.crypto.tink.subtle.Ed25519Sign.KeyPair
                .newKeyPairFromSeed(Keystore.requireIrkSeedForVersion(v)).publicKey
            assertEquals(IrkLineage.key(seed, IrkLineage.Scheme.ANDROID, v).pubHex, HexUtil.encode(pub))
        }
    }

    @Test
    fun import_unknownAccount_isRefusedWithASentence() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val m = vm(server, AppState())
        m.setPassphrase(passphrase)
        m.importBackup(keyfileFor("nobody"))
        val phase = m.phase.first() as KeyfileImportPhase.Failed
        assertTrue(phase.message, phase.message.contains("nobody"))
        assertNull(server.lastRePairInitiate)
    }
}
