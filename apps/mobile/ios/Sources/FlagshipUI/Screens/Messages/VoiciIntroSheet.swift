import SwiftUI
import FlagshipAPI
import FlagshipCore

/// The one-time "Turn on safe messages, calls and posts" offer (owner, 2026-11-20). Only a new account gets it: the
/// create flow arms it when Secure your account closes (never joining, signing in again, a demo or a restore), and the
/// shell shows it once per account on this device, only on a device that can publish the page. The promo line is
/// `.com`'s server config (`GET /api/voici/promo`), not an app string. Turn on opens the Social tab's Profile and goes
/// public the usual way (`PagePublicFlow`: the rules once, the public warning with the first-publish defaults).
public enum VoiciIntro {
    static func key(_ username: String) -> String { "flagship.voici.intro.\(username.lowercased())" }

    /// A new account was created here: its intro waits for the shell. Never re-arms one already shown.
    public static func arm(_ app: AppState, username: String, defaults: UserDefaults = .standard) {
        guard !username.isEmpty, defaults.string(forKey: key(username)) != "shown" else { return }
        defaults.set("pending", forKey: key(username))
        app.pendingVoiciIntro = username
    }

    public static func isPending(username: String, defaults: UserDefaults = .standard) -> Bool {
        !username.isEmpty && defaults.string(forKey: key(username)) == "pending"
    }

    /// True once, when the account's intro is pending; it is recorded as shown at the same time.
    public static func take(username: String, defaults: UserDefaults = .standard) -> Bool {
        guard !username.isEmpty, defaults.string(forKey: key(username)) == "pending" else { return false }
        defaults.set("shown", forKey: key(username))
        return true
    }

    /// `.com`'s promo text for the app's language, or nil (none configured, offline, any error). Replaced by the gym.
    nonisolated(unsafe) public static var fetchPromo: @Sendable (_ lang: String) async -> String? = { lang in
        await livePromo(lang: lang)
    }

    /// The app's language as `.com` names it (pt-BR, zh-Hans …).
    static var appLanguage: String { Bundle.main.preferredLocalizations.first ?? "en" }

    static func livePromo(lang: String) async -> String? {
        var c = URLComponents(url: Endpoints.controlBaseUrl.appendingPathComponent("api/voici/promo"), resolvingAgainstBaseURL: false)
        c?.queryItems = [URLQueryItem(name: "lang", value: lang)]
        guard let url = c?.url else { return nil }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 6)
        req.setValue(lang, forHTTPHeaderField: "Accept-Language")
        guard let (data, resp) = try? await URLSession.shared.gatedData(for: req), (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return promoText(data)
    }

    /// The text of a `{promo: {text, until} | null}` answer, or nil.
    static func promoText(_ data: Data) -> String? {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let p = o["promo"] as? [String: Any],
              let t = (p["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t
    }
}

/// The sheet: what turning it on gives, the optional promo, Turn on or No thanks.
struct VoiciIntroSheet: View {
    let username: String
    var onTurnOn: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var promo: String?

    var body: some View {
        let c = FSColors.scheme(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: FS.space.s4) {
                Image(systemName: "bubble.left.and.text.bubble.right")
                    .font(FS.font.scaled(40))
                    .foregroundColor(c.primary)
                    .accessibilityHidden(true)
                Text("Turn on safe messages, calls and posts")
                    .font(FS.font.h2())
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("voici-intro-title")
                Text("Let people message and call you, and share your updates. Everything is protected against quantum computers. Your page will be at voi.ci/\(username).")
                    .font(.body)
                    .foregroundColor(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                if let promo {
                    Text(verbatim: promo)
                        .font(.callout.weight(.medium))
                        .foregroundColor(c.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(FS.space.s3)
                        .background(c.primary.opacity(0.12), in: RoundedRectangle(cornerRadius: FS.radius.md, style: .continuous))
                        .overlay(alignment: .leading) {
                            UnevenRoundedRectangle(topLeadingRadius: FS.radius.md, bottomLeadingRadius: FS.radius.md, style: .continuous)
                                .fill(c.primary)
                                .frame(width: 3)
                        }
                        .accessibilityIdentifier("voici-intro-promo")
                }
                VStack(spacing: FS.space.s3) {
                    FSPrimaryButton(String(localized: "Turn on"), block: true, large: true) {
                        dismiss()
                        onTurnOn()
                    }
                    .accessibilityIdentifier("voici-intro-turn-on")
                    FSSecondaryButton(String(localized: "No thanks"), block: true, large: true) { dismiss() }
                        .accessibilityIdentifier("voici-intro-no")
                }
                .padding(.top, FS.space.s2)
            }
            .padding(FS.space.s6)
        }
        .scrollBounceBehavior(.basedOnSize)
        .accessibilityIdentifier("voici-intro")
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task { promo = await VoiciIntro.fetchPromo(VoiciIntro.appLanguage) }
    }
}
