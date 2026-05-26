import SwiftUI
import FlagshipAPI
import FlagshipCore

/// P6 — per-app invite issuance form. Submits an `AppInviteIssueRequest`
/// and, on success, renders the share URL + a native share sheet
/// (`ShareLink`) plus a copy-fallback button. Mirrors the canonical
/// webapp `views/invite-issue.js`.
public struct InviteIssueScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var vm: InviteIssueViewModel
    private let appLabel: String
    private let onIssued: () -> Void

    public init(
        vm: InviteIssueViewModel,
        appLabel: String,
        onIssued: @escaping () -> Void = {}
    ) {
        _vm = State(initialValue: vm)
        self.appLabel = appLabel
        self.onIssued = onIssued
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                headerCard(c: c)
                formCard(c: c)
                resultCard(c: c)
                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
            .padding(.top, FS.space.s4)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Issue invite")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func headerCard(c: FSColors) -> some View {
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s2) {
                Text(appLabel)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(c.text)
                Text("Invites are bearer share-links. Anyone with the link can claim access — the daemon enforces a 24-hour default TTL. Names you type stay on this device.")
                    .font(FS.font.caption())
                    .foregroundColor(c.textMuted)
            }
        }
    }

    @ViewBuilder
    private func formCard(c: FSColors) -> some View {
        @Bindable var bvm = vm
        FSCard {
            VStack(alignment: .leading, spacing: FS.space.s3) {
                FSField(value: $bvm.displayName,
                        label: "Label (visible only to you)",
                        placeholder: "John (work)")
                rolePicker(c: c)
                channelPicker(c: c)
                FSField(value: $bvm.sentTo,
                        label: "Sent to (memo)",
                        placeholder: "+1 555 0142")
                FSField(value: $bvm.contextNote,
                        label: "Context note (shown to invitee)",
                        placeholder: "from harry's phone — work")
                FSPrimaryButton(
                    issueButtonLabel,
                    block: true,
                    large: true
                ) {
                    Task { await vm.issue(); if case .issued = vm.phase { onIssued() } }
                }
                .disabled(isIssuing)
                .accessibilityIdentifier("invite-issue-submit")
                if case .failed(let msg) = vm.phase {
                    Text(msg)
                        .font(FS.font.bodySm())
                        .foregroundColor(c.danger)
                }
            }
        }
    }

    private var issueButtonLabel: String {
        switch vm.phase {
        case .issuing: return "Issuing…"
        case .issued: return "Issue another"
        default: return "Issue invite"
        }
    }

    private var isIssuing: Bool {
        if case .issuing = vm.phase { return true }
        return false
    }

    @ViewBuilder
    private func resultCard(c: FSColors) -> some View {
        if case let .issued(_, expiresAt, shareUrl) = vm.phase {
            FSCard {
                VStack(alignment: .leading, spacing: FS.space.s3) {
                    Text("Shareable link")
                        .font(FS.font.caption())
                        .foregroundColor(c.text)
                    Text(shareUrl)
                        .font(FS.font.mono())
                        .foregroundColor(c.text)
                        .textSelection(.enabled)
                        .padding(.vertical, FS.space.s2)
                        .padding(.horizontal, FS.space.s3)
                        .background(c.surfaceSunken)
                        .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm))
                        .accessibilityIdentifier("invite-issue-share-url")
                    Text("Expires \(fmtDate(expiresAt))")
                        .font(FS.font.bodySm())
                        .foregroundColor(c.textMuted)
                    HStack(spacing: FS.space.s3) {
                        if let url = URL(string: shareUrl) {
                            ShareLink(item: url) {
                                Label("Share…", systemImage: "square.and.arrow.up")
                            }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("invite-issue-share-sheet")
                        }
                        Button {
                            UIPasteboard.general.string = shareUrl
                        } label: {
                            Label("Copy link", systemImage: "doc.on.doc")
                        }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("invite-issue-copy-btn")
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func rolePicker(c: FSColors) -> some View {
        @Bindable var bvm = vm
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text("Role").font(FS.font.caption()).foregroundColor(c.text)
            Picker("Role", selection: $bvm.role) {
                Text("member").tag("member")
                Text("admin").tag("admin")
                Text("reader").tag("reader")
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("invite-issue-role-picker")
        }
    }

    @ViewBuilder
    private func channelPicker(c: FSColors) -> some View {
        @Bindable var bvm = vm
        VStack(alignment: .leading, spacing: FS.space.s2) {
            Text("Channel").font(FS.font.caption()).foregroundColor(c.text)
            Picker("Channel", selection: $bvm.channel) {
                Text("iMessage").tag("imessage")
                Text("WhatsApp").tag("whatsapp")
                Text("Signal").tag("signal")
                Text("Telegram").tag("telegram")
                Text("Email").tag("email")
                Text("QR").tag("qr")
                Text("AirDrop").tag("airdrop")
                Text("Manual").tag("manual")
                Text("Other").tag("other")
            }
            .pickerStyle(.menu)
            .accessibilityIdentifier("invite-issue-channel-picker")
        }
    }

    private func fmtDate(_ ms: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        let fmt = DateFormatter()
        fmt.dateStyle = .short
        fmt.timeStyle = .short
        return fmt.string(from: date)
    }
}
