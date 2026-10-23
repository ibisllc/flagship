//! The signed compatibility catalog: which exact GPU model, kernel, driver,
//! runsc, toolkit and userspace image digests are qualified together. It
//! ships with an endorsed release; verification is a trait so the crypto
//! crate supplies the production (hybrid PQ) verifier.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::device::{Backend, Capability, DeviceRecord};
use crate::provider::IsolationProfile;

pub const CATALOG_SCHEMA: &str = "flagship/gpu-compat-catalog/v1";

/// The signature check. `message` is [`signing_bytes`].
pub trait CatalogVerifier {
    fn verify(&self, key_id: &str, message: &[u8], signature: &[u8]) -> Result<(), String>;
}

/// What travels: the payload is kept as the exact text that was signed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogEnvelope {
    pub schema: String,
    pub key_id: String,
    pub serial: u64,
    pub payload: String,
    /// Lowercase hex.
    pub signature: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogPayload {
    pub schema: String,
    pub serial: u64,
    pub issued_at: String,
    pub entries: Vec<CatalogEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogEntry {
    pub id: String,
    pub backend: Backend,
    /// PCI device ids (`0x2684`) this entry covers. Qualification never
    /// carries across models.
    pub pci_device_ids: Vec<String>,
    pub model: String,
    /// Exact `uname -r` strings.
    pub kernels: Vec<String>,
    pub module_signing_required: bool,
    pub drivers: Vec<String>,
    /// CUDA / ROCm / Level Zero userspace versions.
    pub toolkits: Vec<String>,
    /// Pinned CDI generators (e.g. nvidia-ctk) whose specs are trusted.
    pub cdi_generators: Vec<String>,
    /// runsc releases; required for `gvisor-nvproxy`.
    #[serde(default)]
    pub runsc: Vec<String>,
    pub isolation: Vec<IsolationProfile>,
    pub capabilities: Vec<Capability>,
    #[serde(default)]
    pub partitioning: bool,
    #[serde(default)]
    pub cooperative_sharing: bool,
    pub images: Vec<ApprovedImage>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovedImage {
    /// e.g. `cuda-12.9-runtime`, `rocm-6.4-runtime`, `oneapi-2025.2-runtime`.
    pub purpose: String,
    /// `registry/name@sha256:<64 hex>`; a tag is refused.
    pub reference: String,
}

/// The host side of a qualification, measured by the broker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostFacts {
    pub kernel: String,
    pub module_signing_enforced: bool,
    pub runsc: Option<String>,
    pub cdi_generator: Option<String>,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum CatalogError {
    #[error("catalog envelope is malformed: {0}")]
    Malformed(String),
    #[error("catalog signature does not verify: {0}")]
    BadSignature(String),
    #[error("catalog serial {got} is older than {min}")]
    Rollback { got: u64, min: u64 },
    #[error("catalog entry {entry}: {why}")]
    Entry { entry: String, why: String },
}

/// Why a device isn't qualified, one reason per mismatch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unqualified(pub Vec<String>);

/// A catalog whose signature and every entry have been checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedCatalog {
    serial: u64,
    entries: Vec<CatalogEntry>,
}

/// `flagship/gpu-compat-catalog/v1|<key id>|<serial>|sha256:<payload hex>`.
pub fn signing_bytes(key_id: &str, serial: u64, payload: &str) -> Vec<u8> {
    let d = Sha256::digest(payload.as_bytes());
    let mut s = format!("{CATALOG_SCHEMA}|{key_id}|{serial}|sha256:");
    for b in d.iter() {
        s.push_str(&format!("{b:02x}"));
    }
    s.into_bytes()
}

/// `registry/name@sha256:<64 hex>` with no tag. `:latest` or any other tag,
/// with or without a digest, is refused: a catalog never names a mutable ref.
pub fn is_pinned_reference(r: &str) -> bool {
    let Some((name, digest)) = r.split_once('@') else {
        return false;
    };
    let Some(hex) = digest.strip_prefix("sha256:") else {
        return false;
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return false;
    }
    if name.is_empty() || name.contains('@') {
        return false;
    }
    let last = name.rsplit('/').next().unwrap_or(name);
    if last.contains(':') {
        return false;
    }
    name.bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-/:".contains(&b))
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| {
            s.get(i..i.saturating_add(2))
                .and_then(|p| u8::from_str_radix(p, 16).ok())
        })
        .collect()
}

fn parse_pci_id(s: &str) -> Option<u16> {
    u16::from_str_radix(s.strip_prefix("0x")?, 16).ok()
}

impl VerifiedCatalog {
    /// Verify, then parse, then check every entry. `min_serial` is the
    /// newest serial this box has accepted, so an old catalog can't be replayed.
    pub fn open(
        envelope: &CatalogEnvelope,
        verifier: &dyn CatalogVerifier,
        min_serial: u64,
    ) -> Result<Self, CatalogError> {
        if envelope.schema != CATALOG_SCHEMA {
            return Err(CatalogError::Malformed("schema".into()));
        }
        let sig = decode_hex(&envelope.signature)
            .ok_or_else(|| CatalogError::Malformed("signature is not hex".into()))?;
        let msg = signing_bytes(&envelope.key_id, envelope.serial, &envelope.payload);
        verifier
            .verify(&envelope.key_id, &msg, &sig)
            .map_err(CatalogError::BadSignature)?;
        let payload: CatalogPayload = serde_json::from_str(&envelope.payload)
            .map_err(|e| CatalogError::Malformed(e.to_string()))?;
        if payload.schema != CATALOG_SCHEMA || payload.serial != envelope.serial {
            return Err(CatalogError::Malformed("payload schema or serial".into()));
        }
        if payload.serial < min_serial {
            return Err(CatalogError::Rollback {
                got: payload.serial,
                min: min_serial,
            });
        }
        for e in &payload.entries {
            check_entry(e)?;
        }
        Ok(Self {
            serial: payload.serial,
            entries: payload.entries,
        })
    }

    pub fn serial(&self) -> u64 {
        self.serial
    }

    pub fn entries(&self) -> &[CatalogEntry] {
        &self.entries
    }

    /// The entry qualifying this device on this host for this profile and
    /// these capabilities, or every reason none does.
    pub fn qualify(
        &self,
        device: &DeviceRecord,
        host: &HostFacts,
        profile: IsolationProfile,
        capabilities: &BTreeSet<Capability>,
    ) -> Result<&CatalogEntry, Unqualified> {
        let mut reasons = Vec::new();
        let candidates = self.entries.iter().filter(|e| {
            e.backend == device.backend
                && device
                    .pci_device_id
                    .is_some_and(|id| e.pci_device_ids.iter().any(|s| parse_pci_id(s) == Some(id)))
        });
        for e in candidates {
            let mut why = Vec::new();
            if !e.kernels.contains(&host.kernel) {
                why.push(format!("{}: kernel {} not qualified", e.id, host.kernel));
            }
            if e.module_signing_required && !host.module_signing_enforced {
                why.push(format!("{}: kernel module signing is not enforced", e.id));
            }
            if !e.drivers.contains(&device.driver_version) {
                why.push(format!(
                    "{}: driver {} not qualified",
                    e.id, device.driver_version
                ));
            }
            if !device
                .toolkit_version
                .as_ref()
                .is_some_and(|t| e.toolkits.contains(t))
            {
                why.push(format!("{}: toolkit version not qualified", e.id));
            }
            if !host
                .cdi_generator
                .as_ref()
                .is_some_and(|g| e.cdi_generators.contains(g))
            {
                why.push(format!("{}: CDI generator not qualified", e.id));
            }
            if !e.isolation.contains(&profile) {
                why.push(format!("{}: {profile:?} not qualified", e.id));
            }
            if profile == IsolationProfile::GvisorNvproxy
                && !host.runsc.as_ref().is_some_and(|r| e.runsc.contains(r))
            {
                why.push(format!("{}: runsc version not qualified", e.id));
            }
            for c in capabilities {
                if !e.capabilities.contains(c) {
                    why.push(format!("{}: {c:?} not qualified", e.id));
                }
            }
            if why.is_empty() {
                return Ok(e);
            }
            reasons.extend(why);
        }
        if reasons.is_empty() {
            reasons.push(format!(
                "no catalog entry for {} device {:?}",
                device.backend, device.pci_device_id
            ));
        }
        Err(Unqualified(reasons))
    }
}

fn check_entry(e: &CatalogEntry) -> Result<(), CatalogError> {
    let bad = |why: &str| CatalogError::Entry {
        entry: e.id.clone(),
        why: why.to_owned(),
    };
    if e.id.is_empty() {
        return Err(bad("empty id"));
    }
    if e.pci_device_ids.is_empty() || e.pci_device_ids.iter().any(|s| parse_pci_id(s).is_none()) {
        return Err(bad("pciDeviceIds must be 0x-prefixed 16-bit hex"));
    }
    if e.kernels.is_empty() || e.drivers.is_empty() || e.toolkits.is_empty() {
        return Err(bad("kernels, drivers and toolkits must be listed exactly"));
    }
    if e.cdi_generators.is_empty() {
        return Err(bad("no pinned CDI generator"));
    }
    if e.isolation.is_empty() || e.capabilities.is_empty() {
        return Err(bad("isolation and capabilities must be listed"));
    }
    if e.isolation.contains(&IsolationProfile::GvisorNvproxy) {
        if e.backend != Backend::NvidiaCuda {
            return Err(bad("gvisor-nvproxy is NVIDIA only"));
        }
        if e.runsc.is_empty() {
            return Err(bad("gvisor-nvproxy needs pinned runsc releases"));
        }
    }
    if e.partitioning && e.backend != Backend::NvidiaCuda {
        return Err(bad(
            "hardware partitioning is only qualified for NVIDIA MIG",
        ));
    }
    if e.images.is_empty() {
        return Err(bad("no approved userspace image"));
    }
    for i in &e.images {
        if !is_pinned_reference(&i.reference) {
            return Err(bad(
                "image references must be name@sha256:<digest> with no tag",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const D: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn only_digest_pinned_untagged_references() {
        assert!(is_pinned_reference(&format!(
            "nvcr.io/nvidia/cuda@sha256:{D}"
        )));
        assert!(is_pinned_reference(&format!(
            "localhost:5000/rocm/dev@sha256:{D}"
        )));
        assert!(!is_pinned_reference("nvcr.io/nvidia/cuda:latest"));
        assert!(!is_pinned_reference(&format!(
            "nvcr.io/nvidia/cuda:12.9.1-runtime@sha256:{D}"
        )));
        assert!(!is_pinned_reference("nvcr.io/nvidia/cuda@sha256:abc"));
        assert!(!is_pinned_reference(&format!(
            "nvcr.io/nvidia/cuda@sha512:{D}"
        )));
        assert!(!is_pinned_reference(&format!("@sha256:{D}")));
    }
}
