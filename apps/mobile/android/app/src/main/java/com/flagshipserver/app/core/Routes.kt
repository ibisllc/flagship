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
}

sealed interface ActivityRoute {
    data object UnlockApprovals : ActivityRoute
    data class InstallProgress(val serial: String) : ActivityRoute
}

sealed interface SettingsRoute {
    data object Providers : SettingsRoute
    data object Recovery : SettingsRoute
    data object PostRecoveryProgress : SettingsRoute
    data object About : SettingsRoute
    data object AddControlDevice : SettingsRoute
    data object Developer : SettingsRoute
}

enum class RootDestination(val key: String, val label: String) {
    HOME("home", "Home"),
    APPS("apps", "Apps"),
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
    data object PodPair : OnboardingRoute
}
