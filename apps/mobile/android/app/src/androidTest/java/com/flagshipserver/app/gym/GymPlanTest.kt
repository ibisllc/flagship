// GYM Android — Settings → Plan and payments (docs/payments-privacy-and-rails.md "As built"), against the mock `.com`
// (MockPaymentsClient) and a scripted Google Play (MockPlayBilling): a pack bought through Play arrives in the balance,
// test credit arrives as a round amount, choosing Pro spends from the phone's wallet at once and the plan shows its time
// left, and a non-admin device sees it read only with no shop.
// NO BACKEND.

package com.flagshipserver.app.gym

import org.junit.Assert.assertTrue
import org.junit.Test

class GymPlanTest : GymBase() {

    private fun openPlan(admin: Boolean) {
        launch(tab = "settings", adminRoot = admin)
        waitUntilExists("settings-title", 20_000)
        tap("settings-open-plan")
        waitUntilExists("plan-title", 15_000)
    }

    @Test
    fun aPlayPackRaisesTheBalance() {
        openPlan(admin = true)
        waitUntilExists("plan-pack-10", 20_000)
        waitUntilExists("plan-pack-120")
        assertTrue(tagCount("plan-rail-card") == 0 && tagCount("plan-rail-monero") == 0)
        tap("plan-pack-30")
        eventually(30_000, "the balance shows \$30") { textOfTag("plan-balance").contains("30") }
        assertTrue(textOfTag("plan-shop-notice").contains("30"))
        gymShot("bought")
    }

    @Test
    fun testCreditStartsPro() {
        openPlan(admin = true)
        tap("plan-test-add", 20_000)
        eventually(20_000, "the balance shows \$30") { textOfTag("plan-balance").contains("30") }
        gymShot("balance")
        tap("plan-choose-pro")
        eventually(20_000, "Pro shows its time left") { textOfTag("plan-time-left").contains("left") }
        assertTrue(textOfTag("plan-current").contains("Pro"))
        gymShot("pro")
    }

    @Test
    fun nonAdminDeviceIsReadOnly() {
        openPlan(admin = false)
        waitUntilExists("plan-read-only", 15_000)
        assertTrue(tagCount("plan-pack-10") == 0)
        gymShot("read-only")
    }
}
