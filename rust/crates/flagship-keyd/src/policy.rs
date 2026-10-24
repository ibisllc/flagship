//! What the box identity key may sign and how fast: an exact port of `packages/keyd/src/policy.ts`.

use std::collections::HashMap;

use crate::wire::{ErrorCode, KeydError, KeydResult, js_is_space};

/// `BOX_SIGN_PURPOSES`. A conformance test compares this list with the TS source.
pub const BOX_SIGN_PURPOSES: &[&str] = &[
    "flagship/install-service/v1",
    "flagship/update-pull/v1",
    "flagship/secret-request/v1",
    "flagship/tunnel-hello/v2",
    "flagship/daemon-status/v1",
    "flagship/service-invite-list/v1",
    "flagship/service-invite-create-fetch/v1",
    "flagship/service-invite-co-manager/v1",
    "flagship/server-revoke-by-self/v1",
    "flagship/server-migration-attach/v1",
    "flagship/server-migration-ack/v1",
    "flagship/pod-binding/v1",
    "flagship/pb-manifest/v1",
    "flagship/mint-reservation/v1",
    "flagship/lan-hint/v1",
    "flagship/dns01-publish/v1",
    "flagship/dns01-delete/v1",
    "flagship/box-trust-status/v1",
    "flagship/box-read-token-request/v1",
    "flagship/server-register/v1",
    "flagship/put-sealed-luks-key/v1",
    "flagship/boot-suspension/v1",
    "flagship/boot-auth/v1",
    "flagship/boot-key-binding/v1",
    "flagship/pq-key-binding/v1",
    "flagship/boot-key-binding/v2",
    "flagship/pq-session-accept/v1",
    "flagship/pq-session-finish/v1",
    "flagship/inject/v1",
    "flagship/sibling-hello/v1",
    "flagship/sibling-sync/v1",
    "flagship/push-relay/v1",
    "flagship/app-copy-fetch/v1",
    "flagship/pb-http/v1",
    "flagship/app-release/v1",
    "flagship/identity-header/v1",
    "flagship/custom-domain-cert/v1",
    "flagship/pb-checkin/v1",
    "flagship/pb-directory/v1",
    "flagship/pb-tokens/v1",
    "flagship/pb-redeem/v1",
    "flagship/pb-filler-fetch/v1",
    "flagship/pb-filler-proof/v1",
    "flagship/pb-root-deposit/v1",
    "pb-put",
    "pb-resp",
    "pb/request-peers/v1",
];

/// `SWK_HKDF_LABELS`: the only workload-key derivations keyd hands out (both unsalted).
pub const SWK_HKDF_LABELS: &[&str] = &[
    "flagship.pb-manifest.v1",
    "flagship/peer-backup-key/v1",
    "flagship/reissue-journal-key/v1",
];

/// `UNSEAL_PURPOSES`: the sealed messages keyd opens and returns.
pub const UNSEAL_PURPOSES: &[&str] = &["pairing-order"];

/// `isPairingOrder`: UTF-8 JSON `{"request": {"type": "add-paired-session", ..}, "signature": "..", ..}`.
pub fn is_pairing_order(plain: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(plain) else {
        return false;
    };
    let Ok(serde_json::Value::Object(o)) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    let Some(serde_json::Value::Object(r)) = o.get("request") else {
        return false;
    };
    r.get("type").and_then(serde_json::Value::as_str) == Some("add-paired-session")
        && o.get("signature").is_some_and(serde_json::Value::is_string)
}

fn is_service_label(p: &str) -> bool {
    let b = p.as_bytes();
    let ok = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    b.first().is_some_and(ok) && b.len() <= 63 && b.iter().all(|c| ok(c) || *c == b'-')
}

/// `isServiceId`: `<creator>--<slug>` or a bare `<slug>`, each half a lowercase DNS label.
pub fn is_service_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split("--").collect();
    parts.len() <= 2 && parts.iter().all(|p| is_service_label(p))
}

pub const MAX_SIGN_BYTES: usize = 256 * 1024;

fn no_purpose() -> KeydError {
    KeydError::forbidden("the message does not start with a purpose")
}

fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s)
}

/// `purposeOf`: everything before the first `|` of the message's first 256 bytes, which must
/// be valid UTF-8 (a fatal `TextDecoder`, which also drops one leading BOM).
pub fn purpose_of(msg: &[u8]) -> KeydResult<String> {
    let head = msg.get(..msg.len().min(256)).unwrap_or(msg);
    let text = std::str::from_utf8(head).map_err(|_| no_purpose())?;
    let text = strip_bom(text);
    match text.find('|') {
        Some(bar) if bar > 0 => Ok(text.get(..bar).unwrap_or_default().to_owned()),
        _ => Err(no_purpose()),
    }
}

/// `checkSign`. Returns the purpose to record in the audit log.
pub fn check_sign(msg: &[u8], public_key_hex: &str, allowed: &[&str]) -> KeydResult<String> {
    check_sign_with(msg, public_key_hex, allowed, None)
}

/// `HYBRID_ONLY_PURPOSES`: signed with both keys only (`sign.hybrid`).
pub const HYBRID_ONLY_PURPOSES: &[&str] = &[
    "flagship/pq-key-binding/v1",
    "flagship/boot-key-binding/v2",
    "flagship/pq-session-accept/v1",
    "flagship/pq-session-finish/v1",
];

fn session_domain_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.first()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && b.len() <= 253
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'-'))
}

/// `checkSign` with its `hybrid` argument: the STK's ML-DSA public key when the request is
/// `sign.hybrid`, `None` for `sign`.
pub fn check_sign_with(
    msg: &[u8],
    public_key_hex: &str,
    allowed: &[&str],
    mldsa_pub_hex: Option<&str>,
) -> KeydResult<String> {
    if msg.is_empty() || msg.len() > MAX_SIGN_BYTES {
        return Err(KeydError::bad_request("message size out of range"));
    }
    let purpose = purpose_of(msg)?;
    if !allowed.contains(&purpose.as_str()) {
        return Err(KeydError::forbidden(format!(
            "the box does not sign {}",
            js_slice(&purpose, 64)
        )));
    }
    if HYBRID_ONLY_PURPOSES.contains(&purpose.as_str()) && mldsa_pub_hex.is_none() {
        return Err(KeydError::forbidden(
            "the box signs that with both of its keys only",
        ));
    }
    if purpose == "flagship/pq-key-binding/v1" {
        // tag|role|subjectId|ed25519PubHex|mldsaPubHex|issuedAt
        let text = String::from_utf8_lossy(msg);
        let parts: Vec<&str> = text.split('|').collect();
        let part = |i: usize| parts.get(i).copied();
        if parts.len() != 6
            || part(1) != Some("box-stk")
            || part(3) != Some(public_key_hex)
            || part(4) != mldsa_pub_hex
        {
            return Err(KeydError::forbidden(
                "the box binds only its own two keys, as the box",
            ));
        }
    }
    if purpose == "flagship/pq-session-accept/v1" || purpose == "flagship/pq-session-finish/v1" {
        // tag|<server domain>|<128-hex transcript digest>
        let text = String::from_utf8_lossy(msg);
        let parts: Vec<&str> = text.split('|').collect();
        let digest_ok = parts.get(2).is_some_and(|d| {
            d.len() == 128
                && d.bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        });
        if parts.len() != 3 || !parts.get(1).is_some_and(|d| session_domain_ok(d)) || !digest_ok {
            return Err(KeydError::forbidden(
                "a session signature names a server and one transcript digest",
            ));
        }
    }
    if purpose == "flagship/inject/v1" || purpose == "flagship/identity-header/v1" {
        // The identity the box asserts to an app (protocol identityAssertion.ts): a member's
        // rank, an anonymous visitor or an API key, one fixed shape each.
        let text = String::from_utf8_lossy(msg);
        if let Some(code) = identity_assertion_refusal(strip_bom(&text)) {
            return Err(KeydError::forbidden(format!(
                "the box asserts only a member, anonymous or an API key ({code})"
            )));
        }
    }
    if purpose == "flagship/boot-suspension/v1" || purpose == "flagship/boot-auth/v1" {
        let text = String::from_utf8_lossy(msg);
        let parts: Vec<&str> = strip_bom(&text).split('|').collect();
        let part = |i: usize| parts.get(i).copied();
        if purpose == "flagship/boot-suspension/v1" {
            // tag|serverDomain|epoch|seq|action|reason|signer|issuedAt
            let seq_ok = part(3).map(js_number).is_some_and(|n| n >= 1.0);
            if parts.len() != 8 || part(6) != Some("box") || part(4) != Some("suspend") || !seq_ok {
                return Err(KeydError::forbidden(
                    "the box key may only sign a suspend, as the box",
                ));
            }
        } else if parts.len() != 8 || part(1) != Some("box") || part(5) != Some(public_key_hex) {
            // tag|role|serverDomain|method|path|pubKeyHex|nonceHex|issuedAt
            return Err(KeydError::forbidden(
                "the box key signs boot requests as the box only",
            ));
        }
    }
    Ok(purpose)
}

const ASSERTED_RANKS: &[&str] = &["member", "manager", "master"];

fn assertion_field(s: &str) -> bool {
    (1..=128).contains(&s.len()) && s.bytes().all(|c| (0x21..=0x7e).contains(&c))
}

fn assertion_time(s: &str) -> bool {
    let b = s.as_bytes();
    match b {
        [b'0'] => true,
        [first, rest @ ..] => {
            (b'1'..=b'9').contains(first) && rest.len() <= 15 && rest.iter().all(u8::is_ascii_digit)
        }
        [] => false,
    }
}

fn api_user(s: &str) -> bool {
    s.strip_prefix("apikey:").is_some_and(|k| {
        (1..=64).contains(&k.len())
            && k.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    })
}

fn user_role_refusal(user: &str, role: &str, api_allowed: bool) -> Option<&'static str> {
    if !assertion_field(user) {
        return Some("bad-user");
    }
    if role == "anonymous" {
        return (user != "anonymous").then_some("bad-user");
    }
    if role == "api" {
        if !api_allowed {
            return Some("bad-role");
        }
        return (!api_user(user)).then_some("bad-user");
    }
    if !ASSERTED_RANKS.contains(&role) {
        return Some("bad-role");
    }
    (user == "anonymous" || user.starts_with("apikey:")).then_some("bad-user")
}

/// `checkIdentityAssertion` (protocol identityAssertion.ts): `None` for a well-formed
/// `flagship/inject/v1` or `flagship/identity-header/v1`, else the refusal code. Vectors:
/// packages/protocol/test-vectors/identity-assertion.
pub fn identity_assertion_refusal(text: &str) -> Option<&'static str> {
    let parts: Vec<&str> = text.split('|').collect();
    let part = |i: usize| parts.get(i).copied().unwrap_or_default();
    match part(0) {
        "flagship/inject/v1" => {
            if parts.len() != 5 && parts.len() != 6 {
                return Some("bad-shape");
            }
            if !assertion_field(part(1)) {
                return Some("bad-app");
            }
            if let Some(r) = user_role_refusal(part(2), part(3), true) {
                return Some(r);
            }
            if !assertion_time(part(4)) {
                return Some("bad-time");
            }
            if part(3) == "api" {
                return (parts.len() != 6 || !matches!(part(5), "read" | "write"))
                    .then_some("bad-scope");
            }
            (parts.len() == 6).then_some("bad-shape")
        }
        "flagship/identity-header/v1" => {
            if parts.len() != 4 {
                return Some("bad-shape");
            }
            if let Some(r) = user_role_refusal(part(1), part(2), false) {
                return Some(r);
            }
            (!assertion_time(part(3))).then_some("bad-time")
        }
        _ => Some("not-an-assertion"),
    }
}

/// `s.slice(0, n)` for UTF-16 code units, never splitting a surrogate pair.
pub fn js_slice(s: &str, n: usize) -> &str {
    let mut units = 0usize;
    for (i, c) in s.char_indices() {
        units = units.saturating_add(c.len_utf16());
        if units > n {
            return s.get(..i).unwrap_or_default();
        }
    }
    s
}

/// JavaScript's `Number(string)` (ToNumber applied to a String).
pub fn js_number(s: &str) -> f64 {
    let t = s.trim_matches(|c: char| js_is_space(c));
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            let mut v = 0.0f64;
            for c in digits.chars() {
                v = v * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0));
            }
            return v;
        }
    }
    let (sign, body) = match t.as_bytes().first() {
        Some(b'+') => (1.0, t.get(1..).unwrap_or_default()),
        Some(b'-') => (-1.0, t.get(1..).unwrap_or_default()),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    if !is_decimal_literal(body) {
        return f64::NAN;
    }
    body.parse::<f64>().map_or(f64::NAN, |v| sign * v)
}

/// StrUnsignedDecimalLiteral: digits [. digits?] | . digits, then an optional exponent.
fn is_decimal_literal(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0usize;
    let digits = |i: &mut usize| {
        let start = *i;
        while b.get(*i).is_some_and(u8::is_ascii_digit) {
            *i = i.saturating_add(1);
        }
        *i > start
    };
    let int = digits(&mut i);
    let mut frac = false;
    if b.get(i) == Some(&b'.') {
        i = i.saturating_add(1);
        frac = digits(&mut i);
    }
    if !int && !frac {
        return false;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i = i.saturating_add(1);
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i = i.saturating_add(1);
        }
        if !digits(&mut i) {
            return false;
        }
    }
    i == b.len()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Limit {
    pub per_second: f64,
    pub burst: f64,
}

/// `DEFAULT_RATE_LIMITS`, in the TS declaration order.
pub const DEFAULT_RATE_LIMITS: &[(&str, Limit)] = &[
    (
        "sign",
        Limit {
            per_second: 2000.0,
            burst: 4000.0,
        },
    ),
    (
        "sign.hybrid",
        Limit {
            per_second: 200.0,
            burst: 400.0,
        },
    ),
    (
        "unseal",
        Limit {
            per_second: 50.0,
            burst: 100.0,
        },
    ),
    (
        "tls.sign",
        Limit {
            per_second: 500.0,
            burst: 1000.0,
        },
    ),
    (
        "tls.createKey",
        Limit {
            per_second: 5.0 / 3600.0,
            burst: 5.0,
        },
    ),
    (
        "tls.install",
        Limit {
            per_second: 0.2,
            burst: 10.0,
        },
    ),
    (
        "acme.sign",
        Limit {
            per_second: 2.0,
            burst: 60.0,
        },
    ),
    (
        "acme.importGranted",
        Limit {
            per_second: 1.0 / 60.0,
            burst: 3.0,
        },
    ),
    (
        "acme.create",
        Limit {
            per_second: 1.0 / 60.0,
            burst: 3.0,
        },
    ),
    (
        "provision.swk",
        Limit {
            per_second: 0.1,
            burst: 3.0,
        },
    ),
    (
        "provision.cgk",
        Limit {
            per_second: 0.1,
            burst: 3.0,
        },
    ),
    (
        "*",
        Limit {
            per_second: 5000.0,
            burst: 10000.0,
        },
    ),
];

pub fn default_rate_limits() -> HashMap<String, Limit> {
    DEFAULT_RATE_LIMITS
        .iter()
        .map(|(k, v)| ((*k).to_owned(), *v))
        .collect()
}

#[derive(Debug, Clone, Copy)]
struct Bucket {
    tokens: f64,
    at: f64,
}

/// Token bucket per operation, the same arithmetic as the TS `RateLimiter`.
#[derive(Debug)]
pub struct RateLimiter {
    limits: HashMap<String, Limit>,
    buckets: HashMap<String, Bucket>,
}

impl RateLimiter {
    pub fn new(limits: HashMap<String, Limit>) -> Self {
        Self {
            limits,
            buckets: HashMap::new(),
        }
    }

    /// `now_ms` is wall-clock milliseconds, as `Date.now()`.
    pub fn take(&mut self, op: &str, now_ms: f64) -> bool {
        let Some(cfg) = self
            .limits
            .get(op)
            .or_else(|| self.limits.get("*"))
            .copied()
        else {
            return true;
        };
        let mut b = self.buckets.get(op).copied().unwrap_or(Bucket {
            tokens: cfg.burst,
            at: now_ms,
        });
        b.tokens = cfg
            .burst
            .min(b.tokens + ((now_ms - b.at) / 1000.0) * cfg.per_second);
        b.at = now_ms;
        let ok = b.tokens >= 1.0;
        if ok {
            b.tokens -= 1.0;
        }
        self.buckets.insert(op.to_owned(), b);
        ok
    }
}

/// Parse a rate-limit table in the TS option shape: `{"op": {"perSecond": n, "burst": n}}`.
pub fn parse_rate_limits(json: &str) -> KeydResult<HashMap<String, Limit>> {
    let bad = || {
        KeydError::new(
            ErrorCode::BadRequest,
            "rate limits must be {op: {perSecond, burst}}",
        )
    };
    let v: serde_json::Value = serde_json::from_str(json).map_err(|_| bad())?;
    let obj = v.as_object().ok_or_else(bad)?;
    let mut out = HashMap::new();
    for (k, l) in obj {
        let per_second = l
            .get("perSecond")
            .and_then(serde_json::Value::as_f64)
            .ok_or_else(bad)?;
        let burst = l
            .get("burst")
            .and_then(serde_json::Value::as_f64)
            .ok_or_else(bad)?;
        if !(per_second.is_finite() && burst.is_finite() && per_second >= 0.0 && burst >= 0.0) {
            return Err(bad());
        }
        out.insert(k.clone(), Limit { per_second, burst });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    const PUB: &str = "2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12";

    fn ok(m: &str) -> String {
        check_sign(m.as_bytes(), PUB, BOX_SIGN_PURPOSES).unwrap()
    }
    fn denied(m: &[u8]) {
        assert!(
            check_sign(m, PUB, BOX_SIGN_PURPOSES).is_err(),
            "{:?}",
            String::from_utf8_lossy(m)
        );
    }

    #[test]
    fn service_ids_and_pairing_orders() {
        for id in ["alice--chess", "habit-tracker", "a--b-", "x"] {
            assert!(is_service_id(id), "{id}");
        }
        let long = "a".repeat(64);
        for id in [
            "Alice--chess",
            "a--b--c",
            "a---b",
            "--b",
            "a--",
            "-a",
            "a b",
            "a.b",
            "",
            long.as_str(),
        ] {
            assert!(!is_service_id(id), "{id}");
        }
        assert!(is_pairing_order(
            br#"{"request":{"type":"add-paired-session"},"signature":"aa"}"#
        ));
        for bad in [
            &br#"{"request":{"type":"x"},"signature":"aa"}"#[..],
            br#"{"request":{"type":"add-paired-session"},"signature":1}"#,
            br#"[{"request":{"type":"add-paired-session"},"signature":"aa"}]"#,
            b"\xef\xbb\xbf{}",
            &[0x11u8; 32],
        ] {
            assert!(!is_pairing_order(bad));
        }
    }

    #[test]
    fn signs_the_box_purposes() {
        assert_eq!(
            ok("flagship/secret-request/v1|a|b"),
            "flagship/secret-request/v1"
        );
        assert_eq!(
            ok("flagship/inject/v1|app|user|member|1"),
            "flagship/inject/v1"
        );
        assert_eq!(ok("pb-put|a|1|2|peer"), "pb-put");
        assert_eq!(
            ok("\u{feff}flagship/inject/v1|x|anonymous|anonymous|1"),
            "flagship/inject/v1"
        );
        assert_eq!(
            ok("flagship/app-release/v1|app|1"),
            "flagship/app-release/v1"
        );
        for t in [
            "pb-checkin",
            "pb-directory",
            "pb-tokens",
            "pb-redeem",
            "pb-filler-fetch",
            "pb-filler-proof",
            "pb-root-deposit",
        ] {
            let tag = format!("flagship/{t}/v1");
            assert_eq!(ok(&format!("{tag}|home.a.flagship.services|1")), tag);
        }
    }

    #[test]
    fn refuses_authority_untagged_and_binary() {
        for m in [
            "flagship/root-entitlement/v1|x",
            "flagship/server-update/v1|x",
            "flagship/order/power-off/v1|x",
            "flagship/account-self-delete/v1|x",
            "flagship/membership/v1|x",
            "flagship/service-grant/v1|x",
            "flagship/app-rank/v1|x",
            "flagship/debug-access/v2|x",
            "flagship/server-share/v1|x",
            "flagship/re-pair-veto/v1|x",
            "no-separator",
            "|leading",
            "random bytes",
            "flagship/inject/v1",
            "flagship/inject/v1 |x",
            "FLAGSHIP/inject/v1|x",
        ] {
            denied(m.as_bytes());
        }
        denied(&[0xff, 0xfe, 0x7c, 1]);
        denied(&[]);
        let mut big = b"flagship/inject/v1|".to_vec();
        big.resize(MAX_SIGN_BYTES + 1, b'a');
        assert_eq!(
            check_sign(&big, PUB, BOX_SIGN_PURPOSES).unwrap_err().code,
            ErrorCode::BadRequest
        );
        // A multi-byte character cut by the 256-byte head window is not text, as in TS.
        let mut cut = vec![b'a'; 255];
        cut.extend_from_slice("é|x".as_bytes());
        denied(&cut);
    }

    #[test]
    fn only_a_suspend_as_the_box() {
        let s = |signer: &str, action: &str, seq: &str| {
            format!(
                "flagship/boot-suspension/v1|home.a.flagship.services|2|{seq}|{action}|dead-man|{signer}|1760000000000"
            )
        };
        assert_eq!(ok(&s("box", "suspend", "1")), "flagship/boot-suspension/v1");
        assert_eq!(
            ok(&s("box", "suspend", " 0x10 ")),
            "flagship/boot-suspension/v1"
        );
        denied(s("owner", "suspend", "1").as_bytes());
        denied(s("box", "resume", "1").as_bytes());
        denied(s("box", "suspend", "0").as_bytes());
        denied(s("box", "suspend", "").as_bytes());
        denied(s("box", "suspend", "abc").as_bytes());
        denied(b"flagship/boot-suspension/v1|x|1|1|suspend|r|box");
    }

    #[test]
    fn boot_requests_only_as_the_box_with_its_own_key() {
        let a = |role: &str, key: &str| {
            format!(
                "flagship/boot-auth/v1|{role}|home.a.flagship.services|GET|/api/boot/x|{key}|aabb|1760000000000"
            )
        };
        assert_eq!(ok(&a("box", PUB)), "flagship/boot-auth/v1");
        denied(a("owner", PUB).as_bytes());
        denied(a("box", &"00".repeat(32)).as_bytes());
    }

    #[test]
    fn js_number_matches_to_number() {
        for (s, v) in [
            ("1", 1.0),
            (" 2 ", 2.0),
            ("+5", 5.0),
            ("-5", -5.0),
            ("1e3", 1000.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("0x1f", 31.0),
            ("0b11", 3.0),
            ("0o7", 7.0),
            ("", 0.0),
            ("\u{a0}3\n", 3.0),
        ] {
            assert!((js_number(s) - v).abs() < f64::EPSILON, "{s}");
        }
        assert!(js_number("Infinity").is_infinite());
        for s in [
            "abc", "1_0", "inf", "NaN", "0x", "-0x1", "1e", "e3", ".", "infinity", "1 2",
        ] {
            assert!(js_number(s).is_nan(), "{s}");
        }
    }

    #[test]
    fn rate_limiter_spends_refills_and_is_per_op() {
        let mut limits = HashMap::new();
        limits.insert(
            "sign".to_owned(),
            Limit {
                per_second: 1.0,
                burst: 2.0,
            },
        );
        limits.insert(
            "*".to_owned(),
            Limit {
                per_second: 100.0,
                burst: 100.0,
            },
        );
        let mut l = RateLimiter::new(limits);
        assert_eq!(
            [
                l.take("sign", 0.0),
                l.take("sign", 0.0),
                l.take("sign", 0.0)
            ],
            [true, true, false]
        );
        assert!(l.take("other", 0.0));
        assert!(l.take("sign", 1000.0));
    }

    #[test]
    fn js_slice_counts_utf16_units() {
        assert_eq!(js_slice("abc", 2), "ab");
        assert_eq!(js_slice("a\u{1F600}b", 2), "a");
        assert_eq!(js_slice("a\u{1F600}b", 3), "a\u{1F600}");
    }

    #[test]
    fn identity_assertions_match_the_shared_vectors() {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/protocol/test-vectors/identity-assertion/vectors.json"
        ))
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let cases = v.get("cases").and_then(|c| c.as_array()).unwrap();
        assert!(cases.len() > 20);
        for c in cases {
            let msg = c.get("msg").and_then(|m| m.as_str()).unwrap();
            let want = c.get("expect").and_then(|e| e.as_str());
            assert_eq!(identity_assertion_refusal(msg), want, "{msg}");
        }
    }
}
