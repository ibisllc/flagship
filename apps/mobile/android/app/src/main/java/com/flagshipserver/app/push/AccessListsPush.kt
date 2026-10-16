// `access-lists` (feat/marketplace): Pro ended, so the apps that kept a
// separate access list on each server went back to one. The app's lead server
// sends it through `.com`, naming no app; content-free like the APNs alert. A
// tap opens the account activity (the box records `access.lists.merged`).

package com.flagshipserver.app.push

import com.flagshipserver.app.core.Endpoints

object AccessListsPush {
    const val CATEGORY = "access-lists"
    const val TITLE = "Flagship"
    const val BODY = "Pro ended, so your apps use one access list on all your servers again."

    fun matches(data: Map<String, String>): Boolean =
        data["category"] == CATEGORY || data["kind"] == CATEGORY

    fun deepLink(): String = Endpoints.appRoute("account/activity")
}
