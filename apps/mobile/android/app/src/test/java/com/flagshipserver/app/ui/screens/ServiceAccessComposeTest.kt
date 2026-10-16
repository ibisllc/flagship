// Access control (docs/service-access-gating.md, "Open mode + members"): the
// Open to all | Members only toggle, the members list with each person's and
// group's rank (Master wears a crown), the members-only confirmation. With
// ACCESS_SHOT_DIR set, also writes PNGs of each state.

package com.flagshipserver.app.ui.screens

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.flagshipserver.app.api.AppAccountMember
import com.flagshipserver.app.api.AppMember
import com.flagshipserver.app.api.AppMemberGrant
import com.flagshipserver.app.api.AppMemberInviteRole
import com.flagshipserver.app.api.AppMembersResponse
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.ServerKeys
import com.flagshipserver.app.core.ServiceInvite
import com.flagshipserver.app.ui.theme.FlagshipTheme
import com.flagshipserver.app.viewmodels.ServiceAccessViewModel
import com.flagshipserver.app.viewmodels.ServiceAccessViewModelTest.FakeTransport
import com.google.crypto.tink.subtle.Ed25519Sign
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [33], qualifiers = "w411dp-h1600dp-xxhdpi")
class ServiceAccessComposeTest {
    @get:Rule val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val server = "home.alice.flagship.services"
    private val ref = "bright-maple--plants"
    private val umkSeed = ByteArray(32) { 0x0b }
    private val household = ServerKeys.deriveHouseholdKey(umkSeed)
    private val sam = "5a".repeat(32)
    private val priya = "7b".repeat(32)
    private val guest = "3c".repeat(32)

    private val thisDevice = "0123456789abcdef0123456789abcdef"
    private val kitchen = "fedcba9876543210fedcba9876543210"

    private fun row(id: String, name: String, bound: String? = null, group: List<String>? = null, max: Int? = null, manual: Boolean = false, tier: String? = null, by: String? = null): String {
        val sealed = ServiceInvite.sealBundle(ServiceInvite.Bundle(name), household, id)
        val parts = mutableListOf(
            "\"inviteId\":\"$id\"", "\"serviceRef\":\"$ref\"", "\"encryptedBundle\":\"$sealed\"",
            "\"boundAID\":${bound?.let { "\"$it\"" } ?: "null"}",
            "\"approvalMode\":\"${if (manual) "manual" else "auto"}\"",
        )
        if (group != null) parts += "\"boundAIDs\":[${group.joinToString(",") { "\"$it\"" }}]"
        if (max != null) parts += listOf("\"maxRedemptions\":$max", "\"redemptions\":${group?.size ?: 0}")
        if (tier != null) parts += "\"creatorTier\":\"$tier\""
        if (by != null) parts += "\"creatorDeviceId\":\"$by\""
        return "{${parts.joinToString(",")}}"
    }

    private val selfPub = "a1".repeat(32)
    private lateinit var screens: MockScreensClient

    private fun vm(admin: Boolean = true, selfRank: String? = "manager"): Pair<ServiceAccessViewModel, FakeTransport> {
        val list = "{\"invites\":[" + listOf(
            row("sam", "Sam", bound = sam, tier = "admin", by = kitchen),
            row("priya", "Priya", bound = priya, manual = true),
            row("family", "Family", group = listOf(sam, guest), max = 5),
            row("jordan", "Jordan", tier = "member", by = thisDevice),
        ).joinToString(",") + "]}"
        val t = FakeTransport(getJsonByUrl = mapOf("service-invites" to list, "service-access" to """{"mode":"open","allowCount":3}"""))
        screens = MockScreensClient(simulatedLatencyMs = 0)
        screens.membersFixture[ref] = AppMembersResponse(
            serviceId = ref, mode = "open", defaultRole = "member",
            descriptions = mapOf(
                "member" to "Adds and edits their own plants",
                "manager" to "Also waters and edits anyone's plants",
                "master" to "Also changes the garden's settings",
            ),
            accountMembers = listOf(
                AppAccountMember(
                    kind = "device", deviceId = thisDevice, devicePub = selfPub, tier = if (admin) "admin" else "member",
                    rank = if (admin) "master" else selfRank, refused = !admin && selfRank == null,
                ),
                AppAccountMember(kind = "device", deviceId = kitchen, devicePub = "b2".repeat(32), tier = "admin", rank = "master"),
                AppAccountMember(kind = "co-manager", shareId = "0f1e2d3c4b5a69788796a5b4c3d2e1f0", label = "Sam's family", rank = "manager"),
            ),
            members = listOf(
                AppMember(sam, "manager", listOf(AppMemberGrant("sam", "manager"), AppMemberGrant("family", "member"))),
                AppMember(priya, "master", listOf(AppMemberGrant("priya", "master"))),
                AppMember(guest, "member", listOf(AppMemberGrant("family", "member"))),
            ),
            invites = listOf(
                AppMemberInviteRole("sam", "manager", true), AppMemberInviteRole("priya", "master", true),
                AppMemberInviteRole("family", "member", true), AppMemberInviteRole("jordan", "member", false),
            ),
        )
        val irk = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 9 })
        return ServiceAccessViewModel(
            serverDomain = server, serviceRef = ref, username = "alice",
            client = ServiceAccessClient(boxTransport = t, comTransport = t),
            aidSigner = { ServerKeys.deriveAccountId(umkSeed) },
            aidPubHex = { HexUtil.encode(ServerKeys.deriveAccountIdPub(umkSeed)) },
            householdKey = { household },
            screens = screens,
            isAdminDevice = { admin },
            adminSigner = { Ed25519Sign(irk.privateKey) },
            deviceId = { thisDevice },
            deviceSigner = { Ed25519Sign(irk.privateKey) },
            ownDevicePubHex = { selfPub },
            deviceNames = { mapOf(kitchen to "Kitchen iPad", thisDevice to "Pixel 9") },
        ) to t
    }

    private fun shot(name: String) {
        val dir = System.getenv("ACCESS_SHOT_DIR")?.takeIf { it.isNotEmpty() } ?: return
        composeRule.waitForIdle()
        // Draw the window in software (Robolectric's native graphics), whole height.
        val root = composeRule.activity.window.decorView
        val bmp = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
        root.draw(android.graphics.Canvas(bmp))
        File(dir).mkdirs()
        File(dir, "$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun membersShowInBothModes_withRanks_andMembersOnlyAsksFirst() {
        val (vm, t) = vm()
        composeRule.setContent {
            FlagshipTheme {
                androidx.compose.foundation.layout.Box(
                    androidx.compose.ui.Modifier.background(com.flagshipserver.app.ui.theme.FS.colors.bg),
                ) {
                    ServiceAccessContent(vm, ref, "Plants", onShare = {}, onCopy = {}, pickPhoto = null)
                }
            }
        }
        composeRule.waitUntil(10_000) { vm.members.value != null && vm.people.value.size == 4 }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Open to all").assertIsDisplayed()
        composeRule.onNodeWithText("Members (4)").assertIsDisplayed()
        composeRule.onNodeWithText("also in Family: Member").assertIsDisplayed()
        composeRule.onNodeWithTag("service-access-role-priya").assertIsDisplayed()
        composeRule.onNodeWithText("2 of 5 joined").assertIsDisplayed()
        composeRule.onNodeWithText("Invited by Kitchen iPad").assertIsDisplayed()
        composeRule.onNodeWithText("Invited by this device").assertIsDisplayed()
        composeRule.onNodeWithTag("service-access-role-sam").assertIsEnabled()
        for (id in listOf("sam", "priya", "family", "jordan")) {
            composeRule.onNodeWithTag("service-access-remove-$id").assertExists()
        }
        composeRule.onNodeWithText("Account members (3)").assertIsDisplayed()
        composeRule.onNodeWithText("Pixel 9").assertIsDisplayed()
        composeRule.onNodeWithText("This device · Admin").assertIsDisplayed()
        composeRule.onNodeWithText("Kitchen iPad").assertIsDisplayed()
        composeRule.onNodeWithText("Sam's family").assertIsDisplayed()
        composeRule.onNodeWithText("Co-manages this server").assertIsDisplayed()
        composeRule.onAllNodesWithTag("service-access-cant-invite").assertCountEquals(0)
        composeRule.onAllNodesWithTag("service-access-mode-admin-only").assertCountEquals(0)
        shot("access-android-open")

        val share = "service-access-account-rank-share-0f1e2d3c4b5a69788796a5b4c3d2e1f0"
        composeRule.onNodeWithTag(share).assertIsEnabled().performClick()
        composeRule.onNodeWithTag("$share-master").assertIsDisplayed()
        composeRule.onNodeWithText("Refuse").assertIsDisplayed()
        shot("access-android-account-rank-menu")
        composeRule.onNodeWithTag("$share-refuse").performClick()
        composeRule.waitUntil(10_000) { vm.members.value?.accountMembers?.get(2)?.isRefused == true }
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(share).assertContentDescriptionEquals("Rank: Refused")
        assertTrue(screens.setAppRankCalls.last().second.order.rank == "refused")

        composeRule.onNodeWithTag("service-access-mode-members").performClick()
        composeRule.onNodeWithText("Only these 3 people will be able to open it.").assertIsDisplayed()
        shot("access-android-confirm")
        composeRule.onNodeWithTag("service-access-members-only-confirm").performClick()
        composeRule.waitUntil(10_000) { vm.restricted.value }
        composeRule.waitForIdle()
        assertTrue(t.lastPostUrl!!.endsWith("/api/service-access"))
        // The members list never changes with the mode.
        composeRule.onNodeWithText("Members (4)").assertIsDisplayed()
        composeRule.onNodeWithText("Only members and you can open it. Anyone else is asked to sign in.").assertIsDisplayed()
        shot("access-android-members-only")

        composeRule.onNodeWithTag("service-access-add-group").performClick()
        composeRule.onNodeWithTag("service-access-new-role").performClick()
        composeRule.onNodeWithText("Also changes the garden's settings").assertIsDisplayed()
        shot("access-android-rank-menu")
    }

    @Test fun nonAdminDevice_invitesAtMemberOnly_seesRanksReadOnly_andRevokesOnlyItsOwn() {
        val (vm, t) = vm(admin = false)
        composeRule.setContent {
            FlagshipTheme { ServiceAccessContent(vm, ref, "Plants", onShare = {}, onCopy = {}, pickPhoto = null) }
        }
        composeRule.waitUntil(10_000) { vm.members.value != null && vm.people.value.size == 4 }
        composeRule.waitForIdle()
        composeRule.onNodeWithTag("service-access-mode-members").assertIsNotEnabled()
        composeRule.onNodeWithText("Only an admin device can change who may open this app.").assertIsDisplayed()
        composeRule.onNodeWithText("This device").assertIsDisplayed()
        composeRule.onNodeWithTag("service-access-account-rank-device-$thisDevice")
            .assertIsNotEnabled()
            .assertContentDescriptionEquals("Rank: Manager")
        composeRule.onNodeWithTag("service-access-account-rank-device-$kitchen").assertIsNotEnabled()
        composeRule.onAllNodesWithTag("service-access-cant-invite").assertCountEquals(0)
        composeRule.onNodeWithTag("service-access-role-sam").assertIsNotEnabled()
        composeRule.onNodeWithTag("service-access-role-sam").performClick()
        composeRule.onAllNodesWithText("Also changes the garden's settings").assertCountEquals(0)
        composeRule.onNodeWithText("Invited by Kitchen iPad").assertIsDisplayed()
        composeRule.onNodeWithTag("service-access-remove-jordan").assertExists()
        for (id in listOf("sam", "priya", "family")) {
            composeRule.onNodeWithTag("service-access-remove-$id").assertDoesNotExist()
        }
        shot("access-android-non-admin")

        composeRule.onNodeWithTag("service-access-add-person").performClick()
        composeRule.onNodeWithText("Only an admin device can give a higher rank").assertIsDisplayed()
        composeRule.onNodeWithTag("service-access-new-role")
            .assertIsNotEnabled()
            .assertContentDescriptionEquals("Rank: Member")
        shot("access-android-rank-locked")

        composeRule.onNodeWithTag("service-access-remove-jordan").performClick()
        composeRule.onNodeWithTag("service-access-remove-confirm").performClick()
        composeRule.waitUntil(10_000) { t.posts.any { it.first.endsWith("/service-invites/revoke") } }
        composeRule.waitUntil(10_000) { t.posts.any { it.first.endsWith("/api/service-access/invite-withdraw") } }
    }

    private fun belowManager(rank: String?) {
        val (vm, _) = vm(admin = false, selfRank = rank)
        composeRule.setContent {
            FlagshipTheme { ServiceAccessContent(vm, ref, "Plants", onShare = {}, onCopy = {}, pickPhoto = null) }
        }
        composeRule.waitUntil(10_000) { vm.members.value != null && vm.people.value.size == 4 }
        composeRule.waitForIdle()
        composeRule.onNodeWithTag("service-access-cant-invite").assertIsDisplayed()
        composeRule.onNodeWithText("Only an admin can let you invite people to this app.").assertIsDisplayed()
        composeRule.onAllNodesWithTag("service-access-add-person").assertCountEquals(0)
        composeRule.onAllNodesWithTag("service-access-add-group").assertCountEquals(0)
        composeRule.onAllNodesWithTag("service-access-remove-jordan").assertCountEquals(0)
        composeRule.onNodeWithTag("service-access-account-rank-device-$thisDevice")
            .assertContentDescriptionEquals(if (rank == null) "Rank: Refused" else "Rank: Member")
        shot(if (rank == null) "access-android-refused" else "access-android-member-rank")
    }

    @Test fun aMemberRankDevice_seesWhyInsteadOfAdd_andRevokesNothing() = belowManager("member")

    @Test fun aRefusedDevice_seesWhyInsteadOfAdd_andRevokesNothing() = belowManager(null)
}
