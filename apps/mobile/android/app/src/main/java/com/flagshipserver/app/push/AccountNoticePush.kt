// Account notices that carry only their category: a box's relay-trust SOS
// (`cert-alert`, from the box through /api/push/relay) and a newly registered
// server (`server-registered`, from `.com`). Nothing in them names the server;
// a tap opens Home, which shows which one. Same text as the APNs alert and
// the webapp's service worker.

package com.flagshipserver.app.push

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R

object AccountNoticePush {
    const val TITLE = "Flagship"

    private val TEXT get() = mapOf(
        "cert-alert" to FSStrings.get(R.string.one_of_your_servers_needs_your),
        "server-registered" to FSStrings.get(R.string.a_new_server_was_added_to),
    )

    /** The notice's text, or null for any other push. */
    fun body(data: Map<String, String>): String? = data["category"]?.let { TEXT[it] }
}
