//! The signed compatibility catalog: which exact GPU model, kernel, driver,
//! runsc, toolkit and userspace image digests are qualified together, the
//! pinned driver packages the maintenance pipeline may install, and the
//! driver advisories that pause admission. It ships with an endorsed release
//! and is signed by the release signers ([`crate::catalog_trust`]);
//! verification is a trait so tests can supply a stand-in.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::device::{Backend, Capability, DeviceRecord};
use crate::media::{Codec, GraphicsApi};
use crate::provider::IsolationProfile;

pub const CATALOG_SCHEMA: &str = "flagship/gpu-compat-catalog/v1";
/// The PQ companion's purpose tag (`pq-suites.md` §12 pattern).
pub const CATALOG_PQ_TAG: &str = "flagship/gpu-compat-catalog/v2";

/// Checks an envelope's signatures over [`signing_bytes`] (and, once the
/// release key is pinned, [`pq_statement`]).
pub trait CatalogVerifier {
    fn verify(&self, envelope: &CatalogEnvelope) -> Result<(), String>;
}

/// What travels: the payload is kept as the exact text that was signed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogEnvelope {
    pub schema: String,
    pub serial: u64,
    pub payload: String,
    pub signatures: Vec<CatalogSignature>,
    /// `release-key` bindings (subject `flagship-gpu-catalog`) for the PQ
    /// companions, as `flagship/pq-key-binding/v1` wires.
    #[serde(default)]
    pub pq_bindings: Vec<PqBindingWire>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogSignature {
    /// The signer's Ed25519 public key, lowercase hex.
    pub key_hex: String,
    /// Ed25519 over [`signing_bytes`], lowercase hex.
    pub signature_hex: String,
    #[serde(default)]
    pub pq: Option<PqCompanion>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PqCompanion {
    /// The hybrid release key id, lowercase hex.
    pub key_id: String,
    /// `hybrid-ed25519-mldsa65/v1`.
    pub suite: String,
    pub signature_hex: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PqBindingWire {
    pub v: u64,
    pub role: String,
    pub subject_id: String,
    pub ed25519_pub_hex: String,
    pub mldsa_pub_hex: String,
    pub issued_at: u64,
    pub signature: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogPayload {
    pub schema: String,
    pub serial: u64,
    pub issued_at: String,
    pub entries: Vec<CatalogEntry>,
    /// Drivers with a known vulnerability: admission pauses on a host that
    /// runs one, CPU apps keep running.
    #[serde(default)]
    pub advisories: Vec<DriverAdvisory>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverAdvisory {
    pub id: String,
    pub backend: Backend,
    pub drivers: Vec<String>,
    pub reason: String,
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
    /// VM runtime releases (Kata Containers); required for `vm-passthrough`.
    #[serde(default)]
    pub vm_runtimes: Vec<String>,
    pub isolation: Vec<IsolationProfile>,
    pub capabilities: Vec<Capability>,
    /// Required, and only allowed, when `graphics` is qualified.
    #[serde(default)]
    pub graphics_apis: Vec<GraphicsApi>,
    /// Required, and only allowed, when a video capability is qualified.
    #[serde(default)]
    pub video_codecs: Vec<Codec>,
    #[serde(default)]
    pub partitioning: bool,
    #[serde(default)]
    pub cooperative_sharing: bool,
    pub images: Vec<ApprovedImage>,
    /// The exact packages the driver maintenance pipeline installs for this
    /// entry, each pinned by digest.
    pub driver_packages: Vec<DriverPackage>,
    /// How a device is proven clean between security contexts. `none`
    /// quarantines after every job.
    #[serde(default)]
    pub cleanup: CleanupProcedure,
    /// The hardware receipts this entry rests on. Mocks never qualify: an
    /// entry without a receipt is refused.
    pub receipts: Vec<Receipt>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovedImage {
    /// e.g. `cuda-13.0-runtime`, `rocm-6.4-runtime`, `scrub`, `render-check`.
    pub purpose: String,
    /// `registry/name@sha256:<64 hex>`; a tag is refused.
    pub reference: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverPackage {
    pub name: String,
    pub version: String,
    /// `amd64` or `arm64`.
    pub arch: String,
    /// SHA-256 of the `.deb`, lowercase hex.
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    /// e.g. `H1-nvidia-cuda-rtx4090-2026-11-02`.
    pub id: String,
    /// SHA-256 of the receipt file, lowercase hex.
    pub sha256: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CleanupKind {
    /// Nothing qualified: quarantine after every job.
    #[default]
    None,
    /// The pinned scrub image overwrites and reads back device memory
    /// (`scrub.rs`); a residue canary must not survive.
    FlagshipScrubV1,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResetKind {
    #[default]
    None,
    /// PCIe function-level reset.
    Flr,
    /// Destroy and recreate the MIG instance.
    MigRecreate,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanupProcedure {
    pub procedure: CleanupKind,
    #[serde(default)]
    pub reset: ResetKind,
}

/// The host side of a qualification, measured by the broker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostFacts {
    pub kernel: String,
    pub module_signing_enforced: bool,
    pub runsc: Option<String>,
    pub cdi_generator: Option<String>,
    pub vm_runtime: Option<String>,
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
    digest: String,
    entries: Vec<CatalogEntry>,
    advisories: Vec<DriverAdvisory>,
}

pub(crate) fn sha256_hex(b: &[u8]) -> String {
    let d = Sha256::digest(b);
    let mut s = String::with_capacity(64);
    for x in d.iter() {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

/// `flagship/gpu-compat-catalog/v1|<signer key hex>|<serial>|sha256:<payload hex>`:
/// what each signer's Ed25519 key signs.
pub fn signing_bytes(signer_key_hex: &str, serial: u64, payload: &str) -> Vec<u8> {
    format!(
        "{CATALOG_SCHEMA}|{}|{serial}|sha256:{}",
        signer_key_hex.to_ascii_lowercase(),
        sha256_hex(payload.as_bytes())
    )
    .into_bytes()
}

/// `flagship/gpu-compat-catalog/v2|<signer key hex>|<serial>|sha256:<payload hex>|<pq key id>`:
/// the statement the hybrid release key signs.
pub fn pq_statement(signer_key_hex: &str, serial: u64, payload: &str, pq_key_id: &str) -> Vec<u8> {
    format!(
        "{CATALOG_PQ_TAG}|{}|{serial}|sha256:{}|{}",
        signer_key_hex.to_ascii_lowercase(),
        sha256_hex(payload.as_bytes()),
        pq_key_id.to_ascii_lowercase()
    )
    .into_bytes()
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
    if !is_lower_hex64(hex) {
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

pub(crate) fn is_lower_hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn parse_pci_id(s: &str) -> Option<u16> {
    u16::from_str_radix(s.strip_prefix("0x")?, 16).ok()
}

impl VerifiedCatalog {
    /// No catalog: nothing qualifies, every device reports why.
    pub fn empty() -> Self {
        Self {
            serial: 0,
            digest: "none".into(),
            entries: Vec::new(),
            advisories: Vec::new(),
        }
    }

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
        if envelope.signatures.is_empty() {
            return Err(CatalogError::BadSignature("no signatures".into()));
        }
        verifier
            .verify(envelope)
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
        let mut ids = BTreeSet::new();
        for e in &payload.entries {
            check_entry(e)?;
            if !ids.insert(e.id.as_str()) {
                return Err(CatalogError::Entry {
                    entry: e.id.clone(),
                    why: "duplicate entry id".into(),
                });
            }
        }
        for a in &payload.advisories {
            if a.id.is_empty() || a.drivers.is_empty() || a.reason.is_empty() {
                return Err(CatalogError::Malformed(format!(
                    "advisory {} needs drivers and a reason",
                    a.id
                )));
            }
        }
        Ok(Self {
            serial: payload.serial,
            digest: format!("sha256:{}", sha256_hex(envelope.payload.as_bytes())),
            entries: payload.entries,
            advisories: payload.advisories,
        })
    }

    pub fn serial(&self) -> u64 {
        self.serial
    }

    /// `sha256:` of the signed payload text, for receipts and status.
    pub fn digest(&self) -> &str {
        &self.digest
    }

    pub fn entries(&self) -> &[CatalogEntry] {
        &self.entries
    }

    pub fn entry(&self, id: &str) -> Option<&CatalogEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    pub fn advisories(&self) -> &[DriverAdvisory] {
        &self.advisories
    }

    /// The advisory naming this backend's driver, if any.
    pub fn revoked(&self, backend: Backend, driver: &str) -> Option<&DriverAdvisory> {
        self.advisories
            .iter()
            .find(|a| a.backend == backend && a.drivers.iter().any(|d| d == driver))
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
        if let Some(a) = self.revoked(device.backend, &device.driver_version) {
            return Err(Unqualified(vec![format!(
                "driver {} is withdrawn by advisory {}: {}",
                device.driver_version, a.id, a.reason
            )]));
        }
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
            if profile == IsolationProfile::GvisorNvproxy
                && !host
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
            if profile == IsolationProfile::VmPassthrough
                && !host
                    .vm_runtime
                    .as_ref()
                    .is_some_and(|r| e.vm_runtimes.contains(r))
            {
                why.push(format!("{}: VM runtime version not qualified", e.id));
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
        if e.cdi_generators.is_empty() {
            return Err(bad("gvisor-nvproxy needs a pinned CDI generator"));
        }
    }
    if e.isolation.contains(&IsolationProfile::VmPassthrough) && e.vm_runtimes.is_empty() {
        return Err(bad("vm-passthrough needs pinned VM runtime releases"));
    }
    if e.partitioning && e.backend != Backend::NvidiaCuda {
        return Err(bad(
            "hardware partitioning is only qualified for NVIDIA MIG",
        ));
    }
    let graphics = e.capabilities.contains(&Capability::Graphics);
    if graphics == e.graphics_apis.is_empty() {
        return Err(bad(
            "graphics APIs are listed exactly when graphics is qualified",
        ));
    }
    let video = e
        .capabilities
        .iter()
        .any(|c| matches!(c, Capability::VideoEncode | Capability::VideoDecode));
    if video == e.video_codecs.is_empty() {
        return Err(bad(
            "video codecs are listed exactly when video is qualified",
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
    if e.cleanup.procedure == CleanupKind::FlagshipScrubV1
        && !e.images.iter().any(|i| i.purpose == "scrub")
    {
        return Err(bad("the scrub procedure needs a pinned scrub image"));
    }
    if e.cleanup.reset == ResetKind::MigRecreate && !e.partitioning {
        return Err(bad("MIG recreate needs partitioning"));
    }
    if e.driver_packages.is_empty() {
        return Err(bad("no pinned driver packages"));
    }
    for p in &e.driver_packages {
        if p.name.is_empty()
            || p.version.is_empty()
            || !matches!(p.arch.as_str(), "amd64" | "arm64")
            || !is_lower_hex64(&p.sha256)
        {
            return Err(bad("driver packages need a name, version, arch and sha256"));
        }
    }
    if e.receipts.is_empty() {
        return Err(bad(
            "no hardware receipt: an unqualified profile cannot be listed",
        ));
    }
    for r in &e.receipts {
        if r.id.is_empty() || !is_lower_hex64(&r.sha256) {
            return Err(bad("receipts need an id and a sha256"));
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

    #[test]
    fn statements_name_signer_serial_and_payload() {
        let a = String::from_utf8(signing_bytes("AB", 3, "x")).unwrap_or_default();
        assert!(a.starts_with("flagship/gpu-compat-catalog/v1|ab|3|sha256:2d711642"));
        let b = String::from_utf8(pq_statement("ab", 3, "x", "CD")).unwrap_or_default();
        assert!(b.starts_with("flagship/gpu-compat-catalog/v2|ab|3|sha256:"));
        assert!(b.ends_with("|cd"));
    }
}
