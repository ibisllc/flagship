import Foundation
import Flagship
import FlagshipAPI
import FlagshipCore

/// This account as a visitor of someone's voi.ci page (docs/voici-and-messages.md §6): its pseudonym P there, `.com`'s
/// attestation of P, a web delegation from P to a P-256 key, and the thread statement. The sign-in approval answers a
/// browser with it; calling from the app (docs/voici-calls.md "Calling from the app") signs its call request with it,
/// or hands it to the browser for one call.
@MainActor
enum VoiciVisitorSession {
    /// A sign-in answer for `pageId` naming `delegatePub`, its delegation lasting `ttlMs` at most (and never past the
    /// attestation).
    static func answer(client: any VoiciComClient, username: String, pageId: String, origin: String, delegatePub: String, nonce: String,
                       ttlMs: Int64, umk: [UInt8], now: Int64) async throws -> (answer: VoiciSignInAnswer, delegation: WebDelegation) {
        let secret = VoiciMessages.deriveMessagesSecret(umk: umk)
        let p = try VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: secret, pageId: pageId)
        let t = try VoiciMessages.deriveMessagesThreadKey(messagesSecret: secret, pageId: pageId)
        let pPub = CanonicalJson.hex(p.publicKey)
        let att = try await attestation(client: client, username: username, pageId: pageId, pseudonymPub: pPub, now: now)
        let del = WebDelegation(scope: "voici-messages", origin: origin, audience: pageId, principalPub: pPub, delegatePub: delegatePub,
                                issuedAt: now, expiresAt: min(att.expiresAt, now + ttlMs), nonce: nonce)
        let ts = VoiciThreadStatement(pageId: pageId, pseudonymPub: pPub, threadPub: CanonicalJson.hex(t.publicKey), issuedAt: now)
        let cred = VoiciMessageCred(attestation: att, delegation: del, delegationSig: try WebDelegations.signWebDelegation(del, principalSeed: p.seed),
                                    threadStmt: ts, threadSig: try VoiciMessages.signVoiciThreadStatement(ts, pseudonymSeed: p.seed))
        return (VoiciSignInAnswer(pageId: pageId, pseudonymPub: pPub, cred: cred, threadSeed: CanonicalJson.hex(t.seed)), del)
    }

    /// The kept attestation of P while it is valid, a renewal of one that ended within 7 days, else a new one.
    static func attestation(client: any VoiciComClient, username: String, pageId: String, pseudonymPub: String,
                            now: Int64) async throws -> MessagesKeyAttestation {
        let ca = await client.caKeys()
        let storeKey = VoiciSignInBook.attestationKey(pageId)
        let kept = UserDefaults.standard.string(forKey: storeKey).flatMap { JSONValue.parse($0) }
            .flatMap { MessagesAttestations.parseMessagesKeyAttestation($0) }
            .flatMap { $0.pseudonymPub == pseudonymPub ? $0 : nil }
        if let kept, kept.expiresAt - now > 86_400_000, MessagesAttestations.checkMessagesKeyAttestation(kept.json, caKeys: ca, now: now, pseudonymPub: pseudonymPub).isOk {
            return kept
        }
        let renewOf = kept.flatMap { k in now - k.expiresAt <= MessagesAttestations.renewGraceMs ? try? MessagesAttestations.messagesAttestationHash(k) : nil } ?? ""
        let store = MessagesStore.shared
        guard let device = store.deviceKey(), let signer = store.device else { throw VoiciComError(status: 0, code: "locked") }
        var request = MessagesKeyAttestationRequest(username: username, pseudonymPub: pseudonymPub, renewOfHash: renewOf,
                                                    deviceCheckRef: DeviceIntegrity.ref, issuedAt: now)
        var evidence = await DeviceIntegrity.evidence(requestBytes: try MessagesAttestations.canonicalMessagesKeyAttestationRequest(request))
        if evidence.ref != request.deviceCheckRef {
            // The evidence is over the request's bytes, which name the platform: without evidence it says "none".
            request.deviceCheckRef = "none"
            evidence = DeviceIntegrity.Evidence(ref: "none", json: nil)
        }
        let sig = try MessagesAttestations.signMessagesKeyAttestationRequest(request, deviceSeed: Array(device.rawRepresentation))
        let raw = try await client.attest(username: username, request: request, signature: sig, integrity: evidence.json,
                                          previous: renewOf.isEmpty ? nil : kept?.json, device: signer)
        // `.com`'s clock may run a little ahead of this phone's (and it answers after `now` was read): judge a
        // just-issued attestation at its own issuedAt, as Android does.
        let issued = MessagesAttestations.parseMessagesKeyAttestation(raw)?.issuedAt ?? now
        let checkAt = issued > now && issued - now <= VoiciMessages.sendSkewMs ? issued : now
        guard case .ok(let att) = MessagesAttestations.checkMessagesKeyAttestation(raw, caKeys: ca, now: checkAt, pseudonymPub: pseudonymPub) else {
            throw VoiciComError(status: 200, code: "bad-attestation")
        }
        if let text = try? CanonicalJson.canonicalJson(att.json) { UserDefaults.standard.set(text, forKey: storeKey) }
        return att
    }
}
