import SwiftUI
import FlagshipAPI
import FlagshipCore

/// W10 — vibe-code session chat surface.
///
/// Subscribes to GET /api/screens/llm/sessions/<id> (poll-driven) and
/// renders the running message log. When the session is
/// `awaiting-tool-response`, surfaces the model's tool request:
///
///   - talkToUser    — single text field for a free-form reply,
///                     POSTed to /reply.
///   - requestEnvVar — single field labeled with the env-var NAME the
///                     model wants. On send, the value is POSTed to
///                     /api/screens/services/<appId>/env/set FIRST
///                     (the path that actually carries the secret),
///                     then /reply finalizes the ack with status "set".
///
/// The push handler at the app delegate level routes the
/// `vibecode-needs-you` payload here via deep link
/// `flagship://vibecode/<sessionId>`.
@MainActor
public struct VibeCodeChatScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var state: VibeCodeSessionPublicState?
    @State private var loading: Bool = true
    @State private var errorMessage: String?
    @State private var replyDraft: String = ""
    @State private var envValueDraft: String = ""
    @State private var submitting: Bool = false
    @State private var pollTask: Task<Void, Never>?
    /// Deploy state. `ready-to-deploy` (the model finished emitting files +
    /// no tool pending) surfaces the Deploy button; on success the deployed
    /// URL renders. The scratch deploy has no other trigger (the WS stream is
    /// a pure relay), so this button IS how a chat-built service ships.
    @State private var deploying: Bool = false
    @State private var deployedUrl: String?
    @State private var deployedServiceId: String?

    public let sessionId: String
    public let serverFqdn: String
    public let username: String
    public let client: any ScreensClient
    /// Same hook as ServiceEnvScreen — signs a SetServiceEnvRequest
    /// envelope under the owner's IRK. Required because requestEnvVar
    /// acks may need to first push the secret value through /env/set.
    public let signEnvelope: @MainActor (ServiceEnvSetEnvelope) async throws -> String

    public init(
        sessionId: String,
        serverFqdn: String,
        username: String,
        client: any ScreensClient,
        signEnvelope: @escaping @MainActor (ServiceEnvSetEnvelope) async throws -> String
    ) {
        self.sessionId = sessionId
        self.serverFqdn = serverFqdn
        self.username = username
        self.client = client
        self.signEnvelope = signEnvelope
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                if let s = state {
                    statusCard(state: s, c: c)
                    messagesCard(state: s, c: c)
                    if let pending = s.pendingRequest {
                        replySection(state: s, pending: pending, c: c)
                    }
                    deploySection(state: s, c: c)
                } else if loading {
                    FSCard {
                        HStack {
                            ProgressView()
                            Text("Loading session…").foregroundColor(c.textMuted)
                        }
                    }
                }
                if let msg = errorMessage {
                    ErrorCard(message: msg)
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Vibe-code session")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await reload()
            startPolling()
        }
        .onDisappear {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    /// Deploy affordance + result. Shown once the model has finished emitting
    /// the app (`ready-to-deploy`) — the only point a scratch session can be
    /// shipped, since the WS stream never auto-deploys. After a successful
    /// deploy the canonical URL renders with an Open affordance.
    @ViewBuilder
    private func deploySection(state s: VibeCodeSessionPublicState, c: FSColors) -> some View {
        if let url = deployedUrl ?? (s.status == "deployed" ? "" : nil), !(deployedUrl == nil && url.isEmpty) {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    HStack(spacing: FS.space.s2) {
                        Image(systemName: "checkmark.seal.fill").foregroundColor(c.success)
                        Text("Deployed").font(FS.font.h4()).foregroundColor(c.text)
                    }
                    Text(url).font(FS.font.mono()).foregroundColor(c.text)
                        .lineLimit(1).truncationMode(.middle)
                        .accessibilityIdentifier("vibecode-deployed-url")
                }
            }
        } else if s.status == "ready-to-deploy" || s.status == "deploying" {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    Text("Ready to deploy").font(FS.font.h4()).foregroundColor(c.text)
                    Text("The AI finished writing your service. Deploy it to your box.")
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    FSPrimaryButton(
                        (deploying || s.status == "deploying") ? "Deploying…" : "Deploy",
                        enabled: !deploying && s.status == "ready-to-deploy",
                        block: true
                    ) {
                        Task { await deploy() }
                    }
                    .accessibilityIdentifier("vibecode-deploy-btn")
                }
            }
        }
    }

    private func deploy() async {
        deploying = true
        defer { deploying = false }
        do {
            let r = try await client.vibeCodeDeploy(sessionId: sessionId)
            if r.ok {
                deployedUrl = r.url
                deployedServiceId = r.serviceId
            } else {
                errorMessage = "Deploy was rejected by the box."
            }
            await reload()
        } catch {
            errorMessage = ScreensClientError.userFacing(error)
        }
    }

    private func statusCard(state s: VibeCodeSessionPublicState, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                HStack(spacing: FS.space.s2) {
                    Image(systemName: statusIcon(s.status)).foregroundColor(statusColor(s.status, c: c))
                    Text(statusLabel(s.status))
                        .font(FS.font.h4())
                        .foregroundColor(c.text)
                }
                if let appId = s.appId {
                    Text("app: \(appId)").font(FS.font.mono()).foregroundColor(c.textMuted)
                }
                Text("session: \(s.id)").font(FS.font.mono()).foregroundColor(c.textMuted)
            }
        }
    }

    private func statusIcon(_ status: String) -> String {
        switch status {
        case "streaming": return "wand.and.stars"
        case "awaiting-tool-response": return "questionmark.bubble.fill"
        case "ready-to-deploy": return "checkmark.circle.fill"
        case "deployed": return "checkmark.seal.fill"
        case "failed", "cancelled": return "xmark.octagon.fill"
        default: return "circle"
        }
    }

    private func statusColor(_ status: String, c: FSColors) -> Color {
        switch status {
        case "awaiting-tool-response": return c.primary
        case "deployed": return c.success
        case "failed", "cancelled": return c.danger
        default: return c.textMuted
        }
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "streaming": return "Generating…"
        case "awaiting-tool-response": return "AI is asking you something"
        case "ready-to-deploy": return "Ready to deploy"
        case "deploying": return "Deploying…"
        case "deployed": return "Deployed"
        case "failed": return "Failed"
        case "cancelled": return "Cancelled"
        default: return status
        }
    }

    private func messagesCard(state s: VibeCodeSessionPublicState, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("CONVERSATION").font(FS.font.caption()).tracking(1).foregroundColor(c.textMuted)
                if s.messages.isEmpty {
                    Text("No messages yet.").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                } else {
                    ForEach(Array(s.messages.enumerated()), id: \.offset) { _, msg in
                        messageRow(msg: msg, c: c)
                    }
                }
            }
        }
    }

    private func messageRow(msg: VibeCodeSessionMessage, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s1) {
            Text(msg.role == "user" ? "YOU" : "AI")
                .font(.system(size: 11, weight: .semibold)).tracking(1)
                .foregroundColor(c.textMuted)
            Text(msg.text)
                .font(FS.font.body())
                .foregroundColor(c.text)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func replySection(
        state s: VibeCodeSessionPublicState,
        pending: VibeCodePendingRequest,
        c: FSColors
    ) -> some View {
        switch pending {
        case .talkToUser(_, let message):
            talkToUserCard(message: message, c: c)
        case .requestEnvVar(_, let name, let description, let why, let example, let secret):
            requestEnvVarCard(
                state: s,
                pending: pending,
                name: name,
                description: description,
                why: why,
                example: example,
                secret: secret ?? false,
                c: c
            )
        }
    }

    private func talkToUserCard(message: String, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                Text("AI asked:").font(FS.font.caption()).tracking(1).foregroundColor(c.textMuted)
                Text(message).font(FS.font.body()).foregroundColor(c.text)
                TextField("Type your reply", text: $replyDraft, axis: .vertical)
                    .lineLimit(3...6)
                    .padding(10)
                    .background(c.surfaceSunken)
                    .overlay(RoundedRectangle(cornerRadius: FS.radius.sm).stroke(c.border, lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
                    .accessibilityIdentifier("vibecode-reply-field")
                FSPrimaryButton(
                    submitting ? "Sending…" : "Send",
                    enabled: !submitting && !replyDraft.isEmpty,
                    block: true
                ) {
                    Task { await submitReply() }
                }
                .accessibilityIdentifier("vibecode-reply-send-btn")
            }
        }
    }

    private func requestEnvVarCard(
        state s: VibeCodeSessionPublicState,
        pending: VibeCodePendingRequest,
        name: String,
        description: String,
        why: String,
        example: String?,
        secret: Bool,
        c: FSColors
    ) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                HStack(spacing: FS.space.s2) {
                    Image(systemName: secret ? "lock.shield" : "key").foregroundColor(c.primary)
                    Text("AI needs \(name)").font(FS.font.h4()).foregroundColor(c.text)
                }
                Text(description).font(FS.font.body()).foregroundColor(c.text)
                Text("Why: \(why)").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                if let ex = example, !ex.isEmpty {
                    Text("Example: \(ex)").font(FS.font.mono()).foregroundColor(c.textMuted)
                }
                SecureField("paste your value here", text: $envValueDraft)
                    .font(FS.font.mono())
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .padding(.horizontal, 12).frame(height: 40)
                    .background(c.surfaceSunken)
                    .overlay(RoundedRectangle(cornerRadius: FS.radius.sm).stroke(c.border, lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
                    .accessibilityIdentifier("vibecode-envvar-field")
                Text("Sent once to your server. Not saved on your phone.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                HStack(spacing: FS.space.s2) {
                    FSPrimaryButton(
                        submitting ? "Sending…" : "Send value",
                        enabled: !submitting && !envValueDraft.isEmpty && s.appId != nil,
                        block: true
                    ) {
                        Task { await submitEnvVar(state: s, name: name) }
                    }
                    .accessibilityIdentifier("vibecode-envvar-send-btn")
                }
                Button("Decline") {
                    Task { await declineEnvVar() }
                }
                .font(FS.font.bodySm())
                .foregroundColor(c.textMuted)
                .accessibilityIdentifier("vibecode-envvar-decline-btn")
            }
        }
    }

    private func reload() async {
        loading = true
        errorMessage = nil
        defer { loading = false }
        do {
            state = try await client.vibeCodeSessionState(sessionId: sessionId)
        } catch {
            errorMessage = ScreensClientError.userFacing(error)
        }
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                if Task.isCancelled { break }
                // Poll while the session is still moving toward a terminal
                // state. `ready-to-deploy` is included so the screen keeps
                // refreshing until the owner taps Deploy (and reflects a
                // deploy that completed out-of-band).
                if let s = state, ["streaming", "awaiting-tool-response", "ready-to-deploy", "deploying"].contains(s.status) {
                    do {
                        state = try await client.vibeCodeSessionState(sessionId: sessionId)
                    } catch {
                        // network blip — keep polling
                    }
                }
            }
        }
    }

    private func submitReply() async {
        submitting = true
        defer { submitting = false }
        do {
            let _ = try await client.vibeCodeSessionReply(
                sessionId: sessionId,
                VibeCodeReplyRequest(text: replyDraft, envVarStatus: nil)
            )
            replyDraft = ""
            await reload()
        } catch {
            errorMessage = ScreensClientError.userFacing(error)
        }
    }

    private func submitEnvVar(state s: VibeCodeSessionPublicState, name: String) async {
        guard let appId = s.appId else {
            errorMessage = "Session has no app id yet — wait for the manifest to emit."
            return
        }
        // Derive (creator, slug) from the appId. appId = "<creator>--<slug>";
        // split on the `--` delimiter (both halves may carry single dashes —
        // docs/service-addressing-double-dash.md).
        guard let delim = appId.range(of: "--") else {
            errorMessage = "Invalid app id shape"
            return
        }
        let creator = String(appId[..<delim.lowerBound])
        let slug = String(appId[delim.upperBound...])
        submitting = true
        defer { submitting = false }
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let envelope = ServiceEnvSetEnvelope(
            serverId: serverFqdn,
            creator: creator,
            slug: slug,
            env: [name: envValueDraft],
            issuedAt: issuedAt
        )
        do {
            // Step 1: push the secret value through /env/set (the only
            // path that carries it).
            let signature = try await signEnvelope(envelope)
            let _ = try await client.serviceEnvSet(
                appId: appId,
                ServiceEnvSetRequest(name: name, value: envValueDraft, request: envelope, signature: signature)
            )
            // Step 2: finalize the model-facing ack via /reply.
            let _ = try await client.vibeCodeSessionReply(
                sessionId: sessionId,
                VibeCodeReplyRequest(text: nil, envVarStatus: "set")
            )
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
            let _ = try await client.vibeCodeSessionReply(
                sessionId: sessionId,
                VibeCodeReplyRequest(text: nil, envVarStatus: "declined")
            )
            await reload()
        } catch {
            errorMessage = ScreensClientError.userFacing(error)
        }
    }
}
