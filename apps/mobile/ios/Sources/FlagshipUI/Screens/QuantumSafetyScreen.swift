import SwiftUI
import FlagshipAPI
import FlagshipCore

/// Settings → Quantum-safe protection. Strict is opt-in per server and signed by an admin
/// device; at that moment the owner answers whether browsers may still reach the server and
/// chooses, per classical connector, whether it stays allowed. Nothing has a silent default.
public struct QuantumSafetyScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var viewModel: QuantumSafetyViewModel
    @State private var browserAnswer: [String: Bool] = [:]
    @State private var connectorBlocked: [String: [String: Bool]] = [:]
    @State private var confirmLeave: String?

    public init(viewModel: QuantumSafetyViewModel) { self.viewModel = viewModel }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s5) {
                Text("Strict quantum-resistant protection makes a server refuse anything signed or sent with today's classical cryptography alone. It is off until you turn it on, one server at a time.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted).fixedSize(horizontal: false, vertical: true)
                    .padding(.top, FS.space.s4)
                Text("These protections are new and pending an external review.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                if let custody = viewModel.thisDeviceCustody {
                    Label("This device's key: \(custody)", systemImage: "lock.shield").font(FS.font.caption()).foregroundColor(c.text)
                        .accessibilityIdentifier("qs-custody")
                }
                if let m = viewModel.message {
                    FSCard { Text(m).font(FS.font.bodySm()).foregroundColor(c.text).fixedSize(horizontal: false, vertical: true) }
                }
                switch viewModel.phase {
                case .idle, .loading: ProgressView().frame(maxWidth: .infinity)
                case .failed(let m): Text(m).font(FS.font.bodySm()).foregroundColor(c.danger)
                case .loaded:
                    if viewModel.servers.isEmpty {
                        Text("You have no servers yet.").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    }
                    ForEach(viewModel.servers) { s in serverCard(s, c: c) }
                }
            }
            .padding(.horizontal, FS.space.s4)
            .padding(.bottom, FS.space.s8)
        }
        .navigationTitle("Quantum-safe protection")
        .task { if viewModel.phase == .idle { await viewModel.load() } }
        .refreshable { await viewModel.load() }
        .confirmationDialog("Turn off quantum-safe protection?", isPresented: Binding(get: { confirmLeave != nil }, set: { if !$0 { confirmLeave = nil } }), titleVisibility: .visible) {
            Button("Turn off and accept these losses", role: .destructive) {
                if let f = confirmLeave { Task { _ = await viewModel.turnOff(server: f) } }
                confirmLeave = nil
            }
        } message: {
            Text(QuantumSafety.leavingStrictLoss.map(QuantumSafety.lossText).joined(separator: "\n\n"))
        }
    }

    @ViewBuilder
    private func serverCard(_ s: QuantumSafetyViewModel.ServerRow, c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                HStack {
                    Image(systemName: "server.rack").foregroundColor(c.textMuted)
                    Text(s.name).font(FS.font.h4()).foregroundColor(c.text)
                    Spacer()
                    Text(s.strict ? "Strict" : "Compatibility")
                        .font(FS.font.caption()).foregroundColor(s.strict ? c.success : c.textMuted)
                        .accessibilityIdentifier("qs-status-\(s.fqdn)")
                }
                if s.strict { strictDetails(s, c: c) } else { optIn(s, c: c) }
            }
        }
    }

    @ViewBuilder
    private func strictDetails(_ s: QuantumSafetyViewModel.ServerRow, c: FSColors) -> some View {
        Text(s.replayed?.browsersAllowed == true
             ? "Browsers can still reach it. A browser uses post-quantum key exchange, but the server's identity is proven with a classical certificate."
             : "Only the Flagship app reaches it. Browsers are refused.")
            .font(FS.font.caption()).foregroundColor(c.textMuted).fixedSize(horizontal: false, vertical: true)
        if !s.apps.isEmpty {
            Text("Apps on this server").font(FS.font.bodySm()).foregroundColor(c.text).padding(.top, FS.space.s2)
            Text("Choose for each app whether browsers may reach it. A browser's connection is quantum-safe, but the server's identity is proven with a classical certificate.")
                .font(FS.font.caption()).foregroundColor(c.textMuted).fixedSize(horizontal: false, vertical: true)
            ForEach(s.apps) { a in appRow(s.fqdn, a, c: c) }
        }
        Button("Turn off…", role: .destructive) { confirmLeave = s.fqdn }
            .disabled(viewModel.busy)
            .accessibilityIdentifier("qs-turn-off-\(s.fqdn)")
    }

    @ViewBuilder
    private func appRow(_ fqdn: String, _ a: QuantumSafetyViewModel.AppChoice, c: FSColors) -> some View {
        HStack {
            Text(a.name).font(FS.font.caption()).foregroundColor(c.text)
            Spacer()
            Picker(a.name, selection: Binding(get: { a.appOnly }, set: { appOnly in
                Task { _ = await viewModel.setAppBrowsers(server: fqdn, serviceId: a.serviceId, allowed: !appOnly) }
            })) {
                Text("Only the Flagship app").tag(true)
                Text("Also browsers").tag(false)
            }
            .pickerStyle(.menu)
            .disabled(viewModel.busy)
            .accessibilityIdentifier("qs-app-\(fqdn)-\(a.serviceId)")
        }
    }

    @ViewBuilder
    private func optIn(_ s: QuantumSafetyViewModel.ServerRow, c: FSColors) -> some View {
        if let r = s.readiness, !r.ready {
            VStack(alignment: .leading, spacing: 4) {
                Text("Not ready yet").font(FS.font.bodySm()).foregroundColor(c.text)
                ForEach(r.missing, id: \.self) { m in
                    Label(m, systemImage: "circle").font(FS.font.caption()).foregroundColor(c.textMuted).fixedSize(horizontal: false, vertical: true)
                }
            }
        } else {
            Text("Can browsers still reach this server?").font(FS.font.bodySm()).foregroundColor(c.text)
            Picker("Browsers", selection: Binding(get: { browserAnswer[s.fqdn] }, set: { browserAnswer[s.fqdn] = $0 })) {
                Text("Choose").tag(Bool?.none)
                Text("Only the Flagship app").tag(Bool?.some(false))
                Text("Also browsers").tag(Bool?.some(true))
            }
            .pickerStyle(.menu)
            .accessibilityIdentifier("qs-browsers-\(s.fqdn)")
            if browserAnswer[s.fqdn] == true {
                Text(QuantumSafety.lossText(QuantumSafety.browserLoss)).font(FS.font.caption()).foregroundColor(c.textMuted).fixedSize(horizontal: false, vertical: true)
            }
            Text("Services this server sends things to").font(FS.font.bodySm()).foregroundColor(c.text).padding(.top, FS.space.s2)
            ForEach(viewModel.connectors) { k in connectorRow(s.fqdn, k, c: c) }
            Button("Turn on strict protection") {
                Task {
                    let blocked = Set((connectorBlocked[s.fqdn] ?? [:]).filter { $0.value }.map(\.key))
                    _ = await viewModel.turnOn(server: s.fqdn, browsersAllowed: browserAnswer[s.fqdn] == true, blocked: blocked)
                }
            }
            .disabled(viewModel.busy || !answered(s.fqdn))
            .accessibilityIdentifier("qs-turn-on-\(s.fqdn)")
        }
    }

    private func answered(_ fqdn: String) -> Bool {
        guard browserAnswer[fqdn] != nil else { return false }
        let choices = connectorBlocked[fqdn] ?? [:]
        return viewModel.connectors.filter(\.needsChoice).allSatisfy { choices[$0.id] != nil }
    }

    @ViewBuilder
    private func connectorRow(_ fqdn: String, _ k: QuantumSafety.Connector, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(k.name).font(FS.font.caption()).foregroundColor(c.text)
                Spacer()
                Text(k.protection.label).font(FS.font.caption()).foregroundColor(k.protection == .classical ? c.danger : c.textMuted)
            }
            Text(k.detail).font(FS.font.caption()).foregroundColor(c.textMuted).fixedSize(horizontal: false, vertical: true)
            if k.needsChoice {
                Picker(k.name, selection: Binding(get: { connectorBlocked[fqdn]?[k.id] }, set: { connectorBlocked[fqdn, default: [:]][k.id] = $0 })) {
                    Text("Choose").tag(Bool?.none)
                    Text("Keep using it (classical)").tag(Bool?.some(false))
                    Text("Block it in strict").tag(Bool?.some(true))
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("qs-connector-\(fqdn)-\(k.id)")
            } else {
                Text("Allowed in strict: it carries no content.").font(FS.font.caption()).foregroundColor(c.textMuted)
            }
        }
    }
}
