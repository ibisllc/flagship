import SwiftUI
import FlagshipAPI

/// Under a docked browser session: what it may build now, and the way to let it change one more app
/// (SEC-AUTH-002). Admin devices only; anything else sees why it cannot.
struct CompanionDelegationView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.screensClient) private var client
    let sessionId: String
    let canSign: Bool

    @State private var controller: CompanionDelegationController?
    @State private var apps: [AppSummary] = []
    @State private var choosing = false
    @State private var serviceRef = ""
    @State private var build = true
    @State private var deploy = false
    @State private var minutes: Int64 = 60

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s2) {
            if let ctl = controller {
                ForEach(ctl.rows) { r in
                    HStack {
                        Text("May \(r.ops.joined(separator: " and ")) \(r.serviceRef)").font(FS.font.caption()).foregroundColor(c.textMuted)
                        Spacer()
                        Button(SecurityControlWords.delegateEnd) { Task { await ctl.end(serviceRef: r.serviceRef) } }
                            .font(FS.font.caption())
                            .accessibilityIdentifier("delegation-end-\(r.serviceRef)")
                    }
                }
                if canSign {
                    if choosing {
                        VStack(alignment: .leading, spacing: FS.space.s2) {
                            Text(SecurityControlWords.delegateTitle).font(FS.font.bodySm().weight(.semibold))
                            Text(SecurityControlWords.delegateIntro).font(FS.font.caption()).foregroundColor(c.textMuted)
                            Picker("App", selection: $serviceRef) {
                                ForEach(apps, id: \.serviceId) { Text($0.slug).tag($0.serviceId) }
                            }
                            Toggle(SecurityControlWords.delegateBuild, isOn: $build)
                            Toggle(SecurityControlWords.delegateDeploy, isOn: $deploy)
                            Picker("For", selection: $minutes) {
                                Text("30 minutes").tag(Int64(30)); Text("1 hour").tag(Int64(60)); Text("4 hours").tag(Int64(240)); Text("24 hours").tag(Int64(1440))
                            }
                            FSPrimaryButton(SecurityControlWords.delegateAllow, block: true) {
                                let ops = [build ? "build" : nil, deploy ? "deploy" : nil].compactMap { $0 }
                                guard !ops.isEmpty, !serviceRef.isEmpty else { return }
                                Task {
                                    await ctl.allow(serviceRef: serviceRef, ops: ops, durationMs: minutes * 60_000)
                                    choosing = false
                                }
                            }
                            .accessibilityIdentifier("delegation-allow")
                        }
                    } else {
                        FSSecondaryButton(SecurityControlWords.delegateOpen, block: true) {
                            Task {
                                apps = (try? await client.appsList())?.apps ?? []
                                serviceRef = apps.first?.serviceId ?? ""
                                choosing = true
                            }
                        }
                        .accessibilityIdentifier("delegation-open")
                    }
                } else {
                    Text(SecurityControlWords.delegateAdminOnly).font(FS.font.caption()).foregroundColor(c.textMuted)
                }
                if let e = ctl.error { Text(e).font(FS.font.caption()).foregroundColor(c.danger) }
            }
        }
        .task {
            let ctl = controller ?? CompanionDelegationController(sessionId: sessionId, client: client)
            controller = ctl
            await ctl.load()
        }
    }
}
