//! `release/runtime-lock.json`: the exact runtime, as a version-controlled file.

use crate::manifest::is_hex;
use crate::refusal::Refusal;
use crate::verify::sha256_hex;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signer {
    /// 40 lowercase hex.
    pub fingerprint: String,
    pub armored: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub name: String,
    pub file: String,
    pub bytes: u64,
    pub sha256: String,
    /// The executable's path inside the archive after the first component is stripped.
    pub executable: String,
    pub executable_bytes: u64,
    pub executable_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lock {
    pub version: String,
    pub security_floor: String,
    pub base: String,
    pub shasums: String,
    pub shasums_signature: String,
    pub allowed_hosts: Vec<String>,
    pub signers: Vec<Signer>,
    pub targets: BTreeMap<String, Target>,
    /// SHA-256 of the lock file's bytes: what the signed release and the published manifest bind.
    pub sha256: String,
}

fn bad(detail: impl Into<String>) -> Refusal {
    Refusal::with("bad-runtime-lock", detail)
}

fn s<'a>(v: &'a Value, path: &[&str]) -> Result<&'a str, Refusal> {
    let mut cur = v;
    for p in path {
        cur = cur.get(p).ok_or_else(|| bad(path.join(".")))?;
    }
    cur.as_str().ok_or_else(|| bad(path.join(".")))
}

fn u(v: &Value, key: &str) -> Result<u64, Refusal> {
    v.get(key)
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
        .ok_or_else(|| bad(key))
}

fn semver(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.split('.');
    let t = (
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
    );
    it.next().is_none().then_some(t)
}

/// A relative path with no `..`, no empty or control-character component.
pub(crate) fn safe_relative(p: &str) -> bool {
    !p.is_empty()
        && !p.starts_with('/')
        && p.len() <= 256
        && p.split('/').all(|c| {
            !c.is_empty() && c != "." && c != ".." && !c.bytes().any(|b| b < 0x20 || b == 0x7f)
        })
}

/// The host of an `https://` URL, lowercase; `None` for anything else (userinfo, a port or a path-less form).
pub fn https_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() || authority.contains(['@', ':', ' ']) {
        return None;
    }
    Some(authority.to_ascii_lowercase())
}

impl Lock {
    /// Parses and validates the lock.
    ///
    /// # Errors
    /// `bad-runtime-lock` with the field that is wrong.
    pub fn parse(text: &str) -> Result<Self, Refusal> {
        let v: Value = serde_json::from_str(text).map_err(|_| bad("not JSON"))?;
        if v.get("schema").and_then(Value::as_u64) != Some(1) || s(&v, &["runtime"])? != "node" {
            return Err(bad("schema or runtime"));
        }
        let version = s(&v, &["version"])?.to_owned();
        let security_floor = s(&v, &["securityFloor"])?.to_owned();
        let (ver, floor) = (
            semver(&version).ok_or_else(|| bad("version"))?,
            semver(&security_floor).ok_or_else(|| bad("securityFloor"))?,
        );
        if ver < floor {
            return Err(bad("the locked version is below its own security floor"));
        }
        let base = s(&v, &["upstream", "base"])?.to_owned();
        let allowed_hosts: Vec<String> = v
            .get("upstream")
            .and_then(|u| u.get("allowedHosts"))
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|h| h.as_str().map(str::to_ascii_lowercase))
                    .collect()
            })
            .unwrap_or_default();
        if allowed_hosts.is_empty() {
            return Err(bad("upstream.allowedHosts"));
        }
        let host = https_host(&base).ok_or_else(|| bad("upstream.base must be an https URL"))?;
        if !base.ends_with('/') || !allowed_hosts.contains(&host) {
            return Err(bad("upstream.base is not on an allowed host"));
        }
        let shasums = s(&v, &["upstream", "shasums"])?.to_owned();
        let shasums_signature = s(&v, &["upstream", "shasumsSignature"])?.to_owned();
        if !safe_relative(&shasums)
            || !safe_relative(&shasums_signature)
            || shasums.contains('/')
            || shasums_signature.contains('/')
        {
            return Err(bad("upstream file names"));
        }
        let mut signers = Vec::new();
        for sg in v
            .get("keyring")
            .and_then(|k| k.get("signers"))
            .and_then(Value::as_array)
            .ok_or_else(|| bad("keyring.signers"))?
        {
            let fingerprint = s(sg, &["fingerprint"])?.to_owned();
            if !is_hex(&fingerprint, 40) {
                return Err(bad("a signer fingerprint is not 40 lowercase hex"));
            }
            signers.push(Signer {
                fingerprint,
                armored: s(sg, &["armored"])?.to_owned(),
            });
        }
        if signers.is_empty() {
            return Err(bad("keyring.signers is empty"));
        }
        let mut targets = BTreeMap::new();
        for (name, t) in v
            .get("targets")
            .and_then(Value::as_object)
            .ok_or_else(|| bad("targets"))?
        {
            let file = s(t, &["file"])?.to_owned();
            let executable = s(t, &["executable"])?.to_owned();
            let sha256 = s(t, &["sha256"])?.to_owned();
            let executable_sha256 = s(t, &["executableSha256"])?.to_owned();
            if file.contains('/') || !safe_relative(&file) || !safe_relative(&executable) {
                return Err(bad(format!("target {name}: file or executable path")));
            }
            if !file.contains(&version) {
                return Err(bad(format!(
                    "target {name}: the archive is not the locked version"
                )));
            }
            if !is_hex(&sha256, 64) || !is_hex(&executable_sha256, 64) {
                return Err(bad(format!("target {name}: digests")));
            }
            targets.insert(
                name.clone(),
                Target {
                    name: name.clone(),
                    file,
                    bytes: u(t, "bytes")?,
                    sha256,
                    executable,
                    executable_bytes: u(t, "executableBytes")?,
                    executable_sha256,
                },
            );
        }
        if targets.is_empty() {
            return Err(bad("targets is empty"));
        }
        Ok(Self {
            version,
            security_floor,
            base,
            shasums,
            shasums_signature,
            allowed_hosts,
            signers,
            targets,
            sha256: sha256_hex(text.as_bytes()),
        })
    }

    /// `<base><file>`.
    #[must_use]
    pub fn archive_url(&self, t: &Target) -> String {
        format!("{}{}", self.base, t.file)
    }

    #[must_use]
    pub fn shasums_url(&self) -> String {
        format!("{}{}", self.base, self.shasums)
    }

    #[must_use]
    pub fn signature_url(&self) -> String {
        format!("{}{}", self.base, self.shasums_signature)
    }

    /// The target for this host (`linux-amd64`, `linux-arm64`).
    ///
    /// # Errors
    /// `bad-runtime-lock` when the lock has no such target.
    pub fn target(&self, name: &str) -> Result<&Target, Refusal> {
        self.targets
            .get(name)
            .ok_or_else(|| bad(format!("the lock has no target {name}")))
    }
}
