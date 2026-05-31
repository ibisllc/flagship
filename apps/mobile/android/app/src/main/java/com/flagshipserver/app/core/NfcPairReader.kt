// C3 Wave 2 (Android) — testable seam over the NFC reader.
//
// Two records on the tag:
//
//   Record 1: NDEF MIME-typed JSON
//     TNF  = TNF_MIME_MEDIA
//     type = "application/flagship.pair+json"
//     payload = UTF-8 JSON object with the fields:
//       { v: number,
//         stkPub, eBoxPub, nonce, sessionId,           // lowercase hex
//         hint: { mdnsName, cloudRendezvousId, suffix6 } }
//
//   Field-name parity with the iOS sibling
//   (apps/mobile/ios/Sources/FlagshipUI/NFC/NfcPairReader.swift) —
//   bytes-on-the-wire are hex strings; the JSON key names DO NOT carry
//   a `Hex` suffix so a future protocol bump can swap the representation
//   without breaking the key contract.
//
//   Record 2: NDEF MIME-typed raw Ed25519 signature
//     TNF  = TNF_MIME_MEDIA
//     type = "application/flagship.pair.sig"
//     payload = 64 raw bytes — Ed25519_sign(stkPriv, canonicalPair(PAIR))
//
// The wire format intentionally avoids NDEF Well-Known TNFs so a stray
// Android Beam / browser intent never tries to "open" the tag — only an
// app that explicitly hunts for these MIME types reads it. The iOS
// sibling (built in parallel) MUST match this exact shape; any deviation
// gets documented in a code comment + a fixture entry.
//
// LiveNfcPairReader uses enableReaderMode with the standard NFC-A flag
// set; on tag discovery it pulls the NDEF message, parses both records,
// and verifies the signature via NfcPair.verifyPair before resuming the
// caller's coroutine.
//
// MockNfcPairReader is the test seam — it returns a fixture without
// touching any hardware so view-model tests stay deterministic + run
// under Robolectric without a NFC stub.

package com.flagshipserver.app.core

import android.app.Activity
import android.nfc.NdefMessage
import android.nfc.NdefRecord
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.Ndef
import androidx.activity.ComponentActivity
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import kotlin.coroutines.resume

// ── Wire-format constants ──────────────────────────────────────────────

/** MIME type carried in the JSON-encoded PAIR record (record 1). */
const val NFC_PAIR_PAYLOAD_MIME: String = "application/flagship.pair+json"

/** MIME type carried in the raw-bytes Ed25519 signature record (record 2). */
const val NFC_PAIR_SIGNATURE_MIME: String = "application/flagship.pair.sig"

private const val ED25519_SIG_LEN: Int = 64

// ── Result + errors ────────────────────────────────────────────────────

/** Outcome of a successful NFC pair read: the parsed payload + the raw
 *  Ed25519 signature that has ALREADY been verified by the reader. */
data class ReadPairResult(val payload: PairPayload, val signature: ByteArray) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ReadPairResult) return false
        return payload == other.payload && signature.contentEquals(other.signature)
    }

    override fun hashCode(): Int = payload.hashCode() * 31 + signature.contentHashCode()
}

/** Typed failure modes — the view model maps these to user-facing copy. */
sealed interface NfcPairReaderError {
    /** No NFC adapter on the device, or it's disabled in system settings. */
    data object NfcUnavailable : NfcPairReaderError

    /** Caller cancelled (e.g. backed out of the read screen). */
    data object UserCanceled : NfcPairReaderError

    /** Tag dispatched but is not the Flagship-pair shape (no MIME match,
     *  not NDEF, wrong record count, etc.). */
    data object TagFormatUnrecognized : NfcPairReaderError

    /** PAIR record present but its body doesn't parse into a PairPayload. */
    data class MalformedPayload(val reason: String) : NfcPairReaderError

    /** PAIR + SIG records present but verifyPair returned false. */
    data object SignatureMismatch : NfcPairReaderError

    /** Reader timed out without a tap. */
    data object Timeout : NfcPairReaderError
}

/** Carrier exception used to surface reader errors through Result.failure. */
class NfcPairReaderException(val error: NfcPairReaderError, message: String) :
    RuntimeException(message)

// ── Reader interface ───────────────────────────────────────────────────

interface NfcPairReader {
    /**
     * Begin a single-shot NFC tag read using foreground reader-mode
     * dispatch. The activity is needed to wire up the adapter callback.
     *
     * Returns Result.success(parsed) on a tag whose signature checks
     * out, Result.failure(NfcPairReaderException) for every other
     * outcome (no adapter / cancel / malformed / verify fail).
     */
    suspend fun readPair(activity: ComponentActivity): Result<ReadPairResult>
}

// ── JSON ⇄ PairPayload helpers ─────────────────────────────────────────

/** Encode a PairPayload as the canonical JSON record-1 body. Public so
 *  the daemon-side fixtures / Mock reader / cross-language vectors can
 *  build records without re-encoding the fields by hand. */
fun encodePairPayloadJson(payload: PairPayload): String {
    val hint = JSONObject().apply {
        put("mdnsName", payload.hint.mdnsName)
        put("cloudRendezvousId", payload.hint.cloudRendezvousId)
        put("suffix6", payload.hint.suffix6)
    }
    return JSONObject().apply {
        put("v", payload.v)
        put("stkPub", NfcPairHex.encode(payload.stkPub))
        put("eBoxPub", NfcPairHex.encode(payload.eBoxPub))
        put("nonce", NfcPairHex.encode(payload.nonce))
        put("sessionId", NfcPairHex.encode(payload.sessionId))
        put("hint", hint)
    }.toString()
}

/** Decode the JSON record-1 body into a PairPayload. Throws
 *  IllegalArgumentException on any shape mismatch — callers turn that
 *  into NfcPairReaderError.MalformedPayload. */
fun decodePairPayloadJson(json: String): PairPayload {
    val root = try {
        JSONObject(json)
    } catch (t: Throwable) {
        throw IllegalArgumentException("PAIR record is not valid JSON: ${t.message}")
    }
    val v = root.optInt("v", PAIR_PROTOCOL_VERSION)
    val stkPubHex = root.optString("stkPub", "")
    val eBoxPubHex = root.optString("eBoxPub", "")
    val nonceHex = root.optString("nonce", "")
    val sessionIdHex = root.optString("sessionId", "")
    val hintObj = root.optJSONObject("hint")
        ?: throw IllegalArgumentException("PAIR.hint missing")
    val mdnsName = hintObj.optString("mdnsName", "")
    val cloudRendezvousId = hintObj.optString("cloudRendezvousId", "")
    val suffix6 = hintObj.optString("suffix6", "")
    if (stkPubHex.isEmpty() || eBoxPubHex.isEmpty() || nonceHex.isEmpty() ||
        sessionIdHex.isEmpty() || mdnsName.isEmpty() || cloudRendezvousId.isEmpty() ||
        suffix6.isEmpty()
    ) {
        throw IllegalArgumentException("PAIR record missing required field(s)")
    }
    val stkPub = try { NfcPairHex.decode(stkPubHex) } catch (t: Throwable) {
        throw IllegalArgumentException("stkPub is not valid hex")
    }
    val eBoxPub = try { NfcPairHex.decode(eBoxPubHex) } catch (t: Throwable) {
        throw IllegalArgumentException("eBoxPub is not valid hex")
    }
    val nonce = try { NfcPairHex.decode(nonceHex) } catch (t: Throwable) {
        throw IllegalArgumentException("nonce is not valid hex")
    }
    val sessionId = try { NfcPairHex.decode(sessionIdHex) } catch (t: Throwable) {
        throw IllegalArgumentException("sessionId is not valid hex")
    }
    return PairPayload(
        v = v,
        stkPub = stkPub,
        eBoxPub = eBoxPub,
        nonce = nonce,
        sessionId = sessionId,
        hint = PairHint(mdnsName, cloudRendezvousId, suffix6),
    )
}

/**
 * Build an NDEF message that carries a PAIR + SIG record pair. Used by
 * the Mock reader to fabricate a tag fixture; also useful for any
 * future device-to-device emulation experiments + the cross-language
 * conformance suite.
 */
fun buildPairNdefMessage(payload: PairPayload, signature: ByteArray): NdefMessage {
    require(signature.size == ED25519_SIG_LEN) { "SIG must be 64 bytes" }
    val pairRecord = NdefRecord.createMime(
        NFC_PAIR_PAYLOAD_MIME,
        encodePairPayloadJson(payload).toByteArray(Charsets.UTF_8),
    )
    val sigRecord = NdefRecord.createMime(NFC_PAIR_SIGNATURE_MIME, signature)
    return NdefMessage(arrayOf(pairRecord, sigRecord))
}

/**
 * Parse + verify a discovered NDEF message. Returns the verified result
 * on success; throws NfcPairReaderException on any unmet precondition.
 *
 * Exposed (not private) so unit tests can pin the parse logic in
 * isolation from the LiveNfcPairReader's reader-mode coroutine plumbing.
 */
fun parseAndVerifyPairNdef(message: NdefMessage): ReadPairResult {
    val records = message.records ?: emptyArray()
    if (records.size < 2) {
        throw NfcPairReaderException(
            NfcPairReaderError.TagFormatUnrecognized,
            "tag has ${records.size} record(s); need ≥2",
        )
    }
    var pairBytes: ByteArray? = null
    var sigBytes: ByteArray? = null
    for (rec in records) {
        if (rec.tnf != NdefRecord.TNF_MIME_MEDIA) continue
        val mime = String(rec.type, Charsets.UTF_8)
        when (mime) {
            NFC_PAIR_PAYLOAD_MIME -> if (pairBytes == null) pairBytes = rec.payload
            NFC_PAIR_SIGNATURE_MIME -> if (sigBytes == null) sigBytes = rec.payload
        }
    }
    val pb = pairBytes ?: throw NfcPairReaderException(
        NfcPairReaderError.TagFormatUnrecognized,
        "no $NFC_PAIR_PAYLOAD_MIME record",
    )
    val sb = sigBytes ?: throw NfcPairReaderException(
        NfcPairReaderError.TagFormatUnrecognized,
        "no $NFC_PAIR_SIGNATURE_MIME record",
    )
    if (sb.size != ED25519_SIG_LEN) {
        throw NfcPairReaderException(
            NfcPairReaderError.MalformedPayload("SIG must be 64 bytes; got ${sb.size}"),
            "signature wrong length",
        )
    }
    val payload = try {
        decodePairPayloadJson(String(pb, Charsets.UTF_8))
    } catch (t: IllegalArgumentException) {
        throw NfcPairReaderException(
            NfcPairReaderError.MalformedPayload(t.message ?: "malformed PAIR JSON"),
            t.message ?: "malformed PAIR JSON",
        )
    }
    if (!verifyPair(payload, sb)) {
        throw NfcPairReaderException(
            NfcPairReaderError.SignatureMismatch,
            "Ed25519 verifyPair returned false",
        )
    }
    return ReadPairResult(payload, sb)
}

// ── Live impl (Android reader-mode) ────────────────────────────────────

class LiveNfcPairReader : NfcPairReader {
    override suspend fun readPair(activity: ComponentActivity): Result<ReadPairResult> {
        val adapter = NfcAdapter.getDefaultAdapter(activity)
        if (adapter == null || !adapter.isEnabled) {
            return Result.failure(
                NfcPairReaderException(
                    NfcPairReaderError.NfcUnavailable,
                    "no NFC adapter (or disabled in system settings)",
                ),
            )
        }
        return suspendCancellableCoroutine { cont ->
            var resumed = false
            val flags = NfcAdapter.FLAG_READER_NFC_A or
                NfcAdapter.FLAG_READER_NFC_B or
                NfcAdapter.FLAG_READER_NFC_F or
                NfcAdapter.FLAG_READER_NFC_V
            val callback = NfcAdapter.ReaderCallback { tag: Tag ->
                if (resumed) return@ReaderCallback
                val outcome = try {
                    val ndef = Ndef.get(tag) ?: throw NfcPairReaderException(
                        NfcPairReaderError.TagFormatUnrecognized,
                        "tag does not present NDEF tech",
                    )
                    ndef.connect()
                    val message = try {
                        ndef.ndefMessage ?: throw NfcPairReaderException(
                            NfcPairReaderError.TagFormatUnrecognized,
                            "tag has no NDEF message",
                        )
                    } finally {
                        try { ndef.close() } catch (_: Throwable) { /* best-effort */ }
                    }
                    Result.success(parseAndVerifyPairNdef(message))
                } catch (e: NfcPairReaderException) {
                    Result.failure(e)
                } catch (t: Throwable) {
                    Result.failure(
                        NfcPairReaderException(
                            NfcPairReaderError.TagFormatUnrecognized,
                            t.message ?: "tag read failed",
                        ),
                    )
                }
                resumed = true
                try {
                    adapter.disableReaderMode(activity)
                } catch (_: Throwable) { /* best-effort */ }
                cont.resume(outcome)
            }
            try {
                adapter.enableReaderMode(activity as Activity, callback, flags, null)
            } catch (t: Throwable) {
                cont.resume(
                    Result.failure(
                        NfcPairReaderException(
                            NfcPairReaderError.NfcUnavailable,
                            "enableReaderMode threw: ${t.message}",
                        ),
                    ),
                )
                return@suspendCancellableCoroutine
            }
            cont.invokeOnCancellation {
                if (!resumed) {
                    resumed = true
                    try { adapter.disableReaderMode(activity) } catch (_: Throwable) { /* best-effort */ }
                }
            }
        }
    }
}

// ── Mock impl (tests / dev-mode) ───────────────────────────────────────

/**
 * Returns a pre-baked Result on every readPair call without touching
 * any Android NFC API. The activity argument is ignored — view-model
 * tests pass an empty stand-in.
 */
class MockNfcPairReader(
    private val outcome: Result<ReadPairResult>,
) : NfcPairReader {
    /** Number of times readPair has been called. Tests use this to
     *  confirm the VM only kicks off a read on startTap. */
    @Volatile var callCount: Int = 0
        private set

    override suspend fun readPair(activity: ComponentActivity): Result<ReadPairResult> {
        callCount += 1
        return outcome
    }
}
