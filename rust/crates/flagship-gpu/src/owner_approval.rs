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
//! floor only rises.
//!
//! An approval also has a maximum age ([`DEFAULT_APPROVAL_MAX_AGE_MS`], 90 days; root sets another
//! with `--approval-max-age-days`) and may not be dated ahead of gpud's clock: a withdrawal the
//! daemon withholds (gpud learns of withdrawals only through it) stops counting once the approval
//! it should have ended runs out, and the daemon then asks the owner again.
//!
//! The one unsigned shape is the box's own local AI (`flagship-local-ai`, installation `box`):
//! one device, compute only, exclusive and secret, in a `flagship-localai-`/`flagship-aitrain-`
//! container whose images the privileged brokers pin. It can never share a device or reach
//! graphics or video, so the daemon's word is enough for it.
//!
//! This is the minimal verifiable form of the "signed GPU capability" the plan gives the core's
//! capability issuer (R02, not built): when that exists, its short-lived capability replaces this.
//!
//! Strict mode ([`BootPqState`], from `/boot/flagship-unlock-policy`): an approval also needs the
//! owner's hybrid signature (`approvalProof.pqSignature`, `flagship/hybrid-sig/ed25519-mldsa65/v1`
//! over the same text) under the hybrid key in `/boot/flagship-owner-pq.pub`, whose Ed25519 half
//! must be the key keyd pins. That file holds the IRK's hybrid key, so a box whose approvals are
//! signed by an admin root refuses every approval while strict (no admin-root hybrid key is
//! written root-side yet). The daemon writes both /boot files; it can lie that the box is not
//! strict, which leaves the classical check, and cannot make an approval without the owner's
//! Ed25519 signature.

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
/// The longest an approval is used for (the daemon's `GPU_APPROVAL_MAX_AGE_MS` asks again then).
pub const DEFAULT_APPROVAL_MAX_AGE_MS: u64 = 90 * 24 * 60 * 60_000;
/// How far ahead of gpud's clock an approval may be dated.
pub const APPROVAL_FUTURE_SKEW_MS: u64 = 5 * 60_000;
const HYBRID_SUITE: &str = "hybrid-ed25519-mldsa65/v1";
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
    /// The owner's hybrid signature over the same text (lowercase hex), required while strict.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pq_signature: Option<String>,
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

/// Whether the box is strict, and the owner's hybrid key, as /boot holds them.
#[derive(Clone, Debug, Default)]
pub struct BootPqState {
    pub strict: bool,
    /// `ed25519_pk || mldsa65_pk` (1984 bytes), when the box has written one.
    pub owner_hybrid: Option<Vec<u8>>,
}

impl BootPqState {
    /// `flagship-unlock-policy` (no file: not strict; `strict` or `compat`; anything else counts
    /// as strict, so a damaged file never weakens the check) and `flagship-owner-pq.pub` (hex).
    pub fn from_boot_dir(dir: &Path) -> Self {
        let strict = match std::fs::read_to_string(dir.join("flagship-unlock-policy")) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Ok(t) if t.trim() == "compat" => false,
            _ => true,
        };
        let owner_hybrid = std::fs::read_to_string(dir.join("flagship-owner-pq.pub"))
            .ok()
            .and_then(|t| decode_hex(t.trim()))
            .filter(|b| b.len() == flagship_crypto::sig::PUBLIC_KEY_LEN);
        Self {
            strict,
            owner_hybrid,
        }
    }
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if !b.len().is_multiple_of(2) {
        return None;
    }
    let nib = |c: u8| match c {
        b'0'..=b'9' => Some(c.wrapping_sub(b'0')),
        b'a'..=b'f' => Some(c.wrapping_sub(b'a').wrapping_add(10)),
        _ => None,
    };
    b.as_chunks::<2>()
        .0
        .iter()
        .map(|[h, l]| Some((nib(*h)? << 4) | nib(*l)?))
        .collect()
}

/// [`verify`], plus what gpud's own state adds: the approval is not older than `max_age_ms` nor
/// dated ahead of `now_ms`, and, while strict, the owner's hybrid signature checks too.
pub fn verify_admission(
    anchor: &OwnerAnchor,
    a: &GpuApproval,
    proof: &ApprovalProof,
    pq: &BootPqState,
    now_ms: u64,
    max_age_ms: u64,
) -> Result<(), String> {
    verify(anchor, a, proof)?;
    if proof.issued_at > now_ms.saturating_add(APPROVAL_FUTURE_SKEW_MS) {
        return Err("the approval is dated ahead of this server's clock".into());
    }
    if now_ms.saturating_sub(proof.issued_at) > max_age_ms {
        return Err("the approval has expired; the owner needs to approve again".into());
    }
    let key = pq.owner_hybrid.as_deref().filter(|k| {
        k.get(..32)
            .is_some_and(|ed| flagship_crypto::trust::hex(ed) == anchor.signer_hex)
    });
    match (&proof.pq_signature, key) {
        (None, _) if pq.strict => Err(
            "this server is quantum-safe: the approval needs the owner's hybrid signature".into(),
        ),
        (Some(_), None) if pq.strict => Err(
            "this server is quantum-safe and holds no hybrid key for the key that signs approvals"
                .into(),
        ),
        (Some(sig), Some(k)) => {
            let msg = canonical(&anchor.server, a, proof.issued_at)?;
            let vk = flagship_crypto::HybridVerifyingKey::from_bytes(k)
                .map_err(|_| "the owner's hybrid key is damaged".to_owned())?;
            let sig = decode_hex(sig).ok_or("the hybrid signature is not hex")?;
            vk.verify(GPU_APPROVAL_TAG, msg.as_bytes(), &sig)
                .map_err(|_| format!("the owner's {HYBRID_SUITE} signature does not verify"))
        }
        _ => Ok(()),
    }
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
