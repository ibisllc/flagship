import SwiftUI
import UIKit
import FlagshipAPI
import FlagshipCore

/// Settings → "Claim your .com name". See `NameDibsViewModel`.
public struct NameDibsScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var vm: NameDibsViewModel
    @State private var name = ""

    public init(vm: NameDibsViewModel) {
        _vm = State(initialValue: vm)
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                switch vm.phase {
                case .loading, .working:
                    ProgressView().frame(maxWidth: .infinity)
                case .closed(let opensAt):
                    Text(opensAt.map { "The dibs window opens on \(Self.date($0))." }
                         ?? "The dibs window isn't open, so no names are held for .com holders — any free name can be bought as an ordinary name change.")
                        .font(FS.font.body()).foregroundColor(c.textMuted)
                case .enterName(let closesAt):
                    enterName(c, closesAt: closesAt)
                case .publish(let claim):
                    publish(c, claim)
                case .proven(let n):
                    Text("You've proven you control \(n).com, so the name \(n) is held for you. Switching your account to it is a one-time $20 name change — your servers move with you.")
                        .font(FS.font.body()).foregroundColor(c.text)
                        .accessibilityIdentifier("dibs-proven")
                case .failed(let msg):
                    Text(msg).font(FS.font.body()).foregroundColor(c.danger)
                }
                if let err = vm.inlineError {
                    Text(err).font(FS.font.bodySm()).foregroundColor(c.danger)
                        .accessibilityIdentifier("dibs-error")
                }
            }
            .padding(FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Claim your .com name")
        .navigationBarTitleDisplayMode(.inline)
        .task { await vm.load() }
    }

    @ViewBuilder private func enterName(_ c: FSColors, closesAt: Int64?) -> some View {
        Text("Until \(closesAt.map(Self.date) ?? "the window closes"), a name matching a registered .com is held for whoever controls that domain. Enter the name of the .com you control.")
            .font(FS.font.body()).foregroundColor(c.textMuted)
        HStack {
            TextField("acme", text: $name)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(FS.space.s3)
                .background(c.surface)
                .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
                .accessibilityIdentifier("dibs-name")
            Text(".com").font(FS.font.body()).foregroundColor(c.textMuted)
        }
        FSPrimaryButton("Get my code", enabled: !name.isEmpty, block: true) {
            Task { await vm.start(name: name) }
        }
        .accessibilityIdentifier("dibs-start")
    }

    @ViewBuilder private func publish(_ c: FSColors, _ claim: DibsClaim) -> some View {
        Text("Publish this code in one of these two places, then check. It's tied to your account's key, so nobody else can use it. DNS changes can take a while — you can leave and come back.")
            .font(FS.font.bodySm()).foregroundColor(c.textMuted)
        place(c, title: "Option 1 — DNS TXT record", lines: [("Name", claim.publishAt.dns.name), ("Value", claim.record)])
        place(c, title: "Option 2 — a file on your website", lines: [("URL", claim.publishAt.https.url), ("Text", claim.record)])
        FSPrimaryButton("Check now", block: true) { Task { await vm.check() } }
            .accessibilityIdentifier("dibs-check")
        FSSecondaryButton("Use a different name", block: true) { vm.restart() }
    }

    private func place(_ c: FSColors, title: String, lines: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text(title).font(FS.font.bodySm()).foregroundColor(c.text)
            ForEach(lines, id: \.0) { label, value in
                HStack(alignment: .top) {
                    VStack(alignment: .leading) {
                        Text(label).font(FS.font.caption()).foregroundColor(c.textMuted)
                        Text(value).font(.system(.footnote, design: .monospaced)).foregroundColor(c.text)
                            .textSelection(.enabled)
                    }
                    Spacer()
                    Button("Copy") { UIPasteboard.general.string = value }
                        .font(FS.font.caption())
                }
            }
        }
        .padding(FS.space.s3)
        .background(c.surface)
        .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
    }

    static func date(_ ms: Int64) -> String {
        let d = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        return d.formatted(date: .long, time: .omitted)
    }
}
