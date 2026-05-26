// P7 — TierStatusViewModel state machine + the pct() derivation.
//
// Mirrors the canonical webapp `views/tier-status.js` pct() rules:
//   - missing used → 0
//   - missing quota → 0
//   - quota == 0 → 0
//   - else min(100, round(used / quota * 100))
// And asserts the load() Idle → Loading → Loaded (or Failed) progression
// over the MockScreensClient — including the overridable
// `tierStatusFixture` slot the screen exercises in dev/preview.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.TierStatusResponse
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class TierStatusViewModelTest {

    @Test fun usagePercent_missingValues_yieldZero() {
        assertEquals(0, TierStatusViewModel.usagePercent(null, 50.0))
        assertEquals(0, TierStatusViewModel.usagePercent(1.0, null))
        assertEquals(0, TierStatusViewModel.usagePercent(null, null))
    }

    @Test fun usagePercent_quotaZero_yieldsZero() {
        assertEquals(0, TierStatusViewModel.usagePercent(10.0, 0.0))
    }

    @Test fun usagePercent_normalRange_rounds() {
        assertEquals(0, TierStatusViewModel.usagePercent(0.0, 50.0))
        // 1.2 / 50 = 0.024 → 2.4% → round → 2
        assertEquals(2, TierStatusViewModel.usagePercent(1.2, 50.0))
        assertEquals(50, TierStatusViewModel.usagePercent(25.0, 50.0))
        // 49.9 / 50 → 99.8% → round → 100
        assertEquals(100, TierStatusViewModel.usagePercent(49.9, 50.0))
    }

    @Test fun usagePercent_overQuota_clampsTo100() {
        assertEquals(100, TierStatusViewModel.usagePercent(80.0, 50.0))
        assertEquals(100, TierStatusViewModel.usagePercent(10_000.0, 1.0))
    }

    @Test fun load_defaultFixture_rendersPromoTier() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = TierStatusViewModel(client, scope = backgroundScope)
        vm.load().join()
        val s = vm.state.first() as LoadingState.Loaded
        assertEquals("promo", s.value.tier)
        assertEquals(38L, s.value.llmCreditsRemainingDay)
        assertEquals(162L, s.value.llmCreditsRemainingTotal)
        assertEquals(1.2, s.value.dispatcherUsageGBmonth!!, 0.0001)
        assertEquals(50.0, s.value.dispatcherFreeQuotaGBmonth!!, 0.0001)
        assertTrue(s.value.customDomains.isEmpty())
        assertEquals(listOf("harry"), s.value.reservedNames)
    }

    @Test fun load_pinnedFixture_byokTierWithCustomDomains() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0).apply {
            tierStatusFixture = TierStatusResponse(
                tier = "byok",
                llmCreditsRemainingDay = null,
                llmCreditsRemainingTotal = null,
                dispatcherUsageGBmonth = 27.4,
                dispatcherFreeQuotaGBmonth = 50.0,
                customDomains = listOf("shop.example.com", "docs.example.com"),
                reservedNames = listOf("alice"),
            )
        }
        val vm = TierStatusViewModel(client, scope = backgroundScope)
        vm.load().join()
        val s = vm.state.first() as LoadingState.Loaded
        assertEquals("byok", s.value.tier)
        assertEquals(2, s.value.customDomains.size)
        // pct(27.4, 50.0) → 54.8 → round → 55
        assertEquals(
            55,
            TierStatusViewModel.usagePercent(
                s.value.dispatcherUsageGBmonth,
                s.value.dispatcherFreeQuotaGBmonth,
            ),
        )
    }

    @Test fun load_freeTier_renderableWithoutLlmOrDispatcher() = runTest {
        // Free-tier wire: no LLM credits, no dispatcher usage. The screen
        // must still render (Loaded, not Failed); the VM has no opinion on
        // what's present.
        val client = MockScreensClient(simulatedLatencyMs = 0).apply {
            tierStatusFixture = TierStatusResponse(
                tier = "free",
                llmCreditsRemainingDay = null,
                llmCreditsRemainingTotal = null,
                dispatcherUsageGBmonth = null,
                dispatcherFreeQuotaGBmonth = null,
                customDomains = emptyList(),
                reservedNames = emptyList(),
            )
        }
        val vm = TierStatusViewModel(client, scope = backgroundScope)
        vm.load().join()
        val s = vm.state.first() as LoadingState.Loaded
        assertEquals("free", s.value.tier)
        // pct(null, null) is 0 — the screen shows a 0% bar (or hides the
        // dispatcher card entirely; VM doesn't decide).
        assertEquals(
            0,
            TierStatusViewModel.usagePercent(
                s.value.dispatcherUsageGBmonth,
                s.value.dispatcherFreeQuotaGBmonth,
            ),
        )
    }

    @Test fun load_transportError_lands_inFailed() = runTest {
        val throwing = object : ScreensClient by MockScreensClient(simulatedLatencyMs = 0) {
            override suspend fun tierStatus(): TierStatusResponse =
                throw ScreensError.Http(503, "transport down")
        }
        val vm = TierStatusViewModel(throwing, scope = backgroundScope)
        vm.load().join()
        val s = vm.state.first()
        assertTrue("expected Failed, was $s", s is LoadingState.Failed)
        val msg = (s as LoadingState.Failed).message
        // ScreensError.Http renders as "HTTP $status: $body".
        assertTrue(msg, msg.contains("503") || msg.contains("transport down"))
    }
}
