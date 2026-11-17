import SwiftUI

/// A caution or an announcement (docs/design-system.md §8.4): the tone's wash, a 2 pt rule on the leading edge in
/// the tone, a bare line icon, body text in the ink colour so a long warning stays readable.
public struct FSCallout: View {
    public enum Tone { case info, warning, danger }
    @Environment(\.colorScheme) private var scheme
    let text: String
    let tone: Tone
    let identifier: String?

    /// `identifier` goes on the text, so a test finds the sentence as static text.
    public init(_ text: String, tone: Tone = .warning, identifier: String? = nil) {
        self.text = text
        self.tone = tone
        self.identifier = identifier
    }

    public var body: some View {
        let c = FSColors.scheme(scheme)
        let edge: Color = tone == .danger ? c.danger : (tone == .warning ? c.warning : c.primaryFill)
        let wash: Color = tone == .danger ? c.dangerWash : (tone == .warning ? c.warningWash : c.primaryFill.opacity(0.08))
        HStack(alignment: .firstTextBaseline, spacing: FS.space.s2) {
            Image(systemName: tone == .info ? "info.circle" : "exclamationmark.triangle")
                .font(FS.font.caption().weight(.semibold))
                .foregroundColor(edge)
                .accessibilityHidden(true)
            Text(text)
                .font(FS.font.caption())
                .foregroundColor(c.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier(identifier ?? "")
        }
        .padding(FS.space.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(wash)
        .overlay(alignment: .leading) { Rectangle().fill(edge).frame(width: 2) }
        .clipShape(RoundedRectangle(cornerRadius: FS.radius.sm, style: .continuous))
    }
}
