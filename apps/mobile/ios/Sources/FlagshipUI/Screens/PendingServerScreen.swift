import SwiftUI
import FlagshipCore

/// Placeholder detail page for a pod whose InstallBlob has been
/// delivered but whose box hasn't phoned home yet. Same content as
/// the CreateServer "delivered" step — instructions link + Cancel
/// order. The pod card on Home shows a Pending pill until the server
/// transitions to .online.
public struct PendingServerScreen: View {
    @Environment(\.colorScheme) private var scheme
    let pod: PodInfo
    var onCancelOrder: () -> Void = {}

    public init(pod: PodInfo, onCancelOrder: @escaping () -> Void = {}) {
        self.pod = pod
        self.onCancelOrder = onCancelOrder
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Spacer().frame(height: FS.space.s4)
                VStack(alignment: .leading, spacing: FS.space.s2) {
                    Text(pod.name).font(FS.font.h2()).foregroundColor(c.text)
                    if let desc = pod.description, !desc.isEmpty {
                        Text(desc).font(FS.font.body()).foregroundColor(c.textMuted)
                            .lineLimit(1).truncationMode(.tail)
                    }
                }

                FSCard {
                    VStack(alignment: .leading, spacing: FS.space.s3) {
                        FSPill("Pending", kind: .provisioning)
                        Text("Your boot disk should have started downloading at flagshipserver.com.")
                            .font(FS.font.body())
                            .foregroundColor(c.text)
                        Text("Flash it to a USB drive, boot any commodity box, and this device will appear online here once it phones home — usually a few minutes after first boot.")
                            .font(FS.font.bodySm())
                            .foregroundColor(c.textMuted)
                    }
                }

                Link(destination: URL(string: "https://flagshipserver.com/docs/install")!) {
                    HStack {
                        Image(systemName: "book.fill")
                        Text("How to flash + boot")
                    }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(c.primary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, FS.space.s3)
                }

                FSDangerButton("Cancel order", block: true, large: true, action: onCancelOrder)
                    .accessibilityIdentifier("pending-cancel-order-button")

                Spacer().frame(height: FS.space.s12)
            }
            .padding(.horizontal, FS.space.s6)
        }
        .background(c.bg.ignoresSafeArea())
        .navigationTitle("Pending")
        .navigationBarTitleDisplayMode(.inline)
    }
}
