// A sample account's voi.ci page, read only (docs/voici-and-messages.md "Sample accounts"). The operator publishes
// an example page for each sample account from `.com`; a device that opens one holds none of its keys, so it can only
// read the page like a visitor: the account's public keys, the signed index (checked against the account's own
// sensitive key), the profile and the avatar. Nothing is signed, stored in the vault or sent. Mirrors iOS
// MessagesStore's sample-account read.

package com.flagshipserver.app.core.voici

import com.flagshipserver.app.api.VoiciClient

data class VoiciDemoPageUi(
    val username: String,
    /** `.com` answered for the page (published or not). */
    val checked: Boolean = false,
    val isPublic: Boolean = false,
    val profile: VoiciProfile? = null,
    val avatar: ByteArray? = null,
) {
    val displayName: String get() = profile?.displayName?.ifBlank { null } ?: username

    override fun equals(other: Any?): Boolean =
        other is VoiciDemoPageUi && other.username == username && other.checked == checked && other.isPublic == isPublic &&
            other.profile == profile && other.avatar.contentEquals(avatar)

    override fun hashCode(): Int = listOf(username, checked, isPublic, profile, avatar?.contentHashCode()).hashCode()
}

object VoiciDemoPage {
    /**
     * Reads [username]'s public page. A failed read (no network, `.com` refused) answers null, so a page that was
     * shown stays shown; a page that is missing or doesn't check out answers "not public".
     */
    suspend fun load(client: VoiciClient, username: String): VoiciDemoPageUi? {
        val u = username.lowercase()
        val keys = runCatching { client.accountKeys(u) }.getOrNull() ?: return null
        val json = runCatching { client.page(u) }.getOrElse { return null }
            ?: return VoiciDemoPageUi(u, checked = true)
        val idx = VoiciPage.checkVoiciPageIndex(json, u, keys.sensitiveKind, keys.sensitivePub).valueOrNull()
            ?: return VoiciDemoPageUi(u, checked = true)
        val fetched = HashMap<String, ByteArray>()
        for (p in idx.body.pieces) {
            if (p.role != "profile" && p.role != "avatar" && !p.role.startsWith("chunk-")) continue
            val b = runCatching { client.piece(u, idx.body.pageId, p.sha256) }.getOrNull() ?: continue
            if (b.size.toLong() == p.size && WebEnvelopes.sha256Hex(b) == p.sha256) fetched[p.sha256] = b
        }
        val state = VoiciOwner.readPublished(idx) { fetched[it.sha256] } ?: return VoiciDemoPageUi(u, checked = true)
        val avatar = state.profile.avatar?.let { fetched[it] }
        return VoiciDemoPageUi(u, checked = true, isPublic = true, profile = state.profile, avatar = avatar)
    }
}
