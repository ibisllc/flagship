// The voucher link's sentences (the same English on iOS and the webapp; docs/anonymous-vouchers.md "Voucher links").

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings

object VoucherLinkCopy {
    /** The string resource of a refusal code (VoucherLinkPreview.Refused). */
    fun refusalRes(code: String): Int = when (code) {
        "newer" -> R.string.voucher_link_newer
        "already" -> R.string.voucher_link_already
        "spent" -> R.string.voucher_link_spent
        "invalid" -> R.string.voucher_link_invalid
        "unknown-key" -> R.string.voucher_link_unknown_key
        "full" -> R.string.voucher_link_full
        "not-admin" -> R.string.voucher_link_not_admin
        "signed-out" -> R.string.voucher_link_signed_out
        else -> R.string.voucher_link_damaged
    }

    fun refusal(code: String): String = FSStrings.get(refusalRes(code))

    /** "Add 3 vouchers ($3) to this account's wallet?" */
    fun question(plan: VoucherLinkPlan, cfg: PaymentsConfig): String =
        FSStrings.plural(R.plurals.voucher_link_question, plan.add.size, plan.add.size, PlanFormat.usd(plan.add.size.toLong(), cfg))

    /** The lines under the question: the part, then one per kind of voucher left out. */
    fun details(preview: VoucherLinkPreview.Ask): List<String> = buildList {
        val p = preview.plan
        if (preview.parts > 1) add(FSStrings.get(R.string.voucher_link_part, preview.part, preview.parts))
        if (p.duplicate > 0) add(FSStrings.get(R.string.voucher_link_skip_duplicate, p.duplicate))
        if (p.spent > 0) add(FSStrings.get(R.string.voucher_link_skip_spent, p.spent))
        if (p.invalid > 0) add(FSStrings.get(R.string.voucher_link_skip_invalid, p.invalid))
        if (p.unknownKey > 0) add(FSStrings.get(R.string.voucher_link_skip_unknown_key, p.unknownKey))
    }
}
