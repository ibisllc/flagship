import SwiftUI

/// Placeholder for the "Create a new server" provisioning flow. Real
/// impl mints a build code on flagshipserver.com, hands the user the
/// ISO download link, then waits on /api/install-events for the freshly
/// booted box to phone home. Mirrors `views/create-server.js` +
/// `install-progress` in the webapp.
///
/// The user supplies a short name + one-line description at this step
/// so the server has friendly identification from the moment it
/// appears in the pod list — never an FQDN-only entry.
public struct CreateServerStubScreen: View {
    @Environment(\.colorScheme) private var scheme
    let username: String
    var onDemoComplete: (_ name: String, _ description: String) -> Void = { _, _ in }

    @State private var name: String = ""
    @State private var description: String = ""

    public init(
        username: String,
        onDemoComplete: @escaping (_ name: String, _ description: String) -> Void = { _, _ in }
    ) {
        self.username = username
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

                FSCard {
                    HStack(alignment: .top, spacing: FS.space.s2) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundColor(c.warning)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Not yet wired to flagshipserver.com.").font(FS.font.bodySm()).foregroundColor(c.text)
                            Text("For development you can mint a build code from the webapp at /dev/create-server.").font(FS.font.caption()).foregroundColor(c.textMuted)
                        }
                    }
                }

                FSPrimaryButton(
                    "I've provisioned a server (use mock data)",
                    enabled: !name.isEmpty,
                    block: true,
                    large: true
                ) {
                    onDemoComplete(name, description)
                }
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
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
