// MarketplaceViewModel — browse loads the catalog into LoadingState; install
// fetches the listing, signs the canonical bytes with the OWNER IRK, wraps an
// envelope, and POSTs it to the box. The recorded signature must verify
// against the canonical bytes the daemon recomputes. Mirror of
// FrontPageViewModelTest's sign-and-verify discipline + the iOS
// MarketplaceInstallTests call-site assertions.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.installServiceCanonicalBytes
import com.flagshipserver.app.core.HexUtil
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MarketplaceViewModelTest {

    private fun client() = MockScreensClient(simulatedLatencyMs = 0)

    @Test fun load_populatesListings() = runTest {
        val vm = MarketplaceViewModel(client = client())
        vm.load()
        val loaded = vm.state.value as LoadingState.Loaded
        assertEquals(listOf("trent", "wendy", "peggy"), loaded.value.map { it.creator })
    }

    @Test fun filtered_appliesSearchQuery() = runTest {
        val vm = MarketplaceViewModel(client = client())
        vm.load()
        vm.setSearchQuery("wish")
        assertEquals(listOf("wendy"), vm.filtered.map { it.creator })
        vm.setSearchQuery("")
        assertEquals(3, vm.filtered.size)
    }

    @Test fun install_signsCanonicalBytes_andRecordsEnvelope() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val mock = client()
        val vm = MarketplaceViewModel(
            client = mock,
            signer = { Ed25519Sign(kp.privateKey) },
            now = { 1_700_000_000_000L },
        )
        vm.install(creator = "trent", slug = "scratchpad", serverId = "home.harry.flagship.services")

        val state = vm.installState.value as MarketplaceViewModel.InstallState.Succeeded
        assertEquals("trent--scratchpad", state.serviceId)

        // The listing was fetched (manifest source) before the install POST.
        assertEquals(1, mock.listingFetches.size)
        assertEquals(1, mock.installCalls.size)
        val recorded = mock.installCalls[0]
        assertEquals("home.harry.flagship.services", recorded.request.serverId)
        assertEquals("trent", recorded.request.creator)
        assertEquals("scratchpad", recorded.request.slug)
        assertEquals(1_700_000_000_000L, recorded.request.issuedAt)
        assertTrue(recorded.request.addOwnerToMembership)
        // manifestJson came from the fetched listing, not invented locally.
        assertTrue(recorded.request.manifestJson.contains("scratchpad"))

        // The recorded signature is over the canonical bytes — not the request
        // JSON — so the daemon's recomputed bytes verify.
        val sig = HexUtil.decode(recorded.signature)
        assertNotNull(sig)
        Ed25519Verify(kp.publicKey).verify(sig!!, installServiceCanonicalBytes(recorded.request))
    }

    @Test fun install_surfacesDaemonError() = runTest {
        val mock = client().apply {
            installShouldFail = true
            installFailureMessage = "manifest signature invalid"
        }
        val vm = MarketplaceViewModel(
            client = mock,
            signer = { Ed25519Sign(Ed25519Sign.KeyPair.newKeyPair().privateKey) },
        )
        vm.install(creator = "trent", slug = "scratchpad", serverId = "home.harry.flagship.services")
        val state = vm.installState.value
        assertTrue(state is MarketplaceViewModel.InstallState.Failed)
        assertTrue((state as MarketplaceViewModel.InstallState.Failed).message.contains("manifest signature invalid"))
    }

    @Test fun install_rejectsManifestHashMismatch_withoutPosting() = runTest {
        val mock = client().apply { tamperListingManifest = true }
        val vm = MarketplaceViewModel(
            client = mock,
            signer = { Ed25519Sign(Ed25519Sign.KeyPair.newKeyPair().privateKey) },
        )
        vm.install(creator = "trent", slug = "scratchpad", serverId = "home.harry.flagship.services")
        val state = vm.installState.value
        assertTrue(state is MarketplaceViewModel.InstallState.Failed)
        assertTrue((state as MarketplaceViewModel.InstallState.Failed).message.contains("hash mismatch"))
        // A tampered manifest must never reach the box.
        assertEquals(0, mock.installCalls.size)
    }

    @Test fun install_gradeF_withoutOverride_isBlocked_andPostsNothing() = runTest {
        val mock = client()
        val vm = MarketplaceViewModel(
            client = mock,
            signer = { Ed25519Sign(Ed25519Sign.KeyPair.newKeyPair().privateKey) },
        )
        vm.install(
            creator = "trent", slug = "scratchpad",
            serverId = "home.harry.flagship.services", scanGrade = "F",
        )
        assertTrue(vm.installState.value is MarketplaceViewModel.InstallState.BlockedByScan)
        // A failing-scan app must not touch the box without an explicit override —
        // not even the listing fetch or a signature request.
        assertEquals(0, mock.installCalls.size)
        assertEquals(0, mock.listingFetches.size)
    }

    @Test fun install_gradeF_withOverride_proceeds() = runTest {
        val kp = Ed25519Sign.KeyPair.newKeyPair()
        val mock = client()
        val vm = MarketplaceViewModel(
            client = mock,
            signer = { Ed25519Sign(kp.privateKey) },
            now = { 1_700_000_000_000L },
        )
        vm.install(
            creator = "trent", slug = "scratchpad",
            serverId = "home.harry.flagship.services",
            scanGrade = "F", overrideScanBlock = true,
        )
        assertTrue(vm.installState.value is MarketplaceViewModel.InstallState.Succeeded)
        assertEquals(1, mock.installCalls.size)
    }

    @Test fun install_ungraded_proceedsWithoutOverride() = runTest {
        val mock = client()
        val vm = MarketplaceViewModel(
            client = mock,
            signer = { Ed25519Sign(Ed25519Sign.KeyPair.newKeyPair().privateKey) },
        )
        // null grade → cautioned but allowed; the normal path posts.
        vm.install(
            creator = "trent", slug = "scratchpad",
            serverId = "home.harry.flagship.services", scanGrade = null,
        )
        assertTrue(vm.installState.value is MarketplaceViewModel.InstallState.Succeeded)
        assertEquals(1, mock.installCalls.size)
    }

    @Test fun install_signerFailure_failsWithoutPosting() = runTest {
        val mock = client()
        val vm = MarketplaceViewModel(
            client = mock,
            signer = { error("biometric cancelled") },
        )
        vm.install(creator = "trent", slug = "scratchpad", serverId = "home.harry.flagship.services")
        assertTrue(vm.installState.value is MarketplaceViewModel.InstallState.Failed)
        // The listing fetch happens before signing; the install POST must NOT.
        assertEquals(0, mock.installCalls.size)
    }
}
