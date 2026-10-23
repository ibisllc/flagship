//! Which boot worker the box may talk to, and how.
//!
//! Today's shell flow trusts whatever `/boot/flagship-boot-host` names (any
//! scheme, any host) and lets curl follow its defaults. This client:
//! - only speaks HTTPS (plain HTTP only to a loopback address, and only when
//!   asked, for tests);
//! - sends every request to that one origin: no redirects, no proxy
//!   environment, no other host;
//! - checks the origin against an approved list. In `compat` mode a host that
//!   is not on the list is still used, with a warning, because enterprise
//!   clones repoint the worker through that file today; `strict` refuses it.

use core::fmt;

/// The production boot worker, the shell flow's default.
pub const DEFAULT_BOOT_HOST: &str = "https://boot.flagshipserver.com";
/// Hosts approved without configuration.
pub const BUILTIN_ALLOWED_HOSTS: &[&str] = &["boot.flagshipserver.com"];

/// How an unapproved configured host is treated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Enforcement {
    /// Use it and warn (today's behaviour).
    Compat,
    /// Refuse it.
    Strict,
}

/// The approved-endpoint policy.
#[derive(Debug, Clone)]
pub struct EndpointPolicy {
    /// Approved host names (lowercase, no port).
    pub allowed_hosts: Vec<String>,
    /// Compat or strict.
    pub enforcement: Enforcement,
    /// Allow `http://` to 127.0.0.1, ::1 or localhost (tests only).
    pub allow_loopback_http: bool,
}

impl Default for EndpointPolicy {
    fn default() -> Self {
        Self {
            allowed_hosts: BUILTIN_ALLOWED_HOSTS
                .iter()
                .map(|h| (*h).to_owned())
                .collect(),
            enforcement: Enforcement::Compat,
            allow_loopback_http: false,
        }
    }
}

/// A resolved worker origin, e.g. `https://boot.flagshipserver.com`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    /// `scheme://authority`, no trailing slash.
    pub origin: String,
    /// Lowercase host.
    pub host: String,
    /// Whether the host was on the approved list.
    pub approved: bool,
}

impl Endpoint {
    /// The URL for a signed request path.
    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.origin)
    }
}

/// Why an endpoint was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyError(pub String);

impl fmt::Display for PolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PolicyError {}

fn host_ok(host: &str) -> bool {
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return !inner.is_empty()
            && inner
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.');
    }
    !host.is_empty()
        && host.len() <= 253
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

impl EndpointPolicy {
    /// Resolve the configured base URL (the shell's `BOOT_HOST`, one trailing
    /// slash already removed by the caller as `${BOOT_HOST%/}` does).
    pub fn resolve(&self, base: &str) -> Result<Endpoint, PolicyError> {
        let (scheme, rest) = base
            .split_once("://")
            .ok_or_else(|| PolicyError(format!("boot host {base:?} is not a URL")))?;
        let scheme = scheme.to_ascii_lowercase();
        if rest.is_empty()
            || rest.contains(['/', '?', '#', '@', '\\'])
            || rest.chars().any(char::is_whitespace)
        {
            return Err(PolicyError(format!(
                "boot host {base:?} must be scheme://host[:port] with no path, query or user info"
            )));
        }
        let (host, port) = match rest.rsplit_once(':') {
            Some((h, p)) if !h.ends_with(':') && (!h.starts_with('[') || h.ends_with(']')) => {
                (h, Some(p))
            }
            _ => (rest, None),
        };
        if let Some(p) = port
            && (p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()))
        {
            return Err(PolicyError(format!("boot host {base:?} has a bad port")));
        }
        let host = host.to_ascii_lowercase();
        if !host_ok(&host) {
            return Err(PolicyError(format!(
                "boot host {base:?} has a bad host name"
            )));
        }
        let loopback = matches!(host.as_str(), "127.0.0.1" | "[::1]" | "localhost");
        match scheme.as_str() {
            "https" => {}
            "http" if loopback && self.allow_loopback_http => {}
            _ => return Err(PolicyError(format!("boot host {base:?} must use https"))),
        }
        let bare = host.trim_start_matches('[').trim_end_matches(']');
        let approved = self
            .allowed_hosts
            .iter()
            .any(|h| h.eq_ignore_ascii_case(bare))
            || (loopback && self.allow_loopback_http);
        if !approved && self.enforcement == Enforcement::Strict {
            return Err(PolicyError(format!(
                "boot host {host} is not an approved endpoint"
            )));
        }
        Ok(Endpoint {
            origin: format!("{scheme}://{rest}"),
            host,
            approved,
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn resolves_and_refuses() {
        let p = EndpointPolicy::default();
        let e = p.resolve(DEFAULT_BOOT_HOST).unwrap();
        assert!(e.approved);
        assert_eq!(
            e.url("/api/boot/request"),
            "https://boot.flagshipserver.com/api/boot/request"
        );
        assert!(!p.resolve("https://boot.example.org:8443").unwrap().approved);
        assert!(p.resolve("http://boot.flagshipserver.com").is_err());
        assert!(p.resolve("https://boot.flagshipserver.com/x").is_err());
        assert!(p.resolve("https://user@boot.flagshipserver.com").is_err());
        assert!(p.resolve("").is_err());
        assert!(p.resolve("http://127.0.0.1:9").is_err());
        let strict = EndpointPolicy {
            enforcement: Enforcement::Strict,
            ..EndpointPolicy::default()
        };
        assert!(strict.resolve("https://boot.example.org").is_err());
        let test = EndpointPolicy {
            allow_loopback_http: true,
            ..strict
        };
        assert!(test.resolve("http://127.0.0.1:9").unwrap().approved);
    }
}
