import SwiftUI
import FlagshipAPI

/// Real provisioning flow. The user supplies a short name + description,
/// the screen mints a build code via FlagshipServerClient
/// (POST /api/build-codes/mint on flagshipserver.com), then shows the
/// build code + ISO download URL so the user can flash it to a box.
/// "Watch boot" advances to the install-events SSE stream.
public struct CreateServerStubScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: CreateServerViewModel
    var onStartProvisioning: (_ serial: String, _ name: String, _ description: String) -> Void = { _, _, _ in }
    var onDemoComplete: (_ name: String, _ description: String) -> Void = { _, _ in }

    public init(
        vm: CreateServerViewModel,
        onStartProvisioning: @escaping (_ serial: String, _ name: String, _ description: String) -> Void = { _, _, _ in },
        onDemoComplete: @escaping (_ name: String, _ description: String) -> Void = { _, _ in }
    ) {
        self.vm = vm
        self.onStartProvisioning = onStartProvisioning
        self.onDemoComplete = onDemoComplete
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s6) {
                Spacer().frame(height: FS.space.s12)
                Text("Provision a new server").font(FS.font.h2()).foregroundColor(c.text)
                Text("Flagship hands your phone a one-time build code keyed to your identity. Use it to grab a personalized Alpine ISO, flash a USB, and boot any commodity box.")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)

                switch vm.phase {
                case .form:
                    form(c: c)
                case .minting:
                    mintingCard(c: c)
                case .codeReady(let resp):
                    codeCard(resp: resp, c: c)
                case .failed(let msg):
                    ErrorCard(message: msg)
                    FSGhostButton("Try again", block: true) {
                        vm.phase = .form
                    }
                }

                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
    }

    private func form(c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    Text("NAME THIS SERVER")
                        .font(.system(size: 12, weight: .semibold))
                        .tracking(1)
                        .foregroundColor(c.textMuted)
                    FSField(value: $vm.name, label: "Short name", placeholder: "Home, Office, Garage")
                    FSField(value: $vm.description, label: "One-line description", placeholder: "Failover for work · Music projects", helper: "Shown wherever the FQDN used to be.")
                }
            }

            FSPrimaryButton(
                "Mint a build code",
                enabled: vm.canSubmit,
                block: true,
                large: true
            ) {
                Task { await vm.mint() }
            }

            if vm.canSubmit {
                FSGhostButton(
                    "Skip — pretend it's already running",
                    block: true
                ) {
                    onDemoComplete(vm.name, vm.description)
                }
            }
        }
    }

    private func mintingCard(c: FSColors) -> some View {
        FSCard(padding: FS.space.s8) {
            VStack(spacing: FS.space.s4) {
                ProgressView()
                Text("Asking flagshipserver.com for a build code…")
                    .font(FS.font.body())
                    .foregroundColor(c.textMuted)
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func codeCard(resp: MintBuildCodeResponse, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s4) {
            FSCard(padding: FS.space.s6) {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    Text("BUILD CODE")
                        .font(.system(size: 12, weight: .semibold))
                        .tracking(1)
                        .foregroundColor(c.textMuted)
                    Text(resp.buildCode)
                        .font(.system(size: 28, weight: .semibold, design: .monospaced))
                        .foregroundColor(c.text)
                        .tracking(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text("Paste this at flagshipserver.com/build to download your personalized ISO. Expires in 30 minutes.")
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                }
            }

            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("OR DOWNLOAD DIRECTLY").font(.system(size: 12, weight: .semibold)).tracking(1).foregroundColor(c.textMuted)
                    Text(resp.isoUrl)
                        .font(FS.font.mono())
                        .foregroundColor(c.text)
                        .lineLimit(2)
                        .truncationMode(.middle)
                    Link(destination: URL(string: resp.isoUrl)!) {
                        HStack {
                            Image(systemName: "arrow.down.circle.fill")
                            Text("Download personalized ISO")
                        }
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(c.primary)
                    }
                }
            }

            FSCard {
                HStack(alignment: .top, spacing: FS.space.s2) {
                    Image(systemName: "info.circle.fill").foregroundColor(c.primary)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Flash, boot, watch it phone home.").font(FS.font.bodySm()).foregroundColor(c.text)
                        Text("The next screen subscribes to live install-events as your new box boots, gets a TLS cert, and goes ready.")
                            .font(FS.font.caption())
                            .foregroundColor(c.textMuted)
                    }
                }
            }

            FSPrimaryButton("Watch it boot →", block: true, large: true) {
                onStartProvisioning(resp.serial, vm.name, vm.description)
            }
        }
    }
}
