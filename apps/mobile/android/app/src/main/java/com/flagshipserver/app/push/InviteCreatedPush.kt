// `invite-created`: `.com` tells every admin device that a device of the
// account that isn't an admin invited someone (at Member) to one of the apps.
// Content-free like the APNs alert; a tap opens the account activity, which
// lists the event.

package com.flagshipserver.app.push

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.core.Endpoints

object InviteCreatedPush {
    const val CATEGORY = "invite-created"
    const val TITLE = "Flagship"
    val BODY get() = FSStrings.get(R.string.a_device_on_your_account_invited)

    fun matches(data: Map<String, String>): Boolean =
        data["category"] == CATEGORY || data["kind"] == CATEGORY

    fun deepLink(): String = Endpoints.appRoute("account/activity")
}
