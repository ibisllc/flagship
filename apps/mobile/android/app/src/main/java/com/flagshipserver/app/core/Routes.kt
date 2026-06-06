// Kotlin mirror of FlagshipCore/Routes.swift.
//
// Sealed types per tab so a NavHost can route by data class instead of
// stringly-typed routes. Compose's `navigation-compose` doesn't enforce
// type-safety on its own — we layer it on with this sealed hierarchy
// plus a small encoder (see DeepLink.kt).

package com.flagshipserver.app.core

sealed interface HomeRoute {
    data class ServerDetail(val podId: String) : HomeRoute
    data object AddServer : HomeRoute
    data class InstallProgress(
        val serial: String,
        val name: String,
        val description: String,
    ) : HomeRoute
}

sealed interface AppsRoute {
    data class AppDetail(val appId: String) : AppsRoute
    data object Marketplace : AppsRoute
    data class MarketplaceDetail(val creator: String, val slug: String) : AppsRoute
    data object VibeCodeProviderPick : AppsRoute
    data object VibeCodeDescribe : AppsRoute
    data class VibeCodeGenerating(val sessionId: String) : AppsRoute
    /** P8 — list of headless-Chromium tabs running for an app. */
    data class BrowserTabs(val serviceId: String) : AppsRoute
    /** P8 — the framebuffer viewer that streams a single tab. */
    data class BrowserViewer(val serviceId: String, val tabId: String) : AppsRoute
    /** P6 — per-app collaborator-invite manage surface. */
    data class InviteManage(val serviceId: String) : AppsRoute
    /** P6 — per-app collaborator-invite issuance form. */
    data class InviteIssue(val serviceId: String) : AppsRoute
}

sealed interface ActivityRoute {
    /** The sealed-key RELAY approval surface (SecretRequestsScreen). */
    data object SecretRequests : ActivityRoute
    data class InstallProgress(val serial: String) : ActivityRoute
    /** P5 — the dedicated full-page audit-log viewer, reached from the
     *  Activity feed's "View full audit log" row. */
    data object AuditLog : ActivityRoute
}

sealed interface SettingsRoute {
    data object Providers : SettingsRoute
    data object Recovery : SettingsRoute
    data object PostRecoveryProgress : SettingsRoute
    data object About : SettingsRoute
    data object AddControlDevice : SettingsRoute
    data object Developer : SettingsRoute
    /** P14 — Settings → Dock a browser. Mints a 60-second pairing
     *  ticket as a QR; a desktop browser scans to become a 4-hour
     *  read-only companion. */
    data object CompanionDock : SettingsRoute

    /** P14 Phase 2 — Settings → Companion requests. Inbox for unsigned
     *  write requests companions have forwarded to the owner; the
     *  owner approves (IRK-signs + dispatches) or denies. */
    data object CompanionRequests : SettingsRoute
}

enum class RootDestination(val key: String, val label: String) {
    HOME("home", "Home"),
    APPS("apps", "Services"),
    ACTIVITY("activity", "Activity"),
    SETTINGS("settings", "Settings"),
    ;

    companion object {
        fun from(key: String): RootDestination? = entries.firstOrNull { it.key == key }
    }
}

sealed interface OnboardingRoute {
    data object ChooseUsername : OnboardingRoute
    data class CreateServer(val username: String) : OnboardingRoute

    /** WebAuthn-PRF recovery on a fresh install. Replaces the old
     *  [PodPair] route which implied that scanning a QR could claim
     *  another user's pod; this one fetches the wrapped UMK off
     *  flagshipserver.com using the user's passkey (Google Credential
     *  Manager on Android, or a hardware authenticator). */
    data object RecoverFromWelcome : OnboardingRoute
}
