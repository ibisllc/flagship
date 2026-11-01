//! `access.public_routes` (docs/app-apis.md §2; `matchesPublicRoute` in serviceProxy.ts).

/// The path without its query or fragment.
#[must_use]
pub fn strip_query(path: &str) -> &str {
    path.find(['?', '#'])
        .map_or(path, |i| path.get(..i).unwrap_or(path))
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b.wrapping_sub(b'0')),
        b'a'..=b'f' => Some(b.wrapping_sub(b'a').wrapping_add(10)),
        b'A'..=b'F' => Some(b.wrapping_sub(b'A').wrapping_add(10)),
        _ => None,
    }
}

/// `decodeURIComponent`: every `%XX` decoded once; a malformed escape or bytes that are not UTF-8 fail.
fn decode_once(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0usize;
    while let Some(&c) = b.get(i) {
        if c == b'%' {
            let hi = hex_val(*b.get(i.checked_add(1)?)?)?;
            let lo = hex_val(*b.get(i.checked_add(2)?)?)?;
            out.push(hi.checked_mul(16)?.checked_add(lo)?);
            i = i.checked_add(3)?;
        } else {
            out.push(c);
            i = i.checked_add(1)?;
        }
    }
    String::from_utf8(out).ok()
}

/// The form a path is compared in, or `None` when it cannot be compared safely (a dot segment, an
/// encoded `/`, `\` or `%`, a backslash, a control character, a malformed escape).
#[must_use]
pub fn normalize_public_path(path: &str) -> Option<String> {
    if !path.starts_with('/') || path.contains('\\') {
        return None;
    }
    let lower = path.to_ascii_lowercase();
    if lower.contains("%2f") || lower.contains("%5c") || lower.contains("%25") {
        return None;
    }
    let decoded = decode_once(path)?;
    if decoded
        .chars()
        .any(|c| c <= '\u{1f}' || c == '\u{7f}' || c == '\\')
    {
        return None;
    }
    let mut out: Vec<&str> = Vec::new();
    for seg in decoded.split('/') {
        let bare = seg.split(';').next().unwrap_or(seg);
        if bare == "." || bare == ".." {
            return None;
        }
        if !seg.is_empty() {
            out.push(seg);
        }
    }
    Some(format!("/{}", out.join("/")))
}

/// Whether a request path (query ignored) is public under `public_routes`: exact paths, or a
/// prefix ending in `/*` (segment-aware); `/*` is the whole app.
#[must_use]
pub fn matches_public_route(raw_path: &str, public_routes: &[String]) -> bool {
    let Some(path) = normalize_public_path(strip_query(raw_path)) else {
        return false;
    };
    for r in public_routes {
        if let Some(stem) = r.strip_suffix("/*") {
            let Some(prefix) = normalize_public_path(if stem.is_empty() { "/" } else { stem })
            else {
                continue;
            };
            if prefix == "/" || path == prefix || path.starts_with(&format!("{prefix}/")) {
                return true;
            }
        } else if normalize_public_path(r).as_deref() == Some(path.as_str()) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn decodes_once_and_refuses_the_rest() {
        assert_eq!(normalize_public_path("/a%20b/").unwrap(), "/a b");
        assert_eq!(normalize_public_path("/caf%C3%A9").unwrap(), "/café");
        assert!(normalize_public_path("/x%C3").is_none());
        assert!(normalize_public_path("/x%2").is_none());
        assert!(normalize_public_path("x").is_none());
    }
}
