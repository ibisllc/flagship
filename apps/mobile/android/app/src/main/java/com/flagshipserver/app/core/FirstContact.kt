// First contact (docs/first-contact.md): what this device keeps for a server it created, and the
// decision the first blessing makes. Creating a server puts a fresh one-time enrollment secret in
// the recipe; the box proves with it that the key in its first request was built from that recipe.
// A server handed to Studio also gets a Studio confirm key beside the recipe, so Studio can say
// which key it read on the VM's console ("Confirmed by Studio"). Both are kept device-local,
// encrypted under a Keystore key and never backed up, and dropped once the server is pinned.

package com.flagshipserver.app.core

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** What this device keeps for one server it created, until the server is pinned. */
data class EnrollmentRecord(
    /** The recipe's `enrollmentKeyHex` (32 bytes, hex). */
    val secretHex: String,
    /** The AuthCode serial the proof names. */
    val serial: String,
    /** The key handed to Studio beside the recipe, when Studio got the recipe. */
    val studioConfirmKeyHex: String? = null,
)

interface EnrollmentSecretStore {
    fun get(serverDomain: String): EnrollmentRecord?
    fun put(serverDomain: String, record: EnrollmentRecord)
    fun remove(serverDomain: String)
}

class InMemoryEnrollmentSecretStore : EnrollmentSecretStore {
    val map = java.util.concurrent.ConcurrentHashMap<String, EnrollmentRecord>()
    override fun get(serverDomain: String) = map[serverDomain.lowercase()]
    override fun put(serverDomain: String, record: EnrollmentRecord) { map[serverDomain.lowercase()] = record }
    override fun remove(serverDomain: String) { map.remove(serverDomain.lowercase()) }
}

/** The key Studio read on a VM's console, as order status relays it: `serverSeen`. Unverified. */
data class ServerSeen(val stkPubHex: String, val macHex: String)

/**
 * "Confirmed by Studio". Studio holds `studioConfirmKey` (sent beside the recipe over the
 * SAS-verified pairing channel, beside the recipe in the deliver frame), reads `flagship-server-code <domain> <code> <stkPubHex>` on the VM
 * console and reports `macHex` = HMAC-SHA256(key, `flagship/server-code-seen/v1|<domain lowercase>|<stkPubHex>`)
 * through the order status (`serverSeen`, up to 4, newest last). A MAC that verifies under the kept key names the key Studio saw; a
 * wrong one is ignored.
 */
object StudioConfirm {
    const val TAG = "flagship/server-code-seen/v1"
    private val HEX64 = Regex("^[0-9a-f]{64}$")

    fun newKey(): ByteArray = ByteArray(32).also { SecureRandom().nextBytes(it) }

    fun macHex(key: ByteArray, serverDomain: String, stkPubHex: String): String? {
        if (key.size != 32 || !HEX64.matches(stkPubHex) || '|' in serverDomain) return null
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }
        val msg = listOf(TAG, serverDomain.lowercase(), stkPubHex).joinToString("|").toByteArray(Charsets.UTF_8)
        return mac.doFinal(msg).joinToString("") { "%02x".format(it) }
    }

    /** True when [seen] is Studio's word, under [key], that the VM showed exactly [stkPubHex]. */
    fun confirms(key: ByteArray, serverDomain: String, stkPubHex: String, seen: ServerSeen?): Boolean {
        if (seen == null || !seen.stkPubHex.equals(stkPubHex, ignoreCase = true)) return false
        val want = macHex(key, serverDomain, stkPubHex.lowercase()) ?: return false
        return MessageDigest.isEqual(want.toByteArray(), seen.macHex.lowercase().toByteArray())
    }
}

/** What the owner is shown before the first blessing: the code computed here from the key. */
data class FirstLook(
    val serverDomain: String,
    val stkPubHex: String,
    /** Six digits from [stkPubHex] (Enrollment.serverCode), never anything the box or `.com` sent. */
    val code: String,
    /** Studio read this very key on the VM's console. */
    val studioConfirmed: Boolean,
    /** The box proved this key with this device's enrollment secret. */
    val proven: Boolean,
) {
    /** "482 913". */
    val spacedCode: String get() = FirstContact.spaced(code)
}

/** Why a request is refused, and the sentence shown for it. */
enum class FirstContactRefusal(val resId: Int) {
    /** This device holds the recipe's secret and the box's proof is missing or wrong. */
    NOT_FROM_RECIPE(com.flagshipserver.app.R.string.server_not_from_your_recipe),
    /** The request names another key than the pinned one. */
    KEY_CHANGED(com.flagshipserver.app.R.string.server_key_changed);

    /** The sentence, outside a composable (a composable reads [resId] with stringResource). */
    fun message(): String = FSStrings.get(resId)
}

/** The one decision on a box's signed request: which key to use, and what to show. */
class FirstContact(
    private val pins: ServerKeyPins = ServerKeyPins.shared,
    private val secrets: EnrollmentSecretStore? = shared,
    /** The order status's `serverSeen` for an install serial (Studio's reports, newest last). */
    private val studioSeen: suspend (serial: String) -> List<ServerSeen> = { serial -> studioSeenSource(serial) },
) {
    sealed interface Verdict {
        /** The pinned key named it and signed it. */
        data class Pinned(val stkPubHex: String) : Verdict
        /** No pin yet: show [look]. [pinOnApprove] is false only for an unlock request from a server
         *  this device created: its proof comes with the entitlement request, which then pins. */
        data class FirstSight(val look: FirstLook, val pinOnApprove: Boolean) : Verdict
        data class Refused(val reason: FirstContactRefusal, val stkPubHex: String) : Verdict
        /** Malformed or not signed by the key it names: dropped without a word. */
        data object Invalid : Verdict
    }

    suspend fun judge(
        serverDomain: String,
        namedStkHex: String,
        purpose: SecretPurpose,
        verifySignature: (stkPub: ByteArray, stkPubHex: String) -> Boolean,
        enrollmentProof: String?,
    ): Verdict {
        val named = namedStkHex.lowercase()
        if (!HEX64.matches(named)) return Verdict.Invalid
        when (val c = pins.check(serverDomain, named)) {
            is ServerKeyPins.Check.Changed -> return Verdict.Refused(FirstContactRefusal.KEY_CHANGED, named)
            ServerKeyPins.Check.Matches -> {
                val pin = pins.pinnedStk(serverDomain) ?: return Verdict.Invalid
                return if (verifySignature(pin, named)) Verdict.Pinned(named) else Verdict.Invalid
            }
            ServerKeyPins.Check.Unpinned -> Unit
        }
        val key = HexUtil.decode(named) ?: return Verdict.Invalid
        if (!verifySignature(key, named)) return Verdict.Invalid
        val rec = secrets?.get(serverDomain)
        var proven = false
        if (rec != null && purpose == SecretPurpose.ENTITLEMENT) {
            val secret = HexUtil.decode(rec.secretHex)
            val ok = secret != null && enrollmentProof != null &&
                Enrollment.verify(secret, serverDomain, named, rec.serial, enrollmentProof)
            if (!ok) return Verdict.Refused(FirstContactRefusal.NOT_FROM_RECIPE, named)
            proven = true
        }
        val studio = rec?.studioConfirmKeyHex?.let(HexUtil::decode)?.takeIf { it.size == 32 }?.let { k ->
            val seen = try { studioSeen(rec.serial) } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Throwable) { emptyList() }
            // Any report whose MAC verifies and names this very key; a wrong MAC is ignored.
            seen.any { StudioConfirm.confirms(k, serverDomain, named, it) }
        } ?: false
        val code = Enrollment.serverCode(named) ?: return Verdict.Invalid
        return Verdict.FirstSight(
            FirstLook(serverDomain.lowercase(), named, code, studio, proven),
            pinOnApprove = rec == null || purpose == SecretPurpose.ENTITLEMENT,
        )
    }

    fun pinnedHex(serverDomain: String): String? = pins.pinnedHex(serverDomain)

    /** Pin [look]'s key now (the owner approved) and drop what was kept for the first contact. */
    fun pin(look: FirstLook) {
        when (pins.recordFirstSeen(look.serverDomain, look.stkPubHex)) {
            ServerKeyPins.Record.Mismatch -> throw ServerKeyChangedException()
            else -> Unit
        }
        secrets?.remove(look.serverDomain)
    }

    companion object {
        private val HEX64 = Regex("^[0-9a-f]{64}$")

        /** The process-wide store; MainActivity installs the Keystore-backed one. */
        @Volatile
        var shared: EnrollmentSecretStore = InMemoryEnrollmentSecretStore()

        /** Reads an install's order status for Studio's report; MainActivity wires it to `.com`. */
        @Volatile
        var studioSeenSource: suspend (serial: String) -> List<ServerSeen> = { emptyList() }

        fun spaced(code: String): String = if (code.length == 6) code.substring(0, 3) + " " + code.substring(3) else code

        /** A fresh secret for a recipe being minted, kept for [serverDomain]. Returns its hex. */
        fun newEnrollment(store: EnrollmentSecretStore?, serverDomain: String, serial: String, withStudioKey: Boolean): EnrollmentRecord {
            val rec = EnrollmentRecord(
                secretHex = HexUtil.encode(Enrollment.newSecret()),
                serial = serial,
                studioConfirmKeyHex = if (withStudioKey) HexUtil.encode(StudioConfirm.newKey()) else null,
            )
            store?.put(serverDomain, rec)
            return rec
        }
    }
}
