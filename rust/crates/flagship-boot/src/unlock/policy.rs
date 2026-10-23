//! Which boot worker the box may talk to, and how (the premount's rule):
//! - only HTTPS, to a host on the approved list (built in, `--allow-host`,
//!   `/boot/flagship-boot-allowed-hosts`), with no port, path, query or user
//!   info; plain HTTP (with a port) only to a loopback address, and only
//!   when asked, for tests;
//! - every request goes to that one origin: no redirects, no proxy
//!   environment, no other host.

use core::fmt;

/// Hosts approved without configuration (`APPROVED_BOOT_HOSTS` in
/// packages/flagship-builder/src/unlockPremount.ts).
pub const BUILTIN_ALLOWED_HOSTS: &[&str] =
    &["boot.flagshipserver.com", "boot.gym.flagshipserver.com"];

/// The approved-endpoint policy.
#[derive(Debug, Clone)]
pub struct EndpointPolicy {
    /// Approved host names (lowercase, no port).
    pub allowed_hosts: Vec<String>,
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
        let test_loopback = self.allow_loopback_http
            && matches!(host.as_str(), "127.0.0.1" | "[::1]" | "localhost");
        if test_loopback {
            if scheme != "http" && scheme != "https" {
                return Err(PolicyError(format!("boot host {base:?} must use https")));
            }
        } else {
            if scheme != "https" {
                return Err(PolicyError(format!("boot host {base:?} must use https")));
            }
            if port.is_some() {
                return Err(PolicyError(format!(
                    "boot host {base:?} must not name a port"
                )));
            }
            if !self
                .allowed_hosts
                .iter()
                .any(|h| h.eq_ignore_ascii_case(&host))
            {
                return Err(PolicyError(format!(
                    "boot host {host} is not an approved endpoint ({})",
                    self.allowed_hosts.join(" ")
                )));
            }
        }
        Ok(Endpoint {
            origin: format!("{scheme}://{rest}"),
            host,
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
        let e = p.resolve("https://boot.flagshipserver.com").unwrap();
        assert_eq!(
            e.url("/api/boot/request"),
            "https://boot.flagshipserver.com/api/boot/request"
        );
        assert!(p.resolve("https://BOOT.gym.flagshipserver.com").is_ok());
        for bad in [
            "https://boot.example.org",
            "https://boot.flagshipserver.com:8443",
            "http://boot.flagshipserver.com",
            "https://boot.flagshipserver.com/x",
            "https://user@boot.flagshipserver.com",
            "boot.flagshipserver.com",
            "",
            "http://127.0.0.1:9",
        ] {
            assert!(p.resolve(bad).is_err(), "{bad}");
        }
        let extra = EndpointPolicy {
            allowed_hosts: vec!["boot.example.org".into()],
            ..EndpointPolicy::default()
        };
        assert!(extra.resolve("https://boot.example.org").is_ok());
        let test = EndpointPolicy {
            allow_loopback_http: true,
            ..EndpointPolicy::default()
        };
        assert!(test.resolve("http://127.0.0.1:9").is_ok());
        assert!(test.resolve("http://boot.flagshipserver.com").is_err());
    }
}
