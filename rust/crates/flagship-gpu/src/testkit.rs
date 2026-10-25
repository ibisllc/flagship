//! Fixtures for tests and the self-test: throwaway release signers, a
//! catalog that matches the simulated host, and approvals. The signer
//! seeds are public constants, so nothing signed here can ever verify
//! against a box's real trust file (`release/box-artifact-trust.json`).

use std::collections::BTreeSet;

use ed25519_dalek::Signer as _;
use flagship_crypto::HybridSigningKey;
use flagship_crypto::trust::{TAG_PQ_KEY_BINDING, canonical_binding, hex};

use crate::catalog::{
    ApprovedImage, CATALOG_PQ_TAG, CATALOG_SCHEMA, CatalogEntry, CatalogEnvelope, CatalogPayload,
    CatalogSignature, CleanupKind, CleanupProcedure, DriverAdvisory, DriverPackage, HostFacts,
    PqBindingWire, PqCompanion, Receipt, ResetKind, pq_statement, sha256_hex, signing_bytes,
};
use crate::catalog_trust::CATALOG_BINDING_SUBJECT;
use crate::device::{Backend, Capability};
use crate::media::{Codec, GraphicsApi};
use crate::owner_approval::{self, ApprovalProof, OwnerAnchor};
use crate::policy::PolicyKind;
use crate::provider::IsolationProfile;
use crate::request::{AppInstallation, GpuApproval};
use crate::sim::{SimDrivers, sim_deb};

pub const RUNSC: &str = "20260921.0";
pub const NVCTK: &str = "nvidia-ctk 1.18.0";
pub const KATA: &str = "kata 3.21.0";
pub const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/// A release signer: an Ed25519 key (the YubiKey's role) and the hybrid
/// release key bound to it.
pub struct TestSigner {
    ed: ed25519_dalek::SigningKey,
    hybrid: HybridSigningKey,
}

impl std::fmt::Debug for TestSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TestSigner")
            .field("key", &self.ed_pub_hex())
            .finish()
    }
}

impl TestSigner {
    pub fn new(seed: u8) -> Result<Self, String> {
        let ed_seed = [seed; 32];
        let ml_seed = [seed.wrapping_add(0x80); 32];
        Ok(Self {
            ed: ed25519_dalek::SigningKey::from_bytes(&ed_seed),
            hybrid: HybridSigningKey::from_seeds(&ed_seed, &ml_seed).map_err(|e| e.to_string())?,
        })
    }

    pub fn ed_pub_hex(&self) -> String {
        hex(&self.ed.verifying_key().to_bytes())
    }

    pub fn pq_key_id_hex(&self) -> String {
        hex(&self.hybrid.verifying_key().key_id())
    }

    pub fn binding(&self, issued_at: u64) -> Result<PqBindingWire, String> {
        let pk = self.hybrid.verifying_key().as_bytes();
        let ml = hex(pk.get(32..).ok_or("short key")?);
        let ed = self.ed_pub_hex();
        let stmt = canonical_binding("release-key", CATALOG_BINDING_SUBJECT, &ed, &ml, issued_at)
            .map_err(|e| e.code().to_owned())?;
        let sig = self
            .hybrid
            .sign_deterministic(TAG_PQ_KEY_BINDING, &stmt)
            .map_err(|e| e.to_string())?;
        Ok(PqBindingWire {
            v: 1,
            role: "release-key".into(),
            subject_id: CATALOG_BINDING_SUBJECT.into(),
            ed25519_pub_hex: ed,
            mldsa_pub_hex: ml,
            issued_at,
            signature: hex(&sig),
        })
    }

    pub fn sign(&self, serial: u64, payload: &str, pq: bool) -> Result<CatalogSignature, String> {
        let key = self.ed_pub_hex();
        let sig = self.ed.sign(&signing_bytes(&key, serial, payload));
        let pq = if pq {
            let id = self.pq_key_id_hex();
            let s = self
                .hybrid
                .sign_deterministic(CATALOG_PQ_TAG, &pq_statement(&key, serial, payload, &id))
                .map_err(|e| e.to_string())?;
            Some(PqCompanion {
                key_id: id,
                suite: "hybrid-ed25519-mldsa65/v1".into(),
                signature_hex: hex(&s),
            })
        } else {
            None
        };
        Ok(CatalogSignature {
            key_hex: key,
            signature_hex: hex(&sig.to_bytes()),
            pq,
        })
    }
}

/// A `box-artifact-trust.json` naming these signers.
pub fn trust_json(signers: &[&TestSigner], threshold: usize, pq: bool) -> String {
    serde_json::json!({
        "schema": 1,
        "threshold": threshold,
        "keys": signers.iter().map(|s| s.ed_pub_hex()).collect::<Vec<_>>(),
        "pq": {
            "keyIds": if pq { signers.iter().map(|s| s.pq_key_id_hex()).collect::<Vec<_>>() } else { Vec::new() },
            "legacyManifests": [],
        },
    })
    .to_string()
}

pub fn envelope(
    payload: &CatalogPayload,
    signers: &[&TestSigner],
    pq: bool,
    issued_at: u64,
) -> Result<CatalogEnvelope, String> {
    let text = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    let mut signatures = Vec::new();
    let mut bindings = Vec::new();
    for s in signers {
        signatures.push(s.sign(payload.serial, &text, pq)?);
        if pq {
            bindings.push(s.binding(issued_at)?);
        }
    }
    Ok(CatalogEnvelope {
        schema: CATALOG_SCHEMA.into(),
        serial: payload.serial,
        payload: text,
        signatures,
        pq_bindings: bindings,
    })
}

fn image(purpose: &str, name: &str) -> ApprovedImage {
    ApprovedImage {
        purpose: purpose.into(),
        reference: format!("registry.flagship.test/{name}@sha256:{DIGEST}"),
    }
}

/// The package pinned for both architectures.
pub fn driver_packages(name: &str, version: &str) -> Vec<DriverPackage> {
    ["amd64", "arm64"]
        .iter()
        .map(|arch| {
            let mut p = DriverPackage {
                name: name.into(),
                version: version.into(),
                arch: (*arch).into(),
                sha256: String::new(),
            };
            p.sha256 = sha256_hex(&sim_deb(&p));
            p
        })
        .collect()
}

/// A catalog entry for one simulated model, matching the simulated
/// drivers exactly. Its receipt is a placeholder: the catalog the box
/// actually loads is signed by the owner, from real receipts.
pub fn sim_entry(id: &str, backend: Backend, pci_ids: &[&str], d: &SimDrivers) -> CatalogEntry {
    let nvidia = backend == Backend::NvidiaCuda;
    let (driver, toolkit, pkg) = match backend {
        Backend::NvidiaCuda => (d.nvidia.clone(), d.cuda.clone(), "nvidia-driver"),
        Backend::AmdRocm => (d.amd.clone(), d.rocm.clone(), "amdgpu-dkms-driver"),
        Backend::IntelLevelZero => (d.intel.clone(), d.level_zero.clone(), "intel-i915-driver"),
    };
    let toolkit_image = match backend {
        Backend::NvidiaCuda => "cuda-runtime",
        Backend::AmdRocm => "rocm-runtime",
        Backend::IntelLevelZero => "oneapi-runtime",
    };
    CatalogEntry {
        id: id.into(),
        backend,
        pci_device_ids: pci_ids.iter().map(|s| (*s).to_owned()).collect(),
        model: id.into(),
        kernels: vec![d.kernel.clone()],
        module_signing_required: true,
        drivers: vec![driver.clone()],
        toolkits: vec![toolkit],
        cdi_generators: vec![NVCTK.into()],
        runsc: if nvidia {
            vec![RUNSC.into()]
        } else {
            Vec::new()
        },
        vm_runtimes: vec![KATA.into()],
        isolation: if nvidia {
            vec![
                IsolationProfile::GvisorNvproxy,
                IsolationProfile::VmPassthrough,
            ]
        } else {
            vec![IsolationProfile::VmPassthrough]
        },
        capabilities: vec![
            Capability::Compute,
            Capability::Graphics,
            Capability::VideoEncode,
            Capability::VideoDecode,
        ],
        graphics_apis: vec![GraphicsApi::Egl, GraphicsApi::Vulkan],
        video_codecs: vec![Codec::H264, Codec::Hevc],
        partitioning: nvidia,
        cooperative_sharing: nvidia,
        images: vec![
            image(toolkit_image, toolkit_image),
            image("scrub", "gpu-scrub"),
            image("render-check", "render-check"),
        ],
        driver_packages: driver_packages(pkg, &driver),
        cleanup: CleanupProcedure {
            procedure: CleanupKind::FlagshipScrubV1,
            reset: ResetKind::None,
        },
        receipts: vec![Receipt {
            id: format!("SIM-{id}"),
            sha256: DIGEST.into(),
        }],
    }
}

/// Every simulated model, plus extra driver versions the maintenance
/// pipeline may move to.
pub fn sim_payload(serial: u64, d: &SimDrivers, extra_nvidia_drivers: &[&str]) -> CatalogPayload {
    let mut h100 = sim_entry("h100", Backend::NvidiaCuda, &["0x2330"], d);
    for v in extra_nvidia_drivers {
        h100.drivers.push((*v).to_owned());
        h100.driver_packages
            .extend(driver_packages("nvidia-driver", v));
    }
    let mut rtx = sim_entry("rtx4090", Backend::NvidiaCuda, &["0x2684"], d);
    for v in extra_nvidia_drivers {
        rtx.drivers.push((*v).to_owned());
        rtx.driver_packages
            .extend(driver_packages("nvidia-driver", v));
    }
    CatalogPayload {
        schema: CATALOG_SCHEMA.into(),
        serial,
        issued_at: "2026-10-24T00:00:00Z".into(),
        entries: vec![
            rtx,
            h100,
            sim_entry("a100", Backend::NvidiaCuda, &["0x20b0"], d),
            sim_entry("mi210", Backend::AmdRocm, &["0x740f"], d),
            sim_entry("rx7900", Backend::AmdRocm, &["0x744c"], d),
            sim_entry("flex170", Backend::IntelLevelZero, &["0x56c0"], d),
            sim_entry("arc-a770", Backend::IntelLevelZero, &["0x56a0"], d),
        ],
        advisories: Vec::<DriverAdvisory>::new(),
    }
}

pub fn sim_host_facts(d: &SimDrivers) -> HostFacts {
    HostFacts {
        kernel: d.kernel.clone(),
        module_signing_enforced: true,
        runsc: Some(RUNSC.into()),
        cdi_generator: Some(NVCTK.into()),
        vm_runtime: Some(KATA.into()),
    }
}

pub fn app(name: &str, generation: u64) -> AppInstallation {
    AppInstallation {
        app_id: name.into(),
        installation_id: format!("{name}-inst"),
        generation,
    }
}

pub fn approval(
    app: AppInstallation,
    backend: Backend,
    isolation: IsolationProfile,
    caps: &[Capability],
    secrecy: bool,
    domain: Option<&str>,
) -> GpuApproval {
    GpuApproval {
        app,
        backend,
        max_count: 8,
        capabilities: caps.iter().copied().collect::<BTreeSet<_>>(),
        policies: BTreeSet::from([
            PolicyKind::Exclusive,
            PolicyKind::Partition,
            PolicyKind::Cooperative,
        ]),
        isolation,
        secrecy,
        trust_domain: domain.map(str::to_owned),
        owner_consent: domain.map(|d| format!("consent-{d}")),
    }
}

/// The box name test anchors pin.
pub const TEST_SERVER: &str = "home.alice.flagship.services";

/// The owner's sensitive-order key in tests and the simulated matrix.
pub struct TestOwner {
    key: ed25519_dalek::SigningKey,
}

impl std::fmt::Debug for TestOwner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TestOwner").finish_non_exhaustive()
    }
}

impl TestOwner {
    pub fn new(seed: u8) -> Self {
        Self {
            key: ed25519_dalek::SigningKey::from_bytes(&[seed; 32]),
        }
    }

    pub fn anchor(&self) -> OwnerAnchor {
        OwnerAnchor {
            server: TEST_SERVER.into(),
            signer_hex: hex(&self.key.verifying_key().to_bytes()),
        }
    }

    /// The proof for `a` on [`TEST_SERVER`]; an approval that can't be signed gets an empty one.
    pub fn prove(&self, a: &GpuApproval, issued_at: u64) -> ApprovalProof {
        self.prove_for(TEST_SERVER, a, issued_at)
    }

    pub fn prove_for(&self, server: &str, a: &GpuApproval, issued_at: u64) -> ApprovalProof {
        let signature = owner_approval::canonical(server, a, issued_at)
            .map(|m| hex(&self.key.sign(m.as_bytes()).to_bytes()))
            .unwrap_or_default();
        ApprovalProof {
            issued_at,
            signature,
        }
    }

    /// `claim` with `approvalProof` set from its own `approval`.
    pub fn sign_claim(&self, claim: &serde_json::Value) -> serde_json::Value {
        let mut c = claim.clone();
        if let Some(a) = c
            .get("approval")
            .and_then(|a| serde_json::from_value::<GpuApproval>(a.clone()).ok())
            && let Some(m) = c.as_object_mut()
        {
            m.insert(
                "approvalProof".into(),
                serde_json::to_value(self.prove(&a, 1_800_000_000_000)).unwrap_or_default(),
            );
        }
        c
    }
}
