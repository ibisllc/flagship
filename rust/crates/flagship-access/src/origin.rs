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
    if authority.contains(['\\', ' ', '\t', '\r', '\n', '@']) || authority.is_empty() {
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
