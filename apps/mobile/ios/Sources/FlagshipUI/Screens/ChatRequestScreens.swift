import SwiftUI
import FlagshipAPI
import FlagshipCore

/// "A remote machine claiming to run … wants to talk to …": Allow, Always allow, Deny, Not now; then what
/// the answer did.
public struct ChatRequestSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var center: ChatRequestCenter

    public init(center: ChatRequestCenter) { self.center = center }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        Group {
            if let item = center.current {
                content(item, c: c)
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled({ if case .working = center.stage { return true }; return false }())
    }

    private var working: Bool { if case .working = center.stage { return true }; return false }

    private func content(_ item: ChatRequestCenter.Item, c: FSColors) -> some View {
        let r = item.request
        return ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Image(systemName: "bubble.left.and.exclamationmark.bubble.right").font(FS.font.scaled(34)).foregroundColor(c.warning)
                if case .done(let decision) = center.stage {
                    Text(ChatCopy.answered(r, decision: decision))
                        .font(FS.font.h3()).foregroundColor(c.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("chat-alert-done")
                    FSPrimaryButton(String(localized: "Close"), block: true) { center.close() }
                        .accessibilityIdentifier("chat-alert-close")
                } else {
                    ChatRequestDetails(request: r, serverDomain: item.serverDomain, titleId: "chat-alert-title", c: c)
                    if case .failed(let msg) = center.stage {
                        Text(msg).font(FS.font.bodySm()).foregroundColor(c.danger)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("chat-alert-error")
                    }
                    FSPrimaryButton(center.stage == .working(.allow) ? String(localized: "Allowing…") : String(localized: "Allow"),
                                    enabled: !working, block: true) {
                        Task { await center.allow() }
                    }
                    .accessibilityIdentifier("chat-alert-allow")
                    if r.isIncoming {
                        FSSecondaryButton(center.stage == .working(.always) ? String(localized: "Allowing…") : String(localized: "Always allow"),
                                          block: true) {
                            Task { await center.alwaysAllow() }
                        }
                        .disabled(working)
                        .accessibilityIdentifier("chat-alert-always")
                    }
                    FSSecondaryButton(center.stage == .working(.deny) ? String(localized: "Denying…") : String(localized: "Deny"), block: true) {
                        Task { await center.deny() }
                    }
                    .disabled(working)
                    .accessibilityIdentifier("chat-alert-deny")
                    FSGhostButton(String(localized: "Not now"), block: true) { center.notNow() }
                        .disabled(working)
                        .accessibilityIdentifier("chat-alert-not-now")
                }
            }
            .padding(FS.space.s6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(c.bg.ignoresSafeArea())
    }
}

/// The request in words: who claims to ask, which app, its note, how often, and what Always allow means.
struct ChatRequestDetails: View {
    let request: ChatRequest
    let serverDomain: String
    var titleId: String = "chat-request-title"
    let c: FSColors

    var body: some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text(ChatCopy.ask(request))
                .font(FS.font.h4()).foregroundColor(c.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier(titleId)
            Text(serverDomain)
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            if let p = request.phrase, !p.isEmpty {
                Text(ChatCopy.phrase(p))
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let n = ChatCopy.asked(request.count) {
                Text(n).font(FS.font.bodySm()).foregroundColor(c.textMuted)
            }
            if request.isIncoming {
                Text(ChatCopy.alwaysNote(request))
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// The server page's "App chats": what waits on this server, and the apps that take chats without asking,
/// each with Revoke. Hidden while there is nothing to show, and on a box without app chat.
struct ChatRequestsCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.screensClient) private var client

    let serverDomain: String
    @State private var controller: ChatRequestsController?

    var body: some View {
        let c = FSColors.scheme(scheme)
        // A VStack, not a Group: a Group with nothing in it carries no task, and the load would never run.
        VStack(alignment: .leading, spacing: 0) {
            if let controller, controller.loaded, !controller.isEmpty || controller.note != nil {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    FSSectionLabel(ChatCopy.sectionTitle)
                    FSCard {
                        VStack(alignment: .leading, spacing: FS.space.s4) {
                            ForEach(controller.requests) { r in
                                row(r, controller: controller, c: c)
                            }
                            if !controller.always.isEmpty {
                                ForEach(controller.always) { app in
                                    HStack(alignment: .top, spacing: FS.space.s2) {
                                        Text(ChatCopy.alwaysRow(app))
                                            .font(FS.font.bodySm()).foregroundColor(c.text)
                                            .fixedSize(horizontal: false, vertical: true)
                                        Spacer(minLength: FS.space.s2)
                                        Button(String(localized: "Revoke")) { Task { await controller.revoke(app) } }
                                            .font(FS.font.bodySm())
                                            .foregroundColor(c.danger)
                                            .disabled(controller.busy != nil)
                                            .accessibilityIdentifier("sd-chat-revoke-\(app.claimedSender.slug)-\(app.receiverApp.slug)")
                                    }
                                }
                            }
                            if let note = controller.note {
                                Text(note).font(FS.font.bodySm()).foregroundColor(c.success)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .accessibilityIdentifier("sd-chat-note")
                            }
                            if let err = controller.error {
                                Text(err).font(FS.font.bodySm()).foregroundColor(c.danger)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .accessibilityIdentifier("sd-chat-error")
                            }
                        }
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("sd-chat")
            }
        }
        .task(id: serverDomain) {
            let ctl = controller ?? ChatRequestsController(serverDomain: serverDomain, client: client)
            controller = ctl
            await ctl.load()
        }
        .onReceive(NotificationCenter.default.publisher(for: ChatRequestEvents.requested)) { _ in
            Task { await controller?.load() }
        }
    }

    private func row(_ r: ChatRequest, controller: ChatRequestsController, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            ChatRequestDetails(request: r, serverDomain: serverDomain, titleId: "sd-chat-request-title", c: c)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: FS.space.s2) { buttons(r, controller: controller, block: false) }
                VStack(spacing: FS.space.s2) { buttons(r, controller: controller, block: true) }
            }
        }
    }

    @ViewBuilder
    private func buttons(_ r: ChatRequest, controller: ChatRequestsController, block: Bool) -> some View {
        let busy = controller.busy != nil
        FSPrimaryButton(String(localized: "Allow"), enabled: !busy, block: block) { Task { await controller.answer(r, .allow) } }
            .accessibilityIdentifier("sd-chat-allow")
        if r.isIncoming {
            FSSecondaryButton(String(localized: "Always allow"), block: block) { Task { await controller.answer(r, .always) } }
                .disabled(busy)
                .accessibilityIdentifier("sd-chat-always")
        }
        FSSecondaryButton(String(localized: "Deny"), block: block) { Task { await controller.answer(r, .deny) } }
            .disabled(busy)
            .accessibilityIdentifier("sd-chat-deny")
    }
}
