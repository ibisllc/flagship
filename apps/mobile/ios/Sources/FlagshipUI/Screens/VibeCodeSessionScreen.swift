import SwiftUI
import FlagshipAPI
import FlagshipCore
import Flagship

/// One vibe-code session, shaped like a terminal: a box that fills the screen
/// holds the whole transcript (the owner's prompt, the AI's output as it
/// streams, build logs, the AI's questions), and its pinned footer is the
/// command line — a reply field when the AI asks something, a secret field
/// when it needs an env var, the Deploy button once the app is ready, and the
/// live address after. It replaces the separate "Generating" and
/// chat/deploy screens.
///
/// Two feeds drive it: the WS frame stream (`VibeCodeStreamViewModel`, live
/// tokens + build logs) and the polled session state (messages, status and
/// the pending tool request, which the stream never carries).
@MainActor
public struct VibeCodeSessionScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL
    @Bindable var stream: VibeCodeStreamViewModel

    @State private var state: VibeCodeSessionPublicState?
    @State private var errorMessage: String?
    @State private var replyDraft = ""
    @State private var envValueDraft = ""
    @State private var submitting = false
    @State private var deploying = false
    @State private var deployStartedAt: Date?
    /// Where a staged deploy is: "staging" | "fixing" | "going-live".
    @State private var deployPhase: String?
    /// The relay was turned off for the session's key after a relay failure:
    /// the next reply carries the key again so the box uses the new setting.
    @State private var relayTurnedOff = false
    @State private var deployedUrl: String?
    @State private var leftOpen = false
    @State private var shownLines: [VibeTranscript.Line] = []
    @State private var hiddenMessages = 0
    @State private var pollTask: Task<Void, Never>?
    /// Follow new output only while the owner is at the bottom; scrolling up to
    /// read stops the box from jumping away under their finger.
    @State private var followTail = true

    public let serverFqdn: String
    public let client: any ScreensClient
    public let signEnvelope: @MainActor (ServiceEnvSetEnvelope) async throws -> String
    /// The owner's saved AI key, sent with a reply only when the box says it
    /// has none for this session.
    public let savedCredential: () -> LlmProviderCredential?
    /// Mints a fresh free-AI credential for this box (nil ⇒ not offered).
    public let freeAiCredential: (@MainActor () async throws -> LlmProviderCredential)?

    public init(
        stream: VibeCodeStreamViewModel,
        serverFqdn: String,
        client: any ScreensClient,
        signEnvelope: @escaping @MainActor (ServiceEnvSetEnvelope) async throws -> String,
        savedCredential: @escaping () -> LlmProviderCredential? = { nil },
        freeAiCredential: (@MainActor () async throws -> LlmProviderCredential)? = nil
    ) {
        self.stream = stream
        self.serverFqdn = serverFqdn
        self.client = client
        self.signEnvelope = signEnvelope
        self.savedCredential = savedCredential
        self.freeAiCredential = freeAiCredential
    }

    /// The key a reply carries: a fresh free-AI credential when the session
    /// runs on free AI (tokens expire, so every send re-mints); otherwise a
    /// saved key only when the box lacks one (or its relay setting just
    /// changed), falling back to free AI when nothing is saved. Throws
    /// `FreeAiError.usedUp` so the owner sees why nothing was sent.
    private func replyCredential() async throws -> LlmProviderCredential? {
        try await VibeCodeReplyCredential.resolve(
            sessionId: sessionId,
            boxNeedsKey: state?.needsCredential == true || relayTurnedOff,
            saved: savedCredential,
            freeAi: freeAiCredential
        )
    }

    /// The failure on show is the Flagship relay being unavailable.
    private var relayFailureShown: Bool {
        guard !relayTurnedOff else { return false }
        return RelayFailure.matches(errorMessage ?? state?.failureReason ?? stream.errorMessage)
    }

    private var sessionId: String { stream.sessionId }
    private var status: String { state?.status ?? (stream.status == .failed ? "failed" : "streaming") }
    private var liveUrl: String? { deployedUrl ?? stream.deployedUrl }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: FS.space.s3) {
                        transcript(c: c)
                        Color.clear.frame(height: 1).id("tail")
                    }
                    .padding(FS.space.s4)
                }
                .defaultScrollAnchor(.bottom)
                .onScrollGeometryChange(for: Bool.self) { geo in
                    geo.contentOffset.y + geo.containerSize.height >= geo.contentSize.height - 48
                } action: { _, atBottom in
                    followTail = atBottom
                }
                .onChange(of: contentSignature) {
                    if followTail { proxy.scrollTo("tail", anchor: .bottom) }
                }
                .overlay(alignment: .bottomTrailing) {
                    if !followTail {
                        Button {
                            followTail = true
                            withAnimation { proxy.scrollTo("tail", anchor: .bottom) }
                        } label: {
                            Image(systemName: "arrow.down.circle.fill")
                                .font(.system(size: 28))
                                .foregroundStyle(c.primary)
                                .background(Circle().fill(c.surface))
                        }
                        .padding(FS.space.s3)
                        .accessibilityLabel("Jump to latest")
                    }
                }
            }
            Divider().overlay(c.border)
            footer(c: c)
                .padding(FS.space.s3)
                .background(c.surface)
        }
        .background(c.surfaceSunken)
        .clipShape(RoundedRectangle(cornerRadius: FS.radius.md))
        .overlay(RoundedRectangle(cornerRadius: FS.radius.md).stroke(c.border, lineWidth: 1))
        .padding(.horizontal, FS.space.s4)
        .padding(.vertical, FS.space.s3)
        .background(c.bg.ignoresSafeArea())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            stream.start()
            await reload()
            startPolling()
        }
        .onDisappear {
            stream.cancel()
            pollTask?.cancel()
            pollTask = nil
        }
    }

    private var title: String {
        if deploying { return "Deploying" }
        switch status {
        case "streaming": return stream.status == .building ? "Building" : "Generating"
        case "awaiting-tool-response": return "Your turn"
        case "ready-to-deploy": return "Ready to deploy"
        case "deploying": return "Deploying"
        case "deployed": return "Live"
        case "failed", "cancelled": return "Stopped"
        default: return "Vibe code"
        }
    }

    /// Changes whenever new text lands, to drive the follow-the-tail scroll.
    private var contentSignature: Int {
        (state?.messages.count ?? 0) &* 1_000_003 &+ stream.transcript.count &* 31 &+ stream.buildLogs.count
            &+ (state?.pendingRequest == nil ? 0 : 7) &+ (liveUrl == nil ? 0 : 13)
    }

    // MARK: - Transcript

    @ViewBuilder
    private func transcript(c: FSColors) -> some View {
        Text("session \(sessionId)").font(FS.font.caption()).foregroundColor(c.textMuted)
        if hiddenMessages > 0 {
            Text("… \(hiddenMessages) earlier message\(hiddenMessages == 1 ? "" : "s") not shown")
                .font(FS.font.caption()).foregroundColor(c.textMuted)
        }
        ForEach(Array(shownLines.enumerated()), id: \.offset) { _, msg in
            line(role: msg.role, text: msg.text, c: c)
        }
        if status == "streaming", !stream.transcript.isEmpty {
            Text(VibeTranscript.compact(stream.transcript, live: true) + " ▍")
                .font(FS.font.mono())
                .foregroundColor(c.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        } else if state == nil && stream.transcript.isEmpty {
            HStack(spacing: FS.space.s2) {
                ProgressView()
                Text("Starting the session…").font(FS.font.mono()).foregroundColor(c.textMuted)
            }
        }
        ForEach(stream.buildLogs.indices, id: \.self) { i in
            Text(stream.buildLogs[i])
                .font(.system(size: 12, design: .monospaced))
                .foregroundColor(c.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        if let pending = state?.pendingRequest {
            pendingLine(pending, c: c)
        }
        if !["ready-to-deploy", "failed", "cancelled"].contains(status), let err = errorMessage ?? stream.errorMessage {
            Text("✗ \(err)").font(FS.font.mono()).foregroundColor(c.danger)
        }
        if let url = liveUrl, !url.isEmpty {
            Text("✓ Live at \(url)")
                .font(FS.font.mono())
                .foregroundColor(c.success)
                .accessibilityIdentifier("vibecode-deployed-url")
        }
    }

    private func line(role: String, text: String, c: FSColors) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: FS.space.s2) {
            Text(role == "user" ? "›" : " ")
                .font(FS.font.mono().weight(.bold))
                .foregroundColor(c.primary)
            Text(text)
                .font(FS.font.mono())
                .foregroundColor(role == "user" ? c.primary : c.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
    }

    @ViewBuilder
    private func pendingLine(_ pending: VibeCodePendingRequest, c: FSColors) -> some View {
        switch pending {
        case .talkToUser(_, let message):
            Text("? \(message)").font(FS.font.mono().weight(.semibold)).foregroundColor(c.text)
        case .requestEnvVar(_, let name, let description, let why, let example, _):
            VStack(alignment: .leading, spacing: 4) {
                Text("? The app needs \(name): \(description)")
                    .font(FS.font.mono().weight(.semibold)).foregroundColor(c.text)
                Text("  why: \(why)").font(FS.font.mono()).foregroundColor(c.textMuted)
                if let example, !example.isEmpty {
                    Text("  e.g. \(example)").font(FS.font.mono()).foregroundColor(c.textMuted)
                }
            }
        }
    }

    // MARK: - Command line

    @ViewBuilder
    private func footer(c: FSColors) -> some View {
        if let url = liveUrl, !url.isEmpty {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack(spacing: FS.space.s3) {
                    Text(url).font(FS.font.mono()).foregroundColor(c.text).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 0)
                    FSPrimaryButton("Open") {
                        if let u = URL(string: url.hasPrefix("http") ? url : "https://\(url)") { openURL(u) }
                    }
                }
                if leftOpen {
                    Text("This server couldn't make it invite only, so anyone with the link can open it. You can restrict it from the service's Access settings.")
                        .font(FS.font.bodySm()).foregroundColor(c.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } else if let pending = state?.pendingRequest {
            switch pending {
            case .talkToUser:
                HStack(spacing: FS.space.s2) {
                    Text("›").font(FS.font.mono().weight(.bold)).foregroundColor(c.primary)
                    TextField("Reply to the AI", text: $replyDraft, axis: .vertical)
                        .font(FS.font.mono())
                        .lineLimit(1...4)
                        .submitLabel(.send)
                        .onSubmit { Task { await submitReply() } }
                        .accessibilityIdentifier("vibecode-reply-field")
                    Button { Task { await submitReply() } } label: {
                        Image(systemName: submitting ? "ellipsis.circle" : "arrow.up.circle.fill")
                            .font(.system(size: 26)).foregroundColor(c.primary)
                    }
                    .disabled(submitting || replyDraft.isEmpty)
                    .accessibilityIdentifier("vibecode-reply-send-btn")
                }
            case .requestEnvVar(_, let name, _, _, _, _):
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    HStack(spacing: FS.space.s2) {
                        Text("\(name) ›").font(FS.font.mono().weight(.bold)).foregroundColor(c.primary)
                        SecureField("value", text: $envValueDraft)
                            .font(FS.font.mono())
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .accessibilityIdentifier("vibecode-envvar-field")
                    }
                    HStack(spacing: FS.space.s3) {
                        FSPrimaryButton(submitting ? "Sending…" : "Send value",
                                        enabled: !submitting && !envValueDraft.isEmpty && state?.appId != nil) {
                            Task { await submitEnvVar(name: name) }
                        }
                        .accessibilityIdentifier("vibecode-envvar-send-btn")
                        Button("Decline") { Task { await declineEnvVar() } }
                            .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                            .accessibilityIdentifier("vibecode-envvar-decline-btn")
                        Spacer(minLength: 0)
                        Text("Sent once to your server").font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                }
            }
        } else if deploying || status == "deploying" {
            TimelineView(.periodic(from: .now, by: 15)) { context in
                let mins = deployStartedAt.map { Int(context.date.timeIntervalSince($0)) / 60 } ?? 0
                HStack(spacing: FS.space.s2) {
                    ProgressView()
                    Text("\(VibeCodeDeployRun.phaseText(deployPhase ?? state?.deployPhase)) \(mins > 0 ? "\(mins) min, " : "")this can take a few minutes")
                        .font(FS.font.mono()).foregroundColor(c.textMuted)
                    Spacer(minLength: 0)
                }
            }
            .accessibilityIdentifier("vibecode-deploying")
        } else if status == "ready-to-deploy" {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                if let err = errorMessage {
                    Text("✗ \(err)").font(FS.font.mono()).foregroundColor(c.danger)
                }
                FSPrimaryButton("Deploy", enabled: true, block: true) {
                    Task { await deploy() }
                }
                .accessibilityIdentifier("vibecode-deploy-btn")
            }
        } else if status == "failed" || status == "cancelled" {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text("✗ \(errorMessage ?? state?.failureReason ?? stream.errorMessage ?? "Session stopped.")")
                    .font(FS.font.mono()).foregroundColor(c.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                relayAction(c: c)
                if status == "failed", state?.appId != nil {
                    FSPrimaryButton("Try deploying again", enabled: true, block: true) {
                        Task { await deploy() }
                    }
                    .accessibilityIdentifier("vibecode-redeploy-btn")
                }
            }
        } else {
            HStack(spacing: FS.space.s2) {
                ProgressView()
                Text(stream.status == .building ? "Building your app…" : "The AI is writing your app…")
                    .font(FS.font.mono()).foregroundColor(c.textMuted)
                Spacer(minLength: 0)
            }
        }
    }

    /// "Turn the relay off for this key" under a relay failure.
    @ViewBuilder
    private func relayAction(c: FSColors) -> some View {
        if relayFailureShown {
            FSSecondaryButton(AiKeyRelayCopy.turnOff, block: true) { turnRelayOff() }
                .accessibilityIdentifier("vibecode-relay-off")
        } else if relayTurnedOff {
            Text(AiKeyRelayCopy.turnedOff).font(FS.font.bodySm()).foregroundColor(c.textMuted)
        }
    }

    private func turnRelayOff() {
        let store = SavedKeyStore()
        if let cred = savedCredential(), let entry = store.entry(for: cred) {
            try? store.setRelay(id: entry.id, relay: false)
        } else if let active = store.active() {
            try? store.setRelay(id: active.id, relay: false)
        }
        relayTurnedOff = true
    }

    // MARK: - Actions

    private func reload() async {
        do {
            let next = try await client.vibeCodeSessionState(sessionId: sessionId)
            guard next != state else { return }
            let wasEmpty = state == nil
            let before = state?.status
            state = next
            let shown = VibeTranscript.lines(next.messages)
            hiddenMessages = shown.hidden
            shownLines = shown.lines
            if wasEmpty { errorMessage = nil }
            // The live URL and the failure reason ride the stream, which may
            // have closed when the AI finished; reattaching replays them.
            if before != next.status, ["deployed", "failed"].contains(next.status) {
                deploying = false
                stream.start()
            }
        } catch {
            if state == nil { errorMessage = ScreensClientError.userFacing(error) }
        }
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                if Task.isCancelled { break }
                if deploying || ["streaming", "awaiting-tool-response", "ready-to-deploy", "deploying"].contains(status) || state == nil {
                    await reload()
                }
            }
        }
    }

    /// The box tests the app on a private copy, then installs it; a current
    /// box answers at once and this follows the session, an older one answers
    /// when it's done. If the connection drops, the box keeps going, so keep
    /// watching the session status (polled above) instead of reporting a failure.
    private func deploy() async {
        guard !deploying else { return }
        deploying = true
        deployStartedAt = Date()
        deployPhase = nil
        errorMessage = nil
        do {
            let deployCredential: LlmProviderCredential?
            if FreeAiSessions.isFreeAi(sessionId), let freeAiCredential {
                deployCredential = try? await freeAiCredential()
            } else {
                deployCredential = savedCredential()
            }
            let outcome = try await VibeCodeDeployRun.run(client: client, sessionId: sessionId,
                                                          credential: deployCredential) { phase in
                deployPhase = phase
            }
            switch outcome {
            case .deployed(let url, let inviteOnly):
                if !url.isEmpty { deployedUrl = url }
                leftOpen = inviteOnly == false
            case .failed(let reason):
                errorMessage = reason
            case .unknown:
                break
            }
            deploying = false
            deployPhase = nil
            await reload()
        } catch ScreensClientError.http(let code, let message) where code != 0 {
            deploying = false
            deployPhase = nil
            errorMessage = Self.boxError(message) ?? ScreensClientError.plainLanguage(forStatus: code)
            await reload()
        } catch {
            // Transport loss: the deploy goes on without us; the poll sees
            // the session reach deployed or failed.
        }
    }

    /// The daemon's `{ "error": "<reason>" }` body, e.g. "docker build failed: …".
    nonisolated static func boxError(_ body: String) -> String? {
        guard let data = body.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let e = obj["error"] as? String, !e.isEmpty else { return nil }
        return String(e.prefix(600))
    }

    private func submitReply() async {
        guard !replyDraft.isEmpty, !submitting else { return }
        submitting = true
        defer { submitting = false }
        do {
            let credential = try await replyCredential()
            _ = try await client.vibeCodeSessionReply(
                sessionId: sessionId, VibeCodeReplyRequest(text: replyDraft, envVarStatus: nil, credential: credential))
            replyDraft = ""
            followTail = true
            await reload()
        } catch {
            errorMessage = ScreensClientError.userFacing(error)
        }
    }

    private func submitEnvVar(name: String) async {
        // appId = "<creator>--<slug>"; both halves may carry single dashes
        // (docs/service-addressing-double-dash.md).
        guard let appId = state?.appId, let delim = appId.range(of: "--") else {
            errorMessage = "The app has no id yet. Wait for the AI to name it."
            return
        }
        submitting = true
        defer { submitting = false }
        let envelope = ServiceEnvSetEnvelope(
            serverId: serverFqdn,
            creator: String(appId[..<delim.lowerBound]),
            slug: String(appId[delim.upperBound...]),
            env: [name: envValueDraft],
            issuedAt: Int64(Date().timeIntervalSince1970 * 1000))
        do {
            // The value travels only through /env/set; /reply just acknowledges.
            let signature = try await signEnvelope(envelope)
            _ = try await client.serviceEnvSet(
                appId: appId,
                ServiceEnvSetRequest(name: name, value: envValueDraft, request: envelope, signature: signature))
            _ = try await client.vibeCodeSessionReply(
                sessionId: sessionId, VibeCodeReplyRequest(text: nil, envVarStatus: "set", credential: try await replyCredential()))
            envValueDraft = ""
            await reload()
        } catch {
            errorMessage = ScreensClientError.userFacing(error)
        }
    }

    private func declineEnvVar() async {
        submitting = true
        defer { submitting = false }
        do {
            _ = try await client.vibeCodeSessionReply(
                sessionId: sessionId, VibeCodeReplyRequest(text: nil, envVarStatus: "declined", credential: try await replyCredential()))
            await reload()
        } catch {
            errorMessage = ScreensClientError.userFacing(error)
        }
    }
}

/// Which key a vibe-code reply carries. Separate from the view so it's
/// testable. MIRRORS the webapp `views/vibe-code.js` reply path.
@MainActor
enum VibeCodeReplyCredential {
    static func resolve(
        sessionId: String,
        boxNeedsKey: Bool,
        saved: () -> LlmProviderCredential?,
        freeAi: (@MainActor () async throws -> LlmProviderCredential)?
    ) async throws -> LlmProviderCredential? {
        if FreeAiSessions.isFreeAi(sessionId), let freeAi {
            do {
                return try await freeAi()
            } catch let e as FreeAiError {
                if case .usedUp = e { throw e }
                // Unavailable for now: the box keeps the token it holds.
                return nil
            } catch {
                return nil
            }
        }
        guard boxNeedsKey else { return nil }
        if let key = saved() { return key }
        guard let freeAi else { return nil }
        let fresh = try await freeAi()
        FreeAiSessions.mark(sessionId)
        return fresh
    }
}
