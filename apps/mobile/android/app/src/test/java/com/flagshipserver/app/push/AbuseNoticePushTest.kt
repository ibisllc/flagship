package com.flagshipserver.app.push

import org.junit.Assert.assertEquals
import org.junit.Test

class AbuseNoticePushTest {
    @Test fun showsTheFixedContentFreeText() {
        assertEquals(
            "There is a notice about your Flagship account. Open Flagship to read it.",
            AccountNoticePush.body(mapOf("category" to "abuse-notice", "kind" to "abuse-notice")),
        )
    }

    @Test fun postsOnTheAccountNoticesChannel() {
        assertEquals(NotificationChannels.ACCOUNT_NOTICES, NotificationChannels.forPush("abuse-notice", "abuse-notice"))
        assertEquals("flagship.account-notices", NotificationChannels.ACCOUNT_NOTICES.id)
    }
}
