// The two files of a server backup (docs/server-backup-and-clone.md), the
// Kotlin port of packages/protocol/src/serverBackup.ts. Must pass
// packages/protocol/test-vectors/server-backup and server-restore vectors.
//
//   `<name>.flagship-backup`  small JSON: key slots + a body sealed under the content key
//   `<name>.flagship-data`    the apps, sealed in frames (only the box opens them)
//
// MIRRORS: apps/mobile/shared/Sources/FlagshipCore/ServerBackupFormat.swift and
// apps/mobile/ios/Sources/Flagship/ServerBackupPasscode.swift (the Argon2id).

package com.flagshipserver.app.core

import com.flagshipserver.app.api.ServerBackupKdf
import com.flagshipserver.app.api.ServerBackupSlot
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.Normalizer
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object ServerBackupFormat {
    const val MAGIC = "flagship-backup"
    const val VERSION = 2
    const val DATA_MAGIC = "flagship-backup-data/v2\n"
    const val BACKUP_EXTENSION = "flagship-backup"
    const val DATA_EXTENSION = "flagship-data"
    const val BACKUP_FILE_MAX_BYTES = 256 * 1024
    const val PASSCODE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
    /** The keyfile's Argon2id cost: memory KiB, passes, lanes. */
    const val DEFAULT_ARGON_M = 65536
    const val DEFAULT_ARGON_T = 3
    const val DEFAULT_ARGON_P = 4
    private const val TAG_SLOT = "flagship/server-backup-slot/v2"
    private const val TAG_BODY = "flagship/server-backup-body/v2"
    const val TAG_RESTORE = "flagship/server-restore/v1"

    private val dataMagicBytes = DATA_MAGIC.toByteArray(Charsets.UTF_8)
    private val rng = SecureRandom()

    class FormatException(val kind: Kind) : Exception(kind.message) {
        enum class Kind(val message: String) {
            NOT_A_BACKUP("That isn't a Flagship backup file."),
            NEWER_VERSION("This backup is from a newer version of Flagship. Update the app and try again."),
            OLDER_VERSION("This backup is from an older version of Flagship and can't be restored."),
            DAMAGED("This backup file is damaged."),
            CHANGED("This backup file was changed or is damaged."),
            WRONG_PASSCODE("That passcode doesn't open this backup."),
            NO_PASSCODE("This backup has no passcode: open it on a device of the account that made it."),
        }
    }

    data class File(
        val archiveId: String,
        val slots: List<ServerBackupSlot>,
        val bodyNonceHex: String,
        val bodyHex: String,
    ) {
        val passcodeSlot: ServerBackupSlot? get() = slots.firstOrNull { it.kind == "passcode" }
        val accountSlot: ServerBackupSlot? get() = slots.firstOrNull { it.kind == "account" }
    }

    data class ServerSettings(
        val name: String,
        val domain: String,
        /** `auto` | `approve` */
        val bootUnlockMode: String,
        /** `luks` | `none` */
        val diskEncryption: String,
    )

    data class App(val serviceId: String, val name: String, val reason: String? = null)

    data class DataInfo(val fileName: String, val bytes: Long, val sha256: String, val frameBytes: Int)

    data class Body(
        val createdAt: Long,
        val server: ServerSettings,
        val apps: List<App>,
        val left: List<App>,
        val includes: List<String>,
        val excludes: List<String>,
        val data: DataInfo,
    )

    class Opened(
        val file: File,
        val body: Body,
        val contentKey: ByteArray,
        /** `account` | `passcode` */
        val via: String,
    )

    // ── Passcodes ──────────────────────────────────────────────────

    fun normalizePasscode(p: String): String = Normalizer.normalize(p, Normalizer.Form.NFC).trim()

    /** Why a passcode the user chose is too weak, or null. */
    fun passcodeProblem(passcode: String): String? {
        val p = normalizePasscode(passcode)
        val len = p.codePointCount(0, p.length)
        if (len >= 20) return null
        if (len < 12) return "Use at least 12 characters (or 20 if it's all one kind, like words)."
        var kinds = 0
        if (p.any { it in 'a'..'z' }) kinds++
        if (p.any { it in 'A'..'Z' }) kinds++
        if (p.any { it in '0'..'9' }) kinds++
        if (p.any { !(it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9') }) kinds++
        return if (kinds >= 3) null else "Mix at least three of: lowercase, uppercase, digits, symbols (or use 20 characters)."
    }

    /** A suggested passcode: five groups of four, 100 bits. */
    fun generatePasscode(rng: (Int) -> ByteArray = ::randomBytes): String =
        (0 until 5).joinToString("-") { _ ->
            val b = rng(4)
            require(b.size == 4) { "rng must return the requested length" }
            b.joinToString("") { PASSCODE_ALPHABET[it.toInt() and 31].toString() }
        }

    fun randomBytes(n: Int): ByteArray = ByteArray(n).also(rng::nextBytes)

    fun isValidKdf(k: ServerBackupKdf): Boolean =
        k.algo == "argon2id" && k.p in 1..16 && k.t in 1..16 && k.m in 8..1_048_576 && k.m >= 8 * k.p &&
            isHex(k.saltHex, 32)

    /** Argon2id v1.3 of the normalized passcode under the slot's salt and cost.
     *  Slow on purpose (about a second at the default cost): call it off the main thread. */
    fun passcodeKek(passcode: String, kdf: ServerBackupKdf): ByteArray {
        if (!isValidKdf(kdf)) throw FormatException(FormatException.Kind.DAMAGED)
        val salt = HexUtil.decode(kdf.saltHex) ?: throw FormatException(FormatException.Kind.DAMAGED)
        val gen = Argon2BytesGenerator()
        gen.init(
            Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
                .withVersion(Argon2Parameters.ARGON2_VERSION_13)
                .withSalt(salt)
                .withMemoryAsKB(kdf.m)
                .withIterations(kdf.t)
                .withParallelism(kdf.p)
                .build(),
        )
        val out = ByteArray(32)
        gen.generateBytes(normalizePasscode(passcode).toByteArray(Charsets.UTF_8), out)
        return out
    }

    /** A passcode slot for [contentKey], with a fresh salt and nonce. */
    fun passcodeSlot(
        archiveId: String,
        contentKey: ByteArray,
        passcode: String,
        m: Int = DEFAULT_ARGON_M,
        t: Int = DEFAULT_ARGON_T,
        p: Int = DEFAULT_ARGON_P,
    ): ServerBackupSlot {
        val kdf = ServerBackupKdf(m = m, t = t, p = p, saltHex = HexUtil.encode(randomBytes(16)))
        return wrapPasscodeSlot(archiveId, contentKey, passcodeKek(passcode, kdf), kdf, randomBytes(12))
    }

    /** Open a backup file with its passcode (Argon2id: call it off the main thread). */
    fun openWithPasscode(file: File, passcode: String): Opened {
        val kdf = file.passcodeSlot?.kdf ?: throw FormatException(FormatException.Kind.NO_PASSCODE)
        return openWithPasscodeKey(file, passcodeKek(passcode, kdf))
    }

    // ── Slots ──────────────────────────────────────────────────────

    private fun slotAad(archiveId: String, kind: String, kdf: ServerBackupKdf?): ByteArray {
        val parts = mutableListOf(TAG_SLOT, kind, archiveId)
        if (kind == "passcode" && kdf != null) {
            parts += listOf(kdf.algo, "m=${kdf.m}", "t=${kdf.t}", "p=${kdf.p}", kdf.saltHex)
        }
        return parts.joinToString("|").toByteArray(Charsets.UTF_8)
    }

    private fun seal(key: ByteArray, nonce: ByteArray, aad: ByteArray, plain: ByteArray): ByteArray {
        require(key.size == 32 && nonce.size == 12) { "bad key or nonce" }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        c.updateAAD(aad)
        return c.doFinal(plain)
    }

    private fun open(key: ByteArray, nonce: ByteArray, aad: ByteArray, sealed: ByteArray): ByteArray? {
        if (key.size != 32 || nonce.size != 12 || sealed.size < 16) return null
        return try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
            c.updateAAD(aad)
            c.doFinal(sealed)
        } catch (_: Exception) {
            null
        }
    }

    fun wrapAccountSlot(archiveId: String, contentKey: ByteArray, kek: ByteArray, nonce: ByteArray): ServerBackupSlot {
        val w = seal(kek, nonce, slotAad(archiveId, "account", null), contentKey)
        return ServerBackupSlot(kind = "account", nonceHex = HexUtil.encode(nonce), wrappedHex = HexUtil.encode(w))
    }

    /** [kek] is the Argon2id of the passcode under [kdf] ([passcodeKek]). */
    fun wrapPasscodeSlot(archiveId: String, contentKey: ByteArray, kek: ByteArray, kdf: ServerBackupKdf, nonce: ByteArray): ServerBackupSlot {
        val w = seal(kek, nonce, slotAad(archiveId, "passcode", kdf), contentKey)
        return ServerBackupSlot(kind = "passcode", kdf = kdf, nonceHex = HexUtil.encode(nonce), wrappedHex = HexUtil.encode(w))
    }

    /** The content key from a slot, or null. */
    fun unwrap(archiveId: String, slot: ServerBackupSlot, kek: ByteArray): ByteArray? {
        val nonce = HexUtil.decode(slot.nonceHex) ?: return null
        val wrapped = HexUtil.decode(slot.wrappedHex) ?: return null
        return open(kek, nonce, slotAad(archiveId, slot.kind, slot.kdf), wrapped)?.takeIf { it.size == 32 }
    }

    // ── The backup file ────────────────────────────────────────────

    internal fun isHex(s: String, length: Int? = null): Boolean {
        if (length != null && s.length != length) return false
        return s.isNotEmpty() && s.length % 2 == 0 && s.all { it in '0'..'9' || it in 'a'..'f' }
    }

    private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun int(v: JsonElement?): Long? {
        val p = v as? JsonPrimitive ?: return null
        if (p.isString) return null
        p.content.toLongOrNull()?.let { return if (kotlin.math.abs(it) <= 9_007_199_254_740_991L) it else null }
        val d = p.content.toDoubleOrNull() ?: return null
        if (d != Math.floor(d) || kotlin.math.abs(d) > 9_007_199_254_740_991.0) return null
        return d.toLong()
    }

    fun parseSlot(v: JsonElement?): ServerBackupSlot? {
        val o = v as? JsonObject ?: return null
        val nonce = o.str("nonceHex")?.takeIf { isHex(it, 24) } ?: return null
        val wrapped = o.str("wrappedHex")?.takeIf { isHex(it, 96) } ?: return null
        val kind = o.str("kind") ?: return null
        if (kind == "account") return ServerBackupSlot(kind = "account", nonceHex = nonce, wrappedHex = wrapped)
        if (kind != "passcode") return null
        val k = o["kdf"] as? JsonObject ?: return null
        if (k.str("algo") != "argon2id") return null
        val m = int(k["m"]) ?: return null
        val t = int(k["t"]) ?: return null
        val p = int(k["p"]) ?: return null
        val salt = k.str("saltHex") ?: return null
        if (m !in 0..Int.MAX_VALUE.toLong() || t !in 0..16L || p !in 0..16L) return null
        val kdf = ServerBackupKdf(m = m.toInt(), t = t.toInt(), p = p.toInt(), saltHex = salt)
        if (!isValidKdf(kdf)) return null
        return ServerBackupSlot(kind = "passcode", kdf = kdf, nonceHex = nonce, wrappedHex = wrapped)
    }

    /** The outer layer of a backup file. Throws a readable [FormatException]. */
    fun parse(data: ByteArray): File {
        val o = try {
            Json.parseToJsonElement(String(data, Charsets.UTF_8)) as? JsonObject
        } catch (_: Exception) {
            null
        }
        if (o == null || o.str("magic") != MAGIC) throw FormatException(FormatException.Kind.NOT_A_BACKUP)
        val v = int(o["v"]) ?: throw FormatException(FormatException.Kind.NOT_A_BACKUP)
        if (v > VERSION) throw FormatException(FormatException.Kind.NEWER_VERSION)
        if (v < VERSION) throw FormatException(FormatException.Kind.OLDER_VERSION)
        val damaged = FormatException(FormatException.Kind.DAMAGED)
        val id = o.str("archiveId")?.takeIf { isHex(it, 32) } ?: throw damaged
        val bodyNonce = o.str("bodyNonceHex")?.takeIf { isHex(it, 24) } ?: throw damaged
        val body = o.str("bodyHex")?.takeIf { isHex(it) && it.length >= 34 } ?: throw damaged
        val raw = (o["slots"] as? JsonArray)?.takeIf { it.isNotEmpty() } ?: throw damaged
        val slots = raw.map { parseSlot(it) ?: throw damaged }
        return File(id, slots, bodyNonce, body)
    }

    private fun slotJson(s: ServerBackupSlot): String {
        val kdf = s.kdf
        val k = if (s.kind == "passcode" && kdf != null) {
            ",\"kdf\":{\"algo\":${JsonPrimitive(kdf.algo)},\"m\":${kdf.m},\"t\":${kdf.t},\"p\":${kdf.p},\"saltHex\":${JsonPrimitive(kdf.saltHex)}}"
        } else {
            ""
        }
        return "{\"kind\":${JsonPrimitive(s.kind)}$k,\"nonceHex\":${JsonPrimitive(s.nonceHex)},\"wrappedHex\":${JsonPrimitive(s.wrappedHex)}}"
    }

    /** The file's text: one JSON object, keys in a fixed order, one trailing newline. */
    fun serialize(f: File): String =
        "{\"magic\":\"$MAGIC\",\"v\":$VERSION,\"archiveId\":${JsonPrimitive(f.archiveId)}," +
            "\"slots\":[${f.slots.joinToString(",") { slotJson(it) }}]," +
            "\"bodyNonceHex\":${JsonPrimitive(f.bodyNonceHex)},\"bodyHex\":${JsonPrimitive(f.bodyHex)}}\n"

    fun parseBody(data: ByteArray): Body? {
        val o = try {
            Json.parseToJsonElement(String(data, Charsets.UTF_8)) as? JsonObject
        } catch (_: Exception) {
            null
        } ?: return null
        val createdAt = int(o["createdAt"]) ?: return null
        val s = o["server"] as? JsonObject ?: return null
        val name = s.str("name") ?: return null
        val domain = s.str("domain") ?: return null
        val unlock = s.str("bootUnlockMode")?.takeIf { it == "auto" || it == "approve" } ?: return null
        val disk = s.str("diskEncryption")?.takeIf { it == "luks" || it == "none" } ?: return null
        val d = o["data"] as? JsonObject ?: return null
        val fileName = d.str("fileName") ?: return null
        val sha = d.str("sha256")?.takeIf { isHex(it, 64) } ?: return null
        val bytes = int(d["bytes"])?.takeIf { it >= dataMagicBytes.size } ?: return null
        val frame = int(d["frameBytes"])?.takeIf { it in 1024L..16L * 1024 * 1024 } ?: return null
        val rawApps = o["apps"] as? JsonArray ?: return null
        val apps = rawApps.map { a ->
            val ao = a as? JsonObject ?: return null
            App(ao.str("serviceId") ?: return null, ao.str("name") ?: return null)
        }
        val rawLeft = (o["left"] as? JsonArray) ?: JsonArray(emptyList())
        val left = rawLeft.map { a ->
            val ao = a as? JsonObject ?: return null
            App(ao.str("serviceId") ?: return null, ao.str("name") ?: return null, ao.str("reason") ?: return null)
        }
        fun strings(k: String) = (o[k] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content } ?: emptyList()
        return Body(
            createdAt = createdAt,
            server = ServerSettings(name, domain, unlock, disk),
            apps = apps,
            left = left,
            includes = strings("includes"),
            excludes = strings("excludes"),
            data = DataInfo(fileName, bytes, sha, frame.toInt()),
        )
    }

    private fun bodyAad(archiveId: String) = "$TAG_BODY|$archiveId".toByteArray(Charsets.UTF_8)

    fun openBody(file: File, contentKey: ByteArray): Body {
        val nonce = HexUtil.decode(file.bodyNonceHex)
        val sealed = HexUtil.decode(file.bodyHex)
        val plain = if (nonce != null && sealed != null) open(contentKey, nonce, bodyAad(file.archiveId), sealed) else null
        plain ?: throw FormatException(FormatException.Kind.CHANGED)
        return parseBody(plain) ?: throw FormatException(FormatException.Kind.DAMAGED)
    }

    /** Open with this account's key ([ServerArchive.deriveKey]); null when it isn't this account's backup. */
    fun openWithAccountKey(file: File, kek: ByteArray): Opened? {
        val slot = file.accountSlot ?: return null
        val key = unwrap(file.archiveId, slot, kek) ?: return null
        return Opened(file, openBody(file, key), key, "account")
    }

    /** Open with the passcode slot's key (Argon2id of the passcode under `file.passcodeSlot.kdf`). */
    fun openWithPasscodeKey(file: File, kek: ByteArray): Opened {
        val slot = file.passcodeSlot ?: throw FormatException(FormatException.Kind.NO_PASSCODE)
        val key = unwrap(file.archiveId, slot, kek) ?: throw FormatException(FormatException.Kind.WRONG_PASSCODE)
        return Opened(file, openBody(file, key), key, "passcode")
    }

    /** The body sealed under the content key (the box writes real files; this is for tests and parity). */
    fun sealFile(archiveId: String, contentKey: ByteArray, slots: List<ServerBackupSlot>, bodyJson: ByteArray, nonce: ByteArray): File {
        val ct = seal(contentKey, nonce, bodyAad(archiveId), bodyJson)
        return File(archiveId, slots, HexUtil.encode(nonce), HexUtil.encode(ct))
    }

    // ── Picked files ───────────────────────────────────────────────

    enum class PickedKind { BACKUP, DATA }

    /** Which of the two files [head] (the first bytes of a picked file) is. */
    fun classify(head: ByteArray, size: Long): PickedKind? {
        if (head.size >= dataMagicBytes.size && head.copyOfRange(0, dataMagicBytes.size).contentEquals(dataMagicBytes)) return PickedKind.DATA
        if (head.isNotEmpty() && head[0] == '{'.code.toByte() && size <= BACKUP_FILE_MAX_BYTES) return PickedKind.BACKUP
        return null
    }

    class DataCheckException(val kind: Kind, expected: String = "") : Exception(
        when (kind) {
            Kind.WRONG_SIZE -> "That data file isn't this backup's (it should be $expected)."
            Kind.NOT_DATA -> "That isn't a Flagship backup's data file."
            Kind.MISMATCH -> "The data file doesn't match the backup file: it was changed or is damaged."
            Kind.UNREADABLE -> "The data file can't be read any more (was its drive removed?)."
        },
    ) {
        enum class Kind { WRONG_SIZE, NOT_DATA, MISMATCH, UNREADABLE }
    }

    /** Up to [n] bytes, fewer only at the end (InputStream.readNBytes needs API 33). */
    fun readUpTo(input: InputStream, n: Int): ByteArray {
        val buf = ByteArray(n)
        var got = 0
        while (got < n) {
            val r = input.read(buf, got, n - got)
            if (r < 0) break
            got += r
        }
        return if (got == n) buf else buf.copyOf(got)
    }

    /** Check the data file against the backup file without holding it: its
     *  size, its first line and its SHA-256, read in slices. */
    suspend fun checkDataFile(
        size: Long,
        open: () -> InputStream,
        info: DataInfo,
        sliceBytes: Int = 8 * 1024 * 1024,
        progress: suspend (Long) -> Unit = {},
    ) {
        if (size != info.bytes) throw DataCheckException(DataCheckException.Kind.WRONG_SIZE, info.fileName)
        val stream = try {
            open()
        } catch (_: Exception) {
            throw DataCheckException(DataCheckException.Kind.UNREADABLE)
        }
        val h = MessageDigest.getInstance("SHA-256")
        stream.use { input ->
            var read = 0L
            while (read < size) {
                currentCoroutineContext().ensureActive()
                val part = try {
                    readUpTo(input, sliceBytes)
                } catch (_: IOException) {
                    throw DataCheckException(DataCheckException.Kind.UNREADABLE)
                }
                if (part.isEmpty()) throw DataCheckException(DataCheckException.Kind.UNREADABLE)
                if (read == 0L && classify(part, size) != PickedKind.DATA) throw DataCheckException(DataCheckException.Kind.NOT_DATA)
                h.update(part)
                read += part.size
                progress(read)
            }
        }
        if (HexUtil.encode(h.digest()) != info.sha256) throw DataCheckException(DataCheckException.Kind.MISMATCH)
    }

    // ── The restore order ──────────────────────────────────────────

    data class RestoreOrder(
        val serverDomain: String,
        val archiveId: String,
        val bytes: Long,
        val sha256: String,
        val issuedAt: Long,
    ) {
        val isValid: Boolean
            get() = serverDomain.isNotEmpty() &&
                serverDomain.none { it == '|' || it.code <= 0x1f || it.code == 0x7f } &&
                isHex(archiveId, 32) && bytes >= 1 && isHex(sha256, 64) && issuedAt >= 0

        /** `flagship/server-restore/v1|<serverDomain>|<archiveId>|<bytes>|<sha256>|<issuedAt>` */
        fun canonicalBytes(): ByteArray {
            if (!isValid) throw FormatException(FormatException.Kind.DAMAGED)
            return listOf(TAG_RESTORE, serverDomain, archiveId, bytes.toString(), sha256, issuedAt.toString())
                .joinToString("|").toByteArray(Charsets.UTF_8)
        }
    }

    /** The pairing order's JSON with the signed restore order beside it
     *  (`{request, signature, restore: {order, signatureHex}}`). */
    fun attachRestore(pairingJson: String, order: RestoreOrder, signatureHex: String): String {
        if (!pairingJson.endsWith("}")) return pairingJson
        val o = "{\"serverDomain\":${JsonPrimitive(order.serverDomain)}," +
            "\"archiveId\":\"${order.archiveId}\",\"bytes\":${order.bytes}," +
            "\"sha256\":\"${order.sha256}\",\"issuedAt\":${order.issuedAt}}"
        return pairingJson.dropLast(1) + ",\"restore\":{\"order\":$o,\"signatureHex\":\"$signatureHex\"}}"
    }

    /** The pairing order's JSON with the signed backup policy beside it
     *  (`{request, signature, backupPolicy: {order, signatureHex}}`): the box
     *  takes it when the pairing order verifies (docs/server-backup-and-clone.md, "Backup policy"). */
    fun attachBackupPolicy(pairingJson: String, order: BackupPolicyOrder, signatureHex: String): String {
        if (!pairingJson.endsWith("}")) return pairingJson
        val o = "{\"serverDomain\":${JsonPrimitive(order.serverDomain)},\"policy\":${JsonPrimitive(order.policy)}," +
            "\"phoneReserveBytes\":${order.phoneReserveBytes},\"issuedAt\":${order.issuedAt}}"
        return pairingJson.dropLast(1) + ",\"backupPolicy\":{\"order\":$o,\"signatureHex\":\"$signatureHex\"}}"
    }
}
