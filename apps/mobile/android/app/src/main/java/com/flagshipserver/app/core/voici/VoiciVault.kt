// What this device keeps of its voi.ci page and Messages (docs/voici-and-messages.md §5, §7.3, §10): the published
// index and its state, this device's unpublished changes, other devices' drafts, the conversations it has read, the
// state blob it last saw, and the pictures. Sealed at rest under a key from the UMK (the Messages state key, with
// its own AAD), so a copy of the files without the account key reads as noise.

package com.flagshipserver.app.core.voici

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import java.io.File
import java.security.SecureRandom

@Serializable
data class VoiciLocalOp(
    val op: JsonObject,
    /** A non-admin device's op once handed to the admin device (phone or the drafts lane). */
    val delivered: Boolean = false,
)

@Serializable
data class VoiciLocal(
    val pageId: String? = null,
    val inboxEpoch: Long = 1,
    val publishedIndex: JsonObject? = null,
    val publishedState: JsonObject? = null,
    /** This device's unpublished changes, oldest first. */
    val localOps: List<VoiciLocalOp> = emptyList(),
    /** Other devices' changes read from the drafts lane or delivered to this phone (opened ops). */
    val laneOps: List<JsonObject> = emptyList(),
    val conversations: List<StoredVoiciConversation> = emptyList(),
    val inboxCursor: String = "",
    val stateVersion: Long = 0,
    val state: JsonObject? = null,
    /** Visitor side: the attestation last received per pageId (for renewals). */
    val attestations: Map<String, JsonObject> = emptyMap(),
    /** The "Page and message rules" were accepted on this device. */
    val rulesAccepted: Boolean = false,
    /** `.com`'s filters, from the last inbox read. */
    val inboxBlocks: List<String> = emptyList(),
    val revoked: List<String> = emptyList(),
    /** `.com` refused a publish `taken-down`. */
    val takenDown: Boolean = false,
    /** The `seq` of this device's last voici-draft envelope. */
    val draftSeq: Long = 0,
    /** [state] has changes `.com`'s copy (at [stateVersion]) doesn't have yet. */
    val stateDirty: Boolean = false,
    /** Visitor side: the pages this device signed in to (pageId → the page's username), for reply notices. */
    val signInPages: Map<String, String> = emptyMap(),
    /** Visitor side, per pageId: the newest verified owner reply's storedAt, the one last opened, the thread cursor. */
    val replyLatest: Map<String, Long> = emptyMap(),
    val replySeen: Map<String, Long> = emptyMap(),
    val replyCursor: Map<String, String> = emptyMap(),
    /** The owner took the page down (here or on another device): `.com` answers "no page"; [publishedIndex] and
     *  [publishedState] stay, so its conversations still open and turning it on again brings it back as it was. */
    val removed: Boolean = false,
    /** The highest seq on the publish ladder this device saw: an index or a removal (§3.3). */
    val ladderSeq: Long = 0,
    /** "Everything you put on your page is public" was answered with Make it public on this device. */
    val publicWarned: Boolean = false,
)

/** Where the sealed files live. */
interface VoiciVaultStore {
    fun read(username: String, name: String): ByteArray?
    fun write(username: String, name: String, bytes: ByteArray)
    fun delete(username: String)
}

class FileVoiciVaultStore(private val root: File) : VoiciVaultStore {
    private fun dir(u: String) = File(root, u.lowercase().replace(Regex("[^a-z0-9-]"), "_"))
    override fun read(username: String, name: String): ByteArray? = File(dir(username), name).takeIf { it.isFile }?.readBytes()
    override fun write(username: String, name: String, bytes: ByteArray) {
        val d = dir(username).also { it.mkdirs() }
        val tmp = File(d, "$name.tmp")
        tmp.outputStream().use { it.write(bytes); it.fd.sync() }
        if (!tmp.renameTo(File(d, name))) {
            File(d, name).delete()
            tmp.renameTo(File(d, name))
        }
    }
    override fun delete(username: String) {
        dir(username).deleteRecursively()
    }
}

class MemoryVoiciVaultStore : VoiciVaultStore {
    private val files = HashMap<String, ByteArray>()
    override fun read(username: String, name: String) = synchronized(files) { files["$username/$name"] }
    override fun write(username: String, name: String, bytes: ByteArray) = synchronized(files) { files["$username/$name"] = bytes }
    override fun delete(username: String) = synchronized(files) { files.keys.removeAll { it.startsWith("$username/") }; Unit }
}

class VoiciVault(private val store: VoiciVaultStore) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }
    private val rng = SecureRandom()

    private fun aad(username: String, name: String) = VoiciJs.utf8("flagship/voici-local/v1|$username|$name")
    private fun key(umk: ByteArray) = VoiciMessages.deriveMessagesStateKey(umk)

    private fun seal(umk: ByteArray, username: String, name: String, pt: ByteArray): ByteArray {
        val nonce = ByteArray(12).also(rng::nextBytes)
        return nonce + VoiciJs.gcmEncrypt(key(umk), nonce, aad(username, name), pt)
    }

    private fun open(umk: ByteArray, username: String, name: String, b: ByteArray): ByteArray? = runCatching {
        VoiciJs.gcmDecrypt(key(umk), b.copyOfRange(0, 12), aad(username, name), b.copyOfRange(12, b.size))
    }.getOrNull()

    fun load(umk: ByteArray, username: String): VoiciLocal {
        val b = store.read(username, "local") ?: return VoiciLocal()
        val pt = open(umk, username, "local", b) ?: return VoiciLocal()
        return runCatching { json.decodeFromString(VoiciLocal.serializer(), pt.decodeToString()) }.getOrDefault(VoiciLocal())
    }

    fun save(umk: ByteArray, username: String, local: VoiciLocal) {
        store.write(username, "local", seal(umk, username, "local", json.encodeToString(VoiciLocal.serializer(), local).toByteArray()))
    }

    fun image(umk: ByteArray, username: String, sha: String): ByteArray? {
        if (!WebEnvelopes.isLowerHex(sha, 32)) return null
        val b = store.read(username, "img-$sha") ?: return null
        return open(umk, username, "img-$sha", b)?.takeIf { WebEnvelopes.sha256Hex(it) == sha }
    }

    fun putImage(umk: ByteArray, username: String, bytes: ByteArray): String {
        val sha = WebEnvelopes.sha256Hex(bytes)
        store.write(username, "img-$sha", seal(umk, username, "img-$sha", bytes))
        return sha
    }

    fun forget(username: String) = store.delete(username)
}
