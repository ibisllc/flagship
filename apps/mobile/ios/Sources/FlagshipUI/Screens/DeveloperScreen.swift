import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Developer-only settings surface. Unlocked by 3-tapping the version
/// row in AboutStub. Provides:
///
///   - Toggle: use the live ScreensClient (URLSession + paired pod)
///     instead of the mock. Useful once a real pod is paired.
///   - Mock latency slider — pushes the in-memory client's
///     simulatedLatency to exercise loading states.
///   - Sign-out + wipe Keystore for clean-slate testing.
///   - 🧪 NFC pair entry (dev-only) — opens the C3 retail-box flow
///     without affecting the main onboarding chrome. Reachable here
///     until the owner can hold real hardware + we wire it into the
///     "Add a box" navigation properly.
public struct DeveloperScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var dev: DeveloperSettings
    var onWipeIdentity: () -> Void = {}

    public init(dev: DeveloperSettings, onWipeIdentity: @escaping () -> Void = {}) {
        self.dev = dev
        self.onWipeIdentity = onWipeIdentity
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Developer").font(FS.font.h2()).foregroundColor(c.text)
                Text("Switches for testing against the live daemon vs. the mock fixtures. Don't change unless you know what you're doing.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)

                FSCard {
                    Toggle(isOn: $dev.useLiveClient) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Use live data").foregroundColor(c.text)
                            Text(dev.useLiveClient
                                 ? "URLSession against the paired pod (`x-flagship-session`)"
                                 : "Mock fixtures, in-memory")
                                .font(FS.font.caption())
                                .foregroundColor(c.textMuted)
                        }
                    }
                    .tint(c.primary)
                }

                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        HStack {
                            Text("Mock latency").foregroundColor(c.text)
                            Spacer()
                            Text("\(dev.mockLatencyMs) ms").font(FS.font.mono()).foregroundColor(c.textMuted)
                        }
                        Slider(
                            value: Binding(
                                get: { Double(dev.mockLatencyMs) },
                                set: { dev.mockLatencyMs = Int($0) }
                            ),
                            in: 0...2000,
                            step: 50
                        )
                        Text("Applied to mock responses to exercise loading skeletons + error UI.")
                            .font(FS.font.caption())
                            .foregroundColor(c.textMuted)
                    }
                }

                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s2) {
                        Text("🧪 NFC pair (dev-only)").foregroundColor(c.text)
                        Text("Opens the C3 retail-box NFC tap flow. On a Simulator the reader will throw `sessionUnavailable`; on a real device the system NFC sheet will appear.")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                        NavigationLink("Open NFC pair") {
                            NfcPairScreen(vm: NfcPairViewModel(
                                reader: LiveNfcPairReader(),
                                rendezvous: LiveNfcRendezvousClient()
                            ))
                        }
                        .foregroundColor(c.primary)
                    }
                }

                FSDangerButton("Wipe identity (Keystore + session)", block: true, action: onWipeIdentity)
                    .padding(.top, FS.space.s4)
            }
            .padding(FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Developer")
        .navigationBarTitleDisplayMode(.inline)
    }
}
