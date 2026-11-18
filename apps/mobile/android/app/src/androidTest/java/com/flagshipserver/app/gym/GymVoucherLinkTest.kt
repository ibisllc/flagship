// GYM Android — the "Load into Flagship" voucher link (docs/anonymous-vouchers.md "Voucher links"), against the mock
// `.com` (MockPaymentsClient signs the vouchers as the web shop would): a good link asks and adds to the balance, the
// same link again says the vouchers are already in the wallet, and a truncated link says it is damaged.
// NO BACKEND.

package com.flagshipserver.app.gym

import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.MainActivity
import com.flagshipserver.app.api.MockPaymentsClient
import com.flagshipserver.app.core.payments.VoucherLink
import org.junit.Assert.assertTrue
import org.junit.Test

class GymVoucherLinkTest : GymBase() {

    private fun open(link: String) {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        ctx.startActivity(Intent(ctx, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = android.net.Uri.parse(link)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        })
        composeRule.waitForIdle()
    }

    private fun start(): String {
        launch(tab = "settings", adminRoot = true)
        waitUntilExists("settings-title", 20_000)
        tap("settings-open-plan")
        waitUntilExists("plan-test-add", 20_000) // Plan's numbers (and the keys) are loaded
        val mock = MockPaymentsClient.last ?: error("no mock payments client")
        return VoucherLink.encodeLinks(mock.issueForGym(3), "flagshipserver.com").single()
    }

    @Test
    fun aLinkAddsOnceThenSaysAlready() {
        val link = start()
        open(link)
        waitUntilExists("voucher-link-question", 15_000)
        assertTrue(textOfTag("voucher-link-question").contains("3"))
        gymShot("ask")
        tap("voucher-link-add")
        waitGone("voucher-link-question", 15_000)
        eventually(20_000, "the balance shows \$3") { textOfTag("plan-balance").contains("3") }
        open(link)
        waitUntilExists("voucher-link-refused", 15_000)
        assertTrue(textOfTag("voucher-link-refused").contains("already"))
        gymShot("already")
        tap("voucher-link-close")
    }

    @Test
    fun aTruncatedLinkSaysDamaged() {
        val link = start()
        open(link.dropLast(40))
        waitUntilExists("voucher-link-refused", 15_000)
        assertTrue(textOfTag("voucher-link-refused").contains("incomplete"))
        gymShot("damaged")
    }
}
