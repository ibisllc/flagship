// ServiceAccessViewModel — loads the true mode, toggles open/restricted (an
// admin's signed service-access-mode/v2), mints invites across the 3 tiers
// (admin root on an admin device, the account device key elsewhere), lists
// (OWNER-SIGNED) + decrypts + folds groups, withdraws (the same signed revoke
// to .com and to the box), reads the account members and this device's own
// rank, changes ranks (app-rank/v1, Refuse for devices and co-managers), and
// finalizes a manual-approve acceptance. Pins the wire shapes + endpoints.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppAccountMember
import com.flagshipserver.app.api.AppMembersResponse
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.core.AppAccessOrders
import com.flagshipserver.app.core.AppMemberRole
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpResponse
import com.flagshipserver.app.core.InviteLink
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.ServerKeys
import com.flagshipserver.app.core.ServiceInvite
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServiceAccessViewModelTest {
    private val server = "home.alice.flagship.services"
    private val serviceRef = "alice--notes"
    private val username = "alice"

    private val umkSeed = ByteArray(32) { 0x0b }
    private val aidPub = ServerKeys.deriveAccountIdPub(umkSeed)
    private val household = ServerKeys.deriveHouseholdKey(umkSeed)

    /** Stands in for the admin root. */
    private val adminKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 5 })
    /** Stands in for this device's account device key; its pub is the mock box's "this device". */
    private val deviceKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 6 })
    private val thisDevice = "0123456789abcdef0123456789abcdef"
    private val otherDevice = "fedcba9876543210fedcba9876543210"
    private val selfPub = HexUtil.encode(deviceKp.publicKey)

    private fun makeVM(
        client: ServiceAccessClient,
        now: () -> Long = { 1700 },
        admin: Boolean = false,
        screens: com.flagshipserver.app.api.ScreensClient? = null,
        deviceNames: suspend () -> Map<String, String>? = { null },
        deviceId: String? = thisDevice,
    ) =
        ServiceAccessViewModel(
            serverDomain = server, serviceRef = serviceRef, username = username, client = client,
            aidSigner = { ServerKeys.deriveAccountId(umkSeed) },
            aidPubHex = { HexUtil.encode(aidPub) },
            householdKey = { household },
            now = now,
            screens = screens,
            isAdminDevice = { admin },
            adminSigner = { Ed25519Sign(adminKp.privateKey) },
            deviceId = { deviceId },
            deviceSigner = { if (deviceId == null) null else Ed25519Sign(deviceKp.privateKey) },
            ownDevicePubHex = { selfPub },
            deviceNames = deviceNames,
        )

    /** A mock box whose device book lists this device at [rank] (null = refused). */
    private fun boxWithSelf(rank: String?, tier: String = "member") = MockScreensClient(simulatedLatencyMs = 0).apply {
        membersFixture[serviceRef] = AppMembersResponse(
            serviceId = serviceRef, mode = "open", defaultRole = "member",
            accountMembers = listOf(
                AppAccountMember(kind = "device", deviceId = thisDevice, devicePub = selfPub, tier = tier, rank = rank, refused = rank == null),
                AppAccountMember(kind = "device", deviceId = otherDevice, devicePub = "b2".repeat(32), tier = "admin", rank = "master"),
                AppAccountMember(kind = "co-manager", shareId = MockScreensClient.CO_MANAGER_SHARE_ID, label = "Sam's family", rank = "manager"),
            ),
        )
    }

    private fun createBytes(env: JsonObject, maxN: Int? = null, exp: Long? = null): ByteArray {
        val req = env["request"]!!.jsonObject
        return ServiceInvite.canonicalCreate(
            req["inviteId"]!!.jsonPrimitive.content, aidPub, serviceRef,
            req["secretHash"]!!.jsonPrimitive.content, req["encryptedBundle"]!!.jsonPrimitive.content, 1700, maxN, exp,
        )
    }

    private fun sigOf(env: JsonObject) = HexUtil.decode(env["signature"]!!.jsonPrimitive.content)!!

    @Test fun load_readsTrueMode() = runTest {
        val t = FakeTransport(getJsonByUrl = mapOf("service-access" to """{"mode":"restricted","allowCount":3}"""))
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t))
        vm.load()
        assertTrue(vm.phase.value is ServiceAccessPhase.Ready)
        assertTrue(vm.restricted.value)
        assertEquals(3, vm.allowCount.value)
    }

    @Test fun setMode_onAnAdminDevice_signsTheV2OrderWithTheAdminRoot() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 }, admin = true)
        assertTrue(vm.setMode(restricted = true))
        assertTrue(vm.restricted.value)
        assertEquals("https://$server/api/service-access", t.lastPostUrl)
        val env = t.lastBodyJson()!!
        val req = env["request"]!!.jsonObject
        assertEquals(serviceRef, req["serviceRef"]!!.jsonPrimitive.content)
        assertEquals("restricted", req["mode"]!!.jsonPrimitive.content)
        assertNull("v2 names no server", req["serverId"])
        val bytes = AppAccessOrders.canonicalBytes(AppAccessOrders.Mode(serviceRef, "restricted", 1700))
        assertEquals("flagship/service-access-mode/v2|$serviceRef|restricted|1700", String(bytes))
        assertTrue(ServiceInvite.verify(sigOf(env), bytes, adminKp.publicKey))
    }

    @Test fun setMode_onANonAdminDevice_sendsNothing() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t))
        assertFalse(vm.setMode(restricted = true))
        assertFalse(vm.restricted.value)
        assertTrue(t.posts.isEmpty())
    }

    @Test fun addPerson_auto_sealsSignsWithTheDeviceKeyAndReturnsLinkWithAuthor() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 })
        val link = vm.addPerson("Alex", null, InviteTier.PERSONAL_AUTO)
        assertNotNull(link)
        assertTrue(link!!.startsWith("https://$server/invite#"))
        assertEquals(HexUtil.encode(aidPub), InviteLink.authorAidFromLink(link))
        assertNull(InviteLink.inviteIdFromLink(link))

        assertTrue(t.lastPostUrl!!.endsWith("/api/users/$username/service-invites"))
        val env = t.lastBodyJson()!!
        val req = env["request"]!!.jsonObject
        val inviteId = req["inviteId"]!!.jsonPrimitive.content
        assertTrue(Regex("^[0-9a-f]{64}$").matches(inviteId))
        assertEquals("the author is still the AID", HexUtil.encode(aidPub), req["authorAID"]!!.jsonPrimitive.content)
        assertEquals(thisDevice, req["deviceId"]!!.jsonPrimitive.content)
        assertEquals("auto", req["approvalMode"]!!.jsonPrimitive.content)
        assertNull(req["maxRedemptions"])
        assertTrue(ServiceInvite.verify(sigOf(env), createBytes(env), deviceKp.publicKey))
        assertFalse(ServiceInvite.verify(sigOf(env), createBytes(env), aidPub))
        assertEquals("Alex", ServiceInvite.openBundle(req["encryptedBundle"]!!.jsonPrimitive.content, household, inviteId).name)
    }

    @Test fun addPerson_manual_setsApprovalMode() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 })
        val link = vm.addPerson("Sam", null, InviteTier.PERSONAL_MANUAL)
        val req = t.lastBodyJson()!!["request"]!!.jsonObject
        assertEquals("manual", req["approvalMode"]!!.jsonPrimitive.content)
        assertNull(req["maxRedemptions"])
        assertEquals(req["inviteId"]!!.jsonPrimitive.content, InviteLink.inviteIdFromLink(link!!))
    }

    @Test fun addPerson_group_commitsMaxNAndExpiryInSignedBytes() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 })
        vm.addPerson("Chess club", null, InviteTier.GROUP, maxRedemptions = 10, expiresAt = 1700009999999L)
        val env = t.lastBodyJson()!!
        val req = env["request"]!!.jsonObject
        assertEquals("auto", req["approvalMode"]!!.jsonPrimitive.content)
        assertEquals(10, req["maxRedemptions"]!!.jsonPrimitive.content.toInt())
        assertEquals(1700009999999L, req["expiresAt"]!!.jsonPrimitive.content.toLong())
        assertTrue(ServiceInvite.verify(sigOf(env), createBytes(env, 10, 1700009999999L), deviceKp.publicKey))
    }

    @Test fun listPeople_isOwnerSignedAndDecrypts() = runTest {
        val id1 = "aa" + "0".repeat(62)
        val b1 = ServiceInvite.sealBundle(ServiceInvite.Bundle("Alex"), household, id1)
        val listJson = """{"invites":[
            {"inviteId":"$id1","serviceRef":"$serviceRef","encryptedBundle":"$b1","boundAID":"ff","boundAt":1,"createdAt":1}
        ]}"""
        val t = FakeTransport(getJsonByUrl = mapOf(
            "service-access" to """{"mode":"restricted","allowCount":1}""",
            "service-invites" to listJson,
        ))
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t))
        vm.load()
        assertEquals(1, vm.people.value.size)
        assertEquals("Alex", vm.people.value[0].name)
        assertTrue(vm.people.value[0].bound)
        val getUrl = t.lastGetUrl!!
        assertTrue(getUrl.contains("authorAID=${HexUtil.encode(aidPub)}"))
        assertTrue(getUrl.contains("scope=list"))
        assertTrue(getUrl.contains("sig="))
    }

    @Test fun listPeople_foldsGroupToOneRow() = runTest {
        val gid = "cc" + "0".repeat(62)
        val gb = ServiceInvite.sealBundle(ServiceInvite.Bundle("Chess club"), household, gid)
        val listJson = """{"invites":[
            {"inviteId":"$gid","serviceRef":"$serviceRef","encryptedBundle":"$gb","createdAt":1,
             "maxRedemptions":10,"redemptions":2,"boundAIDs":["aa11","bb22"],"approvalMode":"auto"}
        ]}"""
        val t = FakeTransport(getJsonByUrl = mapOf(
            "service-access" to """{"mode":"restricted","allowCount":2}""",
            "service-invites" to listJson,
        ))
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t))
        vm.load()
        assertEquals(1, vm.people.value.size)
        val g = vm.people.value[0]
        assertTrue(g.isGroup)
        assertEquals("Chess club", g.name)
        assertEquals(2, g.redemptions)
        assertEquals(10, g.maxRedemptions)
        assertEquals(listOf("aa11", "bb22"), g.memberAids)
    }

    @Test fun remove_onAnAdminDevice_sendsOneSignedRevokeToComAndTheBox() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 }, admin = true)
        assertTrue(vm.remove("deadbeef"))
        val com = t.bodyJsonFor("/api/users/$username/service-invites/revoke")!!
        assertEquals("deadbeef", com["request"]!!.jsonObject["inviteId"]!!.jsonPrimitive.content)
        assertTrue(ServiceInvite.verify(sigOf(com), ServiceInvite.canonicalRevoke("deadbeef", 1700), adminKp.publicKey))
        val box = t.bodyJsonFor("https://$server/api/service-access/invite-withdraw")!!
        assertEquals("deadbeef", box["revoke"]!!.jsonObject["inviteId"]!!.jsonPrimitive.content)
        assertEquals(1700L, box["revoke"]!!.jsonObject["issuedAt"]!!.jsonPrimitive.content.toLong())
        assertEquals(com["signature"], box["signature"])
        assertNull("no per-person prune any more", t.bodyJsonFor("/api/service-access/allow-remove"))
    }

    @Test fun remove_whenTheBoxCantBeReached_saysSoButComKeepsIt() = runTest {
        val t = FakeTransport(failPostFor = "invite-withdraw")
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), admin = true)
        assertFalse(vm.remove("deadbeef"))
        assertNotNull(t.bodyJsonFor("/service-invites/revoke"))
        assertEquals(
            "Removed them, but the server is still catching up. Try again in a moment.",
            (vm.phase.value as ServiceAccessPhase.Failed).message,
        )
    }

    @Test fun removeGroupMember_onAnAdminDevice_signsTheV2Removal() = runTest {
        val t = FakeTransport()
        val aid = "c4".repeat(32)
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 }, admin = true)
        assertTrue(vm.removeGroupMember(aid.uppercase()))
        assertNull(t.bodyJsonFor("/api/users/$username/service-invites/revoke"))
        val env = t.bodyJsonFor("/api/service-access/allow-remove")!!
        val req = env["request"]!!.jsonObject
        assertEquals(aid, req["aid"]!!.jsonPrimitive.content)
        assertNull(req["serverId"])
        val bytes = AppAccessOrders.canonicalBytes(AppAccessOrders.Remove(serviceRef, aid, 1700))
        assertTrue(ServiceInvite.verify(sigOf(env), bytes, adminKp.publicKey))
    }

    @Test fun removeGroupMember_onANonAdminDevice_sendsNothing() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t))
        assertFalse(vm.removeGroupMember("c4".repeat(32)))
        assertTrue(t.posts.isEmpty())
    }

    @Test fun finalizeAcceptance_submitsOnlyTheAcceptance() = runTest {
        val iid = "ea4ab8be66710610842cf6ef0d7e56bd91a4f03c7a5633fde4a66482cc292890"
        val accept: JsonObject = buildJsonObject {
            put("inviteId", JsonPrimitive(iid))
            put("serviceRef", JsonPrimitive(serviceRef))
            put("contactAID", JsonPrimitive("c".repeat(64)))
            put("acceptedAt", JsonPrimitive(1700L))
        }
        val reply = InviteLink.buildAcceptReply("home.alice.flagship.services", accept, "a".repeat(128))
        val t = FakeTransport(postBody = """{"bound":true,"serviceRef":"$serviceRef","boundAID":"${"c".repeat(64)}"}""")
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 })
        assertTrue(vm.finalizeAcceptance(reply))
        val submitted = t.bodyJsonFor("/api/service-access/accept")!!
        assertEquals(iid, submitted["accept"]!!.jsonObject["inviteId"]!!.jsonPrimitive.content)
        assertEquals("a".repeat(128), submitted["acceptSig"]!!.jsonPrimitive.content)
        assertNull(submitted["create"])
        assertNull(submitted["createSig"])
    }

    @Test fun finalizeAcceptance_malformed_failsBeforeNetwork() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t))
        assertFalse(vm.finalizeAcceptance("not-an-acceptance"))
        assertNull(t.bodyJsonFor("/api/service-access/accept"))
        assertTrue(vm.phase.value is ServiceAccessPhase.Failed)
    }

    @Test fun setMode_keepsTheMembersList() = runTest {
        val row = """{"invites":[{"inviteId":"inv-1","serviceRef":"$serviceRef","encryptedBundle":"00","boundAID":null}]}"""
        val t = FakeTransport(getJsonByUrl = mapOf("service-invites" to row, "service-access" to """{"mode":"open","allowCount":0}"""))
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), admin = true)
        vm.load()
        val before = vm.people.value
        assertEquals(1, before.size)
        assertTrue(vm.setMode(restricted = true))
        assertEquals(before, vm.people.value)
        assertTrue(vm.setMode(restricted = false))
        assertEquals("the toggle never changes the list", before, vm.people.value)
    }

    @Test fun ranks_newInviteSendsSignedAppRankUnlessDefault_andRefusalRollsBack() = runTest {
        val t = FakeTransport()
        val screens = MockScreensClient(simulatedLatencyMs = 0)
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1_700_000_000_000 }, admin = true, screens = screens)
        vm.load()
        assertNotNull(vm.members.value)
        vm.addPerson("Alex", null, role = AppMemberRole.MEMBER)
        assertTrue("the app's default role needs no order", screens.setAppRankCalls.isEmpty())
        vm.addPerson("Club", null, InviteTier.GROUP, 5, null, AppMemberRole.MANAGER)
        assertEquals(1, screens.setAppRankCalls.size)
        val (svc, req) = screens.setAppRankCalls[0]
        assertEquals(serviceRef, svc)
        assertEquals(serviceRef, req.order.serviceRef)
        assertTrue(req.order.target.startsWith("invite:"))
        assertEquals("manager", req.order.rank)
        val bytes = AppAccessOrders.canonicalBytes(AppAccessOrders.Rank(req.order.serviceRef, req.order.target, req.order.rank, req.order.issuedAt))
        assertTrue(String(bytes).startsWith("flagship/app-rank/v1|$serviceRef|invite:"))
        assertTrue(ServiceInvite.verify(HexUtil.decode(req.signature)!!, bytes, adminKp.publicKey))

        val p = AccessPerson(inviteId = "inv-9", name = "Sam", photo = null, bound = false)
        assertEquals(AppMemberRole.MEMBER, vm.roleFor(p))
        screens.memberRoleStatus = 403
        assertFalse(vm.setRole(AppMemberRole.MASTER, p))
        assertEquals(AppMemberRole.MEMBER, vm.roleFor(p))
        assertTrue(vm.phase.value is ServiceAccessPhase.Failed)
        assertTrue(vm.setRole(AppMemberRole.MASTER, p))
        assertEquals(AppMemberRole.MASTER, vm.roleFor(p))
    }

    @Test fun ranks_aStaleOrderIsSignedOnceMoreAndNewer() = runTest {
        val screens = MockScreensClient(simulatedLatencyMs = 0)
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1_700_000_000_000 }, admin = true, screens = screens)
        vm.load()
        screens.memberRoleStatus = 409
        assertTrue(vm.setRole(AppMemberRole.MANAGER, AccessPerson("inv-1", "Sam", null, false)))
        assertEquals(2, screens.setAppRankCalls.size)
        assertTrue(screens.setAppRankCalls[1].second.order.issuedAt > screens.setAppRankCalls[0].second.order.issuedAt)
    }

    // ── Account members (owner, 2026-10-15) ──────────────────────────────

    @Test fun accountMembers_adminRanksAndRefusesDevicesAndCoManagers() = runTest {
        val screens = boxWithSelf("manager")
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1_700_000_000_000 }, admin = true, screens = screens)
        vm.load()
        val members = vm.members.value!!.accountMembers
        assertEquals(3, members.size)
        val other = members[1]
        assertTrue(vm.setAccountRank(other, AppMemberRole.MANAGER))
        val (_, rank) = screens.setAppRankCalls.last()
        assertEquals("device:${"b2".repeat(32)}", rank.order.target)
        assertEquals("manager", rank.order.rank)
        val bytes = AppAccessOrders.canonicalBytes(AppAccessOrders.Rank(serviceRef, rank.order.target, "manager", rank.order.issuedAt))
        assertTrue(ServiceInvite.verify(HexUtil.decode(rank.signature)!!, bytes, adminKp.publicKey))
        assertEquals(AppMemberRole.MANAGER, vm.members.value!!.accountMembers[1].appRank)

        assertTrue(vm.setAccountRank(members[2], null))
        val (_, refuse) = screens.setAppRankCalls.last()
        assertEquals("share:${MockScreensClient.CO_MANAGER_SHARE_ID}", refuse.order.target)
        assertEquals("refused", refuse.order.rank)
        assertTrue(vm.members.value!!.accountMembers[2].isRefused)

        assertTrue("un-refuse = pick a rank", vm.setAccountRank(vm.members.value!!.accountMembers[2], AppMemberRole.MEMBER))
        assertEquals(AppMemberRole.MEMBER, vm.members.value!!.accountMembers[2].appRank)
    }

    @Test fun accountMembers_aNonAdminDeviceChangesNoRank() = runTest {
        val screens = boxWithSelf("master")
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), screens = screens)
        vm.load()
        assertFalse(vm.setAccountRank(vm.members.value!!.accountMembers[1], AppMemberRole.MEMBER))
        assertFalse(vm.setRole(AppMemberRole.MANAGER, AccessPerson("inv-9", "Sam", null, false)))
        assertTrue(screens.setAppRankCalls.isEmpty())
    }

    @Test fun accountMembers_namesResolveOnThePhone_andThisDeviceIsMarked() = runTest {
        val screens = boxWithSelf("manager", tier = "admin")
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), screens = screens, deviceNames = { mapOf(otherDevice to "Kitchen iPad") })
        vm.load()
        val (me, other, family) = vm.members.value!!.accountMembers
        assertEquals("Device 01234567", vm.accountMemberName(me))
        assertEquals("This device · Admin", vm.accountMemberDetail(me))
        assertEquals("Kitchen iPad", vm.accountMemberName(other))
        assertEquals("Admin", vm.accountMemberDetail(other))
        assertEquals("Sam's family", vm.accountMemberName(family))
        assertEquals("Co-manages this server", vm.accountMemberDetail(family))
        assertEquals(me, vm.selfMember)
    }

    @Test fun aManagerClassDevice_invitesAtMemberWithItsDeviceKey_andSendsNoRank() = runTest {
        for (rank in listOf("manager", "master")) {
            val t = FakeTransport()
            val screens = boxWithSelf(rank)
            val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), screens = screens)
            vm.load()
            assertTrue(vm.canInvite)
            assertNull(vm.inviteBlockedLine)
            assertNotNull(vm.addPerson("Club", null, InviteTier.GROUP, 5, null, AppMemberRole.MASTER))
            val env = t.bodyJsonFor("/service-invites")!!
            assertEquals(thisDevice, env["request"]!!.jsonObject["deviceId"]!!.jsonPrimitive.content)
            assertTrue(ServiceInvite.verify(sigOf(env), createBytes(env, 5, null), deviceKp.publicKey))
            assertTrue("a member invite needs no rank order", screens.setAppRankCalls.isEmpty())
        }
    }

    @Test fun aDeviceBelowManagerOrRefused_cantInvite_andSaysWhy() = runTest {
        for (rank in listOf("member", null)) {
            val t = FakeTransport()
            val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), screens = boxWithSelf(rank))
            vm.load()
            assertFalse(vm.canInvite)
            assertEquals("Only an admin can let you invite people to this app.", vm.inviteBlockedLine)
            assertNull(vm.addPerson("Alex", null))
            assertNull(t.bodyJsonFor("/service-invites"))
            assertFalse(vm.canRemove(AccessPerson("x", "X", null, false, creatorTier = "member", creatorDeviceId = thisDevice)))
        }
    }

    @Test fun aDeviceTheBoxDoesntList_cantInvite_butAnAdminAlwaysCan() = runTest {
        val screens = MockScreensClient(simulatedLatencyMs = 0)
        val t = FakeTransport()
        val member = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), screens = screens)
        member.load()
        assertNull(member.selfMember)
        assertFalse(member.canInvite)
        val admin = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), screens = screens, admin = true)
        admin.load()
        assertTrue(admin.canInvite)
    }

    @Test fun withdraw_byTheCreatingDevice_signsWithItsDeviceKeyToComAndTheBox() = runTest {
        val sealed = ServiceInvite.sealBundle(ServiceInvite.Bundle("Jo"), household, "jo")
        val list = """{"invites":[{"inviteId":"jo","serviceRef":"$serviceRef","encryptedBundle":"$sealed","creatorTier":"member","creatorDeviceId":"$thisDevice"}]}"""
        val t = FakeTransport(getJsonByUrl = mapOf("service-invites" to list))
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 }, screens = boxWithSelf("manager"))
        vm.load()
        assertTrue(vm.canRemove(vm.people.value.single()))
        assertTrue(vm.remove("jo"))
        val com = t.bodyJsonFor("/service-invites/revoke")!!
        assertTrue(ServiceInvite.verify(sigOf(com), ServiceInvite.canonicalRevoke("jo", 1700), deviceKp.publicKey))
        val box = t.bodyJsonFor("/api/service-access/invite-withdraw")!!
        assertEquals(com["signature"], box["signature"])
    }

    @Test fun withdraw_ofAnotherDevicesInvite_isRefusedOnANonAdminDevice() = runTest {
        val sealed = ServiceInvite.sealBundle(ServiceInvite.Bundle("Jo"), household, "jo")
        val list = """{"invites":[{"inviteId":"jo","serviceRef":"$serviceRef","encryptedBundle":"$sealed","creatorTier":"member","creatorDeviceId":"$otherDevice"}]}"""
        val t = FakeTransport(getJsonByUrl = mapOf("service-invites" to list))
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), screens = boxWithSelf("manager"))
        vm.load()
        assertFalse(vm.remove("jo"))
        assertFalse(vm.remove("not-listed"))
        assertTrue(t.posts.isEmpty())
    }

    @Test fun create_onAnAdminDevice_signsWithTheAdminRootAndNamesTheDevice() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), admin = true)
        assertNotNull(vm.addPerson("Alex", null))
        val env = t.bodyJsonFor("/service-invites")!!
        assertTrue(ServiceInvite.verify(sigOf(env), createBytes(env), adminKp.publicKey))
        assertFalse(ServiceInvite.verify(sigOf(env), createBytes(env), deviceKp.publicKey))
        val req = env["request"]!!.jsonObject
        assertEquals(thisDevice, req["deviceId"]!!.jsonPrimitive.content)
        assertEquals(HexUtil.encode(aidPub), req["authorAID"]!!.jsonPrimitive.content)
    }

    @Test fun create_withoutADeviceId_onAnAdmin_omitsIt_andANonAdminCant() = runTest {
        val t = FakeTransport()
        val admin = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), admin = true, deviceId = "")
        assertNotNull(admin.addPerson("Alex", null))
        assertNull(t.bodyJsonFor("/service-invites")!!["request"]!!.jsonObject["deviceId"])

        val t2 = FakeTransport()
        val member = makeVM(ServiceAccessClient(boxTransport = t2, comTransport = t2), deviceId = null)
        assertNull("no device key to sign with", member.addPerson("Alex", null))
        assertTrue(t2.posts.isEmpty())
    }

    @Test fun revokeIsOffered_toAdminsOnEveryRow_andOtherwiseOnlyOnOwnInvites() = runTest {
        val t = FakeTransport()
        val mine = AccessPerson("a", "A", null, false, creatorTier = "member", creatorDeviceId = thisDevice)
        val mineUpper = mine.copy(creatorDeviceId = thisDevice.uppercase())
        val othersMember = AccessPerson("b", "B", null, false, creatorTier = "member", creatorDeviceId = otherDevice)
        val mineAdmin = AccessPerson("c", "C", null, false, creatorTier = "admin", creatorDeviceId = thisDevice)
        val old = AccessPerson("d", "D", null, false)
        val admin = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), admin = true)
        for (p in listOf(mine, othersMember, mineAdmin, old)) assertTrue(admin.canRemove(p))
        val member = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t))
        assertTrue(member.canRemove(mine))
        assertTrue(member.canRemove(mineUpper))
        assertFalse(member.canRemove(othersMember))
        assertFalse(member.canRemove(mineAdmin))
        assertFalse(member.canRemove(old))
    }

    @Test fun revokeIsOffered_onAnInviteTheBoxSaysThisDeviceKeySigned() = runTest {
        val sealed = ServiceInvite.sealBundle(ServiceInvite.Bundle("Jo"), household, "jo")
        val list = """{"invites":[{"inviteId":"jo","serviceRef":"$serviceRef","encryptedBundle":"$sealed","creatorTier":"member"}]}"""
        val t = FakeTransport(getJsonByUrl = mapOf("service-invites" to list))
        val screens = boxWithSelf("manager")
        screens.membersFixture[serviceRef] = screens.membersFixture[serviceRef]!!.copy(
            invites = listOf(com.flagshipserver.app.api.AppMemberInviteRole("jo", "member", tier = "member", creatorPub = selfPub)),
        )
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), screens = screens, deviceId = otherDevice)
        vm.load()
        val jo = vm.people.value.single()
        assertTrue(vm.canRemove(jo))
        assertEquals("Invited by this device", vm.invitedBy(jo))
    }

    @Test fun invitedBy_resolvesNamesOnThePhone_withItsFallbacks() = runTest {
        val sealed = { id: String -> ServiceInvite.sealBundle(ServiceInvite.Bundle("P-$id"), household, id) }
        val listJson = """{"invites":[
            {"inviteId":"own","serviceRef":"$serviceRef","encryptedBundle":"${sealed("own")}","creatorTier":"member","creatorDeviceId":"$thisDevice"},
            {"inviteId":"named","serviceRef":"$serviceRef","encryptedBundle":"${sealed("named")}","creatorTier":"admin","creatorDeviceId":"$otherDevice"},
            {"inviteId":"gone","serviceRef":"$serviceRef","encryptedBundle":"${sealed("gone")}","creatorTier":"member","creatorDeviceId":"${"9".repeat(32)}"},
            {"inviteId":"anon","serviceRef":"$serviceRef","encryptedBundle":"${sealed("anon")}","creatorTier":"admin","creatorDeviceId":null},
            {"inviteId":"old","serviceRef":"$serviceRef","encryptedBundle":"${sealed("old")}"}
        ]}"""
        val t = FakeTransport(getJsonByUrl = mapOf(
            "service-access" to """{"mode":"open","allowCount":0}""",
            "service-invites" to listJson,
        ))
        var lookups = 0
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), deviceNames = {
            lookups++
            mapOf(otherDevice to "Kitchen iPad")
        })
        vm.load()
        val by = vm.people.value.associate { it.inviteId to vm.invitedBy(it) }
        assertEquals("Invited by this device", by["own"])
        assertEquals("Invited by Kitchen iPad", by["named"])
        assertEquals("Invited by another device", by["gone"])
        assertEquals("Invited by another device", by["anon"])
        assertNull(by["old"])
        assertEquals("member", vm.people.value.first { it.inviteId == "own" }.creatorTier)
        vm.refreshPeople()
        assertEquals("the directory is read once per screen", 1, lookups)
    }

    @Test fun invitedBy_withoutDirectoryAccess_fallsBack_andOwnRowsNeverLookUp() = runTest {
        val sealed = ServiceInvite.sealBundle(ServiceInvite.Bundle("X"), household, "x")
        val ownOnly = """{"invites":[{"inviteId":"x","serviceRef":"$serviceRef","encryptedBundle":"$sealed","creatorTier":"member","creatorDeviceId":"$thisDevice"}]}"""
        var lookups = 0
        val t1 = FakeTransport(getJsonByUrl = mapOf("service-invites" to ownOnly))
        val vm1 = makeVM(ServiceAccessClient(boxTransport = t1, comTransport = t1), deviceNames = { lookups++; emptyMap() })
        vm1.refreshPeople()
        assertEquals(0, lookups)

        val other = ownOnly.replace(thisDevice, otherDevice)
        val t2 = FakeTransport(getJsonByUrl = mapOf("service-invites" to other))
        val vm2 = makeVM(ServiceAccessClient(boxTransport = t2, comTransport = t2), deviceNames = { throw RuntimeException("403") })
        vm2.refreshPeople()
        assertEquals("Invited by another device", vm2.invitedBy(vm2.people.value.single()))
    }

    @Test fun boxMembers_carryTheInviteTier() {
        val json = Json { ignoreUnknownKeys = true }
        val r = json.decodeFromString(
            AppMembersResponse.serializer(),
            """{"serviceId":"$serviceRef","mode":"open","defaultRole":"member",
               "members":[{"aid":"aa","role":"member","grants":[{"inviteId":"i1","role":"member","tier":"member"}]}],
               "invites":[{"inviteId":"i1","role":"member","set":false,"tier":"member"},{"inviteId":"i2","role":"manager","set":true,"tier":null}]}""",
        )
        assertEquals("member", r.members.single().grants.single().tier)
        assertEquals("member", r.inviteTier("i1"))
        assertNull(r.inviteTier("i2"))
        assertNull(r.inviteTier("missing"))
        assertTrue(r.accountMembers.isEmpty())
    }

    @Test fun setMode_failureSurfaces() = runTest {
        val t = FakeTransport(failPost = RuntimeException("403"))
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), admin = true)
        assertFalse(vm.setMode(restricted = true))
        assertTrue(vm.phase.value is ServiceAccessPhase.Failed)
    }

    /** Records POSTs (url+body); serves canned GET JSON keyed by a url substring;
     *  records the last GET url; can fail POSTs. */
    class FakeTransport(
        private val getJsonByUrl: Map<String, String> = emptyMap(),
        private val failPost: Throwable? = null,
        private val failPostFor: String? = null,
        private val postStatus: Int = 200,
        private val postBody: String = "{}",
    ) : JsonHttpTransport {
        override val json: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }
        var lastPostUrl: String? = null
        var lastPostBody: String? = null
        var lastGetUrl: String? = null
        val posts = mutableListOf<Pair<String, String?>>()
        fun lastBodyJson(): JsonObject? = lastPostBody?.let { json.parseToJsonElement(it).jsonObject }
        fun bodyJsonFor(urlPart: String): JsonObject? =
            posts.firstOrNull { it.first.contains(urlPart) }?.second?.let { json.parseToJsonElement(it).jsonObject }

        override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>): HttpResponse {
            if (method == "GET") {
                lastGetUrl = url
                val canned = getJsonByUrl.entries.firstOrNull { url.contains(it.key) }?.value ?: "{}"
                return HttpResponse(200, canned.toByteArray(), emptyMap())
            }
            failPost?.let { throw it }
            failPostFor?.let { if (url.contains(it)) throw RuntimeException("403 $it") }
            lastPostUrl = url
            lastPostBody = body?.let { String(it, Charsets.UTF_8) }
            posts.add(url to lastPostBody)
            return HttpResponse(postStatus, postBody.toByteArray(), emptyMap())
        }
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
    }
}
