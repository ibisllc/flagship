// `access-lists` (feat/marketplace): Pro ended, so the apps that kept a
// separate access list on each server went back to one. The app's lead server
// sends it through `.com`, naming no app; content-free like the APNs alert. A
// tap opens the account activity (the box records `access.lists.merged`).

package com.flagshipserver.app.push

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.core.Endpoints

object AccessListsPush {
    const val CATEGORY = "access-lists"
    const val TITLE = "Flagship"
    val BODY get() = FSStrings.get(R.string.pro_ended_so_your_apps_use)

    fun matches(data: Map<String, String>): Boolean =
        data["category"] == CATEGORY || data["kind"] == CATEGORY

    fun deepLink(): String = Endpoints.appRoute("account/activity")
}
