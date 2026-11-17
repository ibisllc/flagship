// `outbound-proxy` (docs/outbound-proxy.md "Failure handling"): one of the account's servers can't use its
// outbound proxy. `.com` sends it when a box reports its proxy failing (or connecting directly instead); it names
// no server or proxy. A tap opens the app, whose Home row and server page say which server and why.

package com.flagshipserver.app.push

import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings

object OutboundProxyPush {
    const val CATEGORY = "outbound-proxy"
    const val TITLE = "Flagship"
    val BODY get() = FSStrings.get(R.string.proxy_push_body)

    fun matches(data: Map<String, String>): Boolean = data["category"] == CATEGORY || data["kind"] == CATEGORY
}
