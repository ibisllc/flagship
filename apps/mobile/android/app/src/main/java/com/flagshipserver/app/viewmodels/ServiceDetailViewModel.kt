// Kotlin mirror of FlagshipUI/ViewModels/ServiceDetailViewModel.swift.
//
// Owns the per-service detail surface: the app-detail response (header,
// data layer, members, browser tabs, logs, last backup). `load()` fetches
// /api/screens/app-detail/:serviceId off the box the page works on;
// `uninstall()` removes the app from that box with the owner-signed
// `flagship/uninstall-service/v1` order (`DELETE /api/services/:id`).
// Where else the app runs lives on AppPlacementViewModel
// (docs/app-placement.md §4).
//
// The WEB DOMAINS / Replace machinery stays on
// RenameServiceViewModel (the iOS split is the same: AppLinks live on a
// sibling path). This VM never touches it.
//
// When the contract changes, update this file AND
// apps/mobile/ios/Sources/FlagshipUI/ViewModels/ServiceDetailViewModel.swift
// in the same commit.

package com.flagshipserver.app.viewmodels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.flagshipserver.app.api.AppDetailResponse
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.core.NetworkErrorHumanizer
import com.flagshipserver.app.core.UninstallServiceOrder
import com.flagshipserver.app.keystore.Keystore
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class ServiceDetailViewModel(
    val serviceId: String,
    private val client: ScreensClient,
    /** The box this page works on, when the client can't say. */
    private val fallbackServerDomain: () -> String? = { null },
    /** The owner IRK, which the box checks a signed uninstall against. */
    private val uninstallSigner: suspend (String) -> Ed25519Sign = { r -> Keystore.deriveIRK(r) },
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {

    private val _detail = MutableStateFlow<LoadingState<AppDetailResponse>>(LoadingState.Idle)
    val detail: StateFlow<LoadingState<AppDetailResponse>> = _detail.asStateFlow()

    /** Set when the last failure was a box cert-pin mismatch (UX-A) — the UI
     *  promotes this to a security warning instead of a retry hint. Mirrors
     *  the iOS `ScreensClientError.userFacing` cert-pin branch. */
    private val _certMismatch = MutableStateFlow(false)
    val certMismatch: StateFlow<Boolean> = _certMismatch.asStateFlow()

    fun load() = viewModelScope.launch {
        _detail.value = LoadingState.Loading
        _certMismatch.value = false
        try {
            _detail.value = LoadingState.Loaded(client.appDetail(serviceId))
        } catch (t: Throwable) {
            val classified = NetworkErrorHumanizer.classify(t)
            _certMismatch.value = classified.kind == NetworkErrorHumanizer.Kind.CERT_PIN_MISMATCH
            _detail.value = LoadingState.Failed(classified.message)
        }
    }

    /** Remove the app from this page's box: biometrics, then the owner-signed
     *  uninstall. Throws on failure. */
    suspend fun uninstall() {
        val domain = runCatching { client.boxFqdn() }.getOrNull()?.takeIf { it.isNotEmpty() }
            ?: fallbackServerDomain()?.takeIf { it.isNotEmpty() }
            ?: throw IllegalStateException("Couldn't tell which server this app is on.")
        val app = (_detail.value as? LoadingState.Loaded)?.value?.app
        val (creator, slug) = app?.takeIf { it.creator.isNotEmpty() && it.slug.isNotEmpty() }?.let { it.creator to it.slug }
            ?: UninstallServiceOrder.split(serviceId)
            ?: throw IllegalStateException("Couldn't identify the app to remove.")
        val key = uninstallSigner("Remove $slug")
        client.uninstallService(serviceId, UninstallServiceOrder.body(key, domain, creator, slug, now()))
    }
}
