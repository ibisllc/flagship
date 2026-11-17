// Voucher files: the Kotlin twin of the file half of packages/protocol/src/voucherBatch.ts (vectors:
// test-vectors/org-plan `voucherFile`). A company that bought an invoiced batch on the web hands out files; an org
// admin imports one into the org wallet here. A file is a bearer secret and names nobody.
//
//   {kind: "flagship-vouchers", v: 1, vouchers: [...]}   canonical JSON, vouchers sorted by (k, n)

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.WebEnvelopes
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

object VoucherFiles {
    const val KIND = "flagship-vouchers"
    const val MAX = 5000

    fun text(vouchers: List<Voucher>): String {
        require(vouchers.size in 1..MAX) { "voucher file: 1 to $MAX vouchers" }
        val seen = HashSet<String>()
        val out = vouchers.map { v -> Vouchers.parse(v.toJson()) ?: throw IllegalArgumentException("voucher file: malformed voucher") }
            .filter { seen.add(it.nullifier) }
            .sortedWith { a, b -> if (a.k == b.k) a.n.compareTo(b.n) else a.k.compareTo(b.k) }
        return WebEnvelopes.canonicalJson(JsonObject(mapOf("kind" to JsonPrimitive(KIND), "v" to JsonPrimitive(1), "vouchers" to JsonArray(out.map { it.toJson() }))))
    }

    /** The vouchers of an untrusted file (shape only: the redeem call checks each signature), or null. */
    fun parse(text: String): List<Voucher>? {
        if (text.length > MAX * 600) return null
        return parse(VoiciJs.parseJson(text))
    }

    fun parse(v: JsonElement?): List<Voucher>? {
        val o = VoiciJs.obj(v) ?: return null
        if (o.size != 3 || VoiciJs.str(o["kind"]) != KIND || !VoiciJs.isNumEq(o["v"], 1)) return null
        val list = VoiciJs.arr(o["vouchers"])?.takeIf { it.size in 1..MAX } ?: return null
        return list.map { Vouchers.parse(it) ?: return null }
    }

    /** Files of [perFile] vouchers each (the last holds the rest). */
    fun split(vouchers: List<Voucher>, perFile: Int): List<String> {
        require(perFile >= 1) { "voucher file: bad size" }
        return vouchers.chunked(perFile).map(::text)
    }

    /** The first 8 hex of the SHA-256 of a file's text, shown so two people can tell files apart. */
    fun id(text: String): String = VoiciJs.hex(VoiciJs.sha256(VoiciJs.utf8(text))).take(8)
}
