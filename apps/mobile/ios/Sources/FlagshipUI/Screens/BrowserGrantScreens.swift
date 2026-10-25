import SwiftUI
import FlagshipAPI
import FlagshipCore

/// "Browser access request": the verified app, the exact sites and scope, how long; Allow (named by the
/// ask's duration) or Deny.
public struct BrowserGrantSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var center: BrowserGrantCenter

    public init(center: BrowserGrantCenter) { self.center = center }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        Group {
            if let item = center.current { content(item, c: c) }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled({ if case .working = center.stage { return true }; return false }())
    }

    private var working: Bool { if case .working = center.stage { return true }; return false }

    private func content(_ item: BrowserGrantCenter.Item, c: FSColors) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Image(systemName: "safari").font(FS.font.scaled(34)).foregroundColor(c.warning)
                if case .done(let allowed) = center.stage {
                    Text(BrowserGrantCopy.answered(app: item.appName, allowed: allowed))
                        .font(FS.font.h3()).foregroundColor(c.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("browser-grant-done")
                    FSPrimaryButton(String(localized: "Close"), block: true) { center.close() }
                        .accessibilityIdentifier("browser-grant-close")
                } else {
                    Text(BrowserGrantCopy.title).font(FS.font.h3()).foregroundColor(c.text)
                        .accessibilityIdentifier("browser-grant-heading")
                    BrowserGrantDetails(request: item.request, appName: item.appName, serverDomain: item.serverDomain,
                                        idPrefix: "browser-grant", c: c)
                    if case .failed(let msg) = center.stage {
                        Text(msg).font(FS.font.bodySm()).foregroundColor(c.danger)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("browser-grant-error")
                    }
                    FSPrimaryButton(center.stage == .working(allow: true) ? String(localized: "Allowing…")
                                                                          : BrowserGrantCopy.allow(item.request.duration),
                                    enabled: !working, block: true) {
                        Task { await center.allow() }
                    }
                    .accessibilityIdentifier("browser-grant-allow")
                    FSSecondaryButton(center.stage == .working(allow: false) ? String(localized: "Denying…") : BrowserGrantCopy.deny,
                                      block: true) {
                        Task { await center.deny() }
                    }
                    .disabled(working)
                    .accessibilityIdentifier("browser-grant-deny")
                    Text(BrowserGrantCopy.denyNote).font(FS.font.caption()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    FSGhostButton(String(localized: "Not now"), block: true) { center.notNow() }
                        .disabled(working)
                        .accessibilityIdentifier("browser-grant-not-now")
                }
            }
            .padding(FS.space.s6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(c.bg.ignoresSafeArea())
    }
}

/// The request in words, from the box's normalized fields.
struct BrowserGrantDetails: View {
    let request: BrowserGrantRequest
    let appName: String
    let serverDomain: String?
    let idPrefix: String
    let c: FSColors

    var body: some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(BrowserGrantCopy.ask(app: appName))
                .font(FS.font.h4()).foregroundColor(c.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("\(idPrefix)-title")
            if let serverDomain {
                Text(serverDomain).font(FS.font.bodySm()).foregroundColor(c.textMuted)
            }
            if !request.origins.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text(BrowserGrantCopy.sites).font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
                    ForEach(request.origins, id: \.self) { origin in
                        HStack(alignment: .firstTextBaseline, spacing: FS.space.s2) {
                            Text(origin).font(FS.font.mono()).foregroundColor(c.text)
                                .textSelection(.enabled)
                                .accessibilityIdentifier("\(idPrefix)-origin")
                            if let note = BrowserGrantCopy.originNote(origin) {
                                Text(note).font(FS.font.caption()).foregroundColor(c.warning)
                            }
                        }
                    }
                }
            }
            if let lan = BrowserGrantCopy.localNetwork(request.localNetwork) {
                Label(lan, systemImage: "wifi.exclamationmark")
                    .font(FS.font.bodySm()).foregroundColor(c.warning)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("\(idPrefix)-lan")
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(BrowserGrantCopy.canHeader).font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
                ForEach(request.capabilities, id: \.self) { cap in
                    Text("• \(BrowserGrantCopy.capability(cap))").font(FS.font.bodySm()).foregroundColor(c.text)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("\(idPrefix)-capabilities")
            Text(BrowserGrantCopy.duration(request.duration))
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                .accessibilityIdentifier("\(idPrefix)-duration")
            if let e = request.explanation?.trimmingCharacters(in: .whitespacesAndNewlines), !e.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text(BrowserGrantCopy.appSays).font(FS.font.caption()).foregroundColor(c.textMuted)
                    Text(BrowserGrantCopy.explanation(e)).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("\(idPrefix)-explanation")
            }
        }
    }
}

/// The app page's "Browser access": the sites approved at install, and what the app asks now. Hidden for
/// an app with neither.
struct BrowserAccessSection: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.screensClient) private var client

    let serviceId: String
    let appName: String
    let manifestDomains: [String]
    let serverDomain: String?
    var canAnswer: Bool = true
    @State private var controller: BrowserGrantsController?

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: 0) {
            let requests = controller?.requests ?? []
            if !manifestDomains.isEmpty || !requests.isEmpty || controller?.note != nil {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    FSSectionLabel(BrowserGrantCopy.sectionTitle)
                    FSCard {
                        VStack(alignment: .leading, spacing: FS.space.s4) {
                            if !manifestDomains.isEmpty {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(BrowserGrantCopy.approvedAtInstall).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                    ForEach(manifestDomains, id: \.self) { d in
                                        Text(d).font(FS.font.mono()).foregroundColor(c.text).textSelection(.enabled)
                                    }
                                }
                                .accessibilityElement(children: .combine)
                                .accessibilityIdentifier("app-browser-manifest")
                            }
                            if let controller {
                                ForEach(controller.requests) { r in
                                    row(r, controller: controller, c: c)
                                }
                                if let note = controller.note {
                                    Text(note).font(FS.font.bodySm()).foregroundColor(c.success)
                                        .fixedSize(horizontal: false, vertical: true)
                                        .accessibilityIdentifier("app-browser-note")
                                }
                                if let err = controller.error {
                                    Text(err).font(FS.font.bodySm()).foregroundColor(c.danger)
                                        .fixedSize(horizontal: false, vertical: true)
                                        .accessibilityIdentifier("app-browser-error")
                                }
                            }
                        }
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("app-browser-access")
            }
        }
        .task(id: serviceId) {
            let ctl = controller ?? BrowserGrantsController(serviceId: serviceId, appName: appName,
                                                            serverDomain: serverDomain, client: client)
            controller = ctl
            await ctl.load()
        }
    }

    private func row(_ r: BrowserGrantRequest, controller: BrowserGrantsController, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text(BrowserGrantCopy.title).font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.warning)
            BrowserGrantDetails(request: r, appName: appName, serverDomain: nil, idPrefix: "app-browser-request", c: c)
            if canAnswer {
                let busy = controller.busy != nil
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: FS.space.s2) { buttons(r, controller: controller, busy: busy, block: false) }
                    VStack(spacing: FS.space.s2) { buttons(r, controller: controller, busy: busy, block: true) }
                }
                Text(BrowserGrantCopy.denyNote).font(FS.font.caption()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func buttons(_ r: BrowserGrantRequest, controller: BrowserGrantsController, busy: Bool, block: Bool) -> some View {
        FSPrimaryButton(BrowserGrantCopy.allow(r.duration), enabled: !busy, block: block) {
            Task { await controller.answer(r, allow: true) }
        }
        .accessibilityIdentifier("app-browser-allow")
        FSSecondaryButton(BrowserGrantCopy.deny, block: block) { Task { await controller.answer(r, allow: false) } }
            .disabled(busy)
            .accessibilityIdentifier("app-browser-deny")
    }
}
