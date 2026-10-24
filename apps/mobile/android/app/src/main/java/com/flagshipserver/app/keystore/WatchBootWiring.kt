// Builds the watch path's parts on this device: the Keystore boot-only key, the recorded server
// keys (ServerKeyPins, the only source of a server's STK here) and the boot worker client.

package com.flagshipserver.app.keystore

import com.flagshipserver.app.api.SecretMailboxClient
import com.flagshipserver.app.core.IrkAccess
import com.flagshipserver.app.core.ReadTokenStartUpSource
import com.flagshipserver.app.core.ServerKeyPinStore
import com.flagshipserver.app.core.ServerKeyPins
import com.flagshipserver.app.core.WatchBootApprover
import com.flagshipserver.app.core.WatchBootOptIn

object WatchBootWiring {
    val pins: ServerKeyPins
        get() = ServerKeyPins(object : ServerKeyPinStore {
            override fun get(serverDomain: String) = Keystore.serverKeyPin(serverDomain)
            override fun put(serverDomain: String, stkPubHex: String) = Keystore.setServerKeyPin(serverDomain, stkPubHex)
            override fun remove(serverDomain: String) = Keystore.setServerKeyPin(serverDomain, null)
        })

    /** [currentServerKey]: the key this phone's own server list shows now (offered once, as the first-seen pin). */
    fun optIn(mailbox: SecretMailboxClient, irk: IrkAccess, currentServerKey: suspend (String) -> String?) =
        WatchBootOptIn(mailbox, irk, KeystoreWatchBootKeys(), pins, currentServerKey)

    fun approver(mailbox: SecretMailboxClient, username: String) = WatchBootApprover(
        mailbox = mailbox,
        delegate = { SessionIrkAccess.watchDelegate() },
        store = KeystoreWatchBootKeys(),
        source = ReadTokenStartUpSource(mailbox, username),
        pins = pins,
    )
}
