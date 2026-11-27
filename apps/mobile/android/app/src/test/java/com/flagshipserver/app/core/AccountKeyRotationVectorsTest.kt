package com.flagshipserver.app.core

import com.flagshipserver.app.core.pq.AssurancePolicy
import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqHybrid
import com.flagshipserver.app.core.pq.PqTrust
import com.flagshipserver.app.core.pq.PqTrustException
import com.flagshipserver.app.core.pq.PqVectors
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

// The Kotlin half of packages/protocol/test-vectors/account-key-rotation/vectors.json: every
// canonical form, every Ed25519 signature and both seals re-made byte for byte, and every hop,
// companion, delivery, plaintext, kept-device and derived-key case.
class AccountKeyRotationVectorsTest {
    private val v = PqVectors.load("packages/protocol/test-vectors/account-key-rotation/vectors.json")

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun JsonObject.o(k: String) = this[k]!!.jsonObject
    private fun JsonObject.l(k: String) = this[k]!!.jsonPrimitive.long
    private fun JsonObject.b(k: String) = PqVectors.h(s(k))
    private fun JsonObject.sOrNull(k: String) = this[k]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content
    private val keys get() = v.o("keys")

    private fun rotation(f: JsonObject) = AccountKeyRotation.Rotation(
        f.s("username"), f.l("fromEpoch"), f.l("toEpoch"), f.s("oldIrkPubHex"), f.s("newIrkPubHex"), f.s("newIrkScheme"),
        f.s("oldAidPubHex"), f.s("newAidPubHex"), f.s("adminRootPubHex"), f["removedDeviceIds"]!!.jsonArray.map { it.jsonPrimitive.content },
        f.s("keptDevicesDigestHex"), f.sOrNull("recoveryRecordDigestHex"), f.s("nonceHex"), f.l("issuedAt"),
    )
    private fun sigs(f: JsonObject) = AccountKeyRotation.Signatures(f.s("adminRootSignatureHex"), f.s("newIrkSignatureHex"), f.s("newAidSignatureHex"))
    private fun state(f: JsonObject) = AccountKeyRotation.KeyState(f.s("username"), f.l("epoch"), f.s("irkPubHex"), f.sOrNull("aidPubHex"), f.s("adminRootPubHex"))
    private fun delivery(f: JsonObject) = AccountKeyRotation.Delivery(f.s("username"), f.l("toEpoch"), f.s("deviceId"), f.s("devicePubHex"), f.s("rotationDigestHex"), f.s("sealedDigestHex"), f.l("issuedAt"))
    private fun dev(f: JsonObject) = AccountKeyRotation.KeptDevice(f.s("deviceId"), f.s("devicePubHex"))
    private fun kept(e: JsonElement) = e.jsonArray.map { dev(it.jsonObject) }
    private fun want(e: JsonObject) = if (e["ok"]!!.jsonPrimitive.boolean) "ok" else e.s("code")
    private fun code(f: () -> Unit): String = try {
        f(); "ok"
    } catch (e: AccountKeyRotation.Failure) {
        e.code
    } catch (e: PqTrustException) {
        e.code
    }
    private fun verified(name: JsonElement?): PqTrust.VerifiedBinding? {
        if (name == null || name is JsonNull) return null
        val w = v.o("bindings").o(name.jsonPrimitive.content)
        return PqTrust.verifyPqKeyBinding(w, PqTrust.Expectation(w.s("role"), w.s("subjectId"), w.s("ed25519PubHex"), now = v.l("now")))
    }
    private fun policy(p: JsonObject) = AssurancePolicy.legacyState(AssurancePolicy.Scope("installation", "home.alice.flagship.services"))
        .copy(profile = p.s("profile"), rollout = p.s("rollout"))
    private fun utf8(b: ByteArray) = String(b, Charsets.UTF_8)
    private val r get() = rotation(v.o("rotation").o("fields"))
    private fun seed(name: String) = keys.o(name).b("seedHex")

    @Test
    fun canonicalForms() {
        val rot = v.o("rotation")
        assertEquals(rot.s("canonical"), utf8(AccountKeyRotation.canonical(r)))
        assertEquals(rot.s("digestHex"), AccountKeyRotation.digestHex(r))
        val k = v.o("keptDevices")
        assertEquals(k.s("lines"), AccountKeyRotation.keptDevicesLines(kept(k["list"]!!)))
        assertEquals(k.s("digestHex"), AccountKeyRotation.keptDevicesDigestHex(kept(k["list"]!!)))
        assertEquals(v.o("pq").s("canonicalV2"), utf8(AccountKeyRotation.canonicalV2(r, v.o("pq").s("newIrkKeyIdHex"))))
        for (kind in listOf("xwing", "ed25519")) {
            val d = v.o("delivery").o(kind)
            assertEquals(d.s("canonical"), utf8(AccountKeyRotation.canonical(delivery(d.o("delivery")))))
        }
        val df = v.o("deviceKeyRotate").o("fields")
        assertEquals(v.o("deviceKeyRotate").s("canonical"), utf8(AccountKeyRotation.canonicalDeviceKeyRotate(df.s("username"), df.s("deviceId"), df.s("oldDevicePubHex"), df.s("newDevicePubHex"), df.l("issuedAt"))))
        val rf = v.o("deviceReceiveKey").o("fields")
        assertEquals(v.o("deviceReceiveKey").s("canonical"), utf8(AccountKeyRotation.canonicalDeviceReceiveKey(rf.s("username"), rf.s("deviceId"), rf.s("devicePubHex"), rf.s("xwingPubHex"), rf.l("issuedAt"))))
        assertEquals(keys.o("oldIrk").s("seedHex"), PqHex.encode(AccountKeyRotation.irkSeed(keys.b("oldUmkHex"), AccountKeyRotation.IrkScheme.WEB, 2)))
        assertEquals(keys.o("newIrk").s("seedHex"), PqHex.encode(AccountKeyRotation.irkSeed(keys.b("newUmkHex"), AccountKeyRotation.IrkScheme.IOS)))
        assertEquals(keys.o("newAid").s("seedHex"), PqHex.encode(AccountKeyRotation.aidSeed(keys.b("newUmkHex"))))
        assertThrows(IllegalArgumentException::class.java) { AccountKeyRotation.canonical(r.copy(username = "Alice")) }
        assertThrows(IllegalArgumentException::class.java) { AccountKeyRotation.canonical(r.copy(removedDeviceIds = listOf("d".repeat(32), "d".repeat(32)))) }
    }

    @Test
    fun signaturesResignByteForByte() {
        assertEquals(sigs(v.o("rotation").o("signatures")), AccountKeyRotation.sign(r, AccountKeyRotation.seedSigner(seed("adminRoot")), AccountKeyRotation.seedSigner(seed("newIrk")), AccountKeyRotation.seedSigner(seed("newAid"))))
        val dkr = v.o("deviceKeyRotate")
        val df = dkr.o("fields")
        val msg = AccountKeyRotation.canonicalDeviceKeyRotate(df.s("username"), df.s("deviceId"), df.s("oldDevicePubHex"), df.s("newDevicePubHex"), df.l("issuedAt"))
        assertEquals(dkr.s("newKeySignatureHex"), PqHex.encode(PqHybrid.ed25519Sign(keys.o("devices").o("eNew").b("seedHex"), msg)))
        assertEquals(dkr.s("adminRootSignatureHex"), PqHex.encode(PqHybrid.ed25519Sign(seed("adminRoot"), msg)))
        val admin = keys.o("adminRoot").s("pubHex")
        val other = keys.o("other").s("pubHex")
        val dk = { root: String, newPub: String ->
            AccountKeyRotation.verifyDeviceKeyRotate(df.s("username"), df.s("deviceId"), df.s("oldDevicePubHex"), newPub, df.l("issuedAt"), dkr.s("newKeySignatureHex"), dkr.s("adminRootSignatureHex"), root)
        }
        assertTrue(dk(admin, df.s("newDevicePubHex")))
        assertFalse(dk(other, df.s("newDevicePubHex")))
        assertFalse(dk(admin, df.s("oldDevicePubHex")))
        val drk = v.o("deviceReceiveKey")
        val rf = drk.o("fields")
        val rmsg = AccountKeyRotation.canonicalDeviceReceiveKey(rf.s("username"), rf.s("deviceId"), rf.s("devicePubHex"), rf.s("xwingPubHex"), rf.l("issuedAt"))
        assertEquals(drk.s("signatureHex"), PqHex.encode(PqHybrid.ed25519Sign(keys.o("devices").o("b").b("seedHex"), rmsg)))
        assertTrue(AccountKeyRotation.verifyDeviceReceiveKey(rf.s("username"), rf.s("deviceId"), rf.s("devicePubHex"), rf.s("xwingPubHex"), rf.l("issuedAt"), drk.s("signatureHex")))
        assertFalse(AccountKeyRotation.verifyDeviceReceiveKey(rf.s("username"), keys.o("deviceIds").s("c"), rf.s("devicePubHex"), rf.s("xwingPubHex"), rf.l("issuedAt"), drk.s("signatureHex")))

        val signerSeed = { n: String -> if (n == "newIrk") seed("newIrk") else seed("adminRoot") }
        val cgk = v.o("cgkRekey")
        val cf = cgk.o("fields")
        val cgkBytes = { AccountKeyRotation.canonicalCgkRekey(cf.s("serverDomain"), cf.l("toEpoch"), cf.s("sealedHex"), cf.l("issuedAt")) }
        assertEquals(cgk.s("canonical"), utf8(cgkBytes()))
        assertEquals(cgk.s("signatureHex"), PqHex.encode(PqHybrid.ed25519Sign(signerSeed(cgk.s("signer")), cgkBytes())))
        assertFalse(AccountKeyRotation.verifyRekey(cgkBytes, cgk.s("signatureHex"), other))
        val swk = v.o("swkRekey")
        val sf = swk.o("fields")
        val swkBytes = { AccountKeyRotation.canonicalSwkRekey(sf.s("serverDomain"), sf.l("toEpoch"), sf.s("oldSwkCommitHex"), sf.s("sealedHex"), sf.l("issuedAt")) }
        assertEquals(swk.s("canonical"), utf8(swkBytes()))
        assertEquals(swk.s("signatureHex"), PqHex.encode(PqHybrid.ed25519Sign(signerSeed(swk.s("signer")), swkBytes())))
        val luks = v.o("luksRekeyConfirm")
        val lf = luks.o("fields")
        val luksBytes = { AccountKeyRotation.canonicalLuksRekeyConfirm(lf.s("serverDomain"), lf.l("toEpoch"), lf.s("sealedKeyDigestHex"), lf.l("issuedAt")) }
        assertEquals(luks.s("canonical"), utf8(luksBytes()))
        assertTrue(AccountKeyRotation.verifyRekey(luksBytes, luks.s("signatureHex"), keys.o("newIrk").s("pubHex")))
        assertFalse(AccountKeyRotation.verifyRekey(luksBytes, luks.s("signatureHex"), admin))
        assertThrows(IllegalArgumentException::class.java) { AccountKeyRotation.canonicalCgkRekey("Home.example", 1, "ab", 1) }

        val root = keys.o("adminRoot")
        val secret = root.b("seedHex") + root.b("mldsaSeedHex")
        val nb = PqTrust.pqKeyBindingFromWire(v.o("bindings")["newIrk"])
        val c = AccountKeyRotation.signPq(r, nb) { p, m -> PqHybrid.hybridSign(secret, p, m, deterministic = true) }
        assertEquals(v.o("pqSignatures").o("adminRoot").s("signature"), c.o("signature").s("signature"))
    }

    @Test
    fun hopCases() {
        for (c in v["hopCases"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(c.s("name"), want(c.o("expect")), code { AccountKeyRotation.verify(rotation(c.o("rotation")), sigs(c.o("signatures")), state(c.o("state"))) })
        }
    }

    @Test
    fun pqCases() {
        for (c in v["pqCases"]!!.jsonArray.map { it.jsonObject }) {
            val sig = c.sOrNull("signature")
            val pq = if (sig == null) null else buildJsonObject {
                put("signature", v.o("pqSignatures").o(sig))
                put("newIrkBinding", v.o("bindings").o(c.s("binding")))
            }
            assertEquals(c.s("name"), want(c.o("expect")), code { AccountKeyRotation.verifyPq(r, pq, verified(c["adminRootBinding"]), policy(c.o("policy")), v.l("now")) })
        }
    }

    @Test
    fun sealsReproduceByteForByte() {
        val ids = keys.o("deviceIds")
        val recv = PqHybrid.hybridSealKeygen(keys.o("bReceive").b("seedHex"))
        assertEquals(keys.o("bReceive").s("pubHex"), PqHex.encode(recv.publicKey))
        val x = v.o("delivery").o("xwing")
        val sealed = AccountKeyRotation.sealXWing(r, ids.s("b"), x.b("plaintextHex"), recv.publicKey, x.l("issuedAt"), x.b("randomnessHex"))
        assertEquals(x.s("sealedHex"), PqHex.encode(sealed))
        val e = v.o("delivery").o("ed25519")
        val sealedC = AccountKeyRotation.sealEd25519(e.b("plaintextHex"), keys.o("devices").o("c").b("pubHex"), e.b("ephPrivHex"), e.b("nonceHex"))
        assertEquals(e.s("sealedHex"), PqHex.encode(sealedC))
        for ((d, id) in listOf(x to "b", e to "c")) {
            val (built, sig) = AccountKeyRotation.buildDelivery(r, ids.s(id), keys.o("devices").o(id).s("pubHex"), d.b("sealedHex"), d.o("delivery").l("issuedAt"), AccountKeyRotation.seedSigner(seed("adminRoot")))
            assertEquals(delivery(d.o("delivery")), built)
            assertEquals(d.s("signatureHex"), sig)
        }
    }

    @Test
    fun deliveryCases() {
        for (c in v["deliveryCases"]!!.jsonArray.map { it.jsonObject }) {
            var opened: AccountKeyRotation.Plaintext? = null
            val kind = AccountKeyRotation.SealKind.entries.first { it.wire == c.s("kind") }
            val got = code { opened = AccountKeyRotation.open(rotation(c.o("rotation")), delivery(c.o("delivery")), c.s("signatureHex"), c.b("sealedHex"), kind, dev(c.o("self")), c.b("secretHex")) }
            assertEquals(c.s("name"), want(c.o("expect")), got)
            if (got == "ok") assertEquals(keys.s("newUmkHex"), PqHex.encode(opened!!.umk))
        }
    }

    @Test
    fun plaintextKeptAndDerivedCases() {
        for (c in v["plaintextCases"]!!.jsonArray.map { it.jsonObject }) {
            var p: AccountKeyRotation.Plaintext? = null
            val got = code { p = AccountKeyRotation.decodePlaintext(c.b("hex")) }
            assertEquals(c.s("name"), want(c.o("expect")), got)
            if (got == "ok") {
                val e = c.o("expect")
                assertEquals(e.s("umkHex"), PqHex.encode(p!!.umk))
                assertEquals(e.s("irkScheme"), p!!.irkScheme.wire)
                assertEquals(e.sOrNull("adminRootSeedHex"), p!!.adminRootSeed?.let(PqHex::encode))
                assertEquals(c.s("hex"), PqHex.encode(AccountKeyRotation.encodePlaintext(p!!)))
            }
        }
        for (c in v["keptCases"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(c.s("name"), want(c.o("expect")), code { AccountKeyRotation.verifyKept(r, kept(c["kept"]!!), dev(c.o("self"))) })
        }
        for (c in v["derivedCases"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(c.s("name"), c["derived"]!!.jsonPrimitive.boolean, AccountKeyRotation.deviceKeyIsUmkDerived(c.b("umkHex"), c.s("username"), c.s("deviceId"), c.s("devicePubHex")))
        }
    }
}
