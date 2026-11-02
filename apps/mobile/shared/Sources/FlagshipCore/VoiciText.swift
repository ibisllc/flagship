import Foundation

/// Text rules for voi.ci pages and Messages (docs/voici-and-messages.md §2.4, §2.6, §6.2, §7.2, §12.1): NFC, lengths
/// in code points after NFC, the refusals every client and `.com` apply alike, the profile link grammar, the strict
/// link matcher for message text (UTF-16 offsets, like JavaScript), the known-site table that picks a link's icon,
/// and the generated visitor name. Swift twin of packages/protocol/src/voiciText.ts (+ voiciLinkSites.json, embedded
/// below) and voiciPseudonymName.ts, pinned by packages/protocol/test-vectors/voici/vectors.json.
///
/// Public API: VoiciText namespace: Field, Rule, Refusal, LinkUrlRefusal, LinkMatch, LinkSite, rules, linkUrlMax,
/// linkSites, checkVoiciText, prepareVoiciText, checkVoiciLinkUrl, voiciUrlHost, findVoiciLinks, voiciLinkSite,
/// voiciPseudonymCode, voiciPseudonymName.
public enum VoiciText {
    public enum Field: String, CaseIterable, Sendable {
        case displayName, bio, linkLabel, postText, messageText, cardTitle, cardSite, cardDescription, nickname, reportNote
    }

    public struct Rule: Equatable, Sendable {
        public let min: Int
        public let max: Int
        public let newline: Bool
    }

    public enum Refusal: String, Sendable {
        case notString = "not-string", notNfc = "not-nfc", tooShort = "too-short", tooLong = "too-long", control, bidi, bom
        case surrogate, edgeInvisible = "edge-invisible"
    }

    public enum LinkUrlRefusal: String, Sendable {
        case notString = "not-string", tooLong = "too-long", scheme, malformed
    }

    /// min/max in code points after NFC; `newline` = "\n" allowed.
    public static let rules: [Field: Rule] = [
        .displayName: Rule(min: 1, max: 64, newline: false),
        .bio: Rule(min: 0, max: 280, newline: true),
        .linkLabel: Rule(min: 1, max: 40, newline: false),
        .postText: Rule(min: 1, max: 2000, newline: true),
        .messageText: Rule(min: 1, max: 2000, newline: true),
        .cardTitle: Rule(min: 1, max: 120, newline: false),
        .cardSite: Rule(min: 0, max: 60, newline: false),
        .cardDescription: Rule(min: 0, max: 200, newline: false),
        .nickname: Rule(min: 1, max: 40, newline: false),
        .reportNote: Rule(min: 0, max: 500, newline: true),
    ]

    static let invisible: Set<UInt32> = [0x200b, 0x200c, 0x200d, 0x2060]

    static func check(_ field: Field, units: [UInt16], nfcOk: () -> Bool) -> Refusal? {
        let rule = rules[field]!
        var cps: [UInt32] = []
        var i = 0
        while i < units.count {
            let c = units[i]
            if c >= 0xd800 && c <= 0xdbff {
                guard i + 1 < units.count, units[i + 1] >= 0xdc00 && units[i + 1] <= 0xdfff else { return .surrogate }
                cps.append(((UInt32(c) - 0xd800) << 10) + (UInt32(units[i + 1]) - 0xdc00) + 0x10000)
                i += 2
                continue
            }
            if c >= 0xdc00 && c <= 0xdfff { return .surrogate }
            cps.append(UInt32(c))
            i += 1
        }
        for c in cps {
            if c == 0x0a && rule.newline { continue }
            if c < 0x20 || c == 0x7f || (c >= 0x80 && c <= 0x9f) { return .control }
            if (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) { return .bidi }
            if c == 0xfeff { return .bom }
        }
        if let f = cps.first, let l = cps.last, invisible.contains(f) || invisible.contains(l) { return .edgeInvisible }
        if !nfcOk() { return .notNfc }
        if cps.count < rule.min { return .tooShort }
        if cps.count > rule.max { return .tooLong }
        return nil
    }

    static func isNfc(_ s: String) -> Bool { s.precomposedStringWithCanonicalMapping.unicodeScalars.elementsEqual(s.unicodeScalars) }

    /// Checks a stored (already NFC) value against a field's rule; nil when accepted.
    public static func checkVoiciText(_ field: Field, _ s: String) -> Refusal? {
        check(field, units: Array(s.utf16), nfcOk: { isNfc(s) })
    }

    /// The same on an untrusted JSON value (not a string: "not-string"; a lone surrogate: "surrogate").
    public static func checkVoiciText(_ field: Field, _ v: JSONValue?) -> Refusal? {
        switch v {
        case .string(let s)?: return checkVoiciText(field, s)
        case .brokenString(let u)?: return check(field, units: u, nfcOk: { true })
        default: return .notString
        }
    }

    /// Normalizes to NFC, then checks: what an editor or the compose box calls on typed text.
    public static func prepareVoiciText(_ field: Field, _ s: String) -> VoiciVerdict<String, Refusal> {
        let n = s.precomposedStringWithCanonicalMapping
        if let code = checkVoiciText(field, n) { return .refused(code) }
        return .ok(n)
    }

    // MARK: URLs

    public static let linkUrlMax = 512
    static let labelLc = "[a-z0-9](?:[a-z0-9\\-]{0,61}[a-z0-9])?"
    static let hostLc = "\(labelLc)(?:\\.\(labelLc))+"
    static let labelCi = "[A-Za-z0-9](?:[A-Za-z0-9\\-]{0,61}[A-Za-z0-9])?"
    static let hostCi = "\(labelCi)(?:\\.\(labelCi))+"
    static let pathChars = "[A-Za-z0-9\\-._~/?#\\[\\]@!\\$\\&'()*+,;=%]"
    // ICU `$` also matches before a final newline; `\z` is JavaScript's `$` without the m flag.
    static let httpsUrl = try! NSRegularExpression(pattern: "\\Ahttps://(\(hostLc))(?::([0-9]{1,5}))?([/?#]\(pathChars)*)?\\z")
    static let mailto = try! NSRegularExpression(pattern: "\\Amailto:[A-Za-z0-9.!#\\$%\\&'*+/=?\\^_`\\{|\\}~\\-]{1,64}@(\(hostLc))\\z")
    // JavaScript /i without the u flag never maps a non-ASCII letter to ASCII; ICU's case folding would (Kelvin
    // sign), so the scan spells the cases out instead of using a case-insensitive flag.
    static let scan = try! NSRegularExpression(pattern: "[Hh][Tt][Tt][Pp][Ss]://(\(hostCi))(?:[/?#]\(pathChars)*)?")
    static let mastodonPath = try! NSRegularExpression(pattern: "\\A/@[A-Za-z0-9_]{1,30}(?:@[a-z0-9.\\-]+)?/?\\z")

    static func firstMatch(_ re: NSRegularExpression, _ s: String) -> NSTextCheckingResult? {
        re.firstMatch(in: s, options: [], range: NSRange(location: 0, length: (s as NSString).length))
    }

    static func group(_ m: NSTextCheckingResult, _ n: Int, in s: String) -> String? {
        let r = m.range(at: n)
        return r.location == NSNotFound ? nil : (s as NSString).substring(with: r)
    }

    /// `https://<lowercase ASCII host>[:port][path]`, or `mailto:<addr>` when `allowMailto`; at most 512 UTF-16 units.
    public static func checkVoiciLinkUrl(_ url: String, allowMailto: Bool = false) -> LinkUrlRefusal? {
        if url.utf16.count > linkUrlMax { return .tooLong }
        if url.hasPrefix("mailto:") {
            if allowMailto && firstMatch(mailto, url) != nil { return nil }
            return allowMailto ? .malformed : .scheme
        }
        if !url.hasPrefix("https://") { return .scheme }
        guard let m = firstMatch(httpsUrl, url) else { return .malformed }
        if let port = group(m, 2, in: url), let n = Int(port), n < 1 || n > 65535 { return .malformed }
        return nil
    }

    public static func checkVoiciLinkUrl(_ v: JSONValue?, allowMailto: Bool = false) -> LinkUrlRefusal? {
        switch v {
        case .string(let s)?: return checkVoiciLinkUrl(s, allowMailto: allowMailto)
        case .brokenString(let u)?:
            // A lone surrogate never matches either grammar: only the length and scheme answers can differ.
            if u.count > linkUrlMax { return .tooLong }
            let s = String(decoding: u, as: UTF16.self)
            if s.hasPrefix("mailto:") { return allowMailto ? .malformed : .scheme }
            return s.hasPrefix("https://") ? .malformed : .scheme
        default: return .notString
        }
    }

    /// The host shown under a link (the mail domain for mailto:), or nil when the URL is refused.
    public static func voiciUrlHost(_ url: String) -> String? {
        if checkVoiciLinkUrl(url, allowMailto: true) != nil { return nil }
        if url.hasPrefix("mailto:") { return firstMatch(mailto, url).flatMap { group($0, 1, in: url) } }
        return firstMatch(httpsUrl, url).flatMap { group($0, 1, in: url) }
    }

    public struct LinkMatch: Equatable, Sendable {
        /// UTF-16 offsets into the text, [start, end).
        public let start: Int
        public let end: Int
        public let url: String
        public let host: String
        public var json: JSONValue { ["start": .number(Double(start)), "end": .number(Double(end)), "url": .string(url), "host": .string(host)] }
    }

    static let trailing: Set<UInt16> = Set(".,;:!?)'\"]".utf16)

    static func isAlnum(_ c: UInt16) -> Bool { (0x41...0x5a).contains(c) || (0x61...0x7a).contains(c) || (0x30...0x39).contains(c) }

    /// The links in message text (see the TS doc): `https://` in any case + a host of two labels or more + an optional
    /// path, after the start or a non-alphanumeric; a host followed by "@" or ":" is no link; trailing `.,;:!?)'"]`
    /// are left out; over 2,048 units is no link. Scheme and host come back lowercased.
    public static func findVoiciLinks(_ text: String) -> [LinkMatch] {
        let ns = text as NSString
        let units = Array(text.utf16)
        var out: [LinkMatch] = []
        var last = 0
        while last <= units.count, let m = scan.firstMatch(in: text, options: [], range: NSRange(location: last, length: units.count - last)) {
            let start = m.range.location
            last = m.range.location + m.range.length
            if start > 0, isAlnum(units[start - 1]) { continue }
            let hostLen = m.range(at: 1).length
            let hostEnd = start + 8 + hostLen
            if hostEnd < units.count {
                let after = units[hostEnd]
                if after == 0x40 || after == 0x3a { last = max(last, hostEnd + 1); continue }
                if isAlnum(after) || after == 0x2d { continue }
            }
            var end = start + m.range.length
            while end - start > 8 + hostLen, trailing.contains(units[end - 1]) { end -= 1 }
            if end - start > 2048 { continue }
            let host = ns.substring(with: NSRange(location: start + 8, length: hostLen)).lowercased()
            let rest = ns.substring(with: NSRange(location: hostEnd, length: end - hostEnd))
            out.append(LinkMatch(start: start, end: end, url: "https://" + host + rest, host: host))
        }
        return out
    }

    // MARK: known sites (voiciLinkSites.json; the tests hold it equal to the vectors' table)

    public struct LinkSite: Equatable, Sendable {
        public let id: String
        public let hosts: [String]
        public let label: String
        public var json: JSONValue { ["id": .string(id), "hosts": .array(hosts.map { .string($0) }), "label": .string(label)] }
    }

    public static let linkSites: [LinkSite] = [
        LinkSite(id: "github", hosts: ["github.com"], label: "GitHub"),
        LinkSite(id: "gitlab", hosts: ["gitlab.com"], label: "GitLab"),
        LinkSite(id: "codeberg", hosts: ["codeberg.org"], label: "Codeberg"),
        LinkSite(id: "mastodon", hosts: ["mastodon.social", "mastodon.online"], label: "Mastodon"),
        LinkSite(id: "bluesky", hosts: ["bsky.app"], label: "Bluesky"),
        LinkSite(id: "linkedin", hosts: ["linkedin.com"], label: "LinkedIn"),
        LinkSite(id: "instagram", hosts: ["instagram.com"], label: "Instagram"),
        LinkSite(id: "youtube", hosts: ["youtube.com", "youtu.be"], label: "YouTube"),
        LinkSite(id: "tiktok", hosts: ["tiktok.com"], label: "TikTok"),
        LinkSite(id: "x", hosts: ["x.com", "twitter.com"], label: "X"),
        LinkSite(id: "threads", hosts: ["threads.net", "threads.com"], label: "Threads"),
        LinkSite(id: "facebook", hosts: ["facebook.com", "fb.com"], label: "Facebook"),
        LinkSite(id: "twitch", hosts: ["twitch.tv"], label: "Twitch"),
        LinkSite(id: "substack", hosts: ["substack.com"], label: "Substack"),
        LinkSite(id: "medium", hosts: ["medium.com"], label: "Medium"),
        LinkSite(id: "patreon", hosts: ["patreon.com"], label: "Patreon"),
        LinkSite(id: "kofi", hosts: ["ko-fi.com"], label: "Ko-fi"),
        LinkSite(id: "buymeacoffee", hosts: ["buymeacoffee.com"], label: "Buy Me a Coffee"),
        LinkSite(id: "spotify", hosts: ["open.spotify.com", "spotify.com"], label: "Spotify"),
        LinkSite(id: "soundcloud", hosts: ["soundcloud.com"], label: "SoundCloud"),
        LinkSite(id: "bandcamp", hosts: ["bandcamp.com"], label: "Bandcamp"),
        LinkSite(id: "applemusic", hosts: ["music.apple.com"], label: "Apple Music"),
        LinkSite(id: "behance", hosts: ["behance.net"], label: "Behance"),
        LinkSite(id: "dribbble", hosts: ["dribbble.com"], label: "Dribbble"),
        LinkSite(id: "stackoverflow", hosts: ["stackoverflow.com"], label: "Stack Overflow"),
        LinkSite(id: "reddit", hosts: ["reddit.com"], label: "Reddit"),
        LinkSite(id: "discord", hosts: ["discord.gg", "discord.com"], label: "Discord"),
        LinkSite(id: "telegram", hosts: ["t.me", "telegram.me"], label: "Telegram"),
        LinkSite(id: "signal", hosts: ["signal.me", "signal.group"], label: "Signal"),
        LinkSite(id: "whatsapp", hosts: ["wa.me", "whatsapp.com"], label: "WhatsApp"),
        LinkSite(id: "pinterest", hosts: ["pinterest.com"], label: "Pinterest"),
        LinkSite(id: "tumblr", hosts: ["tumblr.com"], label: "Tumblr"),
        LinkSite(id: "flickr", hosts: ["flickr.com"], label: "Flickr"),
        LinkSite(id: "vimeo", hosts: ["vimeo.com"], label: "Vimeo"),
        LinkSite(id: "etsy", hosts: ["etsy.com"], label: "Etsy"),
        LinkSite(id: "goodreads", hosts: ["goodreads.com"], label: "Goodreads"),
        LinkSite(id: "letterboxd", hosts: ["letterboxd.com"], label: "Letterboxd"),
        LinkSite(id: "strava", hosts: ["strava.com"], label: "Strava"),
        LinkSite(id: "orcid", hosts: ["orcid.org"], label: "ORCID"),
        LinkSite(id: "keybase", hosts: ["keybase.io"], label: "Keybase"),
        LinkSite(id: "flagship", hosts: ["flagship.services", "voi.ci"], label: "Flagship"),
        LinkSite(id: "email", hosts: [], label: "Email"),
    ]

    static let siteIds: Set<String> = Set(linkSites.map(\.id))

    /// The site id for a link's icon: "email" for mailto:, a table entry whose host equals the URL's host or is a
    /// suffix of it at a dot, else "mastodon" for a `/@user` path on any host, else nil. Nil for a refused URL.
    public static func voiciLinkSite(_ url: String) -> String? {
        guard let host = voiciUrlHost(url) else { return nil }
        if url.hasPrefix("mailto:") { return "email" }
        for s in linkSites where s.hosts.contains(where: { host == $0 || host.hasSuffix("." + $0) }) { return s.id }
        let rest = firstMatch(httpsUrl, url).flatMap { group($0, 3, in: url) } ?? ""
        let path = String(rest.prefix { $0 != "?" && $0 != "#" })
        return firstMatch(mastodonPath, path) != nil ? "mastodon" : nil
    }

    // MARK: generated visitor name (§6.2)

    static let base32Alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

    /// Four RFC 4648 base32 characters of SHA-256 over the raw 32-byte pseudonym key.
    public static func voiciPseudonymCode(_ pseudonymPubHex: String) throws -> String {
        guard CanonicalJson.isLowerHex(pseudonymPubHex, bytes: 32) else {
            throw CanonicalJsonError("pseudonym key must be 32 bytes of lowercase hex")
        }
        let h = CanonicalJson.sha256(try CanonicalJson.hexToBytes(pseudonymPubHex))
        var out = ""
        var buffer = 0, bits = 0
        for b in h {
            buffer = ((buffer << 8) | Int(b)) & 0xffff
            bits += 8
            while bits >= 5 {
                bits -= 5
                out.append(base32Alphabet[(buffer >> bits) & 0x1f])
                if out.count == 4 { return out }
            }
        }
        return out
    }

    public static func voiciPseudonymName(_ pseudonymPubHex: String, prefix: String = "Visitor ") throws -> String {
        prefix + (try voiciPseudonymCode(pseudonymPubHex))
    }
}
