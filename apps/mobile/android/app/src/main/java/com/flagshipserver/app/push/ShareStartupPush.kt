// A server shared with this account is waiting to start (docs/share-a-server.md
// §5.4). `.com` sends it under the owner's boot-approval category with
// `kind: "share-start-up"` and nothing else: no server, no share. A tap opens
// Home, where "Shared with me" offers the approval.

package com.flagshipserver.app.push

object ShareStartupPush {
    const val KIND = "share-start-up"
    const val TITLE = "Flagship"
    const val BODY = "A server shared with you is asking you to unlock it."

    fun matches(data: Map<String, String>): Boolean = data["kind"] == KIND
}
