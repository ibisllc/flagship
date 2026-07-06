import SwiftUI
import FlagshipBurnerCore

/// Right sidebar: the "servers on this machine" dashboard. Lists every VM
/// hosted in this app with its live lifecycle state + honest tier badge;
/// "＋ Pair a new server" returns the main area to the QR cover.
struct HostedServersSidebar: View {
    @ObservedObject var model: WizardModel
    @ObservedObject var vmManager: VMManager

    /// Set by a row's Delete action; drives the shared confirmation dialog.
    @State private var confirmDeleteServer: VMManager.HostedServer?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Servers on this Mac")
                .font(FB.Font.rowTitle())
                .foregroundStyle(FB.Colors.ink)
                .padding(.horizontal, FB.Spacing.s3)
                .padding(.vertical, FB.Spacing.s3)
            ScrollView {
                VStack(spacing: FB.Spacing.s2) {
                    ForEach(vmManager.servers) { server in
                        serverRow(server)
                    }
                }
                .padding(.horizontal, FB.Spacing.s2)
            }
            .confirmationDialog(
                confirmDeleteServer.map { "Delete \($0.record.config.serverDomain)?" } ?? "",
                isPresented: Binding(
                    get: { confirmDeleteServer != nil },
                    set: { if !$0 { confirmDeleteServer = nil } }),
                presenting: confirmDeleteServer) { server in
                Button("Delete VM and its disk", role: .destructive) {
                    Task {
                        await vmManager.deleteServer(named: server.id)
                        if model.selectedHostedServer == server.id {
                            model.selectedHostedServer = nil
                        }
                    }
                }
            } message: { _ in
                Text("The VM and its encrypted disk image are removed from this Mac. The server's identity and any backups live with your phone/account, not here.")
            }
            Spacer(minLength: 0)
            Divider()
            Button {
                model.selectedHostedServer = nil
            } label: {
                Label("Pair a new server", systemImage: "plus")
                    .font(FB.Font.caption())
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .padding(FB.Spacing.s3)
        }
        .background(FB.Colors.surface)
    }

    /// One sidebar VM row. Mirrors the Windows sidebar's row actions (⋯ button /
    /// right-click / double-click → Start / Stop / Delete / Open console): the
    /// owner acts on a hosted VM right in the list, no round-trip through the
    /// detail pane. Console is debug-VM-only (gated on `serialConsoleEnabled`,
    /// hard-enforced at the hypervisor in VZHost — a production VM has no console
    /// device at all).
    ///
    /// NOTE — no "Open SSH" on Mac. The Windows/Linux QEMU path forwards a
    /// loopback host port (hostfwd) so it can spawn a terminal at
    /// `ssh -p <port> debug@127.0.0.1`. macOS Virtualization.framework uses
    /// `VZNATNetworkDeviceAttachment` (NAT with no host port-forward and no
    /// host-reachable guest IP), so there is nothing to SSH to. Mac is
    /// console-first: "Open console" attaches to the guest's virtio serial port
    /// (VZHost wires it when the recipe carried the debug grant). Faking an SSH
    /// affordance would be worse than omitting it.
    private func serverRow(_ server: VMManager.HostedServer) -> some View {
        let isSelected = model.selectedHostedServer == server.id
        return HStack(alignment: .top, spacing: FB.Spacing.s1) {
            VStack(alignment: .leading, spacing: 2) {
                Text(server.record.config.serverName + "." + server.record.config.username)
                    .font(FB.Font.rowTitle())
                    .foregroundStyle(FB.Colors.ink)
                    .lineLimit(1)
                Text(server.record.tier.badgeLabel)
                    .font(FB.Font.caption())
                    .foregroundStyle(FB.Colors.textMuted)
                HStack(spacing: FB.Spacing.s1) {
                    stateDot(server.record.state)
                    Text(server.record.state.label)
                        .font(FB.Font.caption())
                        .foregroundStyle(FB.Colors.textMuted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            rowMenu(server)
        }
        .padding(FB.Spacing.s2)
        .background(
            RoundedRectangle(cornerRadius: FB.Radius.sm)
                .fill(isSelected ? FB.Colors.primary.opacity(0.10) : Color.clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: FB.Radius.sm)
                .strokeBorder(isSelected ? FB.Colors.primary : FB.Colors.border, lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: FB.Radius.sm))
        // Double-click is the shortcut to the primary debug action — open the
        // console on a debug VM (parity with Windows double-click → Open SSH,
        // the equivalent primary debug affordance on that platform). Single
        // click selects. Higher count first so it wins the gesture.
        .onTapGesture(count: 2) { handleDoubleClick(server) }
        .onTapGesture { model.selectedHostedServer = server.id }
        .contextMenu { rowActions(server) }
        .pointerCursor()
    }

    /// The ⋯ actions menu on the trailing edge of a row.
    private func rowMenu(_ server: VMManager.HostedServer) -> some View {
        Menu {
            rowActions(server)
        } label: {
            Image(systemName: "ellipsis")
                .font(FB.Font.caption())
                .foregroundStyle(FB.Colors.textMuted)
                .frame(width: 22, height: 18)
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .pointerCursor()
    }

    /// The shared action set — used by BOTH the right-click context menu and the
    /// ⋯ button. Each action first selects the row (so the detail pane follows),
    /// then reuses the same VMManager calls the detail-pane buttons make.
    @ViewBuilder
    private func rowActions(_ server: VMManager.HostedServer) -> some View {
        let name = server.id
        switch server.record.state {
        case .installed, .stopped:
            Button("Start") { select(name); Task { await vmManager.powerOn(named: name) } }
        case .running, .awaitingPhoneUnlock:
            Button("Stop") { select(name); Task { await vmManager.powerOff(named: name) } }
        case .failed(let f) where f.phase == .install:
            if FileManager.default.fileExists(atPath: vmManager.installerISOPath(for: name).path) {
                Button("Retry install") { select(name); Task { await vmManager.beginInstall(named: name) } }
            }
        case .failed:
            Button("Start") { select(name); Task { await vmManager.powerOn(named: name) } }
        case .created, .installing:
            EmptyView()
        }
        if server.record.config.serialConsoleEnabled {
            Button("Open console") { openConsole(server) }
        }
        Divider()
        Button("Delete…", role: .destructive) { select(name); confirmDeleteServer = server }
    }

    private func select(_ name: String) { model.selectedHostedServer = name }

    /// Select the server and request the detail pane open its serial console.
    private func openConsole(_ server: VMManager.HostedServer) {
        select(server.id)
        model.consoleAutoOpenFor = server.id
    }

    private func handleDoubleClick(_ server: VMManager.HostedServer) {
        select(server.id)
        if server.record.config.serialConsoleEnabled { openConsole(server) }
    }

    private func stateDot(_ state: VMState) -> some View {
        Circle().fill(stateColor(state)).frame(width: 7, height: 7)
    }

    private func stateColor(_ state: VMState) -> Color {
        switch state {
        case .running: return FB.Colors.success
        case .awaitingPhoneUnlock, .installing: return FB.Colors.warning
        case .failed: return FB.Colors.danger
        default: return FB.Colors.textMuted
        }
    }
}

/// Main-area detail for one hosted server: status, controls, and — ONLY for
/// a debug-enabled recipe — the one-click serial console. A production VM
/// shows no console affordance at all (the phone-signed grant is the gate;
/// there is no host-side override).
struct VMDetailView: View {
    @ObservedObject var model: WizardModel
    @ObservedObject var vmManager: VMManager
    let name: String

    @State private var confirmDelete = false
    @State private var showConsole = false

    private var server: VMManager.HostedServer? { vmManager.server(named: name) }

    var body: some View {
        if let server {
            VStack(alignment: .leading, spacing: FB.Spacing.s4) {
                header(server)
                statusCard(server)
                specRow(server.record.config)
                controls(server)
                if server.record.config.serialConsoleEnabled {
                    consoleSection(server)
                }
                Spacer(minLength: 0)
                dangerRow(server)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            // A sidebar "Open console" / double-click request auto-opens the
            // serial console here (parity with the Windows ServerRow_OpenConsole
            // path). Consume + clear the one-shot request. Only meaningful for a
            // debug VM — the console section isn't even built otherwise.
            .onChange(of: model.consoleAutoOpenFor) { _, requested in
                consumeConsoleRequest(requested, server: server)
            }
            .onAppear { consumeConsoleRequest(model.consoleAutoOpenFor, server: server) }
        } else {
            Text("This server was removed.")
                .font(FB.Font.caption())
                .foregroundStyle(FB.Colors.textMuted)
        }
    }

    /// Open the serial console if the request names THIS server and the recipe
    /// carried a debug grant. Clears the one-shot request either way.
    private func consumeConsoleRequest(_ requested: String?, server: VMManager.HostedServer) {
        guard requested == name else { return }
        if server.record.config.serialConsoleEnabled { showConsole = true }
        model.consoleAutoOpenFor = nil
    }

    private func header(_ server: VMManager.HostedServer) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(server.record.config.serverName + "." + server.record.config.username)
                .font(FB.Font.title())
                .foregroundStyle(FB.Colors.ink)
            Text(server.record.config.serverDomain)
                .font(FB.Font.mono())
                .foregroundStyle(FB.Colors.textMuted)
                .textSelection(.enabled)
            Text(server.record.tier.badgeLabel)
                .font(FB.Font.caption())
                .foregroundStyle(FB.Colors.primary)
        }
    }

    private func statusCard(_ server: VMManager.HostedServer) -> some View {
        let state = server.record.state
        return StatusCard(icon: statusIcon(state),
                          tint: statusTint(state),
                          title: state.label,
                          subtitle: statusSubtitle(server))
    }

    private func statusIcon(_ state: VMState) -> String {
        switch state {
        case .running: return "checkmark.circle.fill"
        case .awaitingPhoneUnlock: return "lock.iphone"
        case .installing: return "gearshape.arrow.triangle.2.circlepath"
        case .failed: return "exclamationmark.triangle.fill"
        default: return "server.rack"
        }
    }

    private func statusTint(_ state: VMState) -> Color {
        switch state {
        case .running: return FB.Colors.success
        case .awaitingPhoneUnlock, .installing: return FB.Colors.warning
        case .failed: return FB.Colors.danger
        default: return FB.Colors.textMuted
        }
    }

    private func statusSubtitle(_ server: VMManager.HostedServer) -> String {
        switch server.record.state {
        case .awaitingPhoneUnlock:
            return server.record.config.bootUnlockMode == "approve"
                ? "The disk is sealed — approve the unlock on your phone."
                : "The disk is sealed — waiting for the phone-home unlock."
        case .installing:
            return "Unattended install running inside the VM."
        case .running:
            return "Serving at https://\(server.record.config.serverDomain)/"
        case .failed(let f):
            return f.reason
        case .installed, .stopped:
            return "Start the server to bring it online."
        case .created:
            return "Preparing the installer…"
        }
    }

    private func specRow(_ config: VMConfig) -> some View {
        HStack(spacing: FB.Spacing.s4) {
            spec("cpu", "\(config.cpuCount) vCPU")
            spec("memorychip", "\(config.memoryBytes / VMResourcePlan.gib) GiB RAM")
            spec("internaldrive", "\(config.mainDiskSizeBytes / VMResourcePlan.gib) GiB disk")
            spec(config.diskEncrypted ? "lock.fill" : "lock.open",
                 config.diskEncrypted ? "Encrypted (LUKS)" : "Unencrypted")
        }
        .font(FB.Font.caption())
        .foregroundStyle(FB.Colors.textMuted)
    }

    private func spec(_ icon: String, _ label: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon).imageScale(.small)
            Text(label)
        }
    }

    @ViewBuilder
    private func controls(_ server: VMManager.HostedServer) -> some View {
        HStack(spacing: FB.Spacing.s3) {
            switch server.record.state {
            case .installed, .stopped:
                Button("Start") { Task { await vmManager.powerOn(named: name) } }
                    .buttonStyle(.borderedProminent)
            case .running, .awaitingPhoneUnlock:
                Button("Stop") { Task { await vmManager.powerOff(named: name) } }
                    .buttonStyle(.bordered)
            case .failed(let f) where f.phase == .install:
                if FileManager.default.fileExists(
                    atPath: vmManager.installerISOPath(for: name).path) {
                    Button("Retry install") { Task { await vmManager.beginInstall(named: name) } }
                        .buttonStyle(.borderedProminent)
                } else {
                    Text("Delete this server and pair again to rebuild the installer.")
                        .font(FB.Font.caption())
                        .foregroundStyle(FB.Colors.textMuted)
                }
            case .failed:
                Button("Start") { Task { await vmManager.powerOn(named: name) } }
                    .buttonStyle(.borderedProminent)
            case .created, .installing:
                EmptyView()
            }
        }
    }

    /// Debug console — exists IFF the recipe carried the owner-signed debug
    /// grant. The console attaches to the VM's virtio serial port; the guest
    /// side still enforces its own gate (the grant-created debug login).
    @ViewBuilder
    private func consoleSection(_ server: VMManager.HostedServer) -> some View {
        VStack(alignment: .leading, spacing: FB.Spacing.s2) {
            Button {
                showConsole.toggle()
            } label: {
                Label(showConsole ? "Hide console" : "Open CLI/console",
                      systemImage: "terminal")
                    .font(FB.Font.caption())
            }
            .buttonStyle(.link)
            .pointerCursor()
            .disabled(vmManager.host(named: name) == nil)
            if vmManager.host(named: name) == nil {
                Text("Console available while the server is running.")
                    .font(FB.Font.caption())
                    .foregroundStyle(FB.Colors.textMuted)
            }
            if showConsole, let host = vmManager.host(named: name) {
                VMConsoleView(host: host)
                    .frame(minHeight: 180, maxHeight: 260)
            }
        }
    }

    private func dangerRow(_ server: VMManager.HostedServer) -> some View {
        HStack {
            Spacer()
            Button {
                confirmDelete = true
            } label: {
                Label("Delete this server", systemImage: "trash")
                    .font(FB.Font.caption())
                    .foregroundStyle(FB.Colors.danger)
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .confirmationDialog(
                "Delete \(server.record.config.serverDomain)?",
                isPresented: $confirmDelete) {
                Button("Delete VM and its disk", role: .destructive) {
                    Task {
                        await vmManager.deleteServer(named: name)
                        model.selectedHostedServer = nil
                    }
                }
            } message: {
                Text("The VM and its encrypted disk image are removed from this Mac. The server's identity and any backups live with your phone/account, not here.")
            }
        }
    }
}

/// Minimal interactive serial console over the VZ virtio serial pipes:
/// scrolling output + a line-input field. Debug-enabled VMs only — the view
/// is never even constructed for a production VM.
struct VMConsoleView: View {
    let host: VZHost

    @State private var output = ""
    @State private var input = ""

    var body: some View {
        VStack(spacing: FB.Spacing.s1) {
            ScrollViewReader { proxy in
                ScrollView {
                    Text(output.isEmpty ? "— serial console —" : output)
                        .font(FB.Font.mono())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(FB.Spacing.s2)
                    Color.clear.frame(height: 1).id("console-bottom")
                }
                .background(FB.Colors.surfaceSunken)
                .clipShape(RoundedRectangle(cornerRadius: FB.Radius.sm))
                .onChange(of: output) { _, _ in
                    proxy.scrollTo("console-bottom", anchor: .bottom)
                }
            }
            TextField("Type a command and press return…", text: $input)
                .textFieldStyle(.roundedBorder)
                .font(FB.Font.mono())
                .onSubmit {
                    host.consoleInput?.write(Data((input + "\n").utf8))
                    input = ""
                }
        }
        .onAppear { attach() }
        .onDisappear { host.consoleOutput?.readabilityHandler = nil }
    }

    private func attach() {
        guard let out = host.consoleOutput else { return }
        out.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async {
                output += text
                // Keep the buffer bounded.
                if output.count > 200_000 {
                    output = String(output.suffix(150_000))
                }
            }
        }
    }
}
