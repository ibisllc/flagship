// docs/account-key-rotation.md: the rotator's request verifies under the protocol port, kept devices open their
// delivery and nobody else does, the lane replays only from the pinned admin root, and a staged hop is promoted,
// sent again or dropped from what `.com` holds.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.AccountDirectoryAccountProfile
import com.flagshipserver.app.api.AccountDirectoryDevice
import com.flagshipserver.app.api.AccountDirectoryGrant
import com.flagshipserver.app.api.AccountDirectoryReceiveKey
import com.flagshipserver.app.api.AccountDirectoryResponse
import com.flagshipserver.app.api.AccountDirectorySelfProfile
import com.flagshipserver.app.api.AccountKeyBoxStatus
import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqHybrid
import com.flagshipserver.app.viewmodels.RotateAccountKeyViewModel
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class AccountKeyRotationFlowTest {
    private val user = "plucky-avocet"
    private val now = 1_800_000_000_000L
    private fun seed(b: Int) = ByteArray(32) { (b + it).toByte() }
    private fun pub(s: ByteArray) = PqHex.encode(PqHybrid.ed25519PublicKey(s))

    private val oldUmk = seed(1)
    private val newUmk = seed(2)
    private val root = seed(3)
    private val rootPub = pub(root)
    private val selfSeed = seed(10)
    private val phoneSeed = seed(11)
    private val removedSeed = seed(12)
    private val receiveSeed = seed(20)
    private val selfId = "a".repeat(32)
    private val phoneId = "b".repeat(32)
    private val webId = "c".repeat(32)
    private val removedId = "d".repeat(32)
    private val webPub = PqHex.encode(AccountMetadata.deriveAccountDevicePub(oldUmk, user, webId))
    private val oldIrkPub = pub(AccountKeyRotation.irkSeed(oldUmk, AccountKeyRotation.IrkScheme.ANDROID))
    private val oldAidPub = pub(AccountKeyRotation.aidSeed(oldUmk))

    private fun device(id: String, pub: String, at: Long) = AccountDirectoryDevice(user, id, pub, "android", at, at, null, id.take(4))
    private fun grant(id: String, pub: String, scopes: String, root: String) =
        AccountDirectoryGrant("g-$id", user, id, pub, scopes, 0, now + 86_400_000, "00".repeat(64), null, root)

    private fun directory(receive: Boolean = true): AccountDirectoryResponse {
        val rkPub = PqHex.encode(PqHybrid.hybridSealKeygen(receiveSeed).publicKey)
        val rkSig = PqHex.encode(PqHybrid.ed25519Sign(phoneSeed, AccountKeyRotation.canonicalDeviceReceiveKey(user, phoneId, pub(phoneSeed), rkPub, now)))
        val nameKey = AccountMetadata.deriveAccountProfileKey(oldUmk)
        val c = AccountMetadata.encrypt("Home", nameKey, AccountMetadataCoordinates(user, AccountMetadataRecordType.ACCOUNT_PROFILE, 3, 1))
        return AccountDirectoryResponse(
            accountId = user,
            accountProfile = AccountDirectoryAccountProfile(user, 3, 1, c.nonceHex, c.ciphertextHex, rootPub, "00".repeat(64), now, now),
            devices = listOf(
                device(selfId, pub(selfSeed), 1), device(phoneId, pub(phoneSeed), 2), device(webId, webPub, 3), device(removedId, pub(removedSeed), 4),
            ),
            grants = listOf(
                grant(selfId, pub(selfSeed), "[\"admin\",\"view-directory\"]", "admin-root"),
                grant(phoneId, pub(phoneSeed), "[\"browse\",\"view-directory\"]", "membership"),
                grant(removedId, pub(removedSeed), "[\"browse\",\"view-directory\"]", "membership"),
            ),
            receiveKeys = if (receive) listOf(AccountDirectoryReceiveKey(phoneId, pub(phoneSeed), rkPub, now, rkSig)) else emptyList(),
        )
    }

    private fun devices(d: AccountDirectoryResponse = directory()) = AccountKeyRotationFlow.devices(d, user, { it.deviceId.take(4) }, now)

    private fun built(
        d: AccountDirectoryResponse = directory(),
        authority: AccountKeyRotationFlow.Authority = AccountKeyRotationFlow.Authority(AccountKeyRotation.seedSigner(root), rootPub),
        strict: Boolean = false,
    ): Pair<AccountKeyRotationFlow.Plan, AccountKeyRotationFlow.Built> {
        val plan = AccountKeyRotationFlow.plan(devices(d), selfId, removedId, oldUmk, user, strict)
        return plan to AccountKeyRotationFlow.build(AccountKeyRotationFlow.Inputs(
            user, 0, oldIrkPub, oldUmk, newUmk, AccountKeyRotation.IrkScheme.ANDROID, plan, authority, strict, d, now, nonceHex = "e".repeat(32),
        ))
    }

    @Test fun theKeptSetDropsTheRemovedDeviceAndKeysFromTheOldUmk() {
        val plan = AccountKeyRotationFlow.plan(devices(), selfId, removedId, oldUmk, user, strict = false)
        assertEquals(listOf(selfId, phoneId), plan.kept.map { it.deviceId })
        assertEquals(listOf(webId to AccountKeyRotationFlow.ExcludeReason.DERIVED_KEY), plan.excluded.map { it.device.deviceId to it.reason })
        assertFalse(plan.removedHeldAdminKey)
    }

    @Test fun underStrictADeviceWithoutAReceiveKeyIsAddedAgain() {
        val plan = AccountKeyRotationFlow.plan(devices(directory(receive = false)), selfId, removedId, oldUmk, user, strict = true)
        assertEquals(listOf(selfId), plan.kept.map { it.deviceId })
        assertTrue(plan.excluded.any { it.device.deviceId == phoneId && it.reason == AccountKeyRotationFlow.ExcludeReason.NO_RECEIVE_KEY })
    }

    @Test fun aRotatorWithADerivedKeyMustMigrateFirst() {
        val d = directory().let { it.copy(devices = it.devices.map { x -> if (x.deviceId == selfId) x.copy(devicePubHex = PqHex.encode(AccountMetadata.deriveAccountDevicePub(oldUmk, user, selfId))) else x }) }
        try {
            AccountKeyRotationFlow.plan(devices(d), selfId, removedId, oldUmk, user, strict = false)
            fail("planned with a derived rotator key")
        } catch (e: AccountKeyRotationFlow.PlanException) {
            assertEquals("self-derived", e.code)
        }
    }

    @Test fun theHopVerifiesAndEachPartIsWhatDotComChecks() {
        val (plan, b) = built()
        AccountKeyRotation.verify(b.rotation, b.signatures, AccountKeyRotation.KeyState(user, 0, oldIrkPub, oldAidPub, rootPub))
        assertEquals(AccountKeyRotation.keptDevicesDigestHex(plan.keptDevices), b.rotation.keptDevicesDigestHex)
        assertEquals(listOf(removedId), b.rotation.removedDeviceIds)
        assertNull(b.rotation.recoveryRecordDigestHex)
        val deliveries = b.body["deliveries"] as JsonArray
        assertEquals(1, deliveries.size)
        assertEquals("xwing", ((deliveries[0] as JsonObject)["sealKind"] as JsonPrimitive).content)
        // The phone's grant was signed by the account key: a replacement by the admin root, same scopes.
        val g = (b.body["grants"] as JsonArray).single() as JsonObject
        val inner = g["grant"] as JsonObject
        assertEquals(phoneId, (inner["deviceId"] as JsonPrimitive).content)
        val scopes = (inner["scopes"] as JsonArray).map { (it as JsonPrimitive).content }
        assertEquals(listOf("browse", "view-directory"), scopes)
        assertTrue(DeviceCapabilityGrant.verify(
            PqHex.decode((g["signature"] as JsonPrimitive).content)!!, PqHex.decode(rootPub)!!, (inner["grantId"] as JsonPrimitive).content, user,
            phoneId, pub(phoneSeed), scopes, now, (inner["expiresAt"] as JsonPrimitive).content.toLong(),
        ))
        // The account's name, re-encrypted under the new key one revision on.
        val p = b.body["accountProfile"] as JsonObject
        assertEquals(4L, (p["revision"] as JsonPrimitive).content.toLong())
        assertEquals("Home", AccountMetadata.decrypt(
            AccountMetadataCiphertext((p["nonceHex"] as JsonPrimitive).content, (p["ciphertextHex"] as JsonPrimitive).content),
            AccountMetadata.deriveAccountProfileKey(newUmk), AccountMetadataCoordinates(user, AccountMetadataRecordType.ACCOUNT_PROFILE, 4, 1),
        ))
        assertNull(b.body["adminRootRotation"])
    }

    private fun lane(b: AccountKeyRotationFlow.Built, kept: List<AccountKeyRotation.KeptDevice>, before: List<JsonObject> = emptyList()) = JsonArray(before + buildJsonObject {
        put("kind", "account-key-rotation")
        put("rotation", AccountKeyRotationFlow.rotationJson(b.rotation))
        put("signatures", b.body["signatures"]!!)
        put("kept", JsonArray(kept.map { k -> buildJsonObject { put("deviceId", k.deviceId); put("devicePubHex", k.devicePubHex) } }))
    })

    private fun phoneLocal(pin: String = rootPub) = AccountKeyRotationFlow.Local(user, 0, oldIrkPub, oldAidPub, pin)

    @Test fun aKeptDeviceReplaysTheLaneAndOpensItsDelivery() {
        val (plan, b) = built()
        val replay = AccountKeyRotationFlow.replay(lane(b, plan.keptDevices), phoneLocal())
        val hop = replay.hops.single()
        val d = AccountKeyRotationFlow.parseDeliveries(buildJsonObject {
            put("deliveries", JsonArray((b.body["deliveries"] as JsonArray).map { e ->
                buildJsonObject { (e as JsonObject).forEach { (k, v) -> put(k, v) }; put("toEpoch", 1) }
            }))
        }).single()
        val plain = AccountKeyRotationFlow.open(hop, d, AccountKeyRotation.KeptDevice(phoneId, pub(phoneSeed)), receiveSeed)
        assertArrayEquals(newUmk, plain.umk)
        assertEquals(AccountKeyRotation.IrkScheme.ANDROID, plain.irkScheme)
        assertNull(plain.adminRootSeed)

        // The removed device is in no kept list, so the same delivery never opens for it.
        try {
            AccountKeyRotationFlow.open(hop, d, AccountKeyRotation.KeptDevice(removedId, pub(removedSeed)), receiveSeed)
            fail("opened for a device that was not kept")
        } catch (e: AccountKeyRotation.Failure) {
            assertEquals("not-kept", e.code)
        }
    }

    @Test fun aHopUnderAnotherRootOrTheOldAccountKeyIsNotReplayed() {
        val stranger = seed(40)
        val (plan, forged) = built(authority = AccountKeyRotationFlow.Authority(AccountKeyRotation.seedSigner(stranger), pub(stranger)))
        assertTrue(AccountKeyRotationFlow.replay(lane(forged, plan.keptDevices), phoneLocal()).hops.isEmpty())
        val irkSeed = AccountKeyRotation.irkSeed(oldUmk, AccountKeyRotation.IrkScheme.ANDROID)
        val (plan2, byIrk) = built(authority = AccountKeyRotationFlow.Authority(AccountKeyRotation.seedSigner(irkSeed), oldIrkPub))
        assertTrue(AccountKeyRotationFlow.replay(lane(byIrk, plan2.keptDevices), phoneLocal(pin = oldIrkPub)).hops.isEmpty())
        // A kept list that is not the one the hop signed is refused too.
        val (_, b) = built()
        assertTrue(AccountKeyRotationFlow.replay(lane(b, listOf(AccountKeyRotation.KeptDevice(removedId, pub(removedSeed)))), phoneLocal()).hops.isEmpty())
    }

    @Test fun anAdminRootRotationInTheLaneMovesThePinOnlyWhenTheOldRootSignedIt() {
        val newRoot = seed(50)
        val newRootPub = pub(newRoot)
        val ar = AdminRootRotation(user, rootPub, newRootPub, now)
        val event = buildJsonObject {
            put("kind", "admin-root-rotation"); put("seq", 1)
            put("rotation", buildJsonObject { put("username", user); put("oldAdminRootPubHex", rootPub); put("newAdminRootPubHex", newRootPub); put("issuedAt", now) })
            put("signatureHex", HexUtil.encode(AdminRootRotationClaim.sign(ar, com.google.crypto.tink.subtle.Ed25519Sign(root))))
        }
        val (plan, b) = built(authority = AccountKeyRotationFlow.Authority(AccountKeyRotation.seedSigner(newRoot), newRootPub, newRootSeed = newRoot))
        val replay = AccountKeyRotationFlow.replay(lane(b, plan.keptDevices, listOf(event)), phoneLocal())
        assertEquals(newRootPub, replay.adminRoot)
        assertEquals(1, replay.hops.size)
        // A rotation the pinned root never signed leaves the pin, and the hop under the new root, alone.
        val forged = buildJsonObject { event.forEach { (k, v) -> if (k != "signatureHex") put(k, v) }; put("signatureHex", "00".repeat(64)) }
        val r2 = AccountKeyRotationFlow.replay(lane(b, plan.keptDevices, listOf(forged)), phoneLocal())
        assertEquals(rootPub, r2.adminRoot)
        assertTrue(r2.hops.isEmpty())
    }

    @Test fun aKeptAdminDeviceGetsTheNewAdminRootWhenItChanges() {
        val newRoot = seed(50)
        val d = directory().let { it.copy(grants = it.grants.map { g -> if (g.deviceId == phoneId) g.copy(scopesJson = "[\"admin\",\"view-directory\"]", signerRoot = "admin-root") else g }) }
        val (plan, b) = built(d, AccountKeyRotationFlow.Authority(AccountKeyRotation.seedSigner(newRoot), pub(newRoot), newRootSeed = newRoot, rotationBody = buildJsonObject { put("x", 1) }))
        assertNotNull(b.body["adminRootRotation"])
        assertNull(b.body["grants"])
        val hop = AccountKeyRotationFlow.replay(lane(b, plan.keptDevices), phoneLocal(pin = pub(newRoot))).hops.single()
        val raw = (b.body["deliveries"] as JsonArray).single() as JsonObject
        val del = AccountKeyRotationFlow.parseDeliveries(buildJsonObject { put("deliveries", JsonArray(listOf(buildJsonObject { raw.forEach { (k, v) -> put(k, v) }; put("toEpoch", 1) }))) }).single()
        val plain = AccountKeyRotationFlow.open(hop, del, AccountKeyRotation.KeptDevice(phoneId, pub(phoneSeed)), receiveSeed)
        assertArrayEquals(newRoot, plain.adminRootSeed)
    }

    @Test fun withoutAReceiveKeyTheClassicalSealIsUsedOutsideStrictOnly() {
        val (_, b) = built(directory(receive = false))
        val raw = (b.body["deliveries"] as JsonArray).single() as JsonObject
        assertEquals("ed25519", (raw["sealKind"] as JsonPrimitive).content)
        try {
            built(directory(), strict = true)
            fail("built a strict hop without a hybrid companion")
        } catch (e: AccountKeyRotationFlow.PlanException) {
            assertEquals("strict-requires-hybrid", e.code)
        }
    }

    @Test fun aStagedHopIsPromotedSentAgainOrDropped() {
        val (_, b) = built()
        val r = b.rotation
        assertEquals(AccountKeyRotationFlow.PendingAction.PROMOTE, AccountKeyRotationFlow.decidePending(r, r.newIrkPubHex, now + 3_600_000))
        assertEquals(AccountKeyRotationFlow.PendingAction.RETRY, AccountKeyRotationFlow.decidePending(r, r.oldIrkPubHex, now + 60_000))
        assertEquals(AccountKeyRotationFlow.PendingAction.DROP, AccountKeyRotationFlow.decidePending(r, r.oldIrkPubHex, now + 16 * 60_000))
        assertEquals(AccountKeyRotationFlow.PendingAction.DROP, AccountKeyRotationFlow.decidePending(r, pub(seed(60)), now))
        // The staged body round-trips: what is parsed back is the hop that was signed.
        val parsed = AccountKeyRotationFlow.parseRotation(kotlinx.serialization.json.Json.parseToJsonElement(b.body.toString()).let { (it as JsonObject)["rotation"] })
        assertEquals(r, parsed)
    }

    @Test fun progressCountsDevicesBackInTheDirectoryAndServersOnTheEpoch() {
        val dir = AccountDirectoryResponse(user, selfProfiles = listOf(AccountDirectorySelfProfile(user, selfId, 1, 1, "00", "00", "00", "00", 0, 0)))
        val p = RotateAccountKeyViewModel.progressOf(listOf(selfId, phoneId), dir, 1, listOf(
            "home" to AccountKeyBoxStatus(trustedEpoch = 1, capability = AccountKeyRotationFlow.CAPABILITY),
            "cabin" to AccountKeyBoxStatus(trustedEpoch = 0, capability = AccountKeyRotationFlow.CAPABILITY, rekeyDue = listOf("luks")),
            "attic" to null,
        ))
        assertEquals(1, p.devicesUpdated); assertEquals(2, p.devicesTotal)
        assertEquals(1, p.serversOnNewKey); assertEquals(3, p.serversTotal)
        assertEquals(listOf("cabin", "attic"), p.waitingFor)
        assertEquals(listOf("cabin" to listOf("luks")), p.rekeyDue)
        assertFalse(p.complete)
    }
}
