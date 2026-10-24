// Builds the watch path's parts on this device: the Keystore boot-only key, the recorded server
// keys (ServerKeyPins.shared, the only source of a server's STK) and the boot worker client.

package com.flagshipserver.app.keystore

import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.core.IrkAccess
import com.flagshipserver.app.core.ReadTokenStartUpSource
import com.flagshipserver.app.core.ServerKeyPins
import com.flagshipserver.app.core.WatchBootApprover
import com.flagshipserver.app.core.WatchBootOptIn

object WatchBootWiring {
    /** The one pin store (docs/first-contact.md), recorded at a server's first blessing. */
    val pins: ServerKeyPins get() = ServerKeyPins.shared

    fun optIn(mailbox: SecretMailboxClient, irk: IrkAccess) =
        WatchBootOptIn(mailbox, irk, KeystoreWatchBootKeys(), pins)

    fun approver(mailbox: SecretMailboxClient, username: String) = WatchBootApprover(
        mailbox = mailbox,
        delegate = { SessionIrkAccess.watchDelegate() },
        store = KeystoreWatchBootKeys(),
        source = ReadTokenStartUpSource(mailbox, username),
        pins = pins,
    )
}
