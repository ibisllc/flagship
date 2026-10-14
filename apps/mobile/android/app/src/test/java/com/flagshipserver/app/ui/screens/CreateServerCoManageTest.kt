// The create-server entry offers co-managing a server another account shares
// (docs/share-a-server.md): one button that opens the paste/scan screen.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.flagshipserver.app.ui.theme.FlagshipTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class CreateServerCoManageTest {
    @get:Rule val composeRule = createComposeRule()

    @Test fun coManageOpensTheShareAcceptScreen() {
        var opened = 0
        composeRule.setContent {
            FlagshipTheme {
                CreateServerScreen(
                    onDelivered = { _, _, _, _ -> },
                    onCancel = {},
                    onCoManage = { opened++ },
                )
            }
        }
        composeRule.onNodeWithText("Co-manage a server from another user").performScrollTo().assertIsDisplayed().performClick()
        assertEquals(1, opened)
    }
}
