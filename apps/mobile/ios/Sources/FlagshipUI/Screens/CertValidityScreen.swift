import SwiftUI
import FlagshipCore

/// Settings → Certificates → Certificate validity.
///
/// Account-wide renewal window for servers your devices manage. This is the
/// dead-man's-switch: if every admin device stays offline past this window, a
/// managed server's TLS certificate lapses and the box stops serving — the
/// safety cut-off if you lose your phone. Only admin devices mint; autonomous
/// (self-renewing) servers ignore this window.
public struct CertValidityScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var validity = CertValidityStore()

    public init() {}

    public var body: some View {
        @Bindable var validity = validity
        let c = FSColors.scheme(scheme)
        return ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Text("Certificate validity").font(FS.font.h2()).foregroundColor(c.text)
                Text("How long a server your devices manage keeps serving before its TLS certificate must be renewed. If every admin device stays offline past this window, the certificate lapses and the box stops serving — the safety cut-off if you lose your phone. Applies account-wide; only admin devices mint.")
                    .font(FS.font.body()).foregroundColor(c.textMuted)

                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        Picker("Certificate validity", selection: $validity.days) {
                            ForEach(CertValidityStore.presets, id: \.self) { d in
                                Text("\(d) days").tag(d)
                            }
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("cert-validity-picker")
                        Text("Shorter is safer — the box dies faster if you lose access; longer is more forgiving. Default 30 days. Self-renewing servers ignore this.")
                            .font(FS.font.caption()).foregroundColor(c.textMuted)
                    }
                }
            }
            .padding(FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Certificate validity")
        .navigationBarTitleDisplayMode(.inline)
    }
}
