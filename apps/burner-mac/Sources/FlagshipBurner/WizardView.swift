import SwiftUI
import UniformTypeIdentifiers
import FlagshipBurnerCore

/// The single-screen wizard described in the brief. We deliberately keep
/// it one VStack rather than NavigationStack pages — the user wants to
/// see all four inputs and the log at once on a desktop window.
struct WizardView: View {
    @StateObject private var model = WizardModel()

    var body: some View {
        VStack(alignment: .leading, spacing: FB.Spacing.s6) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: FB.Spacing.s6) {
                    Step1RecipeView(model: model)
                    Step2ISOView(model: model)
                    Step3DiskView(model: model)
                    Step4FlashView(model: model)
                    if model.isFinished {
                        Step5DoneView(model: model)
                    }
                }
                .padding(.horizontal, FB.Spacing.s8)
                .padding(.bottom, FB.Spacing.s8)
            }
            logPanel
        }
        .background(FB.Colors.bg)
        .task { await model.refreshDisks() }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Flagship Burner")
                    .font(FB.Font.h2())
                Text("Phone-signed recipe → USB. The CLI does the work; this is just the wrapper.")
                    .font(FB.Font.body())
                    .foregroundStyle(FB.Colors.textMuted)
            }
            Spacer()
        }
        .padding(.horizontal, FB.Spacing.s8)
        .padding(.top, FB.Spacing.s6)
    }

    private var logPanel: some View {
        VStack(alignment: .leading, spacing: FB.Spacing.s2) {
            HStack {
                Text("Log")
                    .font(FB.Font.h4())
                Spacer()
                if model.isRunning {
                    ProgressView().controlSize(.small)
                    Button("Cancel") { model.cancel() }
                        .keyboardShortcut(.cancelAction)
                }
                Button("Clear") { model.clearLog() }
                    .disabled(model.logLines.isEmpty || model.isRunning)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(model.logLines.enumerated()), id: \.offset) { idx, line in
                            HStack(alignment: .top, spacing: FB.Spacing.s2) {
                                Text(line.stream == .stderr ? "!" : " ")
                                    .font(FB.Font.mono())
                                    .foregroundStyle(line.stream == .stderr ? FB.Colors.danger : FB.Colors.textMuted)
                                Text(line.text)
                                    .font(FB.Font.mono())
                                    .textSelection(.enabled)
                                    .foregroundStyle(line.stream == .stderr ? FB.Colors.danger : .primary)
                            }
                            .id(idx)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(FB.Spacing.s3)
                }
                .frame(maxHeight: 200)
                .background(FB.Colors.surface)
                .clipShape(RoundedRectangle(cornerRadius: FB.Radius.md))
                .onChange(of: model.logLines.count) { _, n in
                    if n > 0 { withAnimation { proxy.scrollTo(n - 1, anchor: .bottom) } }
                }
            }
        }
        .padding(.horizontal, FB.Spacing.s8)
        .padding(.bottom, FB.Spacing.s6)
    }
}

// MARK: - Step 1: recipe

private struct Step1RecipeView: View {
    @ObservedObject var model: WizardModel
    @State private var pasted: String = ""

    var body: some View {
        WizardCard(stepNumber: 1, title: "Drop the recipe", subtitle: "JSON file from the website after you scanned the QR code.") {
            VStack(alignment: .leading, spacing: FB.Spacing.s3) {
                HStack(spacing: FB.Spacing.s3) {
                    DropZone(label: "Drop .flagship-recipe.json here",
                             allowedTypes: [.json, .data, .item],
                             onDrop: { url in model.acceptRecipeFile(url: url) })
                        .frame(minHeight: 80)
                    Button("Choose file…") {
                        if let url = pickFile(types: [.json, .data]) { model.acceptRecipeFile(url: url) }
                    }
                }
                Text("Or paste the JSON:")
                    .font(FB.Font.body())
                    .foregroundStyle(FB.Colors.textMuted)
                TextEditor(text: $pasted)
                    .font(FB.Font.mono())
                    .frame(minHeight: 60, maxHeight: 100)
                    .overlay(RoundedRectangle(cornerRadius: FB.Radius.md).stroke(.separator))
                HStack {
                    Button("Use pasted JSON") {
                        model.acceptRecipeText(pasted)
                    }
                    .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if let r = model.recipe {
                        Text("Loaded: \(r.lastPathComponent)")
                            .foregroundStyle(FB.Colors.success)
                    }
                }
                if let v = model.verified {
                    VerifiedBadge(verify: v)
                }
                if let e = model.recipeError {
                    Text(e).foregroundStyle(FB.Colors.danger).font(FB.Font.body())
                }
            }
        }
    }
}

private struct VerifiedBadge: View {
    let verify: VerifyResult
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Recipe verified")
                .font(FB.Font.h4())
                .foregroundStyle(FB.Colors.success)
            Text("server: \(verify.serverDomain)").font(FB.Font.body())
            if let exp = verify.expiresAt {
                Text("expires: \(exp)").font(FB.Font.body()).foregroundStyle(FB.Colors.textMuted)
            }
        }
        .padding(FB.Spacing.s3)
        .background(FB.Colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: FB.Radius.md))
    }
}

// MARK: - Step 2: ISO

private struct Step2ISOView: View {
    @ObservedObject var model: WizardModel

    var body: some View {
        WizardCard(stepNumber: 2, title: "Drop the ISO", subtitle: "Ubuntu Server stock image. See `flagship-burn distros` for accepted SHAs.") {
            HStack(spacing: FB.Spacing.s3) {
                DropZone(label: "Drop ubuntu-*-live-server.iso here",
                         allowedTypes: [.diskImage, .data, .item],
                         onDrop: { url in model.acceptISOFile(url: url) })
                    .frame(minHeight: 80)
                Button("Choose file…") {
                    if let url = pickFile(types: [.diskImage, .data]) { model.acceptISOFile(url: url) }
                }
                if let iso = model.iso {
                    VStack(alignment: .leading) {
                        Text(iso.lastPathComponent).font(FB.Font.body())
                            .foregroundStyle(FB.Colors.success)
                    }
                }
            }
        }
    }
}

// MARK: - Step 3: USB disk

private struct Step3DiskView: View {
    @ObservedObject var model: WizardModel

    var body: some View {
        WizardCard(stepNumber: 3, title: "Pick the USB drive", subtitle: "Only removable / external drives are listed. The internal disk is hidden on purpose.") {
            VStack(alignment: .leading, spacing: FB.Spacing.s2) {
                HStack {
                    Button("Refresh") { Task { await model.refreshDisks() } }
                        .disabled(model.isRunning)
                    if model.isRefreshingDisks {
                        ProgressView().controlSize(.small)
                    }
                    Spacer()
                }
                if model.disks.isEmpty {
                    Text("No removable disks detected. Plug one in and click Refresh.")
                        .font(FB.Font.body())
                        .foregroundStyle(FB.Colors.textMuted)
                } else {
                    ForEach(model.disks) { d in
                        DiskRow(disk: d,
                                selected: model.selectedDisk?.id == d.id,
                                onTap: { model.selectedDisk = d })
                    }
                }
            }
        }
    }
}

private struct DiskRow: View {
    let disk: USBDisk
    let selected: Bool
    let onTap: () -> Void
    var body: some View {
        HStack {
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(selected ? FB.Colors.primary : FB.Colors.textMuted)
            VStack(alignment: .leading, spacing: 2) {
                Text(disk.displayName).font(FB.Font.body())
                Text("\(disk.deviceNode)  ·  whole: \(disk.isWholeDisk ? "yes" : "no")  ·  removable: \(disk.isRemovable ? "yes" : "no")  ·  external: \(disk.isExternal ? "yes" : "no")")
                    .font(FB.Font.mono())
                    .foregroundStyle(FB.Colors.textMuted)
            }
            Spacer()
        }
        .padding(FB.Spacing.s3)
        .background(selected ? FB.Colors.primary.opacity(0.08) : FB.Colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: FB.Radius.md))
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
    }
}

// MARK: - Step 4: flash

private struct Step4FlashView: View {
    @ObservedObject var model: WizardModel

    var body: some View {
        WizardCard(stepNumber: 4, title: "Bake the ISO", subtitle: "Phase-2 CLI emits a flashable ISO; you'll dd it to the picked disk yourself once everything is wired.") {
            VStack(alignment: .leading, spacing: FB.Spacing.s3) {
                Text(model.readinessSummary)
                    .font(FB.Font.body())
                    .foregroundStyle(model.canFlash ? FB.Colors.success : FB.Colors.textMuted)
                HStack(spacing: FB.Spacing.s3) {
                    Button(action: { Task { await model.runPrepare() } }) {
                        Text(model.isRunning ? "Working…" : "Bake ISO")
                            .frame(minWidth: 140)
                            .padding(.vertical, FB.Spacing.s2)
                    }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .tint(FB.Colors.primary)
                    .disabled(!model.canFlash || model.isRunning)

                    Button("Verify recipe only") {
                        Task { await model.runVerify() }
                    }
                    .disabled(model.recipe == nil || model.isRunning)
                }
                if let outPath = model.outIsoPath {
                    Text("output: \(outPath.path)")
                        .font(FB.Font.mono())
                        .foregroundStyle(FB.Colors.textMuted)
                        .textSelection(.enabled)
                }
            }
        }
    }
}

// MARK: - Step 5: done

private struct Step5DoneView: View {
    @ObservedObject var model: WizardModel
    var body: some View {
        WizardCard(stepNumber: 5, title: "Done", subtitle: "Bring this USB to the machine you're installing on.") {
            VStack(alignment: .leading, spacing: 4) {
                if let v = model.verified {
                    Text("server domain: \(v.serverDomain)").font(FB.Font.h4())
                    if let exp = v.expiresAt { Text("expires: \(exp)").foregroundStyle(FB.Colors.textMuted) }
                }
                if let out = model.outIsoPath {
                    Text("file: \(out.path)").font(FB.Font.mono()).textSelection(.enabled)
                }
                if let disk = model.selectedDisk {
                    Text("hand-off: dd if=\(model.outIsoPath?.path ?? "<iso>") of=\(disk.deviceNode) bs=4M")
                        .font(FB.Font.mono())
                        .textSelection(.enabled)
                }
            }
        }
    }
}

// MARK: - Helpers

private struct WizardCard<Content: View>: View {
    let stepNumber: Int
    let title: String
    let subtitle: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: FB.Spacing.s3) {
            HStack(spacing: FB.Spacing.s3) {
                Text("\(stepNumber)")
                    .font(FB.Font.h3())
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .background(FB.Colors.primary)
                    .clipShape(Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(FB.Font.h3())
                    Text(subtitle).font(FB.Font.body()).foregroundStyle(FB.Colors.textMuted)
                }
            }
            content()
        }
        .padding(FB.Spacing.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background)
        .overlay(RoundedRectangle(cornerRadius: FB.Radius.lg).stroke(.separator))
        .clipShape(RoundedRectangle(cornerRadius: FB.Radius.lg))
    }
}

private struct DropZone: View {
    let label: String
    let allowedTypes: [UTType]
    let onDrop: (URL) -> Void
    @State private var isTargeted = false

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: FB.Radius.md)
                .stroke(isTargeted ? FB.Colors.primary : Color.secondary.opacity(0.5),
                        style: StrokeStyle(lineWidth: 1.5, dash: [4]))
                .background(
                    RoundedRectangle(cornerRadius: FB.Radius.md)
                        .fill(isTargeted ? FB.Colors.primary.opacity(0.08) : Color.clear)
                )
            Text(label)
                .font(FB.Font.body())
                .foregroundStyle(FB.Colors.textMuted)
                .multilineTextAlignment(.center)
                .padding(FB.Spacing.s3)
        }
        .onDrop(of: [.fileURL], isTargeted: $isTargeted) { providers in
            guard let p = providers.first else { return false }
            _ = p.loadObject(ofClass: URL.self) { item, _ in
                if let url = item {
                    DispatchQueue.main.async { onDrop(url) }
                }
            }
            return true
        }
    }
}

private func pickFile(types: [UTType]) -> URL? {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = false
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowedContentTypes = types
    return panel.runModal() == .OK ? panel.url : nil
}
