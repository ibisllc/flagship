//! The owner's signature on a GPU approval, checked by gpud itself.
//!
//! An app's approval (`GpuApproval`: backend, device count, capabilities, sharing policies,
//! isolation, secrecy, trust domain and consent, and what the claim itself carries: container,
//! userspace image, run-time limit and share) arrives from the daemon, which runs without root.
//! gpud admits it only when the owner signed exactly it for this box:
//!
//! ```text
//! flagship/gpu-approval/v2|<server>|<appId>|<installationId>|<generation>|<backend>|<maxCount>
//!   |<capabilities, sorted, comma-joined>|<policies, sorted, comma-joined>|<isolation>
//!   |<secrecy 1|0>|<trustDomain or empty>|<ownerConsent or empty>|<container>
//!   |<userspace or empty>|<maxRuntimeMs or empty>|<computePercent:memoryMib or empty>|<issuedAt ms>
//! ```
//!
//! (one line; TS `packages/protocol/src/gpuApproval.ts`, vectors `test-vectors/gpu-approval/`).
//! The signer is the sensitive-order key keyd's root-written `owner.json` pins: the admin root
//! when the account has one, else the owner IRK. `<server>` is keyd's `policy.json` name for the
//! box, so an approval signed for one box is refused on another. A claim must ask for exactly the
//! container, userspace, run-time limit and share its approval names.
//!
//! A withdrawal, `flagship/gpu-approval-withdraw/v1|<server>|<appId>|<installationId>|<generation>
//! |<issuedAt>` signed by the same key, raises a floor gpud keeps in its own root-owned state
//! ([`ApprovalFloors`]): from then on no approval of that installation signed at or before the
//! withdrawal is admitted, whichever generation it names and whatever the daemon re-presents. The
//! floor only rises. There is no maximum age: an app's approval is used at every start.
//!
//! The one unsigned shape is the box's own local AI (`flagship-local-ai`, installation `box`):
//! one device, compute only, exclusive and secret, in a `flagship-localai-`/`flagship-aitrain-`
//! container whose images the privileged brokers pin. It can never share a device or reach
//! graphics or video, so the daemon's word is enough for it.
//!
//! This is the minimal verifiable form of the "signed GPU capability" the plan gives the core's
//! capability issuer (R02, not built): when that exists, its short-lived capability replaces this.
//! Not covered here: the strict-mode PQ half (the gate runs under the legacy policy, as keyd's
//! master evidence does).

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use flagship_crypto::trust::{Envelope, PolicyState, verify_critical_signature};
use serde::{Deserialize, Serialize};

use crate::device::Capability;
use crate::policy::PolicyKind;
use crate::provider::IsolationProfile;
use crate::request::{AppInstallation, GpuApproval};

pub const GPU_APPROVAL_TAG: &str = "flagship/gpu-approval/v2";
pub const GPU_APPROVAL_WITHDRAW_TAG: &str = "flagship/gpu-approval-withdraw/v1";
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
        // An admin root that is present but damaged must not quietly hand the approval to the IRK.
        let signer_hex = match owner.get("adminRootPubHex") {
            None | Some(serde_json::Value::Null) => {
                hex64(owner.get("irkPubHex")).ok_or("owner.json pins no owner key")?
            }
            Some(v) => hex64(Some(v)).ok_or("owner.json adminRootPubHex is not a valid key")?,
        };
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
        a.container
            .clone()
            .filter(|c| container_ok(c))
            .ok_or("the approval names no valid container")?,
        match &a.userspace {
            None => String::new(),
            Some(u) if field_ok(u) => u.clone(),
            Some(_) => return Err("bad userspace".into()),
        },
        match a.max_runtime_ms {
            None => String::new(),
            Some(ms) if (1..=MAX_SAFE).contains(&ms) => ms.to_string(),
            Some(_) => return Err("a number out of range".into()),
        },
        match a.share {
            None => String::new(),
            Some(sh) => {
                sh.check()?;
                if sh.memory_mib > MAX_SAFE {
                    return Err("a number out of range".into());
                }
                format!("{}:{}", sh.compute_percent, sh.memory_mib)
            }
        },
        issued_at.to_string(),
    ]
    .join("|"))
}

/// gpud's own container-name rule (`service.rs`).
fn container_ok(c: &str) -> bool {
    c.len() <= 128
        && c.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && c.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

/// The owner's withdrawal of an approval, as the daemon forwards it (`gpu.withdrawApproval`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Withdrawal {
    pub app_id: String,
    pub installation_id: String,
    pub generation: u64,
    pub issued_at: u64,
    /// Ed25519, 128 lowercase hex.
    pub signature: String,
}

pub fn withdraw_canonical(
    server: &str,
    app_id: &str,
    installation_id: &str,
    generation: u64,
    issued_at: u64,
) -> Result<String, String> {
    if !server_ok(server) {
        return Err("bad server name".into());
    }
    if !field_ok(app_id) || !field_ok(installation_id) {
        return Err("bad app installation".into());
    }
    if generation > MAX_SAFE || issued_at > MAX_SAFE {
        return Err("a number out of range".into());
    }
    Ok([
        GPU_APPROVAL_WITHDRAW_TAG,
        server,
        app_id,
        installation_id,
        &generation.to_string(),
        &issued_at.to_string(),
    ]
    .join("|"))
}

fn verify_signed(anchor: &OwnerAnchor, msg: &str, tag: &str, sig: &str) -> Result<(), String> {
    verify_critical_signature(
        msg.as_bytes(),
        tag,
        Envelope {
            suite: "ed25519/v1",
            signature_hex: sig,
        },
        &anchor.signer_hex,
        None,
        &PolicyState::legacy(),
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// The owner signed this withdrawal for this box.
pub fn verify_withdrawal(anchor: &OwnerAnchor, w: &Withdrawal) -> Result<(), String> {
    let msg = withdraw_canonical(
        &anchor.server,
        &w.app_id,
        &w.installation_id,
        w.generation,
        w.issued_at,
    )?;
    verify_signed(anchor, &msg, GPU_APPROVAL_WITHDRAW_TAG, &w.signature)
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FloorsFile {
    v: u32,
    /// Nothing signed at or before this counts (set when a damaged file was found).
    all: u64,
    /// `<appId>|<installationId>` to the newest withdrawal's `issuedAt`.
    floors: BTreeMap<String, u64>,
}

/// The newest withdrawal per app installation, kept in gpud's state directory, which only root
/// writes. It only rises, so a daemon can neither undo a withdrawal nor re-present an approval
/// signed before one.
#[derive(Debug)]
pub struct ApprovalFloors {
    path: PathBuf,
    file: FloorsFile,
}

fn floor_key(app_id: &str, installation_id: &str) -> String {
    format!("{app_id}|{installation_id}")
}

impl ApprovalFloors {
    /// A damaged file is set aside and every approval signed before `now_ms` is refused, so the
    /// owner approves again rather than a withdrawn approval coming back.
    pub fn open(path: PathBuf, now_ms: u64) -> Result<Self, String> {
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self {
                    path,
                    file: FloorsFile {
                        v: 1,
                        ..FloorsFile::default()
                    },
                });
            }
            Err(e) => return Err(format!("approval floors: {}", e.kind())),
        };
        match serde_json::from_str::<FloorsFile>(&text) {
            Ok(file) if file.v == 1 => Ok(Self { path, file }),
            _ => {
                let mut aside = path.clone().into_os_string();
                aside.push(format!(".corrupt-{now_ms}"));
                std::fs::rename(&path, &aside)
                    .map_err(|e| format!("approval floors: {}", e.kind()))?;
                let mut f = Self {
                    path,
                    file: FloorsFile {
                        v: 1,
                        all: now_ms,
                        floors: BTreeMap::new(),
                    },
                };
                f.save()?;
                Ok(f)
            }
        }
    }

    /// Why an approval of `app` signed at `issued_at` no longer counts, if it doesn't.
    pub fn admits(&self, app: &AppInstallation, issued_at: u64) -> Result<(), String> {
        let floor = self
            .file
            .floors
            .get(&floor_key(&app.app_id, &app.installation_id))
            .copied()
            .unwrap_or(0)
            .max(self.file.all);
        if issued_at <= floor {
            return Err("the owner withdrew this approval; it needs a new one".into());
        }
        Ok(())
    }

    /// Raise the floor to `issued_at`; false when it was already there or higher.
    pub fn raise(
        &mut self,
        app_id: &str,
        installation_id: &str,
        issued_at: u64,
    ) -> Result<bool, String> {
        let key = floor_key(app_id, installation_id);
        if self.file.floors.get(&key).is_some_and(|f| *f >= issued_at) {
            return Ok(false);
        }
        let before = self.file.floors.insert(key.clone(), issued_at);
        if let Err(e) = self.save() {
            match before {
                Some(b) => self.file.floors.insert(key, b),
                None => self.file.floors.remove(&key),
            };
            return Err(e);
        }
        Ok(true)
    }

    fn save(&mut self) -> Result<(), String> {
        let err = |e: std::io::Error| format!("approval floors: {}", e.kind());
        let text = serde_json::to_vec(&self.file).map_err(|e| e.to_string())?;
        if let Some(d) = self.path.parent() {
            std::fs::create_dir_all(d).map_err(err)?;
        }
        let mut tmp = self.path.clone().into_os_string();
        tmp.push(".tmp");
        let mut f = std::fs::File::create(&tmp).map_err(err)?;
        f.write_all(&text).map_err(err)?;
        f.sync_all().map_err(err)?;
        std::fs::rename(&tmp, &self.path).map_err(err)?;
        if let Some(d) = self.path.parent() {
            std::fs::File::open(d)
                .and_then(|d| d.sync_all())
                .map_err(err)?;
        }
        Ok(())
    }
}

/// The owner signed exactly this approval for this box.
pub fn verify(anchor: &OwnerAnchor, a: &GpuApproval, proof: &ApprovalProof) -> Result<(), String> {
    let msg = canonical(&anchor.server, a, proof.issued_at)?;
    verify_signed(anchor, &msg, GPU_APPROVAL_TAG, &proof.signature)
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
