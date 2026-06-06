import Foundation
#if canImport(CoreNFC)
import CoreNFC
#endif
import FlagshipCore

/// C3 — phone-side NFC reader for the retail-box pairing tap.
///
/// The branded box exposes an NDEF tag (writable in production hardware,
/// read-only fallback shipped to dev kits) containing TWO records:
///
///   1. **PAIR** — `application/flagship.pair+json`, the JSON-encoded
///      PairPayload (`v`, `stkPub`, `eBoxPub`, `nonce`, `sessionId`,
///      `hint{mdnsName,cloudRendezvousId,suffix6}`).
///   2. **SIG**  — `application/flagship.pair.sig`, raw 64-byte Ed25519
///      signature over `canonicalPair(payload)`.
///
/// **Wire format assumption**: PAIR-as-JSON-MIME and SIG-as-raw-MIME is
/// the simplest scheme that round-trips through CoreNFC's NDEF surface
/// without inventing a new TNF. The box-side daemon (N-BOX track) is not
/// yet shipping a final emitter; if it lands with a different scheme
/// (e.g. PAIR-as-bytes via canonicalPair instead of JSON, or both
/// records concatenated in a single MIME blob), the parser below is the
/// single place to adjust. Bytes-on-wire stay protocol-stable because
/// `verifyPair` runs against canonical bytes that we re-derive locally
/// from the parsed PairPayload — the JSON envelope is only a transport.
///
/// The reader is single-shot: it opens an NFCTagReaderSession, polls
/// ISO14443 (covers MIFARE / NTAG / DESFire — the cheapest hardware
/// options for a sticker tag), reads the first detected tag's NDEF
/// message, parses both records, calls `verifyPair`, then invalidates
/// the session. The continuation resolves with `ReadPairResult` or
/// throws `NfcPairReaderError`.
///
/// Surfaces consumed by `NfcPairViewModel`; the live impl is gated
/// behind `#if canImport(CoreNFC)` so test targets and the macOS
/// SPM build (which has no CoreNFC) still compile.

public struct ReadPairResult: Sendable, Equatable {
    public let payload: PairPayload
    /// Raw 64-byte Ed25519 SIG record bytes.
    public let signature: Data

    public init(payload: PairPayload, signature: Data) {
        self.payload = payload
        self.signature = signature
    }
}

public enum NfcPairReaderError: Error, Equatable, Sendable {
    /// Core NFC isn't available (no NFC chip, or running on a platform
    /// that doesn't import CoreNFC — e.g. macOS / Simulator).
    case sessionUnavailable
    /// User dismissed the system NFC sheet before a tag was read.
    case userCanceled
    /// Tag responded but it wasn't NDEF (or NDEF was empty).
    case tagFormatUnrecognized
    /// NDEF must contain exactly PAIR + SIG (= 2 records). Anything else
    /// is either an unrelated tag or a malformed box-side emitter.
    case multipleRecords(Int)
    /// PAIR record present but JSON didn't deserialize into a valid
    /// PairPayload (missing field, wrong hex length, etc.).
    case malformedPayload(String)
    /// `verifyPair` returned false — either tampered, or the wrong tag.
    case signatureMismatch
    /// Session invalidated by Core NFC for a timeout reason.
    case timeout
}

public protocol NfcPairReaderProtocol: Sendable {
    /// Begin a single-shot NFC tag read. Resolves with the first tag's
    /// PAIR + SIG content on success, throws `NfcPairReaderError`.
    func readPair() async throws -> ReadPairResult
}

// ────────────────────────────────────────────────────────────────────────
// MIME types — single source of truth for the box-side emitter to match.

public enum NfcPairWireFormat {
    public static let pairMimeType = "application/flagship.pair+json"
    public static let sigMimeType = "application/flagship.pair.sig"
}

// ────────────────────────────────────────────────────────────────────────
// Parser — pure function over an NDEF message's (type, payload) records.
// Pulled out of the live reader so MockNfcPairReader callers + tests can
// exercise the same wire format without instantiating Core NFC.

public enum NfcPairWireParser {
    /// Parse a pre-extracted (type, payload) list into a `ReadPairResult`.
    /// Each entry is `(mimeType, payloadBytes)` — exactly the shape
    /// `NFCNDEFPayload.type` + `payload` give us, but without the
    /// CoreNFC import so tests stay platform-portable.
    public static func parse(records: [(type: String, payload: Data)]) throws -> ReadPairResult {
        if records.count != 2 {
            throw NfcPairReaderError.multipleRecords(records.count)
        }
        let pairRec = records.first { $0.type == NfcPairWireFormat.pairMimeType }
        let sigRec = records.first { $0.type == NfcPairWireFormat.sigMimeType }
        guard let pairRec else {
            throw NfcPairReaderError.malformedPayload("missing PAIR record (\(NfcPairWireFormat.pairMimeType))")
        }
        guard let sigRec else {
            throw NfcPairReaderError.malformedPayload("missing SIG record (\(NfcPairWireFormat.sigMimeType))")
        }
        if sigRec.payload.count != 64 {
            throw NfcPairReaderError.malformedPayload("SIG must be 64 bytes (Ed25519); got \(sigRec.payload.count)")
        }
        let payload = try decodePairJSON(pairRec.payload)
        if !verifyPair(payload, signature: sigRec.payload) {
            throw NfcPairReaderError.signatureMismatch
        }
        return ReadPairResult(payload: payload, signature: sigRec.payload)
    }

    /// JSON shape:
    /// `{ v, stkPub:hex, eBoxPub:hex, nonce:hex, sessionId:hex,
    ///    hint:{ mdnsName, cloudRendezvousId, suffix6 } }`.
    static func decodePairJSON(_ data: Data) throws -> PairPayload {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NfcPairReaderError.malformedPayload("PAIR record is not JSON")
        }
        guard let stkPubHex = obj["stkPub"] as? String,
              let eBoxPubHex = obj["eBoxPub"] as? String,
              let nonceHex = obj["nonce"] as? String,
              let sessionIdHex = obj["sessionId"] as? String,
              let hint = obj["hint"] as? [String: Any],
              let mdnsName = hint["mdnsName"] as? String,
              let cloudRendezvousId = hint["cloudRendezvousId"] as? String,
              let suffix6 = hint["suffix6"] as? String
        else {
            throw NfcPairReaderError.malformedPayload("PAIR JSON missing required field")
        }
        let v: Int
        if let n = obj["v"] as? Int { v = n }
        else if let n = obj["v"] as? Double { v = Int(n) }
        else { v = PAIR_PROTOCOL_VERSION }

        let stkPub = NfcPairHex.decode(stkPubHex)
        let eBoxPub = NfcPairHex.decode(eBoxPubHex)
        let nonce = NfcPairHex.decode(nonceHex)
        let sessionId = NfcPairHex.decode(sessionIdHex)
        if stkPub.count != 32 || eBoxPub.count != 32 {
            throw NfcPairReaderError.malformedPayload("stkPub/eBoxPub must be 32 bytes")
        }
        if nonce.count != 16 || sessionId.count != 16 {
            throw NfcPairReaderError.malformedPayload("nonce/sessionId must be 16 bytes")
        }
        return PairPayload(
            v: v,
            stkPub: stkPub,
            eBoxPub: eBoxPub,
            nonce: nonce,
            sessionId: sessionId,
            hint: PairHint(mdnsName: mdnsName, cloudRendezvousId: cloudRendezvousId, suffix6: suffix6)
        )
    }

    /// Inverse of `decodePairJSON` — used by tests + by the dev-mode
    /// "emit a fake tag" helper. Kept here so the canonical wire format
    /// lives in one place.
    public static func encodePairJSON(_ p: PairPayload) throws -> Data {
        let obj: [String: Any] = [
            "v": p.v,
            "stkPub": NfcPairHex.encode(p.stkPub),
            "eBoxPub": NfcPairHex.encode(p.eBoxPub),
            "nonce": NfcPairHex.encode(p.nonce),
            "sessionId": NfcPairHex.encode(p.sessionId),
            "hint": [
                "mdnsName": p.hint.mdnsName,
                "cloudRendezvousId": p.hint.cloudRendezvousId,
                "suffix6": p.hint.suffix6,
            ]
        ]
        // .sortedKeys keeps the test golden bytes stable across Swift
        // runtimes; it has no effect on the parser.
        return try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    }
}

// ────────────────────────────────────────────────────────────────────────
// Mock — scripted result for tests + dev-mode dry runs.

public final class MockNfcPairReader: NfcPairReaderProtocol, @unchecked Sendable {
    private let scripted: Result<ReadPairResult, NfcPairReaderError>
    public private(set) var callCount: Int = 0

    public init(result: Result<ReadPairResult, NfcPairReaderError>) {
        self.scripted = result
    }

    public func readPair() async throws -> ReadPairResult {
        callCount += 1
        switch scripted {
        case .success(let r): return r
        case .failure(let e): throw e
        }
    }
}

// ────────────────────────────────────────────────────────────────────────
// Live — Core NFC backed.

#if canImport(CoreNFC)

public final class LiveNfcPairReader: NSObject, NfcPairReaderProtocol, NFCTagReaderSessionDelegate, @unchecked Sendable {

    private let alertMessage: String
    private var session: NFCTagReaderSession?
    private var continuation: CheckedContinuation<ReadPairResult, Error>?

    public init(alertMessage: String = "Hold your phone to the Flagship box.") {
        self.alertMessage = alertMessage
    }

    public func readPair() async throws -> ReadPairResult {
        guard NFCTagReaderSession.readingAvailable else {
            throw NfcPairReaderError.sessionUnavailable
        }
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<ReadPairResult, Error>) in
            self.continuation = cont
            let s = NFCTagReaderSession(
                pollingOption: [.iso14443],
                delegate: self,
                queue: nil
            )
            s?.alertMessage = self.alertMessage
            if let s {
                self.session = s
                s.begin()
            } else {
                cont.resume(throwing: NfcPairReaderError.sessionUnavailable)
                self.continuation = nil
            }
        }
    }

    // MARK: NFCTagReaderSessionDelegate

    public func tagReaderSessionDidBecomeActive(_ session: NFCTagReaderSession) {
        // No-op; the user-facing message is already set via session.alertMessage.
    }

    public func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: Error) {
        let mapped = mapInvalidationError(error)
        finish(.failure(mapped))
    }

    public func tagReaderSession(_ session: NFCTagReaderSession, didDetect tags: [NFCTag]) {
        guard let first = tags.first else {
            session.invalidate(errorMessage: "No tag detected.")
            return
        }
        session.connect(to: first) { [weak self] err in
            guard let self else { return }
            if let err {
                session.invalidate(errorMessage: "Couldn't connect: \(err.localizedDescription)")
                return
            }
            let ndefTag = self.asNdefTag(first)
            guard let ndefTag else {
                session.invalidate(errorMessage: "Tag isn't NDEF.")
                self.finish(.failure(.tagFormatUnrecognized))
                return
            }
            ndefTag.queryNDEFStatus { status, _, queryErr in
                if let queryErr {
                    session.invalidate(errorMessage: "NDEF query failed: \(queryErr.localizedDescription)")
                    return
                }
                if status == .notSupported {
                    session.invalidate(errorMessage: "Tag isn't NDEF.")
                    self.finish(.failure(.tagFormatUnrecognized))
                    return
                }
                ndefTag.readNDEF { message, readErr in
                    if let readErr {
                        session.invalidate(errorMessage: "Couldn't read tag: \(readErr.localizedDescription)")
                        return
                    }
                    guard let message else {
                        session.invalidate(errorMessage: "Tag is empty.")
                        self.finish(.failure(.tagFormatUnrecognized))
                        return
                    }
                    do {
                        let records = message.records.map { rec in
                            (type: String(data: rec.type, encoding: .utf8) ?? "", payload: rec.payload)
                        }
                        let result = try NfcPairWireParser.parse(records: records)
                        session.alertMessage = "Box paired."
                        session.invalidate()
                        self.finish(.success(result))
                    } catch let e as NfcPairReaderError {
                        session.invalidate(errorMessage: "Pair failed.")
                        self.finish(.failure(e))
                    } catch {
                        session.invalidate(errorMessage: "Pair failed.")
                        self.finish(.failure(.malformedPayload(error.localizedDescription)))
                    }
                }
            }
        }
    }

    // MARK: helpers

    private func asNdefTag(_ tag: NFCTag) -> NFCNDEFTag? {
        switch tag {
        case .miFare(let t): return t
        case .iso7816(let t): return t
        case .iso15693(let t): return t
        case .feliCa(let t): return t
        @unknown default: return nil
        }
    }

    private func mapInvalidationError(_ error: Error) -> NfcPairReaderError {
        let nsErr = error as NSError
        if nsErr.domain == NFCReaderError.errorDomain {
            switch nsErr.code {
            case NFCReaderError.readerSessionInvalidationErrorUserCanceled.rawValue:
                return .userCanceled
            case NFCReaderError.readerSessionInvalidationErrorSessionTimeout.rawValue:
                return .timeout
            default:
                return .tagFormatUnrecognized
            }
        }
        return .tagFormatUnrecognized
    }

    private func finish(_ result: Result<ReadPairResult, NfcPairReaderError>) {
        guard let cont = continuation else { return }
        continuation = nil
        session = nil
        switch result {
        case .success(let r): cont.resume(returning: r)
        case .failure(let e): cont.resume(throwing: e)
        }
    }
}

#else

/// Platform fallback (macOS SPM build, Simulator) so call sites compile.
/// `readPair` always throws `.sessionUnavailable`.
public final class LiveNfcPairReader: NfcPairReaderProtocol, @unchecked Sendable {
    public init(alertMessage: String = "") {}
    public func readPair() async throws -> ReadPairResult {
        throw NfcPairReaderError.sessionUnavailable
    }
}

#endif
