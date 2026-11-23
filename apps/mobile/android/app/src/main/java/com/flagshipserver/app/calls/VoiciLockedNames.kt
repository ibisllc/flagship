// Names on a locked phone (docs/voici-locked-caller-names.md, owner-agreed 2026-11-22). Same rules as iOS
// VoiciLockedNames.swift: a small table outside the app lock, readable after the first unlock since boot, so a locked
// phone can show the nickname of a visitor the owner has really had calls with, and the page name of a ring-back.
// Opt-in ("Show names while locked"), rebuilt whole from the unlocked account, never synced, erased when the setting
// goes off or the account leaves. At most 50 nicknames (keyed by a hash of the pseudonym) and 50 ring-back pages (keyed
// by their ring tag key). Never logged, never sent anywhere, never read by a model.

package com.flagshipserver.app.calls

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.flagshipserver.app.core.voici.MessagesForgotten
import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.VoiciRings
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@Serializable
data class VoiciLockedName(val n: String, val last: Long)

@Serializable
data class VoiciLockedRing(val u: String, val p: String, val last: Long)

@Serializable
data class VoiciLockedNamesTable(
    val v: Int = 1,
    val account: String,
    val builtAt: Long,
    val names: Map<String, VoiciLockedName> = emptyMap(),
    val rings: Map<String, VoiciLockedRing> = emptyMap(),
)

object VoiciLockedNames {
    const val MAX_ENTRIES = 50
    /** "Had calls with" and the ring-back channel's life: 90 days. */
    const val WINDOW_MS = 90L * 86_400_000L

    /** A page this account may be rung back from, as this device knows it (its call-back pages, named by its calls). */
    data class RingPage(val username: String, val pageId: String, val last: Long)

    private val PSEUDONYM = Regex("^[0-9a-f]{64}$")
    private val USERNAME = Regex("^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")

    /**
     * The whole table from what the unlocked account holds. [includeNames] only while "Answer calls while Flagship is
     * locked" is on for a page that takes calls; ring-back pages whenever the setting is on ([messagesSecret] derives
     * their tag keys).
     */
    fun build(
        account: String,
        now: Long,
        includeNames: Boolean,
        nicknames: Map<String, String>,
        blocked: Set<String>,
        forgotten: Map<String, MessagesForgotten>,
        records: List<VoiciCallRecord>,
        missed: List<VoiciMissedCallRow>,
        ringPages: List<RingPage>,
        messagesSecret: ByteArray?,
    ): VoiciLockedNamesTable {
        val since = now - WINDOW_MS
        val names = LinkedHashMap<String, VoiciLockedName>()
        if (includeNames) {
            val goneConvs = forgotten.keys
            val gonePubs = forgotten.values.mapNotNull { it.pseudonymPub }.toSet()
            val last = HashMap<String, Long>()
            fun saw(conv: String?, pub: String?, at: Long) {
                if (pub == null || at < since || at > now + 60_000 || !PSEUDONYM.matches(pub) || conv in goneConvs || pub in gonePubs || pub in blocked) return
                last[pub] = maxOf(last[pub] ?: 0L, at)
            }
            for (r in records) if (r.outcome != "failed" && r.pseudonymPub != null) saw(r.conv, r.pseudonymPub, r.at)
            for (m in missed) saw(m.conv, m.pseudonymPub, m.ringingAt)
            last.mapNotNull { (pub, at) -> nicknames[pub]?.trim()?.takeIf { it.isNotEmpty() }?.let { Triple(pub, it, at) } }
                .sortedByDescending { it.third }.take(MAX_ENTRIES)
                .forEach { (pub, n, at) -> names[VoiciRings.lockedNameKey(pub)] = VoiciLockedName(n, at) }
        }
        val rings = LinkedHashMap<String, VoiciLockedRing>()
        if (messagesSecret != null) {
            ringPages.filter { it.last in since..(now + 60_000) && USERNAME.matches(it.username) }
                .groupBy { it.pageId }.values.map { ps -> ps.maxBy { it.last } }
                .sortedByDescending { it.last }.take(MAX_ENTRIES)
                .forEach { p ->
                    val k = runCatching { VoiciRings.deriveRingTagKey(messagesSecret, p.pageId) }.getOrNull() ?: return@forEach
                    rings[VoiciJs.hex(k)] = VoiciLockedRing(p.username, p.pageId, p.last)
                }
        }
        return VoiciLockedNamesTable(account = account.lowercase(), builtAt = now, names = names, rings = rings)
    }

    /** The nickname for a ringing caller's pseudonym, while it is still within the window. */
    fun name(pseudonymPub: String, table: VoiciLockedNamesTable?, account: String, now: Long): String? {
        if (table == null || table.account != account.lowercase() || !PSEUDONYM.matches(pseudonymPub)) return null
        val e = table.names[VoiciRings.lockedNameKey(pseudonymPub)] ?: return null
        return e.n.takeIf { it.isNotEmpty() && now - e.last <= WINDOW_MS }
    }

    /** The page a ring-back push names by its tag; every entry is tried, so the time taken doesn't say which matched. */
    fun ringPage(ringId: String, tag: String?, table: VoiciLockedNamesTable?, now: Long): VoiciCallTarget? {
        if (table == null || tag == null) return null
        var hit: VoiciLockedRing? = null
        for ((keyHex, ring) in table.rings) {
            val key = runCatching { com.flagshipserver.app.core.voici.WebEnvelopes.hexToBytes(keyHex) }.getOrNull()?.takeIf { it.size == 32 } ?: continue
            if (VoiciRings.ringTagMatches(key, ringId, tag) && now - ring.last <= WINDOW_MS) hit = ring
        }
        return hit?.let { VoiciCallTarget(it.u, it.p) }
    }
}

/** Where the table lives: a file per account, or memory in tests. */
interface VoiciLockedNamesStore {
    fun save(table: VoiciLockedNamesTable)
    fun load(username: String): VoiciLockedNamesTable?
    fun delete(username: String)
    /** Every account's table, and the key that seals them. */
    fun deleteAll()
}

class MemoryLockedNamesStore : VoiciLockedNamesStore {
    val tables = HashMap<String, VoiciLockedNamesTable>()
    override fun save(table: VoiciLockedNamesTable) { tables[table.account] = table }
    override fun load(username: String) = tables[username.lowercase()]
    override fun delete(username: String) { tables.remove(username.lowercase()) }
    override fun deleteAll() = tables.clear()
}

/**
 * The phone's store: `filesDir/voici-locked-names/<sha256(username)>.bin` (credential-encrypted storage: readable after
 * the first unlock since boot), AES-256-GCM under the Keystore key `flagship.voici.lockedNames` with no user
 * authentication, no unlocked-device requirement and no StrongBox (it must open quickly while ringing). The directory
 * is excluded from cloud backup and device transfer (res/xml/data_extraction_rules.xml); the app also has
 * allowBackup="false". Erasing the last table deletes the key too.
 */
class KeystoreLockedNamesStore(context: Context) : VoiciLockedNamesStore {
    private val dir = File(context.applicationContext.filesDir, DIR)
    private val ks: KeyStore by lazy { KeyStore.getInstance("AndroidKeyStore").apply { load(null) } }
    private val json = Json { ignoreUnknownKeys = true }

    private fun file(username: String) = File(dir, VoiciJs.hex(VoiciJs.sha256(VoiciJs.utf8(username.lowercase()))).substring(0, 32) + ".bin")

    private fun key(create: Boolean): SecretKey? {
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        if (!create) return null
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(false)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(spec) }.generateKey()
    }

    override fun save(table: VoiciLockedNamesTable) {
        val k = key(create = true) ?: return
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, k) }
        val aad = VoiciJs.utf8("$ALIAS|${table.account}")
        c.updateAAD(aad)
        val ct = c.doFinal(VoiciJs.utf8(json.encodeToString(VoiciLockedNamesTable.serializer(), table)))
        dir.mkdirs()
        val tmp = File(dir, file(table.account).name + ".tmp")
        tmp.writeBytes(byteArrayOf(c.iv.size.toByte()) + c.iv + ct)
        if (!tmp.renameTo(file(table.account))) tmp.delete()
    }

    override fun load(username: String): VoiciLockedNamesTable? = runCatching {
        val f = file(username)
        if (!f.exists()) return null
        val k = key(create = false) ?: return null
        val b = f.readBytes()
        val n = b[0].toInt()
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, k, GCMParameterSpec(128, b.copyOfRange(1, 1 + n))) }
        c.updateAAD(VoiciJs.utf8("$ALIAS|${username.lowercase()}"))
        json.decodeFromString(VoiciLockedNamesTable.serializer(), c.doFinal(b.copyOfRange(1 + n, b.size)).decodeToString())
            .takeIf { it.v == 1 && it.account == username.lowercase() }
    }.getOrNull()

    override fun delete(username: String) {
        file(username).delete()
        if (dir.listFiles()?.none { it.name.endsWith(".bin") } != false) runCatching { ks.deleteEntry(ALIAS) }
    }

    override fun deleteAll() {
        dir.deleteRecursively()
        runCatching { ks.deleteEntry(ALIAS) }
    }

    companion object {
        const val DIR = "voici-locked-names"
        const val ALIAS = "flagship.voici.lockedNames"
    }
}

/** The per-device choices: "Show names while locked" per account and whether the one-time question was asked. */
class VoiciLockedNamesSettings(private val prefs: android.content.SharedPreferences) {
    constructor(context: Context) : this(context.applicationContext.getSharedPreferences("flagship.voici.lockedNames", Context.MODE_PRIVATE))

    fun isOn(username: String): Boolean = username.isNotEmpty() && prefs.getBoolean("on.${username.lowercase()}", false)
    fun setOn(username: String, on: Boolean) {
        if (username.isEmpty()) return
        prefs.edit().apply { if (on) putBoolean("on.${username.lowercase()}", true) else remove("on.${username.lowercase()}") }.apply()
    }

    fun sheetShown(username: String): Boolean = prefs.getBoolean("sheet.${username.lowercase()}", false)
    fun markSheetShown(username: String) { if (username.isNotEmpty()) prefs.edit().putBoolean("sheet.${username.lowercase()}", true).apply() }

    fun forget(username: String) { prefs.edit().remove("on.${username.lowercase()}").remove("sheet.${username.lowercase()}").apply() }
}
