import SwiftUI
import FlagshipAPI
import FlagshipCore

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
    @State private var deployedUrl: String?
    @State private var pollTask: Task<Void, Never>?
    /// Follow new output only while the owner is at the bottom; scrolling up to
    /// read stops the box from jumping away under their finger.
    @State private var followTail = true

    public let serverFqdn: String
    public let client: any ScreensClient
    public let signEnvelope: @MainActor (ServiceEnvSetEnvelope) async throws -> String

    public init(
        stream: VibeCodeStreamViewModel,
        serverFqdn: String,
        client: any ScreensClient,
        signEnvelope: @escaping @MainActor (ServiceEnvSetEnvelope) async throws -> String
    ) {
        self.stream = stream
        self.serverFqdn = serverFqdn
        self.client = client
        self.signEnvelope = signEnvelope
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
        ForEach(Array((state?.messages ?? []).enumerated()), id: \.offset) { _, msg in
            line(role: msg.role, text: msg.text, c: c)
        }
        if status == "streaming", !stream.transcript.isEmpty {
            Text(stream.transcript + " ▍")
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
        if let url = liveUrl, !url.isEmpty {
            Text("✓ Live at \(url)")
                .font(FS.font.mono())
                .foregroundColor(c.success)
                .accessibilityIdentifier("vibecode-deployed-url")
        }
        if let err = errorMessage ?? stream.errorMessage {
            Text("✗ \(err)").font(FS.font.mono()).foregroundColor(c.danger)
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
            HStack(spacing: FS.space.s3) {
                Text(url).font(FS.font.mono()).foregroundColor(c.text).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
                FSPrimaryButton("Open") {
                    if let u = URL(string: url.hasPrefix("http") ? url : "https://\(url)") { openURL(u) }
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
        } else if status == "ready-to-deploy" || status == "deploying" || deploying {
            FSPrimaryButton((deploying || status == "deploying") ? "Deploying…" : "Deploy",
                            enabled: !deploying && status == "ready-to-deploy", block: true) {
                Task { await deploy() }
            }
            .accessibilityIdentifier("vibecode-deploy-btn")
        } else if status == "failed" || status == "cancelled" {
            Text("Session stopped.").font(FS.font.mono()).foregroundColor(c.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            HStack(spacing: FS.space.s2) {
                ProgressView()
                Text(stream.status == .building ? "Building your app…" : "The AI is writing your app…")
                    .font(FS.font.mono()).foregroundColor(c.textMuted)
                Spacer(minLength: 0)
            }
        }
    }

    // MARK: - Actions

    private func reload() async {
        do {
            state = try await client.vibeCodeSessionState(sessionId: sessionId)
            errorMessage = nil
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
                if ["streaming", "awaiting-tool-response", "ready-to-deploy", "deploying"].contains(status) || state == nil {
                    await reload()
                }
            }
        }
    }

    private func deploy() async {
        deploying = true
        defer { deploying = false }
        do {
            let r = try await client.vibeCodeDeploy(sessionId: sessionId)
            if r.ok { deployedUrl = r.url } else { errorMessage = "Deploy was rejected by the box." }
            await reload()
        } catch {
            errorMessage = ScreensClientError.userFacing(error)
        }
    }

    private func submitReply() async {
        guard !replyDraft.isEmpty, !submitting else { return }
        submitting = true
        defer { submitting = false }
        do {
            _ = try await client.vibeCodeSessionReply(
                sessionId: sessionId, VibeCodeReplyRequest(text: replyDraft, envVarStatus: nil))
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
                sessionId: sessionId, VibeCodeReplyRequest(text: nil, envVarStatus: "set"))
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
                sessionId: sessionId, VibeCodeReplyRequest(text: nil, envVarStatus: "declined"))
            await reload()
        } catch {
            errorMessage = ScreensClientError.userFacing(error)
        }
    }
}
