// GYM Android — Settings → Plan and payments (docs/payments-privacy-and-rails.md "As built"), against the mock `.com`
// (MockPaymentsClient): the shop's rails are placeholders, test credit arrives as a round amount, choosing Pro spends
// from the phone's wallet at once and the plan shows its time left, and a non-admin device sees it read only.
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
    fun railsArePlaceholdersAndTestCreditStartsPro() {
        openPlan(admin = true)
        waitUntilExists("plan-rail-play")
        waitUntilExists("plan-rail-card")
        waitUntilExists("plan-rail-monero")
        waitText("Not on sale yet")
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
        gymShot("read-only")
    }
}
