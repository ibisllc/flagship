import SwiftUI
import FlagshipAPI
import FlagshipCore
import Flagship

/// "Front page" picker on the server-detail screen: choose which installed
/// app the box's root domain redirects to (a visible 302 to the app's tier-1
/// canonical), or keep the default Flagship page. Save signs a
/// `set-front-page` order with the owner IRK (biometric inside the VM
/// signer) and POSTs it box-direct.
///
/// Self-contained like the other server-detail cards: reads its dependencies
/// (the box-direct front-page client, toasts) from the environment.
struct FrontPageCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.frontPageClient) private var client
    @Environment(ToastCenter.self) private var toasts

    let serverDomain: String

    @State private var vm: FrontPageViewModel?
    @State private var selection: String = ""

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            Text("FRONT PAGE")
                .font(.system(size: 12, weight: .semibold))
                .tracking(1)
                .foregroundColor(c.textMuted)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    Text("What visitors see at \(serverDomain). Point it at one of your apps, or keep the default Flagship page.")
                        .font(FS.font.caption())
                        .foregroundColor(c.textMuted)
                    switch vm?.phase {
                    case .none, .loading:
                        Label("Loading…", systemImage: "circle.dotted")
                            .font(FS.font.body())
                            .foregroundColor(c.textMuted)
                    case .failed(let msg):
                        Text(msg)
                            .font(FS.font.caption())
                            .foregroundColor(c.textMuted)
                        FSSecondaryButton("Retry", block: true) { Task { await reload() } }
                    default:
                        picker(c: c)
                    }
                }
            }
        }
        .task { await reload() }
    }

    @ViewBuilder
    private func picker(c: FSColors) -> some View {
        if let vm {
            Picker("Front page", selection: $selection) {
                Text("Default Flagship page").tag("")
                ForEach(vm.options) { o in
                    Text("\(o.name) — \(o.urlLabel)").tag(o.urlLabel)
                }
                // An assigned-but-uninstalled label still shows (marked), so
                // the owner can see and clear a stale assignment.
                if let cur = vm.current, !vm.options.contains(where: { $0.urlLabel == cur }) {
                    Text("\(cur) (no longer installed)").tag(cur)
                }
            }
            .pickerStyle(.menu)
            .accessibilityIdentifier("sd-front-page-picker")
            .disabled(isBusy)

            FSSecondaryButton(isBusy ? "Saving…" : "Save", block: true) {
                Task { await save() }
            }
            .accessibilityIdentifier("sd-front-page-save")
            .disabled(isBusy || selection == (vm.current ?? ""))
        }
    }

    private var isBusy: Bool {
        switch vm?.phase {
        case .signing, .posting: return true
        default: return false
        }
    }

    @MainActor
    private func reload() async {
        let m = vm ?? FrontPageViewModel(client: client, serverDomain: serverDomain)
        vm = m
        await m.load()
        selection = m.current ?? ""
    }

    @MainActor
    private func save() async {
        guard let vm else { return }
        await vm.save(label: selection)
        if case .failed(let msg) = vm.phase {
            toasts.error(msg)
            selection = vm.current ?? ""
        } else {
            toasts.success(
                selection.isEmpty
                    ? "Front page reset to default"
                    : "Front page set to \(selection)"
            )
        }
    }
}
