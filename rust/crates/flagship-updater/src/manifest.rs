//! The release manifest file: `{ "manifest": {...}, "signatures": [...], "pqBindings": [...] }`
//! (`packages/protocol/src/boxArtifact.ts`), read as strictly as the shell verifier's `jq` did.

use crate::refusal::Refusal;
use flagship_protocol::parse::parse_decimal_u64;
use serde_json::Value;

pub const MAX_MANIFEST_BYTES: usize = 1 << 20;
const MAX_SIGNATURES: usize = 32;
const MAX_PQ_BINDINGS: usize = 32;

/// The signed fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    pub commit: String,
    pub arch: String,
    pub artifact_sha256: String,
    pub artifact_bytes: u64,
    pub node_version: String,
    pub node_sha256: String,
    pub lock_sha256: String,
    pub sbom_sha256: String,
    pub provenance_sha256: String,
    pub min_verifier: u64,
    pub sequence: u64,
    pub issued_at: u64,
}

/// A hybrid companion of one signature.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PqCompanion {
    pub key_id: String,
    pub signature_hex: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignatureEntry {
    pub key_hex: String,
    pub signature_hex: String,
    pub pq: Option<PqCompanion>,
}

/// A `release-key` binding as it travels in the manifest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PqBindingWire {
    pub version: u8,
    pub role: String,
    pub subject_id: String,
    pub ed25519_pub_hex: String,
    pub mldsa_pub_hex: String,
    pub issued_at: u64,
    pub signature_hex: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManifestFile {
    pub manifest: Manifest,
    pub signatures: Vec<SignatureEntry>,
    pub pq_bindings: Vec<PqBindingWire>,
}

fn bad(field: &'static str) -> Refusal {
    Refusal::with("bad-manifest", field)
}

pub fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_semver(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.bytes().all(|b| b.is_ascii_digit())
                && (*p == "0" || !p.starts_with('0'))
        })
}

/// A string, or a number written as a string, as `jq`'s `tostring` gave it.
fn text(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn int(m: &Value, key: &'static str) -> Result<u64, Refusal> {
    let t = text(m.get(key)).ok_or_else(|| bad(key))?;
    parse_decimal_u64(&t, u64::MAX >> 11).map_err(|_| bad(key))
}

fn hex(m: &Value, key: &'static str, len: usize) -> Result<String, Refusal> {
    let t = text(m.get(key)).ok_or_else(|| bad(key))?;
    if is_hex(&t, len) {
        Ok(t)
    } else {
        Err(bad(key))
    }
}

fn signatures(root: &Value) -> Result<Vec<SignatureEntry>, Refusal> {
    let list = root
        .get("signatures")
        .and_then(Value::as_array)
        .ok_or_else(|| Refusal::with("bad-manifest", "signatures"))?;
    Ok(list
        .iter()
        .take(MAX_SIGNATURES)
        .map(|s| {
            let get = |k: &str| {
                s.get(k)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_ascii_lowercase()
            };
            let pq = s.get("pq").map(|p| PqCompanion {
                key_id: p
                    .get("keyId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                signature_hex: p
                    .get("signatureHex")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            });
            SignatureEntry {
                key_hex: get("keyHex"),
                signature_hex: get("signatureHex"),
                pq,
            }
        })
        .collect())
}

const BINDING_KEYS: [&str; 7] = [
    "ed25519PubHex",
    "issuedAt",
    "mldsaPubHex",
    "role",
    "signature",
    "subjectId",
    "v",
];

fn pq_bindings(root: &Value) -> Vec<PqBindingWire> {
    let Some(list) = root.get("pqBindings").and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter()
        .take(MAX_PQ_BINDINGS)
        .filter_map(|b| {
            let obj = b.as_object()?;
            let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
            keys.sort_unstable();
            if keys != BINDING_KEYS {
                return None;
            }
            let s = |k: &str| b.get(k).and_then(Value::as_str).map(str::to_owned);
            let version = b.get("v").and_then(Value::as_u64)?;
            Some(PqBindingWire {
                version: u8::try_from(version).ok()?,
                role: s("role")?,
                subject_id: s("subjectId")?,
                ed25519_pub_hex: s("ed25519PubHex")?,
                mldsa_pub_hex: s("mldsaPubHex")?,
                issued_at: b.get("issuedAt").and_then(Value::as_u64)?,
                signature_hex: s("signature")?,
            })
        })
        .collect()
}

/// Parses a manifest file's text.
///
/// # Errors
/// `bad-manifest` with the field that is wrong.
pub fn parse(text_in: &str) -> Result<ManifestFile, Refusal> {
    if text_in.len() > MAX_MANIFEST_BYTES {
        return Err(Refusal::with("bad-manifest", "too large"));
    }
    let root: Value =
        serde_json::from_str(text_in).map_err(|_| Refusal::with("bad-manifest", "not JSON"))?;
    let m = root
        .get("manifest")
        .filter(|m| m.is_object())
        .ok_or_else(|| bad("manifest"))?;
    let arch = text(m.get("arch")).ok_or_else(|| bad("arch"))?;
    if arch != "amd64" && arch != "arm64" {
        return Err(bad("arch"));
    }
    let node_version = text(m.get("nodeVersion")).ok_or_else(|| bad("nodeVersion"))?;
    if !is_semver(&node_version) {
        return Err(bad("nodeVersion"));
    }
    let artifact_bytes = int(m, "artifactBytes")?;
    if artifact_bytes == 0 {
        return Err(bad("artifactBytes"));
    }
    let manifest = Manifest {
        commit: hex(m, "commit", 40)?,
        arch,
        artifact_sha256: hex(m, "artifactSha256", 64)?,
        artifact_bytes,
        node_version,
        node_sha256: hex(m, "nodeSha256", 64)?,
        lock_sha256: hex(m, "lockSha256", 64)?,
        sbom_sha256: hex(m, "sbomSha256", 64)?,
        provenance_sha256: hex(m, "provenanceSha256", 64)?,
        min_verifier: int(m, "minVerifier")?,
        sequence: int(m, "sequence")?,
        issued_at: int(m, "issuedAt")?,
    };
    Ok(ManifestFile {
        manifest,
        signatures: signatures(&root)?,
        pq_bindings: pq_bindings(&root),
    })
}

impl Manifest {
    /// `flagship/box-artifact/v1|commit|arch|artifactSha256|artifactBytes|nodeVersion|nodeSha256|
    /// lockSha256|sbomSha256|provenanceSha256|minVerifier|sequence|issuedAt`, byte for byte the
    /// TypeScript canonical form.
    #[must_use]
    pub fn canonical(&self) -> String {
        format!(
            "flagship/box-artifact/v1|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
            self.commit,
            self.arch,
            self.artifact_sha256,
            self.artifact_bytes,
            self.node_version,
            self.node_sha256,
            self.lock_sha256,
            self.sbom_sha256,
            self.provenance_sha256,
            self.min_verifier,
            self.sequence,
            self.issued_at
        )
    }
}
