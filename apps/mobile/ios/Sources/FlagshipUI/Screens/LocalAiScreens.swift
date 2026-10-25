import SwiftUI
import Flagship
import FlagshipAPI
import FlagshipCore

/// The server page's "Local AI" section: what is downloaded and running, and a way into the screen.
struct LocalAiCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.screensClient) private var client
    let serverDomain: String

    @State private var vm: LocalAiViewModel?
    @State private var open = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: FS.space.s3) {
            FSSectionLabel(LocalAiCopy.title)
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    if let vm, vm.view != nil {
                        Text(vm.summary)
                            .font(FS.font.body().weight(.semibold)).foregroundColor(c.text)
                            .accessibilityIdentifier("local-ai-summary")
                    } else if let e = vm?.loadError {
                        Text(e).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    } else {
                        ProgressView()
                    }
                    Text(LocalAiCopy.privacy)
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    FSSecondaryButton(String(localized: "Open Local AI"), block: true) { open = true }
                        .accessibilityIdentifier("local-ai-open")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("local-ai-card")
        .task(id: serverDomain) {
            let m = LocalAiViewModel(serverDomain: serverDomain, client: client)
            vm = m
            await m.load()
        }
        .sheet(isPresented: $open, onDismiss: { Task { await vm?.load() } }) {
            if let vm {
                NavigationStack {
                    LocalAiScreen(vm: vm)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { open = false } } }
                }
            }
        }
    }
}

/// Models, the model server, the job queue, fine-tuning and app access, all on this one server.
struct LocalAiScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: LocalAiViewModel
    @State private var training = false
    @State private var confirmDelete: LocalAiModel?

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                header(c)
                if let e = vm.error {
                    Text(e).font(FS.font.bodySm()).foregroundColor(c.danger)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("local-ai-error")
                }
                if let n = vm.notice {
                    Text(n).font(FS.font.bodySm()).foregroundColor(c.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("local-ai-notice")
                }
                if let v = vm.view {
                    if !v.available, let r = v.reason {
                        Text(r).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    }
                    hardware(v, c: c)
                    service(v, c: c)
                    models(v, c: c)
                    jobs(v, c: c)
                    apps(v, c: c)
                } else if let e = vm.loadError {
                    Text(e).font(FS.font.bodySm()).foregroundColor(c.danger)
                } else {
                    ProgressView()
                }
            }
            .padding(FS.space.s6)
            .fsReadingColumn()
        }
        .navigationTitle(LocalAiCopy.title)
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("local-ai-screen")
        .refreshable { await vm.load() }
        .task {
            await vm.load()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if vm.hasActivity { await vm.load() }
            }
        }
        .sheet(isPresented: $training) {
            NavigationStack { LocalAiFineTuneSheet(vm: vm, onDone: { training = false }) }
        }
        .sheet(item: Binding(get: { vm.jobDetail.map(JobBox.init) }, set: { if $0 == nil { Task { @MainActor in vm.closeJob() } } })) { box in
            NavigationStack { LocalAiJobDetailView(vm: vm, detail: box.detail) }
        }
        .confirmationDialog(String(localized: "Delete this model from the server?"),
                            isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }),
                            titleVisibility: .visible, presenting: confirmDelete) { m in
            Button(String(localized: "Delete model"), role: .destructive) { Task { await vm.delete(m) } }
                .accessibilityIdentifier("local-ai-delete-confirm")
        } message: { m in
            Text("\(m.name) will be removed from this server. You can download it again later.")
        }
    }

    private struct JobBox: Identifiable {
        let detail: LocalAiJobDetail
        var id: String { detail.job.id }
    }

    private func header(_ c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s1) {
            Label(LocalAiCopy.privacy, systemImage: "lock.shield")
                .font(FS.font.bodySm()).foregroundColor(c.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("local-ai-privacy")
            Label(LocalAiCopy.cost, systemImage: "checkmark.seal")
                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                .accessibilityIdentifier("local-ai-cost")
        }
    }

    // MARK: Hardware and settings

    private func hardware(_ v: LocalAiView, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            FSSectionLabel(String(localized: "This server"))
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text("CPUs: \(v.hardware.cpus) · Memory: \(LocalAiCopy.mib(v.hardware.memoryMiB))")
                        .font(FS.font.bodySm()).foregroundColor(c.text)
                    if let free = v.hardware.diskFreeBytes {
                        Text("\(LocalAiCopy.size(free)) of disk free · models use \(LocalAiCopy.size(v.budget.usedBytes)) of their \(LocalAiCopy.size(v.budget.budgetBytes))")
                            .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("local-ai-disk")
                    }
                    if v.hardware.gpus.isEmpty {
                        Text("No GPU on this server: models run on the CPU.")
                            .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    }
                    ForEach(v.hardware.gpus) { g in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("GPU \(g.id): \(g.model), \(LocalAiCopy.mib(g.memoryMiB))")
                                .font(FS.font.bodySm().weight(.semibold)).foregroundColor(c.text)
                            Text(LocalAiCopy.gpuState(g.state)).font(FS.font.caption()).foregroundColor(c.textMuted)
                            ForEach(g.holders, id: \.allocationId) { h in
                                Text("Held by \(h.appName ?? h.appId)")
                                    .font(FS.font.caption()).foregroundColor(c.textMuted)
                                    .accessibilityIdentifier("local-ai-gpu-holder-\(g.id)")
                            }
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("local-ai-gpu-\(g.id)")
                    }
                    Toggle(String(localized: "Use a GPU when one is free"), isOn: Binding(get: { v.settings.useGpu }, set: { on in Task { await vm.setUseGpu(on) } }))
                        .font(FS.font.bodySm())
                        .tint(c.accent)
                        .disabled(vm.busy.contains("gpu"))
                        .accessibilityIdentifier("local-ai-gpu-toggle")
                }
            }
        }
    }

    // MARK: The model server

    private func service(_ v: LocalAiView, c: FSColors) -> some View {
        let s = v.service
        let name = s.modelId.flatMap { id in v.models.first { $0.id == id }?.name }
        return VStack(alignment: .leading, spacing: FS.space.s2) {
            FSSectionLabel(String(localized: "Model server"))
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text(name.map { "\(LocalAiCopy.jobState(s.state)): \($0)" } ?? LocalAiCopy.jobState(s.state))
                        .font(FS.font.body().weight(.semibold)).foregroundColor(c.text)
                        .accessibilityIdentifier("local-ai-service-state")
                    if s.state != "stopped" {
                        Text(LocalAiCopy.device(s.device, gpuIds: s.gpu?.deviceIds))
                            .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    }
                    if let q = LocalAiCopy.queue(s.queuePosition) {
                        Text(q).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    }
                    if let r = s.reason, s.state == "failed" || s.state == "stopped" {
                        Text(r).font(FS.font.bodySm()).foregroundColor(s.state == "failed" ? c.danger : c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Picker(String(localized: "Model to serve"), selection: Binding(get: { v.settings.serveModel ?? "" },
                                                                                  set: { id in Task { await vm.serve(id.isEmpty ? nil : id) } })) {
                        Text("Best downloaded model").tag("")
                        ForEach(vm.installedModels) { m in Text(m.name).tag(m.id) }
                    }
                    .pickerStyle(.menu)
                    .tint(c.accent)
                    .accessibilityIdentifier("local-ai-serve-model")
                    if s.state == "running" || s.state == "starting" || s.state == "queued" {
                        FSSecondaryButton(String(localized: "Stop the model"), block: true) { Task { await vm.stop() } }
                            .accessibilityIdentifier("local-ai-stop")
                    } else {
                        FSPrimaryButton(String(localized: "Start the model"), enabled: !vm.installedModels.isEmpty && !vm.busy.contains("service"), block: true) {
                            Task { await vm.start() }
                        }
                        .accessibilityIdentifier("local-ai-start")
                    }
                }
            }
        }
    }

    // MARK: Models

    private func models(_ v: LocalAiView, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            FSSectionLabel(String(localized: "Models"))
            ForEach(v.models) { m in
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s1) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(m.name).font(FS.font.body().weight(.semibold)).foregroundColor(c.text)
                            Spacer()
                            Text(LocalAiCopy.size(m.sizeBytes)).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        }
                        Text(m.descriptor).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("\(m.parameters) · \(m.quantization) · License: \(m.license.id)")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                        Text(LocalAiCopy.speed(m.speed)).font(FS.font.caption()).foregroundColor(c.textMuted)
                            .accessibilityIdentifier("local-ai-speed-\(m.id)")
                        Text(m.fits ? String(localized: "Needs \(LocalAiCopy.mib(m.memoryNeededMiB)) of memory") : String(localized: "Needs \(LocalAiCopy.mib(m.memoryNeededMiB)) of memory: more than this server has free for it"))
                            .font(FS.font.caption()).foregroundColor(m.fits ? c.textMuted : c.danger)
                            .fixedSize(horizontal: false, vertical: true)
                        if m.tools == false {
                            Text("Can't build apps (no tool calls)").font(FS.font.caption()).foregroundColor(c.textMuted)
                        }
                        Text(LocalAiCopy.modelState(m)).font(FS.font.bodySm()).foregroundColor(m.state == "failed" ? c.danger : c.text)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("local-ai-state-\(m.id)")
                        if let p = m.progress {
                            ProgressView(value: p.fraction)
                                .tint(c.accent)
                                .accessibilityIdentifier("local-ai-progress-\(m.id)")
                        }
                        modelActions(m, c: c)
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("local-ai-model-\(m.id)")
            }
        }
    }

    @ViewBuilder
    private func modelActions(_ m: LocalAiModel, c: FSColors) -> some View {
        let busy = vm.busy.contains("model-\(m.id)")
        if m.isBusy {
            FSSecondaryButton(String(localized: "Cancel download")) { Task { await vm.cancelDownload(m) } }
                .accessibilityIdentifier("local-ai-cancel-\(m.id)")
        } else if m.isInstalled {
            HStack {
                FSGhostButton(String(localized: "Start with this model")) { Task { await vm.start(m.id) } }
                    .accessibilityIdentifier("local-ai-start-\(m.id)")
                Spacer()
                FSDangerButton(String(localized: "Delete"), muted: true) { confirmDelete = m }
                    .disabled(busy)
                    .accessibilityIdentifier("local-ai-delete-\(m.id)")
            }
        } else {
            FSPrimaryButton(String(localized: "Download"), enabled: !busy) { Task { await vm.download(m) } }
                .accessibilityIdentifier("local-ai-download-\(m.id)")
        }
    }

    // MARK: Jobs

    private func jobs(_ v: LocalAiView, c: FSColors) -> some View {
        VStack(alignment: .leading, spacing: FS.space.s2) {
            HStack {
                FSSectionLabel(String(localized: "Jobs"))
                Spacer()
                Button(String(localized: "Fine-tune a model")) {
                    vm.prepareTrain()
                    training = true
                }
                .font(FS.font.bodySm().weight(.semibold))
                .foregroundColor(c.primary)
                .accessibilityIdentifier("local-ai-finetune")
            }
            if v.jobs.isEmpty {
                Text("Nothing is running or waiting.").font(FS.font.bodySm()).foregroundColor(c.textMuted)
            }
            ForEach(v.jobs) { j in
                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s1) {
                        Text(jobTitle(j, v)).font(FS.font.body().weight(.semibold)).foregroundColor(c.text)
                        Text("\(LocalAiCopy.jobState(j.state)) · \(LocalAiCopy.device(j.device, gpuIds: j.gpu?.deviceIds))")
                            .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        if let q = LocalAiCopy.queue(j.queuePosition) {
                            Text(q).font(FS.font.bodySm()).foregroundColor(c.text)
                                .accessibilityIdentifier("local-ai-job-queue-\(j.id)")
                        }
                        if let e = j.epochs {
                            Text("Epoch \(j.epochsDone ?? 0) of \(e) · Checkpoints: \(j.checkpoints ?? 0)")
                                .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        }
                        if let r = j.reason {
                            Text(r).font(FS.font.bodySm()).foregroundColor(j.state == "failed" ? c.danger : c.textMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Text(LocalAiCopy.cost).font(FS.font.caption()).foregroundColor(c.textMuted)
                        if j.isTraining { jobActions(j) }
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("local-ai-job-\(j.id)")
            }
        }
    }

    private func jobTitle(_ j: LocalAiJob, _ v: LocalAiView) -> String {
        let model = j.modelId.flatMap { id in v.models.first { $0.id == id }?.name } ?? j.modelId ?? ""
        if j.isTraining { return String(localized: "Fine-tuning \(model) for \(j.appName ?? j.appId ?? "")") }
        return String(localized: "Model server: \(model)")
    }

    @ViewBuilder
    private func jobActions(_ j: LocalAiJob) -> some View {
        HStack {
            FSGhostButton(String(localized: "Checkpoints")) { Task { await vm.openJob(j) } }
                .accessibilityIdentifier("local-ai-job-open-\(j.id)")
            Spacer()
            if j.canCancel {
                FSSecondaryButton(String(localized: "Cancel")) { Task { await vm.job(.cancel, j) } }
                    .accessibilityIdentifier("local-ai-job-cancel-\(j.id)")
            }
            if j.canResume {
                FSSecondaryButton(String(localized: "Resume")) { Task { await vm.job(.resume, j) } }
                    .accessibilityIdentifier("local-ai-job-resume-\(j.id)")
            }
            if j.canDelete {
                FSDangerButton(String(localized: "Delete"), muted: true) { Task { await vm.job(.delete, j) } }
                    .accessibilityIdentifier("local-ai-job-delete-\(j.id)")
            }
        }
    }

    // MARK: App access

    @ViewBuilder
    private func apps(_ v: LocalAiView, c: FSColors) -> some View {
        if !v.apps.isEmpty {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                FSSectionLabel(String(localized: "Apps that ask to use it"))
                Text("An app only sends its own data, and only while you allow it.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(v.apps) { a in
                    FSCard {
                        VStack(alignment: .leading, spacing: FS.space.s1) {
                            Text(a.name).font(FS.font.body().weight(.semibold)).foregroundColor(c.text)
                            if let g = a.grant {
                                Text("Requests a day: \(g.requestsPerDay) · Tokens a day: \(g.tokensPerDay) · Tokens per answer: \(g.maxTokensPerRequest)")
                                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                    .fixedSize(horizontal: false, vertical: true)
                                if let u = a.usage {
                                    Text("Used today. Requests: \(u.requests) · Tokens: \(u.tokens)").font(FS.font.caption()).foregroundColor(c.textMuted)
                                }
                                FSSecondaryButton(String(localized: "Stop allowing")) { Task { await vm.setAppAccess(a, allowed: false) } }
                                    .accessibilityIdentifier("local-ai-app-withdraw-\(a.serviceId)")
                            } else {
                                Text("Not allowed").font(FS.font.bodySm()).foregroundColor(c.textMuted)
                                FSPrimaryButton(String(localized: "Allow 500 requests a day")) { Task { await vm.setAppAccess(a, allowed: true) } }
                                    .accessibilityIdentifier("local-ai-app-allow-\(a.serviceId)")
                            }
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("local-ai-app-\(a.serviceId)")
                }
            }
        }
    }
}

/// Fine-tune a downloaded model on one app's staged sample data (never its live data).
struct LocalAiFineTuneSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: LocalAiViewModel
    let onDone: () -> Void

    var body: some View {
        let c = FSColors.scheme(scheme)
        Form {
            Section {
                Text("The model learns from the sample data you attached to the app's build chats, never from the app's live data. It runs only on this server.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
            }
            if vm.trainableApps.isEmpty {
                Text("No app has sample data yet. Attach sample data in one of its build chats first.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .accessibilityIdentifier("local-ai-train-no-apps")
            } else {
                Picker(String(localized: "App"), selection: $vm.trainApp) {
                    ForEach(vm.trainableApps) { a in Text(a.name).tag(a.serviceId) }
                }
                .accessibilityIdentifier("local-ai-train-app")
            }
            if vm.trainBases.isEmpty {
                Text("Download a model that can be fine-tuned (TinyStories) first.")
                    .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                    .accessibilityIdentifier("local-ai-train-no-base")
            } else {
                Picker(String(localized: "Base model"), selection: $vm.trainModel) {
                    ForEach(vm.trainBases) { m in Text(m.name).tag(m.id) }
                }
                .accessibilityIdentifier("local-ai-train-model")
            }
            Stepper(value: $vm.trainEpochs, in: 1...LocalAiOrders.maxEpochs) {
                Text("Epochs: \(vm.trainEpochs)")
            }
            .accessibilityIdentifier("local-ai-train-epochs")
            Section {
                Text(LocalAiCopy.cost).font(FS.font.caption()).foregroundColor(c.textMuted)
                if let e = vm.error {
                    Text(e).font(FS.font.bodySm()).foregroundColor(c.danger).accessibilityIdentifier("local-ai-train-error")
                }
                FSPrimaryButton(String(localized: "Start fine-tuning"), enabled: vm.canStartTraining && !vm.busy.contains("train"), block: true) {
                    Task { if await vm.startTraining() { onDone() } }
                }
                .accessibilityIdentifier("local-ai-train-start")
            }
        }
        .navigationTitle(String(localized: "Fine-tune a model"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { onDone() } } }
    }
}

/// One training job's checkpoints: each epoch's file, its size, digest and loss.
struct LocalAiJobDetailView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var vm: LocalAiViewModel
    let detail: LocalAiJobDetail

    var body: some View {
        let c = FSColors.scheme(scheme)
        List {
            Section {
                Text("\(LocalAiCopy.jobState(detail.job.state)) · \(LocalAiCopy.device(detail.job.device, gpuIds: detail.job.gpu?.deviceIds))")
                if let d = detail.datasetDigest {
                    Text("Sample data: \(String(d.prefix(12)))…\(detail.datasetBytes.map { " · \(LocalAiCopy.size($0))" } ?? "")")
                        .font(FS.font.mono()).foregroundColor(c.textMuted)
                }
            }
            Section(String(localized: "Checkpoints")) {
                if detail.checkpoints.isEmpty {
                    Text("No checkpoint yet.").foregroundColor(c.textMuted)
                }
                ForEach(detail.checkpoints) { cp in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Epoch \(cp.epoch)").font(FS.font.body().weight(.semibold))
                        Text("\(LocalAiCopy.size(cp.sizeBytes)) · \(String(cp.sha256.prefix(12)))…")
                            .font(FS.font.mono()).foregroundColor(c.textMuted)
                        if let l = cp.loss {
                            Text("Loss \(l.formatted(.number.precision(.fractionLength(0...3))))")
                                .font(FS.font.caption()).foregroundColor(c.textMuted)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("local-ai-checkpoint-\(cp.epoch)")
                }
            }
        }
        .navigationTitle(String(localized: "Checkpoints"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { vm.closeJob() } } }
        .accessibilityIdentifier("local-ai-job-detail")
    }
}
