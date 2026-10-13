// Access control (docs/service-access-gating.md, "Open mode + members"): the
// Open to all | Members only toggle, the members list with each person's and
// group's rank (Master wears a crown), the members-only confirmation. With
// ACCESS_SHOT_DIR set, also writes PNGs of each state.

package com.flagshipserver.app.ui.screens

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.ui.test.assertIsDisplayed
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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

    private fun row(id: String, name: String, bound: String? = null, group: List<String>? = null, max: Int? = null, manual: Boolean = false): String {
        val sealed = ServiceInvite.sealBundle(ServiceInvite.Bundle(name), household, id)
        val parts = mutableListOf(
            "\"inviteId\":\"$id\"", "\"serviceRef\":\"$ref\"", "\"encryptedBundle\":\"$sealed\"",
            "\"boundAID\":${bound?.let { "\"$it\"" } ?: "null"}",
            "\"approvalMode\":\"${if (manual) "manual" else "auto"}\"",
        )
        if (group != null) parts += "\"boundAIDs\":[${group.joinToString(",") { "\"$it\"" }}]"
        if (max != null) parts += listOf("\"maxRedemptions\":$max", "\"redemptions\":${group?.size ?: 0}")
        return "{${parts.joinToString(",")}}"
    }

    private fun vm(): Pair<ServiceAccessViewModel, FakeTransport> {
        val list = "{\"invites\":[" + listOf(
            row("sam", "Sam", bound = sam),
            row("priya", "Priya", bound = priya, manual = true),
            row("family", "Family", group = listOf(sam, guest), max = 5),
            row("jordan", "Jordan"),
        ).joinToString(",") + "]}"
        val t = FakeTransport(getJsonByUrl = mapOf("service-invites" to list, "service-access" to """{"mode":"open","allowCount":3}"""))
        val screens = MockScreensClient(simulatedLatencyMs = 0)
        screens.membersFixture[ref] = AppMembersResponse(
            serviceId = ref, mode = "open", defaultRole = "member",
            descriptions = mapOf(
                "member" to "Adds and edits their own plants",
                "manager" to "Also waters and edits anyone's plants",
                "master" to "Also changes the garden's settings",
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
            irkSigner = { Ed25519Sign(irk.privateKey) },
            aidSigner = { ServerKeys.deriveAccountId(umkSeed) },
            aidPubHex = { HexUtil.encode(ServerKeys.deriveAccountIdPub(umkSeed)) },
            householdKey = { household },
            screens = screens,
            roleSigner = { Ed25519Sign(irk.privateKey) },
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
        composeRule.onNodeWithText("MEMBERS (4)").assertIsDisplayed()
        composeRule.onNodeWithText("also in Family: Member").assertIsDisplayed()
        composeRule.onNodeWithTag("service-access-role-priya").assertIsDisplayed()
        composeRule.onNodeWithText("2 of 5 joined").assertIsDisplayed()
        shot("access-android-open")

        composeRule.onNodeWithTag("service-access-mode-members").performClick()
        composeRule.onNodeWithText("Only these 3 people will be able to open it.").assertIsDisplayed()
        shot("access-android-confirm")
        composeRule.onNodeWithTag("service-access-members-only-confirm").performClick()
        composeRule.waitUntil(10_000) { vm.restricted.value }
        composeRule.waitForIdle()
        assertTrue(t.lastPostUrl!!.endsWith("/api/service-access"))
        // The members list never changes with the mode.
        composeRule.onNodeWithText("MEMBERS (4)").assertIsDisplayed()
        composeRule.onNodeWithText("Only members and you can open it. Anyone else is asked to sign in.").assertIsDisplayed()
        shot("access-android-members-only")

        composeRule.onNodeWithTag("service-access-add-group").performClick()
        composeRule.onNodeWithTag("service-access-new-role").performClick()
        composeRule.onNodeWithText("Also changes the garden's settings").assertIsDisplayed()
        shot("access-android-rank-menu")
    }
}
