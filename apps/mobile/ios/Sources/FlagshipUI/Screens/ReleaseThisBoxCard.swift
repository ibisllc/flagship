import SwiftUI
import FlagshipAPI
import FlagshipCore

/// The server page's "Release this box" on a retail box (docs/retail-box-setup.md §8.2).
struct ReleaseThisBoxCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.screensClient) private var client

    let serverDomain: String
    let username: String
    let retail: RetailBoxView

    @State private var vm: ReleaseThisBoxViewModel?
    @State private var confirm = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            FSSectionLabel(String(localized: "Release this box"))
            FSCard {
                if let vm {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        Text(ReleaseThisBoxViewModel.warning)
                            .font(FS.font.bodySm())
                            .foregroundColor(c.text)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(ReleaseThisBoxViewModel.suggestion)
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                        if vm.released {
                            Text("The server is being wiped. It restarts as a new server.")
                                .font(FS.font.bodySm().weight(.semibold))
                                .foregroundColor(c.text)
                                .accessibilityIdentifier("sd-release-done")
                        } else if vm.canRelease {
                            Button(role: .destructive) { confirm = true } label: {
                                Text(vm.busy ? String(localized: "Releasing…") : String(localized: "Release this box"))
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(c.danger)
                            .disabled(vm.busy)
                            .accessibilityIdentifier("sd-release-button")
                        } else {
                            Text(ReleaseThisBoxViewModel.adminOnly)
                                .font(FS.font.bodySm())
                                .foregroundColor(c.textMuted)
                        }
                        if let e = vm.error {
                            Text(e)
                                .font(FS.font.bodySm())
                                .foregroundColor(c.danger)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("sd-release-error")
                        }
                    }
                } else {
                    ProgressView()
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sd-release")
        .task(id: serverDomain) {
            vm = ReleaseThisBoxViewModel(serverDomain: serverDomain, username: username, stkPubHex: retail.stkPubHex, client: client)
        }
        .confirmationDialog("Release this box?", isPresented: $confirm, titleVisibility: .visible) {
            Button("Wipe and release", role: .destructive) {
                Task { await vm?.release() }
            }
            .accessibilityIdentifier("sd-release-confirm")
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(ReleaseThisBoxViewModel.warning)
        }
    }
}
