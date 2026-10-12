// The update card and sheet while an order is pending: the card swaps its
// button for the "sent" line, the sheet opens on the post-send state, the box's
// report clears it, and after 30 minutes Send again / Forget it appear.

package com.flagshipserver.app.ui.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.flagshipserver.app.api.LastUpdate
import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.core.InMemoryPendingUpdateStore
import com.flagshipserver.app.core.PendingUpdate
import com.flagshipserver.app.ui.theme.FlagshipTheme
import com.flagshipserver.app.viewmodels.UpdateServerViewModel
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class UpdateServerCardComposeTest {
    @get:Rule val composeRule = createComposeRule()

    private val server = "home.alice.flagship.services"
    private val current = "1234567890abcdef1234567890abcdef12345678"
    private val target = "9f2c1ab3de4567890abcdef1234567890abcdef1"
    private val t0 = 1_760_000_000_000L
    private val minute = 60_000L

    private fun storeWithPending(tag: String? = "v1.2.0") = InMemoryPendingUpdateStore().apply {
        set(server, PendingUpdate(target, tag, current, t0))
    }

    @Test fun noPending_showsTheUpdateButton() {
        composeRule.setContent {
            FlagshipTheme {
                UpdateServerCard(server, current, pendingStore = InMemoryPendingUpdateStore(), clock = { t0 })
            }
        }
        composeRule.onNodeWithContentDescription("sd-update-server").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("sd-update-pending").assertDoesNotExist()
    }

    @Test fun pending_hidesTheButtonAndShowsTheSentLine() {
        composeRule.setContent {
            FlagshipTheme {
                UpdateServerCard(server, current, pendingStore = storeWithPending(), clock = { t0 + 3 * minute })
            }
        }
        composeRule.onNodeWithContentDescription("sd-update-server").assertDoesNotExist()
        composeRule.onNodeWithText("Update to v1.2.0 sent 3m ago", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("goes back on its own if the new version doesn't start", substring = true)
            .assertIsDisplayed()
        composeRule.onNodeWithText("Send again").assertDoesNotExist()
    }

    @Test fun pendingIsPerServer() {
        composeRule.setContent {
            FlagshipTheme {
                UpdateServerCard("work.alice.flagship.services", current, pendingStore = storeWithPending(), clock = { t0 })
            }
        }
        composeRule.onNodeWithContentDescription("sd-update-server").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("sd-update-pending").assertDoesNotExist()
    }

    @Test fun boxRunningTheTarget_clearsIt() {
        val store = storeWithPending()
        var commit by mutableStateOf(current)
        composeRule.setContent {
            FlagshipTheme { UpdateServerCard(server, commit, pendingStore = store, clock = { t0 + minute }) }
        }
        composeRule.onNodeWithContentDescription("sd-update-pending").assertIsDisplayed()
        commit = target
        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription("sd-update-pending").assertDoesNotExist()
        composeRule.onNodeWithContentDescription("sd-update-server").assertIsDisplayed()
        assertNull(store.get(server))
    }

    @Test fun matchingNewerVerdict_clearsItForEachOutcome() {
        val store = InMemoryPendingUpdateStore()
        var round by mutableStateOf(0)
        var last by mutableStateOf<LastUpdate?>(null)
        composeRule.setContent {
            FlagshipTheme {
                key(round) {
                    UpdateServerCard(server, current, lastUpdate = last, pendingStore = store, clock = { t0 + minute })
                }
            }
        }
        val summaries = mapOf(
            "applied" to "Last update: 9f2c1ab3 installed and running.",
            "rolled-back" to "The last update to 9f2c1ab3 didn't start cleanly, so the server went back to 12345678 on its own.",
            "refused" to "The server refused the last update: Flagship's maintainers haven't endorsed that release.",
        )
        for ((outcome, summary) in summaries) {
            store.set(server, PendingUpdate(target, "v1.2.0", current, t0))
            last = LastUpdate(outcome = "refused", at = t0 - 1, targetCommit = target)
            round++
            composeRule.waitForIdle()
            composeRule.onNodeWithContentDescription("sd-update-pending").assertIsDisplayed()
            last = LastUpdate(
                outcome = outcome,
                at = t0 + 30_000,
                targetCommit = target,
                previousCommit = current,
                reason = "unendorsed",
            )
            composeRule.waitForIdle()
            composeRule.onNodeWithContentDescription("sd-update-pending").assertDoesNotExist()
            composeRule.onNodeWithText(summary).assertIsDisplayed()
            assertNull(outcome, store.get(server))
        }
    }

    @Test fun staleOrder_offersSendAgainAndForget() {
        val store = storeWithPending(tag = null)
        composeRule.setContent {
            FlagshipTheme { UpdateServerCard(server, current, pendingStore = store, clock = { t0 + 31 * minute }) }
        }
        composeRule.onNodeWithText(PendingUpdate.STALE_COPY).assertIsDisplayed()
        composeRule.onNodeWithText("Update to 9f2c1ab3 sent", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("Send again").assertIsDisplayed()
        composeRule.onNodeWithText("Forget it").performClick()
        composeRule.onNodeWithContentDescription("sd-update-pending").assertDoesNotExist()
        composeRule.onNodeWithContentDescription("sd-update-server").assertIsDisplayed()
        assertNull(store.get(server))
    }

    @Test fun sheetOpensOnThePostSendState() {
        val vm = UpdateServerViewModel(
            username = "alice",
            serverFqdn = server,
            currentCommit = current,
            mailbox = MockSecretMailboxClient(),
            pendingStore = storeWithPending(),
            now = { t0 + minute },
        )
        composeRule.setContent {
            FlagshipTheme { UpdateServerSheet(server, current, vm, onDone = {}, nowMs = t0 + minute) }
        }
        composeRule.onNodeWithText("Update to v1.2.0 sent 1m ago", substring = true).assertIsDisplayed()
        composeRule.onNodeWithContentDescription("update-advanced").assertDoesNotExist()
        composeRule.onNodeWithContentDescription("update-latest-btn").assertDoesNotExist()
    }

    @Test fun sheetWithoutPending_showsThePicker() {
        val vm = UpdateServerViewModel(
            username = "alice",
            serverFqdn = server,
            currentCommit = current,
            mailbox = MockSecretMailboxClient(),
            pendingStore = InMemoryPendingUpdateStore(),
        )
        composeRule.setContent {
            FlagshipTheme { UpdateServerSheet(server, current, vm, onDone = {}) }
        }
        composeRule.onNodeWithContentDescription("update-advanced").assertIsDisplayed()
    }
}
