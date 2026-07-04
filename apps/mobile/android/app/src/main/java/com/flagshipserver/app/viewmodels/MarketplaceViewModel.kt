// Marketplace browse + install. `load()` pulls the catalog from the pod's
// BFF; `install(...)` fetches the full listing (manifest lives only on the
// single-listing endpoint), builds an InstallServiceRequest, signs the
// canonical bytes with the OWNER IRK (biometric, never silent — same path as
// FrontPageViewModel), wraps it as an envelope, and POSTs it straight to the
// box's /api/services. Mirror of iOS MarketplaceViewModel + the
// MarketplaceDetailContainer install flow.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.InstallServiceEnvelope
import com.flagshipserver.app.api.InstallServiceRequest
import com.flagshipserver.app.api.MarketplaceListing
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.installServiceCanonicalBytes
import com.flagshipserver.app.api.manifestSha256Hex
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class MarketplaceViewModel(
    private val client: ScreensClient,
    /** Signing seam — production derives the OWNER IRK from the Keystore
     *  (biometric on every install). Tests inject a fixed keypair so the
     *  recorded signature is verifiable. Mirror of FrontPageViewModel.signer. */
    private val signer: suspend (reason: String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val _state = MutableStateFlow<LoadingState<List<MarketplaceListing>>>(LoadingState.Idle)
    val state: StateFlow<LoadingState<List<MarketplaceListing>>> = _state.asStateFlow()

    private val _searchQuery = MutableStateFlow("")
    val searchQuery: StateFlow<String> = _searchQuery.asStateFlow()
    fun setSearchQuery(q: String) { _searchQuery.value = q }

    /** Listings filtered by the current [searchQuery] (title / summary /
     *  creator, case-insensitive). Empty until [load] succeeds. */
    val filtered: List<MarketplaceListing>
        get() {
            val listings = (_state.value as? LoadingState.Loaded)?.value ?: return emptyList()
            val q = _searchQuery.value.trim().lowercase()
            if (q.isEmpty()) return listings
            return listings.filter {
                it.title.lowercase().contains(q) ||
                    it.summary.lowercase().contains(q) ||
                    it.creator.lowercase().contains(q)
            }
        }

    suspend fun load() {
        _state.value = LoadingState.Loading
        try {
            _state.value = LoadingState.Loaded(client.marketplaceBrowse().listings)
        } catch (t: Throwable) {
            _state.value = LoadingState.Failed(t.message ?: "couldn't load the marketplace")
        }
    }

    /** Per-install lifecycle for the detail screen's CTA. */
    sealed interface InstallState {
        data object Idle : InstallState
        data object Installing : InstallState
        data class Succeeded(val serviceId: String) : InstallState
        data class Failed(val message: String) : InstallState
    }

    private val _installState = MutableStateFlow<InstallState>(InstallState.Idle)
    val installState: StateFlow<InstallState> = _installState.asStateFlow()

    fun resetInstall() { _installState.value = InstallState.Idle }

    /**
     * Install [creator]/[slug] onto the box at [serverId] (the pod's FQDN).
     * Two-step like the webapp / iOS: fetch the full listing for its
     * `manifestJson`, then sign + POST. The signature is over the canonical
     * bytes — NOT the request JSON — so the daemon's recomputed bytes verify.
     */
    suspend fun install(creator: String, slug: String, serverId: String) {
        _installState.value = InstallState.Installing
        try {
            val detail = client.marketplaceFetchListing(creator, slug)
            // The manifest is carried on the listing but not in the signed
            // canonical bytes; bind it by re-checking it hashes to the listing's
            // committed manifest_hash before installing a byte of it.
            if (detail.manifestHash.isNotEmpty() &&
                !detail.manifestHash.equals(manifestSha256Hex(detail.manifestJson), ignoreCase = true)
            ) {
                _installState.value =
                    InstallState.Failed("manifest hash mismatch — refusing to install a tampered listing")
                return
            }
            val request = InstallServiceRequest(
                serverId = serverId,
                creator = creator,
                slug = slug,
                manifestJson = detail.manifestJson,
                addOwnerToMembership = true,
                issuedAt = now(),
            )
            val irk = signer("Install $creator/$slug")
            val signature = irk.sign(installServiceCanonicalBytes(request))
            val resp = client.installFromMarketplace(
                InstallServiceEnvelope(request = request, signature = HexUtil.encode(signature)),
            )
            _installState.value = InstallState.Succeeded(resp.serviceId)
        } catch (t: Throwable) {
            _installState.value = InstallState.Failed(t.message ?: "install failed")
        }
    }
}
