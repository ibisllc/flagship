// GYM Android — Settings → Organizations → Acme → Plan (docs/plans-and-backup-offer.md §3, §6), against the mock
// `.com` (MockOrgPlan, MockPaymentsClient) and a scripted Google Play (MockPlayBilling): the trial with its days left
// and the seat stepper, a lapsed org whose admin buys vouchers into the org wallet and is paid at once, a paid org, and
// a member seat that sees the plan but no balance.
// NO BACKEND.

package com.flagshipserver.app.gym

import org.junit.Assert.assertTrue
import org.junit.Test

class GymOrgPlanTest : GymBase() {

    private fun openOrgPlan(scenario: String) {
        launch(tab = "settings", adminRoot = true, orgPlan = scenario)
        waitUntilExists("settings-title", 20_000)
        tap("settings-open-organizations")
        tap("org-row-acme", 15_000)
        tap("org-open-plan", 15_000)
        waitUntilExists("org-plan-title", 15_000)
        waitUntilExists("org-plan-status", 20_000)
    }

    @Test
    fun trialShowsDaysLeftAndTheSeatStepper() {
        openOrgPlan("trial")
        eventually(20_000, "the trial's days left") { textOfTag("org-plan-status").contains("12") }
        waitUntilExists("org-plan-trial-note")
        eventually(20_000, "3 seats paid for, \$18 a month") { textOfTag("org-plan-seats").contains("3") }
        tap("org-plan-seats-more", 15_000)
        eventually(20_000, "4 seats, \$24 a month") { textOfTag("org-plan-seats").contains("4") }
        tap("org-plan-seats-less")
        eventually(20_000, "back to 3") { textOfTag("org-plan-seats").contains("3") }
        assertTrue(tagCount("org-plan-batch-note") == 1)
        gymShot("trial")
    }

    @Test
    fun aLapsedOrgBuysIntoItsOwnWallet() {
        openOrgPlan("lapsed")
        waitUntilExists("org-plan-lapsed", 15_000)
        waitUntilExists("org-plan-balance", 20_000)
        gymShot("lapsed")
        tap("org-plan-pack-30", 20_000)
        eventually(30_000, "the org's balance and the purchase notice") { tagCount("org-plan-notice") == 1 }
        // The trickle spends at once for a lapsed org: the plan is paid again.
        eventually(30_000, "the org is paid") { tagCount("org-plan-lapsed") == 0 }
        assertTrue(textOfTag("org-plan-balance").isNotEmpty())
        gymShot("bought")
    }

    @Test
    fun aPaidOrgShowsItsEndDate() {
        openOrgPlan("paid")
        eventually(20_000, "paid through a date") { tagCount("org-plan-trial-note") == 0 && tagCount("org-plan-lapsed") == 0 }
        eventually(20_000, "5 of 5 seats paid") { textOfTag("org-plan-seats-used").contains("5") }
        gymShot("paid")
    }

    @Test
    fun aMemberSeatSeesNoBalance() {
        openOrgPlan("trial-member")
        waitUntilExists("org-plan-read-only", 15_000)
        assertTrue(tagCount("org-plan-balance") == 0 && tagCount("org-plan-seats-more") == 0 && tagCount("org-plan-pack-30") == 0)
        gymShot("member")
    }
}
