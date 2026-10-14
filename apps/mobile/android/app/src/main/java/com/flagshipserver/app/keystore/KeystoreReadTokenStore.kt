// Production ReadTokenStore: the active profile's encrypted prefs (Keystore),
// so a token follows the profile and goes with it on wipe.

package com.flagshipserver.app.keystore

import com.flagshipserver.app.core.AccountReadTokenResponse
import com.flagshipserver.app.core.ReadTokenStore

class KeystoreReadTokenStore : ReadTokenStore {
    override fun get(username: String): AccountReadTokenResponse? {
        val raw = Keystore.accountReadToken(username) ?: return null
        val expiresAt = raw.substringBefore(' ').toLongOrNull() ?: return null
        val token = raw.substringAfter(' ', "")
        return if (token.isEmpty()) null else AccountReadTokenResponse(token, expiresAt)
    }

    override fun put(username: String, token: AccountReadTokenResponse) {
        Keystore.setAccountReadToken(username, "${token.expiresAt} ${token.token}")
    }

    override fun remove(username: String) = Keystore.setAccountReadToken(username, null)

    override fun clear() = Keystore.clearAccountReadTokens()
}
