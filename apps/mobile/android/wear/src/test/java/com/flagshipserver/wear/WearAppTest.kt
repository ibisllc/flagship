// The Wear OS app's screens, pressed (Robolectric: the phone emulator can't
// install the watch build, which shares the phone's applicationId). A box
// waiting for its phone opens its Approve page; Approve asks the phone (a fake
// here) and says Approved, or the phone's own refusal. The server list, an
// install in flight and recent events show from the phone's context.

package com.flagshipserver.wear

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.companion.ApproveReply
import com.flagshipserver.companion.PendingApproval
import com.flagshipserver.companion.PodStatusSnapshot
import com.flagshipserver.companion.WatchContext
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class WearAppTest {
    @get:Rule val compose = createComposeRule()

    private val cabin = PendingApproval(requestId = "req-1", serverFqdn = "cabin.harry.flagship.services", serverName = "Cabin", requestedAt = 1)

    @Before
    fun seed() {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val context = WatchContext(
            status = PodStatusSnapshot.EMPTY,
            pendingApprovals = listOf(cabin),
        )
        WatchStore.write(ctx, context.encode())
    }

    @Test
    fun approveAsksThePhoneAndSaysApproved() {
        val asked = mutableListOf<PendingApproval>()
        compose.setContent {
            androidx.wear.compose.material.MaterialTheme {
                WearApp(sync = {}, approve = { _, a -> asked += a; ApproveReply(a.serverFqdn, ok = true) })
            }
        }
        compose.onNodeWithTag("watch-approval-cabin.harry.flagship.services").performClick()
        compose.onNodeWithTag("watch-approve").performClick()
        compose.waitUntil(5_000) { asked.isNotEmpty() }
        compose.onNodeWithTag("watch-approved").assertExists()
        assertEquals(listOf(cabin), asked)
    }

    @Test
    fun aRefusalShowsThePhonesMessage() {
        compose.setContent {
            androidx.wear.compose.material.MaterialTheme {
                WearApp(sync = {}, approve = { _, a -> ApproveReply(a.serverFqdn, ok = false, errorMessage = "Unlock Flagship on your phone first.") })
            }
        }
        compose.onNodeWithTag("watch-approval-cabin.harry.flagship.services").performClick()
        compose.onNodeWithTag("watch-approve").performClick()
        compose.waitUntil(5_000) {
            compose.onAllNodes(androidx.compose.ui.test.hasText("Unlock Flagship on your phone first.")).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("watch-approve").assertExists()
    }

    @Test
    fun withNothingFromThePhoneItSaysWhereToLook() {
        WatchStore.write(ApplicationProvider.getApplicationContext(), WatchContext.EMPTY.encode())
        compose.setContent {
            androidx.wear.compose.material.MaterialTheme { WearApp(sync = {}) }
        }
        compose.onNodeWithText("Open Flagship on your phone to see your servers here.").assertExists()
    }
}
