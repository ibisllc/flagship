import SwiftUI
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// "Sign in with Flagship" for a voi.ci page (docs/voici-and-messages.md §6, §11.4): the visitor's app shows the page's
/// verified name and photo and the 6-digit code the browser also shows; Approve (one Face ID) derives this account's
/// pseudonym for the page, gets `.com`'s attestation of it (with App Attest and DeviceCheck evidence), signs the web
/// delegation for the browser's key and the thread statement, and seals the answer to the browser over `/qr-pipe`.
@MainActor
@Observable
final class VoiciSignInViewModel {
    enum Phase: Equatable { case loading, ready(code: String), approving, done, failed(String) }

    let link: VoiciSignInLink
    private let client: any VoiciComClient
    private let relay: any QrRelayClient
    private let username: String
    private let now: () -> Int64
    private(set) var phase: Phase = .loading
    private(set) var displayName = ""
    private(set) var avatar: [UInt8]?
    private(set) var pseudonymName: String?
    /// The 6-digit code both sides show.
    private(set) var code = ""
    @ObservationIgnored private var aeadKey: SymmetricKey?

    init(link: VoiciSignInLink, client: any VoiciComClient, relay: any QrRelayClient, username: String,
         now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.link = link
        self.client = client
        self.relay = relay
        self.username = username.lowercased()
        self.now = now
    }

    func start() async {
        let r = link.request
        do {
            let keys = try await client.accountKeys(username: r.username)
            guard let raw = try await client.page(username: r.username) else { phase = .failed(String(localized: "This page isn't on voi.ci.")); return }
            let s = keys.sensitive
            guard case .ok(let idx) = VoiciPage.checkVoiciPageIndex(raw, username: r.username, sensitiveKind: s.kind, sensitivePub: s.pub, pageId: r.pageId) else {
                phase = .failed(String(localized: "This page couldn't be checked."))
                return
            }
            guard idx.acceptsMessages == 1 else { phase = .failed(String(localized: "This page isn't taking messages.")); return }
            guard let profileRef = idx.pieces.first(where: { $0.role == "profile" }) else { phase = .failed(String(localized: "This page couldn't be checked.")); return }
            let bytes = try await client.piece(pageId: idx.pageId, sha256: profileRef.sha256)
            guard CanonicalJson.sha256Hex(bytes) == profileRef.sha256, let profile = VoiciPage.parseVoiciProfilePiece(bytes) else {
                phase = .failed(String(localized: "This page couldn't be checked."))
                return
            }
            displayName = profile.displayName
            if let a = idx.pieces.first(where: { $0.role == "avatar" }), let b = try? await client.piece(pageId: idx.pageId, sha256: a.sha256),
               CanonicalJson.sha256Hex(b) == a.sha256, VoiciPage.isVoiciJpeg(b) {
                avatar = b
            }
            if let umk = Keystore.messagesUMKIfCached(),
               let p = try? VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: VoiciMessages.deriveMessagesSecret(umk: Array(umk)), pageId: r.pageId) {
                pseudonymName = try? VoiciText.voiciPseudonymName(CanonicalJson.hex(p.publicKey), prefix: String(localized: "Visitor "))
            }
            let sk = Curve25519.KeyAgreement.PrivateKey()
            let derived = try QrRelay.deriveMaterial(phonePrivateKey: sk, browserPublicKey: link.session.browserPublicKey)
            try await relay.openAndHello(sid: link.session.sid, phonePkBase64Url: Base64URL.encode(sk.publicKey.rawRepresentation))
            aeadKey = derived.aeadKey
            code = derived.matchCode
            phase = .ready(code: derived.matchCode)
        } catch {
            phase = .failed(Self.sentence(error))
        }
    }

    func approve() async {
        guard case .ready = phase, let key = aeadKey else { return }
        phase = .approving
        let r = link.request
        do {
            let umk = Array(try await Keystore.messagesUMK(reason: String(localized: "Sign in to voi.ci")))
            let secret = VoiciMessages.deriveMessagesSecret(umk: umk)
            let p = try VoiciMessages.deriveMessagesPseudonymKey(messagesSecret: secret, pageId: r.pageId)
            let t = try VoiciMessages.deriveMessagesThreadKey(messagesSecret: secret, pageId: r.pageId)
            let pPub = CanonicalJson.hex(p.publicKey)
            pseudonymName = try? VoiciText.voiciPseudonymName(pPub, prefix: String(localized: "Visitor "))
            let att = try await attestation(pseudonymPub: pPub)
            let t0 = now()
            let del = WebDelegation(scope: "voici-messages", origin: r.origin, audience: r.pageId, principalPub: pPub, delegatePub: r.delegatePub,
                                    issuedAt: t0, expiresAt: min(att.expiresAt, t0 + MessagesAttestations.ttlMs), nonce: r.nonce)
            let ts = VoiciThreadStatement(pageId: r.pageId, pseudonymPub: pPub, threadPub: CanonicalJson.hex(t.publicKey), issuedAt: t0)
            let cred = VoiciMessageCred(attestation: att, delegation: del, delegationSig: try WebDelegations.signWebDelegation(del, principalSeed: p.seed),
                                        threadStmt: ts, threadSig: try VoiciMessages.signVoiciThreadStatement(ts, pseudonymSeed: p.seed))
            let answer = VoiciSignInAnswer(pageId: r.pageId, pseudonymPub: pPub, cred: cred, threadSeed: CanonicalJson.hex(t.seed))
            let sealed = try QrRelay.seal(payload: Data(try CanonicalJson.canonicalJson(answer.json).utf8), with: key)
            try await relay.deliver(ciphertextBase64Url: sealed.ciphertextBase64Url, nonceBase64Url: sealed.nonceBase64Url)
            await relay.close()
            aeadKey = nil
            VoiciSignInBook.remember(pageId: r.pageId, username: r.username, displayName: displayName)
            VoiciSignInBook.keep(delegation: del.json, signature: cred.delegationSig)
            await MessagesStore.shared.recordSignIn(pageId: r.pageId, delegatePub: r.delegatePub)
            phase = .done
        } catch {
            phase = .failed(Self.sentence(error))
            await relay.close()
        }
    }

    func cancel() async {
        aeadKey = nil
        await relay.close()
    }

    /// The kept attestation of P while it is valid, a renewal of one that ended within 7 days, else a new one.
    private func attestation(pseudonymPub: String) async throws -> MessagesKeyAttestation {
        let ca = await client.caKeys()
        let storeKey = VoiciSignInBook.attestationKey(link.request.pageId)
        let kept = UserDefaults.standard.string(forKey: storeKey).flatMap { JSONValue.parse($0) }
            .flatMap { MessagesAttestations.parseMessagesKeyAttestation($0) }
            .flatMap { $0.pseudonymPub == pseudonymPub ? $0 : nil }
        let t = now()
        if let kept, kept.expiresAt - t > 86_400_000, MessagesAttestations.checkMessagesKeyAttestation(kept.json, caKeys: ca, now: t, pseudonymPub: pseudonymPub).isOk {
            return kept
        }
        let renewOf = kept.flatMap { k in t - k.expiresAt <= MessagesAttestations.renewGraceMs ? try? MessagesAttestations.messagesAttestationHash(k) : nil } ?? ""
        let store = MessagesStore.shared
        guard let device = store.deviceKey(), let signer = store.device else { throw VoiciComError(status: 0, code: "locked") }
        var request = MessagesKeyAttestationRequest(username: username, pseudonymPub: pseudonymPub, renewOfHash: renewOf,
                                                    deviceCheckRef: DeviceIntegrity.ref, issuedAt: t)
        var evidence = await DeviceIntegrity.evidence(requestBytes: try MessagesAttestations.canonicalMessagesKeyAttestationRequest(request))
        if evidence.ref != request.deviceCheckRef {
            // The evidence is over the request's bytes, which name the platform: without evidence it says "none".
            request.deviceCheckRef = "none"
            evidence = DeviceIntegrity.Evidence(ref: "none", json: nil)
        }
        let sig = try MessagesAttestations.signMessagesKeyAttestationRequest(request, deviceSeed: Array(device.rawRepresentation))
        let raw = try await client.attest(username: username, request: request, signature: sig, integrity: evidence.json,
                                          previous: renewOf.isEmpty ? nil : kept?.json, device: signer)
        guard case .ok(let att) = MessagesAttestations.checkMessagesKeyAttestation(raw, caKeys: ca, now: now(), pseudonymPub: pseudonymPub) else {
            throw VoiciComError(status: 200, code: "bad-attestation")
        }
        if let text = try? CanonicalJson.canonicalJson(att.json) { UserDefaults.standard.set(text, forKey: storeKey) }
        return att
    }

    static func sentence(_ error: Error) -> String {
        if let e = error as? VoiciComError {
            switch e.code {
            case "first-contact-limit":
                let when = e.retryAfterSec.map { Date().addingTimeInterval(TimeInterval($0)).formatted(.relative(presentation: .named)) }
                    ?? String(localized: "tomorrow")
                if let limit = e.limit { return String(localized: "You can start \(limit) new conversations a day. Try again \(when).") }
                return String(localized: "You've started as many new conversations as you can today. Try again \(when).")
            case "device-limit": return String(localized: "This device already set up Messages for another account this month.")
            case "banned": return String(localized: "Your account can't send messages. If you think this is a mistake, tell us.")
            case "unattested-too-new": return String(localized: "New accounts can start conversations from the web after 7 days.")
            case "bad-attestation": return String(localized: "Flagship's answer couldn't be checked. Try again.")
            default: return MessagesStore.sentence(e)
            }
        }
        if let e = error as? QrRelayError {
            switch e {
            case .peerMissing, .sessionExpired: return String(localized: "The voi.ci page stopped waiting. Start again from the page.")
            default: return String(localized: "Couldn't reach the voi.ci page. Try again.")
            }
        }
        return UserErrorText.of(error)
    }
}

struct VoiciSignInScreen: View {
    @State var vm: VoiciSignInViewModel
    var onDone: () -> Void
    @State private var showRules = false
    @State private var afterRules = false

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                AvatarView(sha: nil, bytes: vm.avatar, size: 88)
                switch vm.phase {
                case .loading:
                    ProgressView().padding(.top, 20)
                case .failed(let why):
                    Text(verbatim: why).multilineTextAlignment(.center).foregroundStyle(.secondary)
                        .accessibilityIdentifier("voici-signin-error")
                    Button("Close", action: onDone).buttonStyle(.bordered)
                case .done:
                    Label("You're signed in. Go back to voi.ci to write your message.", systemImage: "checkmark.circle.fill")
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("voici-signin-done")
                    Button("Done", action: onDone).buttonStyle(.borderedProminent)
                case .ready, .approving:
                    readyView(code: vm.code)
                }
            }
            .padding(24)
        }
        .navigationTitle(Text("Sign in to voi.ci"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await vm.start() }
        .sheet(isPresented: $showRules, onDismiss: {
            if afterRules {
                afterRules = false
                Task { await vm.approve() }
            }
        }) {
            VoiciRulesSheet { afterRules = true }
        }
    }

    private func readyView(code: String) -> some View {
        VStack(spacing: 16) {
            Text(verbatim: String(localized: "Sign in to voi.ci to message \(vm.displayName)?"))
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("voici-signin-title")
            if !code.isEmpty {
                VStack(spacing: 4) {
                    Text("Check the code matches the one on the page")
                        .font(.footnote).foregroundStyle(.secondary)
                    Text(verbatim: code)
                        .font(.system(size: 34, weight: .semibold, design: .monospaced))
                        .accessibilityIdentifier("voici-signin-code")
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                if let name = vm.pseudonymName {
                    Text(verbatim: String(localized: "You appear as \(name). They never see your username."))
                } else {
                    Text("You appear as a visitor. They never see your username.")
                }
                Text("Messages are private. If someone reports your message, Flagship can see which account sent it.")
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                if VoiciRules.accepted { Task { await vm.approve() } } else { showRules = true }
            } label: {
                Text(vm.phase == .approving ? String(localized: "Approving…") : String(localized: "Approve")).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(vm.phase == .approving)
            .accessibilityIdentifier("voici-signin-approve")
            Button("Cancel", role: .cancel) {
                Task {
                    await vm.cancel()
                    onDone()
                }
            }
        }
    }
}
