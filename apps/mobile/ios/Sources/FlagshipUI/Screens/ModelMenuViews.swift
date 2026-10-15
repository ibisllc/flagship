import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import FlagshipAPI

/// The compact model menu: the current model's short name; tap for the list
/// (labels + descriptors) and, when the model lists effort levels, the effort picker.
struct ModelMenuButton: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var menu: ModelMenuModel
    @State private var isOpen = false
    var identifier = "model-menu"
    /// False when the effort sits beside the button instead.
    var effortInPanel = true

    var body: some View {
        let c = FSColors.scheme(scheme)
        Button { isOpen = true } label: {
            HStack(spacing: 4) {
                Text(menu.shortName)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
            }
            .foregroundColor(c.primary)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(Capsule().fill(c.primary.opacity(0.10)))
            .frame(maxWidth: 180)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Model: \(menu.shortName)")
        .accessibilityIdentifier(identifier)
        .popover(isPresented: $isOpen, arrowEdge: .top) {
            ModelMenuPanel(menu: menu, showsEffort: effortInPanel)
                .presentationCompactAdaptation(.popover)
        }
        .task { await menu.ensureLoaded() }
    }
}

/// The open menu.
struct ModelMenuPanel: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var menu: ModelMenuModel
    var showsEffort = true

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                content(c: c)
            }
            .padding(.vertical, FS.space.s2)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(width: 320)
        .frame(maxHeight: 460)
        .fixedSize(horizontal: false, vertical: true)
        .background(c.surface)
        .accessibilityIdentifier("model-menu-panel")
    }

    @ViewBuilder
    private func content(c: FSColors) -> some View {
        switch menu.source {
        case .idle, .loading:
            HStack { ProgressView(); Spacer() }.padding(FS.space.s4)
        case .flagship(nil):
            header(ModelMenuText.flagshipInference, c: c)
            row(title: ModelMenuText.flagshipInference, subtitle: ModelMenuText.boxPicks, selected: true, c: c) {}
        case .flagship(let catalog?):
            header(ModelMenuText.flagshipInference, c: c)
            if showsEffort, let efforts = menu.efforts {
                effortRow(efforts, c: c)
                Divider().overlay(c.border).padding(.vertical, FS.space.s1)
            }
            ForEach(catalog.models) { m in
                row(title: m.label, subtitle: m.descriptor, selected: m.id == menu.catalogModel?.id, c: c) {
                    menu.select(m.id)
                }
                .accessibilityIdentifier("model-menu-\(m.id)")
            }
        case .own(let r) where r.listed == true:
            header(r.provider.capitalized, c: c)
            if showsEffort, let efforts = menu.efforts {
                effortRow(efforts, c: c)
                Divider().overlay(c.border).padding(.vertical, FS.space.s1)
            }
            ForEach(menu.ownOptions) { o in
                row(title: o.label, subtitle: o.known ? nil : ModelMenuText.capabilitiesUnknown,
                    selected: o.id == menu.selectedId, c: c) {
                    menu.select(o.id)
                }
            }
        case .own(let r):
            header(r.provider.capitalized, c: c)
            VStack(alignment: .leading, spacing: FS.space.s1) {
                TextField("Model", text: $menu.customModel)
                    .font(FS.font.mono())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: FS.radius.sm).fill(c.surfaceSunken))
                    .overlay(RoundedRectangle(cornerRadius: FS.radius.sm).stroke(c.border, lineWidth: 1))
                    .accessibilityIdentifier("model-menu-custom")
                Text(r.reason == "rejected" ? ModelMenuText.keyRefused : "Type the model's name.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
            }
            .padding(.horizontal, FS.space.s4).padding(.vertical, FS.space.s2)
        }
    }

    private func header(_ t: String, c: FSColors) -> some View { ModelMenuRows.header(t, c: c) }

    private func row(title: String, subtitle: String?, selected: Bool, c: FSColors,
                     action: @escaping () -> Void) -> some View {
        ModelMenuRows.row(title: title, subtitle: subtitle, selected: selected, c: c, action: action)
    }

    private func effortRow(_ efforts: [String], c: FSColors) -> some View {
        HStack {
            Text("Effort").font(FS.font.bodySm()).foregroundColor(c.text)
            Spacer()
            Picker("Effort", selection: Binding(get: { menu.effort ?? "" }, set: { menu.setEffort($0.isEmpty ? nil : $0) })) {
                ForEach(efforts, id: \.self) { e in Text(ModelMenuText.effort(e)).tag(e) }
            }
            .pickerStyle(.menu)
            .tint(c.primary)
            .accessibilityIdentifier("model-menu-effort")
        }
        .padding(.horizontal, FS.space.s4).padding(.vertical, FS.space.s1)
    }
}

/// The rows both menus draw.
enum ModelMenuRows {
    static func header(_ t: String, c: FSColors) -> some View {
        Text(t.uppercased())
            .font(.system(size: 11, weight: .semibold))
            .tracking(0.6)
            .foregroundColor(c.textMuted)
            .lineLimit(1)
            .truncationMode(.middle)
            .padding(.horizontal, FS.space.s4)
            .padding(.top, FS.space.s1).padding(.bottom, FS.space.s2)
    }

    static func row(title: String, subtitle: String?, selected: Bool, c: FSColors,
                    action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: FS.space.s2) {
                Image(systemName: "checkmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(c.primary)
                    .opacity(selected ? 1 : 0)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 15, weight: selected ? .semibold : .regular)).foregroundColor(c.text)
                    if let subtitle {
                        Text(subtitle).font(FS.font.caption().weight(.regular)).foregroundColor(c.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, FS.space.s4).padding(.vertical, FS.space.s2)
            .contentShape(Rectangle())
            .background(selected ? c.primary.opacity(0.06) : Color.clear)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// The build chat's menu: the chosen model's short name (and the key's name
/// for an own key); tap for every group's models.
struct GroupedModelMenuButton: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var menu: GroupedModelMenu
    @State private var isOpen = false
    var identifier = "vibecode-model-menu"

    var body: some View {
        let c = FSColors.scheme(scheme)
        Button { isOpen = true } label: {
            HStack(spacing: 4) {
                Text(menu.shortName)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
            }
            .foregroundColor(c.primary)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(Capsule().fill(c.primary.opacity(0.10)))
            .frame(maxWidth: 200)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Model: \(menu.shortName)")
        .accessibilityIdentifier(identifier)
        .popover(isPresented: $isOpen, arrowEdge: .top) {
            GroupedModelMenuPanel(menu: menu)
                .presentationCompactAdaptation(.popover)
        }
        .task { await menu.loadCurrent() }
    }
}

/// The open grouped menu: Flagship Inference, then each saved key.
struct GroupedModelMenuPanel: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var menu: GroupedModelMenu

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if menu.groups.isEmpty {
                    Text(ModelGroups.noGroups)
                        .font(FS.font.bodySm()).foregroundColor(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, FS.space.s4).padding(.vertical, FS.space.s2)
                }
                ForEach(Array(menu.groups.enumerated()), id: \.element.id) { i, g in
                    if i > 0 { Divider().overlay(c.border).padding(.vertical, FS.space.s1) }
                    group(g, c: c)
                }
            }
            .padding(.vertical, FS.space.s2)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(width: 320)
        .frame(maxHeight: 460)
        .fixedSize(horizontal: false, vertical: true)
        .background(c.surface)
        .accessibilityIdentifier("model-menu-panel")
        .task { await menu.loadAll() }
    }

    @ViewBuilder
    private func group(_ g: ModelMenuGroup, c: FSColors) -> some View {
        let chosen = g.id == menu.selectedGroupId
        ModelMenuRows.header(g.title, c: c)
        switch g.menu.source {
        case .idle, .loading:
            HStack(spacing: FS.space.s2) {
                ProgressView()
                Text(ModelGroups.loadingModels).font(FS.font.bodySm()).foregroundColor(c.textMuted)
                Spacer()
            }
            .padding(.horizontal, FS.space.s4).padding(.vertical, FS.space.s2)
        case .flagship(nil):
            ModelMenuRows.row(title: ModelMenuText.flagshipInference, subtitle: ModelGroups.catalogUnreadable,
                              selected: chosen, c: c) { menu.selectGroup(g.id) }
        case .flagship(let catalog?):
            ForEach(catalog.models) { m in
                ModelMenuRows.row(title: m.label, subtitle: m.descriptor,
                                  selected: chosen && m.id == g.menu.catalogModel?.id, c: c) {
                    menu.pick(groupId: g.id, modelId: m.id)
                }
                .accessibilityIdentifier("model-menu-\(g.id)-\(m.id)")
            }
        case .own(let r) where r.listed == true:
            ForEach(g.menu.ownOptions) { o in
                ModelMenuRows.row(title: o.label, subtitle: o.known ? nil : ModelMenuText.capabilitiesUnknown,
                                  selected: chosen && o.id == g.menu.selectedId, c: c) {
                    menu.pick(groupId: g.id, modelId: o.id)
                }
                .accessibilityIdentifier("model-menu-\(g.id)-\(o.id)")
            }
        case .own(let r):
            VStack(alignment: .leading, spacing: FS.space.s1) {
                TextField("Model", text: Binding(get: { g.menu.customModel },
                                                 set: { g.menu.customModel = $0; menu.selectGroup(g.id) }))
                    .font(FS.font.mono())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: FS.radius.sm).fill(c.surfaceSunken))
                    .overlay(RoundedRectangle(cornerRadius: FS.radius.sm)
                        .stroke(chosen ? c.primary : c.border, lineWidth: 1))
                    .accessibilityIdentifier("model-menu-custom-\(g.id)")
                Text(r.reason == "rejected" ? ModelMenuText.keyRefused : "Type the model's name.")
                    .font(FS.font.caption()).foregroundColor(c.textMuted)
            }
            .padding(.horizontal, FS.space.s4).padding(.vertical, FS.space.s2)
        }
    }
}

/// The effort beside the menu, for a model that lists effort levels.
struct EffortMenuButton: View {
    @Environment(\.colorScheme) private var scheme
    let efforts: [String]
    let selected: String?
    let onPick: (String?) -> Void
    var identifier = "vibecode-effort-menu"

    var body: some View {
        let c = FSColors.scheme(scheme)
        let label = selected.map(ModelMenuText.effort) ?? "Effort"
        Menu {
            Picker("Effort", selection: Binding(get: { selected ?? "" }, set: { onPick($0.isEmpty ? nil : $0) })) {
                ForEach(efforts, id: \.self) { e in Text(ModelMenuText.effort(e)).tag(e) }
            }
        } label: {
            HStack(spacing: 4) {
                Text(label).font(.system(size: 13, weight: .medium)).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
            }
            .foregroundColor(c.textMuted)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .overlay(Capsule().stroke(c.border, lineWidth: 1))
        }
        .accessibilityLabel("Effort: \(label)")
        .accessibilityIdentifier(identifier)
    }
}

/// One attachment: icon by kind + name, removable while staged.
struct AttachmentChip: View {
    @Environment(\.colorScheme) private var scheme
    let name: String
    let kind: ChatAttachmentRules.Kind
    var onRemove: (() -> Void)? = nil

    var body: some View {
        let c = FSColors.scheme(scheme)
        HStack(spacing: 5) {
            Image(systemName: kind.symbol).font(.system(size: 12)).foregroundColor(c.primary)
            Text(name).font(.system(size: 12, weight: .medium)).foregroundColor(c.text)
                .lineLimit(1).truncationMode(.middle)
                .frame(maxWidth: 150, alignment: .leading)
                .fixedSize(horizontal: true, vertical: false)
            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundColor(c.textMuted)
                        .padding(3)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove \(name)")
            }
        }
        .padding(.leading, 8).padding(.trailing, onRemove == nil ? 8 : 4).padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: FS.radius.sm).fill(c.surface))
        .overlay(RoundedRectangle(cornerRadius: FS.radius.sm).stroke(c.border, lineWidth: 1))
    }
}

/// Chips for a sent message's attachments.
struct SentAttachments: View {
    let attachments: [VibeCodeAttachment]
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(attachments.enumerated()), id: \.offset) { _, a in
                    AttachmentChip(name: a.name ?? "file", kind: ChatAttachmentRules.kind(of: a))
                }
            }
        }
    }
}

/// The attach control: Photo / File, both feeding `stager`.
struct AttachButton: View {
    @Environment(\.colorScheme) private var scheme
    let stager: ChatAttachmentStager
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var photoItems: [PhotosPickerItem] = []

    var body: some View {
        let c = FSColors.scheme(scheme)
        Menu {
            Button { showPhotos = true } label: { Label(ChatAttachmentCopy.photo, systemImage: "photo") }
            Button { showFiles = true } label: { Label(ChatAttachmentCopy.file, systemImage: "doc") }
        } label: {
            Image(systemName: "paperclip")
                .font(.system(size: 18, weight: .medium))
                .foregroundColor(c.primary)
                .frame(width: 30, height: 30)
        }
        .accessibilityLabel(ChatAttachmentCopy.attach)
        .accessibilityIdentifier("chat-attach")
        .photosPicker(isPresented: $showPhotos, selection: $photoItems,
                      maxSelectionCount: ChatAttachmentRules.maxPerMessage, matching: .images)
        .fileImporter(isPresented: $showFiles, allowedContentTypes: ChatAttachmentRules.pickerTypes,
                      allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): stager.addFiles(urls)
            case .failure: stager.fail("Couldn't open that file.")
            }
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            Task { @MainActor in
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        stager.addPhoto(data)
                    } else {
                        stager.fail("Couldn't read that photo.")
                    }
                }
                photoItems = []
            }
        }
    }
}

/// Staged chips, the notice, and an inline refusal.
struct StagedAttachmentsBar: View {
    @Environment(\.colorScheme) private var scheme
    let stager: ChatAttachmentStager
    /// Show the notice even before anything is staged (by the attach control).
    var alwaysShowNotice = false

    var body: some View {
        let c = FSColors.scheme(scheme)
        VStack(alignment: .leading, spacing: 6) {
            if !stager.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(stager.staged) { s in
                            AttachmentChip(name: s.name, kind: s.kind) { stager.remove(s.id) }
                        }
                    }
                }
            }
            if alwaysShowNotice || !stager.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Image(systemName: "eye").font(.system(size: 10))
                    Text(stager.hasData ? "\(ChatAttachmentCopy.notice) \(ChatAttachmentCopy.sampleData)" : ChatAttachmentCopy.notice)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.system(size: 12)).foregroundColor(c.textMuted)
                .accessibilityIdentifier("chat-attach-notice")
            }
            if let e = stager.error {
                Text(e).font(.system(size: 12)).foregroundColor(c.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("chat-attach-error")
            }
        }
    }
}

extension View {
    /// The image-switch alert: "I'll have to switch to … for this." with
    /// Switch / Cancel, or "… can't see images." with OK.
    func visionSwitchAlert(_ decision: Binding<VisionDecision?>, onSwitch: @escaping (String) -> Void) -> some View {
        alert(decision.wrappedValue?.message ?? "",
              isPresented: Binding(get: { decision.wrappedValue != nil }, set: { if !$0 { decision.wrappedValue = nil } }),
              presenting: decision.wrappedValue) { d in
            if case .offerSwitch(let to, _) = d {
                Button("Switch") { onSwitch(to) }
                Button("Cancel", role: .cancel) {}
            } else {
                Button("OK", role: .cancel) {}
            }
        }
    }
}
