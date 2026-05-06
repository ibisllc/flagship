import SwiftUI

/// D.4.1 — ApproveUnlockScreen. Push-driven entry point.
public struct ApproveUnlockScreen: View {
    @State private var autoApprove: Bool = false
    var serverFqdn: String = "home.harry.flagship.services"
    var requestOrigin: String = "192.0.2.14 · home Wi-Fi"
    var fingerprint: String = "4f:9a:7c:b2:01:dd:e8:b1"
    var onApprove: () -> Void = {}
    var onBlock: () -> Void = {}

    public init(
        serverFqdn: String = "home.harry.flagship.services",
        requestOrigin: String = "192.0.2.14 · home Wi-Fi",
        fingerprint: String = "4f:9a:7c:b2:01:dd:e8:b1",
        onApprove: @escaping () -> Void = {},
        onBlock: @escaping () -> Void = {}
    ) {
        self.serverFqdn = serverFqdn
        self.requestOrigin = requestOrigin
        self.fingerprint = fingerprint
        self.onApprove = onApprove
        self.onBlock = onBlock
    }

    public var body: some View {
        FSScreen {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Spacer().frame(height: FS.space.s12)
                Text("Unlock your Flagship?").font(FS.font.h2())
                FSColorReader { c in
                    Text("Someone just powered on your server at home. Approve to send the unlock key.")
                        .font(FS.font.body()).foregroundColor(c.textMuted)
                }

                FSCard {
                    LabelValue(label: "Server", value: serverFqdn, mono: true)
                    LabelValue(label: "Requested from", value: requestOrigin)
                    LabelValue(label: "Fingerprint", value: fingerprint + "  ·  tap to verify", mono: true)
                }

                Toggle(isOn: $autoApprove) {
                    Text("Auto-approve from home Wi-Fi for 24h").font(FS.font.bodySm())
                }
                .tint(FSColors.scheme(.light).primary)

                Spacer()

                VStack(spacing: FS.space.s3) {
                    FSPrimaryButton("Approve with Face ID", block: true, large: true, action: onApprove)
                    FSDangerButton("Not me. Block.", block: true, large: true, action: onBlock)
                }
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.bottom, FS.space.s8)
        }
    }
}

private struct LabelValue: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let value: String
    var mono: Bool = false
    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s1) {
            Text(label).font(FS.font.caption()).foregroundColor(c.textMuted)
            Text(value)
                .font(mono ? FS.font.mono() : FS.font.body())
                .foregroundColor(c.text)
        }
    }
}
