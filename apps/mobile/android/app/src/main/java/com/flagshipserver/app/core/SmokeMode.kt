// GYM smoke-mode seam (§10 Phase-5) — Kotlin mirror of iOS
// FlagshipApp.applySmokeModeIfRequested. The instrumentation harness launches
// MainActivity with a set of intent extras that seed DemoFixtures (no backend),
// land the shell on a tab, and optionally seed a server-event / operations /
// trust state so a Compose-UI-Test can assert each screen deterministically.
//
// Android idiom: the launch SELECTORS are intent extras (the iOS twins are
// process launch arguments `-smoke-mode` / `-smoke-tab` / …). Mapping:
//   iOS -smoke-mode             ↔ --ez flagship.smokeMode true
//   iOS -smoke-tab <home|…>     ↔ --es flagship.smokeTab home|apps|activity|settings
//   iOS -smoke-ops              ↔ --ez flagship.smokeOps true
//   iOS -smoke-trust-untrusted  ↔ --ez flagship.smokeTrustUntrusted true
//   iOS -smoke-awaiting-unlock  ↔ --es flagship.smokePods awaiting-unlock
//   iOS -smoke-dead             ↔ --es flagship.smokePods dead
//
// PRODUCTION SAFETY: MainActivity only calls into here when the app is
// debuggable (ApplicationInfo.FLAG_DEBUGGABLE) AND the smokeMode extra is set —
// a release build NEVER seeds fixtures from an intent (mirrors iOS, where
// ProcessInfo.arguments only carry these when a test launcher sets them). The
// extras are namespaced `flagship.*` so nothing collides with a real deep link.

package com.flagshipserver.app.core

import android.content.Intent

/** The selectors the gym harness sets on the launch Intent. Parsed once in
 *  MainActivity. A null/blank [smokeTab] lands on Home (the default). */
data class SmokeModeConfig(
    val tab: RootDestination,
    val seedOps: Boolean,
    val seedTrustUntrusted: Boolean,
    /** "awaiting-unlock" | "dead" | null — picks the variant fixture pod set. */
    val podsVariant: String?,
    /** Treat this device as holding the admin master root (GymSeams twin of
     *  iOS `-smoke-admin-root`) so the Slice-D admin-gated surfaces render. */
    val seedAdminRoot: Boolean,
) {
    companion object {
        const val EXTRA_SMOKE_MODE = "flagship.smokeMode"
        const val EXTRA_SMOKE_TAB = "flagship.smokeTab"
        const val EXTRA_SMOKE_OPS = "flagship.smokeOps"
        const val EXTRA_SMOKE_TRUST_UNTRUSTED = "flagship.smokeTrustUntrusted"
        const val EXTRA_SMOKE_PODS = "flagship.smokePods"
        const val EXTRA_SMOKE_ADMIN_ROOT = "flagship.smokeAdminRoot"

        const val SMOKE_USERNAME = "smoketest"

        /** Resolve the config from a launch [intent], or null when the
         *  smoke-mode extra is absent (the normal production path). */
        fun from(intent: Intent?): SmokeModeConfig? {
            if (intent?.getBooleanExtra(EXTRA_SMOKE_MODE, false) != true) return null
            val tab = RootDestination.from(
                intent.getStringExtra(EXTRA_SMOKE_TAB)?.trim()?.lowercase() ?: "",
            ) ?: RootDestination.HOME
            return SmokeModeConfig(
                tab = tab,
                seedOps = intent.getBooleanExtra(EXTRA_SMOKE_OPS, false),
                seedTrustUntrusted = intent.getBooleanExtra(EXTRA_SMOKE_TRUST_UNTRUSTED, false),
                podsVariant = intent.getStringExtra(EXTRA_SMOKE_PODS)?.trim()?.lowercase(),
                seedAdminRoot = intent.getBooleanExtra(EXTRA_SMOKE_ADMIN_ROOT, false),
            )
        }
    }
}

object SmokeMode {
    /** Apply [config] to the app-scope state: seed DemoFixtures (skipping
     *  onboarding) + optionally a server-event / operations / trust state. The
     *  shell's initial tab is returned to the caller (it threads it into
     *  RootShell, mirroring iOS's `-smoke-tab`). Idempotent on isPaired: if the
     *  app is somehow already paired we leave the pods alone. */
    fun apply(
        config: SmokeModeConfig,
        appState: AppState,
        operations: ActiveOperationsCenter,
        trust: TrustCenter,
    ): RootDestination {
        if (!appState.isPaired.value) {
            val pods = when (config.podsVariant) {
                "awaiting-unlock" -> DemoFixtures.samplePodsWithAwaitingUnlock(SmokeModeConfig.SMOKE_USERNAME)
                "dead" -> DemoFixtures.samplePodsWithDeadServer(SmokeModeConfig.SMOKE_USERNAME)
                else -> DemoFixtures.samplePods(SmokeModeConfig.SMOKE_USERNAME)
            }
            appState.completeOnboarding(username = SmokeModeConfig.SMOKE_USERNAME, pods = pods)
        }

        // The gym drives an UNLOCKED shell (mirror of iOS's deterministic-unlock
        // smoke seam). Without this, the biometric-at-launch default leaves
        // isUnlocked=false, which correctly HIDES the operations sliver (it gates
        // on isUnlocked) — so a backendless gym run would never see it.
        appState.markUnlocked()

        // Seed ONE in-flight build so the global operations sliver renders
        // (mirror of iOS -smoke-ops). The default DemoFixtures pods are all
        // online/offline (no pending), so the sliver correctly stays hidden
        // without this.
        if (config.seedOps) {
            operations.upsertBuild(
                id = "build:gym-smoke",
                subject = "blog",
                onServer = "Home",
                target = DeepLink.VibeCodeChat(sessionId = "gym-smoke"),
            )
        }

        // Seed a positively-untrusted maintainer-trust verdict so the red
        // GlobalTrustBar renders (mirror of iOS -smoke-trust-untrusted). The
        // live path derives this from a real `.com` blessing check; the gym
        // injects a fixed, obviously-fake failure so the degraded-trust
        // experience is exercisable offline.
        // Treat this device as an admin (Slice D) — set BOTH ways so a prior
        // same-process launch's seed can never leak into an unflagged run.
        GymSeams.forceAdminRoot = config.seedAdminRoot

        if (config.seedTrustUntrusted) {
            trust.markUntrusted(
                listOf(
                    TrustFailure(
                        certClass = TrustCertClass.CONTROL,
                        certHash = "ab".repeat(32),
                        caPubkey = "cd".repeat(32),
                    ),
                ),
            )
        }

        return config.tab
    }
}
