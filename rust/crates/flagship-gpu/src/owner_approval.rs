//! The owner's signature on a GPU approval, checked by gpud itself.
//!
//! An app's approval (`GpuApproval`: backend, device count, capabilities, sharing policies,
//! isolation, secrecy, trust domain and consent) arrives from the daemon, which runs without root.
//! gpud admits it only when the owner signed exactly it for this box:
//!
//! ```text
//! flagship/gpu-approval/v1|<server>|<appId>|<installationId>|<generation>|<backend>|<maxCount>
//!   |<capabilities, sorted, comma-joined>|<policies, sorted, comma-joined>|<isolation>
//!   |<secrecy 1|0>|<trustDomain or empty>|<ownerConsent or empty>|<issuedAt ms>
//! ```
//!
//! (one line; TS `packages/protocol/src/gpuApproval.ts`, vectors `test-vectors/gpu-approval/`).
//! The signer is the sensitive-order key keyd's root-written `owner.json` pins: the admin root
//! when the account has one, else the owner IRK. `<server>` is keyd's `policy.json` name for the
//! box, so an approval signed for one box is refused on another.
//!
//! The one unsigned shape is the box's own local AI (`flagship-local-ai`, installation `box`):
//! one device, compute only, exclusive and secret, in a `flagship-localai-`/`flagship-aitrain-`
//! container whose images the privileged brokers pin. It can never share a device or reach
//! graphics or video, so the daemon's word is enough for it.
//!
//! This is the minimal verifiable form of the "signed GPU capability" the plan gives the core's
//! capability issuer (R02, not built): when that exists, its short-lived capability replaces this.
//! Not covered here: the strict-mode PQ half (the gate runs under the legacy policy, as keyd's
//! master evidence does), and revocation, which still comes from the daemon (`gpu.revokeApp`).

use std::path::{Path, PathBuf};

use flagship_crypto::trust::{Envelope, PolicyState, verify_critical_signature};
use serde::{Deserialize, Serialize};

use crate::device::Capability;
use crate::policy::PolicyKind;
use crate::provider::IsolationProfile;
use crate::request::GpuApproval;

pub const GPU_APPROVAL_TAG: &str = "flagship/gpu-approval/v1";
/// How the daemon's local AI appears to gpud (`localAi/devices.ts` `LOCAL_AI_APP`).
pub const LOCAL_AI_APP: &str = "flagship-local-ai";
pub const LOCAL_AI_INSTALLATION: &str = "box";
const MAX_SAFE: u64 = (1 << 53) - 1;

/// The owner's signature as it travels with a claim (`approvalProof`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalProof {
    pub issued_at: u64,
    /// Ed25519, 128 lowercase hex.
    pub signature: String,
}

/// Who must have signed, and for which box.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnerAnchor {
    pub server: String,
    /// Ed25519 public key, 64 lowercase hex.
    pub signer_hex: String,
}

fn hex64(v: Option<&serde_json::Value>) -> Option<String> {
    let s = v?.as_str()?;
    (s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
    .then(|| s.to_owned())
}

fn server_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

fn field_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}

impl OwnerAnchor {
    /// keyd's root-written pins: `owner.json` (`adminRootPubHex`, else `irkPubHex`) and
    /// `policy.json` (`serverFqdn`).
    pub fn from_keyd_state(dir: &Path) -> Result<Self, String> {
        let read = |name: &str| -> Result<serde_json::Value, String> {
            let text = std::fs::read_to_string(dir.join(name))
                .map_err(|e| format!("{name}: {}", e.kind()))?;
            serde_json::from_str(&text).map_err(|_| format!("{name} is not JSON"))
        };
        let owner = read("owner.json")?;
        let signer_hex = hex64(owner.get("adminRootPubHex"))
            .or_else(|| hex64(owner.get("irkPubHex")))
            .ok_or("owner.json pins no owner key")?;
        let server = read("policy.json")?
            .get("serverFqdn")
            .and_then(serde_json::Value::as_str)
            .filter(|s| server_ok(s))
            .ok_or("policy.json names no server")?
            .to_owned();
        Ok(Self { server, signer_hex })
    }
}

#[derive(Clone, Debug)]
pub enum OwnerAnchorSource {
    /// Read on every claim, so keyd's next start (an admin-root rotation) is picked up.
    KeydState(PathBuf),
    Fixed(OwnerAnchor),
    /// Nothing but the box's own local AI is admitted.
    None,
}

impl OwnerAnchorSource {
    pub fn load(&self) -> Result<OwnerAnchor, String> {
        match self {
            Self::KeydState(d) => OwnerAnchor::from_keyd_state(d),
            Self::Fixed(a) => Ok(a.clone()),
            Self::None => Err("this server has no owner key for GPU approvals".into()),
        }
    }
}

fn wire<T: Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn sorted<T: Serialize>(items: impl Iterator<Item = T>) -> String {
    let mut v: Vec<String> = items.map(|x| wire(&x)).collect();
    v.sort_unstable();
    v.join(",")
}

/// The signed text, or why this approval can't be signed at all.
pub fn canonical(server: &str, a: &GpuApproval, issued_at: u64) -> Result<String, String> {
    if !server_ok(server) {
        return Err("bad server name".into());
    }
    if !field_ok(&a.app.app_id) || !field_ok(&a.app.installation_id) {
        return Err("bad app installation".into());
    }
    if a.app.generation > MAX_SAFE || issued_at > MAX_SAFE {
        return Err("a number out of range".into());
    }
    if a.max_count == 0 || a.max_count > crate::request::MAX_GANG {
        return Err("maxCount is 1 to 16".into());
    }
    if a.capabilities.is_empty() || a.policies.is_empty() {
        return Err("no capability or policy approved".into());
    }
    let opt = |o: &Option<String>| -> Result<String, String> {
        match o {
            None => Ok(String::new()),
            Some(s) if field_ok(s) => Ok(s.clone()),
            Some(_) => Err("bad trust domain or consent".into()),
        }
    };
    Ok([
        GPU_APPROVAL_TAG.to_owned(),
        server.to_owned(),
        a.app.app_id.clone(),
        a.app.installation_id.clone(),
        a.app.generation.to_string(),
        wire(&a.backend),
        a.max_count.to_string(),
        sorted(a.capabilities.iter()),
        sorted(a.policies.iter()),
        wire(&a.isolation),
        if a.secrecy { "1" } else { "0" }.to_owned(),
        opt(&a.trust_domain)?,
        opt(&a.owner_consent)?,
        issued_at.to_string(),
    ]
    .join("|"))
}

/// The owner signed exactly this approval for this box.
pub fn verify(anchor: &OwnerAnchor, a: &GpuApproval, proof: &ApprovalProof) -> Result<(), String> {
    let msg = canonical(&anchor.server, a, proof.issued_at)?;
    verify_critical_signature(
        msg.as_bytes(),
        GPU_APPROVAL_TAG,
        Envelope {
            suite: "ed25519/v1",
            signature_hex: &proof.signature,
        },
        &anchor.signer_hex,
        None,
        &PolicyState::legacy(),
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn local_ai_container(c: &str) -> bool {
    let tail = c
        .strip_prefix("flagship-localai-")
        .or_else(|| c.strip_prefix("flagship-aitrain-"));
    tail.is_some_and(|t| {
        t.len() == 16
            && t.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// The box's own local AI in its narrowest shape: the one approval gpud takes unsigned.
pub fn box_local(a: &GpuApproval, container: &str) -> bool {
    a.app.app_id == LOCAL_AI_APP
        && a.app.installation_id == LOCAL_AI_INSTALLATION
        && a.max_count == 1
        && a.capabilities.len() == 1
        && a.capabilities.contains(&Capability::Compute)
        && a.policies.len() == 1
        && a.policies.contains(&PolicyKind::Exclusive)
        && a.secrecy
        && a.trust_domain.is_none()
        && a.owner_consent.is_none()
        && matches!(
            a.isolation,
            IsolationProfile::GvisorNvproxy | IsolationProfile::VmPassthrough
        )
        && local_ai_container(container)
}
