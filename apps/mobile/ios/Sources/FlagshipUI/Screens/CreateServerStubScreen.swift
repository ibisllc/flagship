import SwiftUI

/// Provisioning flow entry point. The user supplies a short name +
/// one-line description so the server is identified from the moment
/// it appears in the pod list (never an FQDN-only entry). Tapping
/// "Mint a build code" advances the parent to a live install-progress
/// screen that subscribes to the daemon's SSE stream.
public struct CreateServerStubScreen: View {
    @Environment(\.colorScheme) private var scheme
    let username: String
    var onStartProvisioning: (_ serial: String, _ name: String, _ description: String) -> Void = { _, _, _ in }
    var onDemoComplete: (_ name: String, _ description: String) -> Void = { _, _ in }

    @State private var name: String = ""
    @State private var description: String = ""

    public init(
        username: String,
        onStartProvisioning: @escaping (_ serial: String, _ name: String, _ description: String) -> Void = { _, _, _ in },
        onDemoComplete: @escaping (_ name: String, _ description: String) -> Void = { _, _ in }
    ) {
        self.username = username
        self.onStartProvisioning = onStartProvisioning
        self.onDemoComplete = onDemoComplete
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Spacer().frame(height: FS.space.s12)
                Text("Provision a new server").font(FS.font.h2()).foregroundColor(c.text)
                Text("Welcome, \(username). Here's the rough idea:")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)

                FSCard(padding: FS.space.s6) {
                    VStack(alignment: .leading, spacing: FS.space.s4) {
                        step(n: 1, title: "Mint a build code", body: "Flagship hands you a one-time code keyed to your phone's identity.", c: c)
                        step(n: 2, title: "Download the personalized ISO", body: "Paste the code on flagshipserver.com/build to download an Alpine ISO with your trust roots baked in.", c: c)
                        step(n: 3, title: "Boot the box", body: "Flash a USB stick. Boot any commodity machine. LUKS unlock happens on every boot via your phone.", c: c)
                        step(n: 4, title: "Cert + apps", body: "The daemon runs ACME locally, gets a real Let's Encrypt cert, and you're live.", c: c)
                    }
                }

                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        Text("NAME THIS SERVER")
                            .font(.system(size: 12, weight: .semibold))
                            .tracking(1)
                            .foregroundColor(c.textMuted)
                        FSField(value: $name, label: "Short name", placeholder: "Home, Office, Garage")
                        FSField(value: $description, label: "One-line description", placeholder: "Failover for work · Music projects · Family photos", helper: "Up to ~40 characters. Shown wherever the FQDN used to be.")
                    }
                }

                FSPrimaryButton(
                    "Mint a build code & watch boot",
                    enabled: !name.isEmpty,
                    block: true,
                    large: true
                ) {
                    let serial = mintMockSerial()
                    onStartProvisioning(serial, name, description)
                }

                if !name.isEmpty {
                    FSGhostButton(
                        "Skip — pretend it's already running",
                        block: true
                    ) {
                        onDemoComplete(name, description)
                    }
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
    }

    private func mintMockSerial() -> String {
        // Real impl POSTs to flagshipserver.com/api/build-codes/mint and
        // gets back a 12-char build code. Here we synthesize a similar
        // shape so the SSE stream feels real.
        let alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        return String((0..<12).map { _ in alphabet.randomElement()! })
    }

    private func step(n: Int, title: String, body: String, c: FSColors) -> some View {
        HStack(alignment: .top, spacing: FS.space.s3) {
            ZStack {
                Circle().fill(c.primary.opacity(0.12)).frame(width: 28, height: 28)
                Text("\(n)").font(.system(size: 13, weight: .semibold)).foregroundColor(c.primary)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 16, weight: .semibold)).foregroundColor(c.text)
                Text(body).font(FS.font.bodySm()).foregroundColor(c.textMuted)
            }
        }
    }
}
