//! Downloading from the official upstream: HTTPS only, only the hosts the lock allows (a redirect to anywhere
//! else is refused), a byte cap, a deadline, and a file that is removed again when anything is wrong.

use super::lock::https_host;
use crate::refusal::Refusal;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

const MAX_REDIRECTS: u8 = 3;

/// Where bytes come from. The production client is [`Ureq`]; tests supply canned answers.
pub trait Get {
    /// One request, no redirects followed: the status, the `Location` header and the body reader.
    ///
    /// # Errors
    /// A transport error as text.
    fn get(&self, url: &str) -> Result<Reply, String>;
}

pub struct Reply {
    pub status: u16,
    pub location: Option<String>,
    pub body: Box<dyn Read>,
}

impl std::fmt::Debug for Reply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Reply")
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

/// The production client: rustls, no proxy, no automatic redirects.
#[derive(Debug)]
pub struct Ureq {
    agent: ureq::Agent,
}

impl Ureq {
    #[must_use]
    pub fn new(timeout: Duration) -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .max_redirects(0)
            .max_redirects_will_error(false)
            .proxy(None)
            .https_only(true)
            .http_status_as_error(false)
            .user_agent(concat!("flagship-updater/", env!("CARGO_PKG_VERSION")))
            .build();
        Self {
            agent: ureq::Agent::new_with_config(config),
        }
    }
}

impl Get for Ureq {
    fn get(&self, url: &str) -> Result<Reply, String> {
        let resp = self.agent.get(url).call().map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let location = resp
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let (_, body) = resp.into_parts();
        Ok(Reply {
            status,
            location,
            body: Box::new(body.into_reader()),
        })
    }
}

/// A redirect target as an absolute https URL (a relative one is resolved against the request's host).
fn absolute(from: &str, location: &str) -> Option<String> {
    if location.starts_with("https://") {
        return Some(location.to_owned());
    }
    if let Some(path) = location.strip_prefix('/') {
        let host = https_host(from)?;
        return Some(format!("https://{host}/{path}"));
    }
    None
}

/// Downloads `url` into `dest`, returning its size and SHA-256.
///
/// # Errors
/// `download-refused` (not https, a host the lock does not allow, a redirect loop, a status other than 200) or
/// `download-failed` (transport, too large, short). `dest` is removed on any error.
pub fn download(
    client: &dyn Get,
    url: &str,
    allowed_hosts: &[String],
    max_bytes: u64,
    dest: &Path,
) -> Result<(u64, String), Refusal> {
    let result = download_inner(client, url, allowed_hosts, max_bytes, dest);
    if result.is_err() {
        let _ = std::fs::remove_file(dest);
    }
    result
}

fn download_inner(
    client: &dyn Get,
    url: &str,
    allowed_hosts: &[String],
    max_bytes: u64,
    dest: &Path,
) -> Result<(u64, String), Refusal> {
    let mut current = url.to_owned();
    let mut reply = None;
    for _ in 0..=MAX_REDIRECTS {
        let host = https_host(&current).ok_or_else(|| {
            Refusal::with(
                "download-refused",
                format!("{current} is not a plain https URL"),
            )
        })?;
        if !allowed_hosts.contains(&host) {
            return Err(Refusal::with(
                "download-refused",
                format!("{host} is not an allowed host"),
            ));
        }
        let r = client
            .get(&current)
            .map_err(|e| Refusal::with("download-failed", e))?;
        if matches!(r.status, 301 | 302 | 303 | 307 | 308) {
            let next = r
                .location
                .as_deref()
                .and_then(|l| absolute(&current, l))
                .ok_or_else(|| {
                    Refusal::with(
                        "download-refused",
                        "a redirect to something that is not an https URL",
                    )
                })?;
            current = next;
            continue;
        }
        if r.status != 200 {
            return Err(Refusal::with(
                "download-failed",
                format!("HTTP {}", r.status),
            ));
        }
        reply = Some(r);
        break;
    }
    let mut r = reply.ok_or_else(|| Refusal::with("download-refused", "too many redirects"))?;
    let mut out =
        File::create(dest).map_err(|e| Refusal::with("download-failed", e.to_string()))?;
    let mut hash = Sha256::new();
    let mut total: u64 = 0;
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = r
            .body
            .read(&mut buf)
            .map_err(|e| Refusal::with("download-failed", e.to_string()))?;
        if n == 0 {
            break;
        }
        total = total.saturating_add(u64::try_from(n).unwrap_or(u64::MAX));
        if total > max_bytes {
            return Err(Refusal::with(
                "download-failed",
                "larger than the lock allows",
            ));
        }
        let chunk = buf.get(..n).unwrap_or(&[]);
        hash.update(chunk);
        out.write_all(chunk)
            .map_err(|e| Refusal::with("download-failed", e.to_string()))?;
    }
    out.sync_all()
        .map_err(|e| Refusal::with("download-failed", e.to_string()))?;
    Ok((
        total,
        flagship_protocol::parse::encode_lower_hex(&hash.finalize()),
    ))
}
