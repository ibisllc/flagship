// The voucher link (docs/anonymous-vouchers.md "Voucher links"): https://<control host>/app/vouchers#v=…, the vouchers
// only in the fragment. Uri.parse needs Robolectric.

package com.flagshipserver.app.core

import android.net.Uri
import com.flagshipserver.app.core.payments.VoucherLink
import com.flagshipserver.app.core.payments.VoucherLinkParse
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.vectorsFile
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class VoucherLinkDeepLinkTest {
    private val single = Json.parseToJsonElement(vectorsFile("packages/protocol/test-vectors/voucher-link/vectors.json").readText())
        .jsonObject["links"]!!.jsonObject["single"]!!.jsonArray[0].jsonPrimitive.content

    @Test fun theAppLinkRoutesWithItsFragmentWhole() {
        val link = DeepLink.parse(Uri.parse(single))
        assertTrue(link is DeepLink.VoucherLink)
        val parsed = VoucherLink.parse((link as DeepLink.VoucherLink).rawLink)
        assertTrue(parsed is VoucherLinkParse.Ok && parsed.vouchers.size == 3)
        assertTrue(AppLink.resolve(Uri.parse(single.replace("/app/vouchers#", "/app/vouchers/#"))) is DeepLink.VoucherLink)
    }

    @Test fun aTruncatedLinkStillOpensTheSheetWhichSaysDamaged() {
        val link = DeepLink.parse(Uri.parse(single.dropLast(40))) as DeepLink.VoucherLink
        assertEquals(VoucherLinkParse.Failed("damaged"), VoucherLink.parse(link.rawLink))
    }

    @Test fun theVouchersStayOutOfLogs() {
        val link = DeepLink.parse(Uri.parse(single))!!
        assertEquals("VoucherLink", link.toString())
        assertFalse(link.toString().contains("v="))
    }
}
