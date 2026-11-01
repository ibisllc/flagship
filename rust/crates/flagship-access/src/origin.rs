//! The sibling-app guard (docs/app-apis.md §4; `isCrossOriginUnsafe` in serviceProxy.ts). Apps on
//! one server share a site, so an unsafe request or a WebSocket upgrade whose `Origin` (else
//! `Sec-Fetch-Site`, else `Referer`) shows another origin carries no member. The app's own origin
//! is the host the router selected it by, never the request's `Host`.

use std::collections::BTreeMap;

const SAFE_METHODS: [&str; 3] = ["GET", "HEAD", "OPTIONS"];

/// The origin of an `http(s)` URL (`scheme://host[:port]`, default port dropped, lower case), or
/// `None`. Stricter than a browser's URL parser: anything it does not plainly understand is
/// another origin.
#[must_use]
pub fn normalize_origin(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let (scheme, rest) = raw.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "https" => 443u32,
        "http" => 80,
        _ => return None,
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = rest.get(..end)?;
    // Only printable ASCII: a browser sends a punycoded host, a control or non-ASCII space is never part of one, and
    // `trim` on a second pass would eat a trailing one, so accepting them made the result non-idempotent (fuzz:
    // access_origin found `\v` and U+00A0). Refusing gives no origin, which counts as cross-origin: fail closed.
    if authority.contains(['\\', '@'])
        || !authority.chars().all(|c| c.is_ascii_graphic())
        || authority.is_empty()
    {
        return None;
    }
    let (host, port) = if let Some(after) = authority.strip_prefix('[') {
        let close = after.find(']')?;
        let host = format!("[{}]", after.get(..close)?);
        let tail = after.get(close.checked_add(1)?..)?;
        (
            host,
            if tail.is_empty() {
                None
            } else {
                Some(tail.strip_prefix(':')?)
            },
        )
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_owned(), Some(p)),
            None => (authority.to_owned(), None),
        }
    };
    if host.is_empty() || host == "[]" {
        return None;
    }
    // Outside an IPv6 literal a host never holds ':', '[' or ']' (the TS twin's URL parse refuses them). Accepting one
    // made the result non-idempotent: `http://a:b:80` gave `http://a:b`, which then gave `http://a` (fuzz: access_origin).
    if !host.starts_with('[') && host.contains([':', '[', ']']) {
        return None;
    }
    let host = host.to_ascii_lowercase();
    let port = match port {
        None | Some("") => None,
        Some(p) => {
            if p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let n: u32 = p.parse().ok()?;
            if n > 65_535 {
                return None;
            }
            (n != default_port).then_some(n)
        }
    };
    Some(match port {
        Some(n) => format!("{scheme}://{host}:{n}"),
        None => format!("{scheme}://{host}"),
    })
}

/// Whether this request must lose its member: an unsafe method or an upgrade from another origin.
/// `headers` are lower-case names. No origin signal at all (curl, scripts) counts as same-origin.
#[must_use]
pub fn is_cross_origin_unsafe(
    method: &str,
    upgrade: bool,
    headers: &BTreeMap<String, String>,
    routed_host: &str,
) -> bool {
    if !upgrade && SAFE_METHODS.contains(&method.to_ascii_uppercase().as_str()) {
        return false;
    }
    let own = normalize_origin(&format!("https://{}", routed_host.trim()));
    let differs = |v: &str| own.is_none() || normalize_origin(v) != own;
    let present = |k: &str| headers.get(k).filter(|v| !v.is_empty());
    if let Some(origin) = present("origin") {
        return differs(origin);
    }
    if let Some(site) = present("sec-fetch-site") {
        let v = site.trim().to_ascii_lowercase();
        return v != "same-origin" && v != "none";
    }
    if let Some(referer) = present("referer") {
        return differs(referer);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_control_character_in_the_host_is_no_origin() {
        assert_eq!(normalize_origin("http://\u{0}\u{b}?.2xh"), None);
        assert_eq!(normalize_origin("https://a\u{7f}.b"), None);
        // A trailing one is trimmed off the whole value first, as before.
        assert_eq!(
            normalize_origin("http://t\u{a0}").as_deref(),
            Some("http://t")
        );
        assert_eq!(normalize_origin("http://t\u{a0}/x"), None);
    }

    #[test]
    fn an_unbracketed_host_with_a_colon_or_bracket_is_no_origin() {
        assert_eq!(normalize_origin("http://0[::"), None);
        assert_eq!(normalize_origin("http://a:b:80"), None);
        assert_eq!(normalize_origin("http://a]:80"), None);
        assert_eq!(
            normalize_origin("http://[::1]:8080").as_deref(),
            Some("http://[::1]:8080")
        );
    }

    #[test]
    fn origins() {
        assert_eq!(
            normalize_origin("https://A.b:443/x").as_deref(),
            Some("https://a.b")
        );
        assert_eq!(
            normalize_origin("http://a.b:8080").as_deref(),
            Some("http://a.b:8080")
        );
        assert_eq!(normalize_origin("null"), None);
        assert_eq!(normalize_origin("ftp://a.b"), None);
        assert_eq!(normalize_origin("https://u@a.b"), None);
        assert_eq!(
            normalize_origin("https://[::1]:443").as_deref(),
            Some("https://[::1]")
        );
    }
}
