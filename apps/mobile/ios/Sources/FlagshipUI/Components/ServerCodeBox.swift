import SwiftUI
import FlagshipCore

/// First contact (docs/first-contact.md): the small box directly above Approve. For a server this device
/// has not pinned yet it shows the six-digit code computed here from the key the request names, or
/// "Confirmed by Studio" when Studio read that same key on the server's console. A refused request shows
/// why instead, and the caller offers no Approve.
struct ServerCodeBox: View {
    enum Kind: Equatable {
        case code(String)
        case confirmedByStudio
        case refused(String)
    }

    let kind: Kind
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let c = FSColors.scheme(scheme)
        Group {
            switch kind {
            case .code(let code):
                Text(FirstContact.codeLine(code))
                    .font(FS.font.body())
                    .foregroundColor(c.text)
            case .confirmedByStudio:
                Label(FirstContact.confirmedByStudioText, systemImage: "checkmark.seal.fill")
                    .font(FS.font.body())
                    .foregroundColor(c.text)
            case .refused(let sentence):
                Label(sentence, systemImage: "exclamationmark.octagon.fill")
                    .font(FS.font.body())
                    .foregroundColor(c.danger)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(FS.space.s3)
        .background(RoundedRectangle(cornerRadius: 10).fill(isRefused ? c.dangerWash : c.surfaceSunken))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(isRefused ? c.danger : c.border, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }

    private var identifier: String {
        switch kind {
        case .code: return "first-contact-code"
        case .confirmedByStudio: return "first-contact-studio"
        case .refused: return "first-contact-refused"
        }
    }

    private var isRefused: Bool {
        if case .refused = kind { return true }
        return false
    }

    /// The box for a fetched request, or nil when its key is the pinned one.
    static func kind(for request: SecretRequestCoordinator.VerifiedRequest) -> Kind? {
        switch request.trust {
        case .pinned: return nil
        case .keyChanged: return .refused(FirstContact.keyChangedText)
        case .notFromRecipe: return .refused(FirstContact.notFromRecipeText)
        case .firstSight(let code, _): return request.studioConfirmed ? .confirmedByStudio : .code(code)
        }
    }
}
