// Account notices that carry only their category: a box's relay-trust SOS
// (`cert-alert`, from the box through /api/push/relay) and a newly registered
// server (`server-registered`, from `.com`). Nothing in them names the server;
// a tap opens Home, which shows which one. Same text as the APNs alert and
// the webapp's service worker.

package com.flagshipserver.app.push

object AccountNoticePush {
    const val TITLE = "Flagship"

    private val TEXT = mapOf(
        "cert-alert" to "One of your servers needs your attention.",
        "server-registered" to "A new server was added to your account.",
    )

    /** The notice's text, or null for any other push. */
    fun body(data: Map<String, String>): String? = data["category"]?.let { TEXT[it] }
}
