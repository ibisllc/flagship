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
    @State private var menu: GroupedModelMenu
    @State private var stager: ChatAttachmentStager
    @State private var visionAlert: VisionDecision?

    public let serverFqdn: String
    public let client: any ScreensClient
    public let signEnvelope: @MainActor (ServiceEnvChange) async throws -> String
    /// The owner's default saved AI key, which an older box's chat (one that
    /// doesn't name its provider) is assumed to use.
    public let savedCredential: () -> LlmProviderCredential?
    /// The AI keys saved on this device, in saved order: one menu group each.
    public let savedKeys: () -> [SavedKeyStore.Entry]
    /// Mints a fresh free-AI credential for this box (nil ⇒ not offered).
    public let freeAiCredential: (@MainActor () async throws -> LlmProviderCredential)?
    /// The Flagship Inference catalog from `.com` (nil ⇒ not offered).
    public let inferenceCatalog: (@MainActor () async -> InferenceCatalogResponse?)?
    /// Whether the owner can use Flagship Inference now (read when the menu opens).
    public let flagshipUsable: (@MainActor () async -> Bool)?

    public init(
        stream: VibeCodeStreamViewModel,
        serverFqdn: String,
        client: any ScreensClient,
        signEnvelope: @escaping @MainActor (ServiceEnvChange) async throws -> String,
        savedCredential: @escaping () -> LlmProviderCredential? = { nil },
        savedKeys: @escaping () -> [SavedKeyStore.Entry] = { [] },
        freeAiCredential: (@MainActor () async throws -> LlmProviderCredential)? = nil,
        inferenceCatalog: (@MainActor () async -> InferenceCatalogResponse?)? = nil,
        flagshipUsable: (@MainActor () async -> Bool)? = nil,
        menu: GroupedModelMenu? = nil,
        attachments: ChatAttachmentStager? = nil
    ) {
        _menu = State(initialValue: menu ?? GroupedModelMenu())
        #if DEBUG
        _stager = State(initialValue: attachments ?? ChatAttachmentStager(staged: GymSweepSeams.chatAttachments))
        #else
        _stager = State(initialValue: attachments ?? ChatAttachmentStager())
        #endif
        self.stream = stream
        self.serverFqdn = serverFqdn
        self.client = client
        self.signEnvelope = signEnvelope
        self.savedCredential = savedCredential
        self.savedKeys = savedKeys
        self.freeAiCredential = freeAiCredential
        self.inferenceCatalog = inferenceCatalog
        self.flagshipUsable = flagshipUsable
    }

    /// The key a message carries. With the grouped menu: a fresh Flagship
    /// Inference pass whenever that group is chosen; an own key when the
    /// owner picked another group here, the box holds no key, or the relay
    /// setting just changed. Without one (no group fits): the older rules.
    /// Throws `FreeAiError` (used up, busy today, …) so the owner sees why
    /// nothing was sent. `switching` false keeps the box's group (an env-var
    /// answer carries no model).
    private func messageCredential(switching: Bool = true) async throws -> LlmProviderCredential? {
        let boxNeedsKey = state?.needsCredential == true || relayTurnedOff
        guard (switching ? menu.currentGroup : menu.boxGroup) != nil else {
            return try await VibeCodeReplyCredential.resolve(
                sessionId: sessionId, boxNeedsKey: boxNeedsKey, saved: savedCredential, freeAi: freeAiCredential)
        }
        return try await VibeCodeReplyCredential.resolve(
            choice: menu.credentialChoice(needsCredential: boxNeedsKey, switching: switching),
            switchingProvider: switching && menu.picked,
            freeAi: freeAiCredential)
    }

    /// After a message went through: the box holds the chosen group's key.
    private func noteSent() {
        menu.didSend()
        guard let g = menu.boxGroup else { return }
        if g.spec.isFlagship { FreeAiSessions.mark(sessionId) } else { FreeAiSessions.unmark(sessionId) }
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
                                .font(FS.font.scaled(28))
                                .foregroundStyle(c.accent)
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
        .clipShape(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous).stroke(c.border, lineWidth: 1))
        .padding(.horizontal, FS.space.s4)
        .padding(.vertical, FS.space.s3)
        .background(c.bg.ignoresSafeArea())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if menu.isActive {
                // One item, so picking a model that lists effort levels adds
                // the effort control beside the menu without replacing the
                // item its open popover hangs from (UIKit traps on that).
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 6) {
                        if let efforts = menu.efforts {
                            EffortMenuButton(efforts: efforts, selected: menu.effort, onPick: { menu.setEffort($0) })
                        }
                        GroupedModelMenuButton(menu: menu, identifier: "vibecode-model-menu")
                    }
                }
            }
        }
        .visionSwitchAlert($visionAlert) { to in
            menu.select(to)
            Task { await submitReply(checkedVision: true) }
        }
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
        case "failed": return "Failed"
        case "cancelled": return "Stopped"
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
        if state?.summarised == true {
            Text(ModelMenuText.summarised).font(FS.font.caption()).foregroundColor(c.textMuted)
        }
        ForEach(Array(shownLines.enumerated()), id: \.offset) { _, msg in
            line(msg, c: c)
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
                .font(FS.font.scaled(12, design: .monospaced))
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

    func line(_ msg: VibeTranscript.Line, c: FSColors) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: FS.space.s2) {
            Text(msg.role == "user" ? "›" : " ")
                .font(FS.font.mono().weight(.bold))
                .foregroundColor(c.primary)
            VStack(alignment: .leading, spacing: 4) {
                Text(msg.text)
                    .font(FS.font.mono())
                    .foregroundColor(msg.role == "user" ? c.primary : c.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                if let a = msg.attachments, !a.isEmpty {
                    SentAttachments(attachments: a)
                }
                if msg.role == "assistant", let credits = msg.credits {
                    Text(ModelMenuText.creditsUsed(credits))
                        .font(FS.font.scaled(11))
                        .foregroundColor(c.textMuted)
                        .accessibilityIdentifier("vibecode-credits")
                }
            }
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

    /// What the AI is waiting on comes first: an edit session runs on an app
    /// that is already live, and the owner must still be able to answer it
    /// (the transcript keeps the live link).
    @ViewBuilder
    private func footer(c: FSColors) -> some View {
        if let pending = state?.pendingRequest {
            switch pending {
            case .talkToUser:
                composer(placeholder: VibeCodeComposer.replyPlaceholder, c: c)
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
        } else if let url = liveUrl, !url.isEmpty {
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
                if let placeholder = VibeCodeComposer.placeholder(status: status, canContinue: state?.canContinue == true) {
                    composer(placeholder: placeholder, c: c)
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
                if let placeholder = VibeCodeComposer.placeholder(status: status, canContinue: state?.canContinue == true) {
                    composer(placeholder: placeholder, c: c)
                }
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

    /// The message field: an answer to the AI's question, or a new request on
    /// a chat that is ready to deploy or failed.
    private func composer(placeholder: String, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            if let notice = menu.contextNotice(for: state) {
                Text(notice)
                    .font(FS.font.scaled(12)).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("vibecode-context-notice")
            }
            StagedAttachmentsBar(stager: stager)
            HStack(spacing: FS.space.s2) {
                AttachButton(stager: stager)
                TextField(placeholder, text: $replyDraft, axis: .vertical)
                    .font(FS.font.mono())
                    .lineLimit(1...4)
                    .submitLabel(.send)
                    .onSubmit { Task { await submitReply() } }
                    .accessibilityIdentifier("vibecode-reply-field")
                Button { Task { await submitReply() } } label: {
                    Image(systemName: submitting ? "ellipsis.circle" : "arrow.up.circle.fill")
                        .font(FS.font.scaled(26)).foregroundColor(c.accent)
                }
                .disabled(submitting || replyDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("vibecode-reply-send-btn")
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
        if let entry = menu.boxGroup?.spec.entry {
            try? store.setRelay(id: entry.id, relay: false)
        } else if let cred = savedCredential(), let entry = store.entry(for: cred) {
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
            if wasEmpty { configureMenu(next) }
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
            if let g = menu.boxGroup {
                if let entry = g.spec.entry {
                    deployCredential = menu.keyLookup(entry.id).map(ModelGroups.wireCredential)
                } else {
                    deployCredential = try? await freeAiCredential?()
                }
            } else if FreeAiSessions.isFreeAi(sessionId), let freeAiCredential {
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

    /// The menu's groups: Flagship Inference (when the chat uses it; added
    /// on opening the menu when the owner can use it), then each saved key.
    /// The chat's provider picks the group it starts on.
    private func configureMenu(_ s: VibeCodeSessionPublicState) {
        guard !menu.isConfigured else { return }
        menu.configure(
            entries: savedKeys(),
            provider: s.provider,
            freeAiSession: FreeAiSessions.isFreeAi(sessionId),
            fallbackCredential: savedCredential(),
            initial: ModelChoice(model: s.model, effort: s.effort),
            flagshipCatalog: inferenceCatalog,
            ownModels: { [client] cred in await ModelMenuCache.models(for: cred) { try await client.aiModels($0) } },
            flagshipUsable: flagshipUsable)
        Task { await menu.loadCurrent() }
    }

    private func submitReply(checkedVision: Bool = false) async {
        let text = replyDraft
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !submitting else { return }
        if !checkedVision {
            let decision = menu.visionDecision(hasImage: stager.hasImage)
            if decision != .send {
                visionAlert = decision
                return
            }
        }
        submitting = true
        defer { submitting = false }
        let continuing = state?.pendingRequest == nil
        do {
            let credential = try await messageCredential()
            let model = menu.isActive ? menu.wireModel : nil
            _ = try await client.vibeCodeSessionReply(
                sessionId: sessionId,
                VibeCodeReplyRequest(text: text, envVarStatus: nil, credential: credential,
                                     model: model, effort: model == nil ? nil : menu.wireEffort,
                                     attachments: stager.wire))
            noteSent()
            replyDraft = ""
            stager.clear()
            errorMessage = nil
            followTail = true
            if continuing { stream.restart() }
            await reload()
        } catch let e as ModelGroups.KeyGone {
            errorMessage = e.errorDescription
        } catch {
            errorMessage = ScreensClientError.boxReason(error) ?? ScreensClientError.userFacing(error)
        }
    }

    private func submitEnvVar(name: String) async {
        // appId = "<creator>--<slug>"; both halves may carry single dashes
        // (docs/service-addressing-double-dash.md).
        guard let appId = state?.appId, appId.contains("--") else {
            errorMessage = "The app has no id yet. Wait for the AI to name it."
            return
        }
        submitting = true
        defer { submitting = false }
        let change = ServiceEnvChange.make(serverId: serverFqdn, serviceId: appId, set: name, value: envValueDraft)
        do {
            // The value travels only through /env/set; /reply just acknowledges.
            let signature = try await signEnvelope(change)
            _ = try await client.serviceEnvSet(
                appId: appId,
                ServiceEnvSetRequest(change: change, value: envValueDraft, signature: signature))
            _ = try await client.vibeCodeSessionReply(sessionId: sessionId, try await envVarAck("set"))
            noteSent()
            envValueDraft = ""
            await reload()
        } catch {
            errorMessage = ScreensClientError.userFacing(error)
        }
    }

    /// The env-var answer resumes the AI, so it carries what any message
    /// does (as on the webapp and Android): the key for the chosen model and
    /// the model choice.
    private func envVarAck(_ status: String) async throws -> VibeCodeReplyRequest {
        let model = menu.isActive ? menu.wireModel : nil
        return Self.envVarAck(status, credential: try await messageCredential(), model: model, effort: menu.wireEffort)
    }

    nonisolated static func envVarAck(_ status: String, credential: LlmProviderCredential?,
                                      model: String?, effort: String?) -> VibeCodeReplyRequest {
        VibeCodeReplyRequest(text: nil, envVarStatus: status, credential: credential,
                             model: model, effort: model == nil ? nil : effort)
    }

    private func declineEnvVar() async {
        submitting = true
        defer { submitting = false }
        do {
            _ = try await client.vibeCodeSessionReply(sessionId: sessionId, try await envVarAck("declined"))
            noteSent()
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
                // Used up, busy today, no server, ended: say so, send nothing.
                if e.opensAddKey { throw e }
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

    /// The grouped menu's choice made concrete. A Flagship Inference pass
    /// that can't be minted stops the send when it says why (used up, busy
    /// today, …) or when the message switches to it; otherwise the box keeps
    /// the pass it holds.
    static func resolve(
        choice: ModelGroups.CredentialChoice,
        switchingProvider: Bool,
        freeAi: (@MainActor () async throws -> LlmProviderCredential)?
    ) async throws -> LlmProviderCredential? {
        switch choice {
        case .keep:
            return nil
        case .send(let c):
            return c
        case .keyGone:
            throw ModelGroups.KeyGone()
        case .mintFlagship:
            guard let freeAi else {
                if switchingProvider { throw FreeAiError.unavailable(message: FreeAiCopy.unavailable) }
                return nil
            }
            do {
                return try await freeAi()
            } catch let e as FreeAiError {
                if e.opensAddKey || switchingProvider { throw e }
                return nil
            } catch {
                if switchingProvider { throw error }
                return nil
            }
        }
    }
}

/// The build chat's message field. MIRRORS the webapp `views/vibe-code.js`.
enum VibeCodeComposer {
    static let replyPlaceholder = "Reply to the AI"
    static let changePlaceholder = "Ask for a change…"
    static let retryPlaceholder = "Tell the AI what to try next…"

    /// The placeholder for a chat that takes a new message, nil when it takes none.
    static func placeholder(status: String, canContinue: Bool) -> String? {
        guard canContinue else { return nil }
        switch status {
        case "ready-to-deploy": return changePlaceholder
        case "failed": return retryPlaceholder
        default: return nil
        }
    }
}
