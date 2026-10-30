//! Verifies a release artifact before anything in it runs: the Rust twin of
//! `installer/verify-box-artifact.sh`, check for check and in the same order, with the same
//! refusal codes. Nothing from the artifact judges itself: the manifest is checked against trust
//! that came from the running release and a recipe, never from the artifact.

use crate::manifest::{ManifestFile, PqBindingWire, is_hex};
use crate::refusal::Refusal;
use flagship_crypto::key_id;
use flagship_crypto::trust::{
    BindingWire, Envelope, Expectation, PolicyState, Profile, Role, Rollout, VerifiedBinding,
    verify_binding, verify_critical_signature,
};
use flagship_protocol::SuiteId;
use flagship_protocol::parse::{encode_lower_hex, parse_lower_hex};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::Path;

/// The verifier generation this binary implements (`minVerifier` in a manifest may not exceed it).
pub const VERIFIER_VERSION: u64 = 1;
const PQ_SUBJECT: &str = "flagship-box-artifact";
const TAG_V1: &str = "flagship/box-artifact/v1";
const TAG_V2: &str = "flagship/box-artifact/v2";
const SUITE_ED: &str = "ed25519/v1";
const SUITE_HYBRID: &str = "hybrid-ed25519-mldsa65/v1";

/// What a release's recipe and the running release pin.
#[derive(Clone, Debug, Default)]
pub struct Trust {
    /// Authorised Ed25519 release keys, 64 lowercase hex each.
    pub keys: Vec<String>,
    pub threshold: u64,
    /// `BOX_ARTIFACT_PQ_PIN`: once non-empty, every signer needs a hybrid companion.
    pub pq_key_ids: Vec<String>,
    /// SHA-256 of v1 canonical forms signed before the PQ cut-over (they need no PQ half).
    pub legacy_manifests: Vec<String>,
}

/// What this install expects of the artifact.
#[derive(Clone, Debug)]
pub struct Expect {
    pub sha256: String,
    pub commit: String,
    pub arch: String,
    /// The newest sequence this box ever ran; the artifact's must be higher.
    pub last_sequence: Option<u64>,
    pub node_floor: Option<String>,
    pub now_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verified {
    pub commit: String,
    pub arch: String,
    pub sequence: u64,
    pub signers: usize,
}

fn lower(s: &str) -> String {
    s.to_ascii_lowercase()
}

fn pq_policy() -> PolicyState {
    PolicyState {
        profile: Profile::Strict,
        rollout: Rollout::Enforced,
    }
}

const fn legacy_policy() -> PolicyState {
    PolicyState::legacy()
}

/// SHA-256 of a file, streamed.
///
/// # Errors
/// An I/O error.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(buf.get(..n).unwrap_or(&[]));
    }
    Ok(encode_lower_hex(&h.finalize()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    encode_lower_hex(&Sha256::digest(bytes))
}

fn semver_tuple(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.split('.');
    let a = it.next()?.parse().ok()?;
    let b = it.next()?.parse().ok()?;
    let c = it.next()?.parse().ok()?;
    it.next().is_none().then_some((a, b, c))
}

fn trust_set(trust: &Trust) -> Result<HashSet<String>, Refusal> {
    if trust.threshold < 1 {
        return Err(Refusal::with("bad-trust", "threshold"));
    }
    let mut keys = HashSet::new();
    for k in &trust.keys {
        let k = lower(k);
        if !is_hex(&k, 64) {
            return Err(Refusal::with("bad-trust", "key"));
        }
        keys.insert(k);
    }
    if u64::try_from(keys.len()).unwrap_or(0) < trust.threshold {
        return Err(Refusal::with("bad-trust", "threshold"));
    }
    Ok(keys)
}

fn binding_key_id(ed: &str, ml: &str) -> Option<String> {
    let mut pk = parse_lower_hex(ed, 32, 32).ok()?;
    pk.extend(parse_lower_hex(ml, 0, 1 << 16).ok()?);
    Some(encode_lower_hex(&key_id(
        SuiteId::HybridSigEd25519MlDsa65V1,
        &pk,
    )))
}

/// The `release-key` bindings in the manifest whose key id the pin names and that verify.
fn bound_keys(
    wires: &[PqBindingWire],
    pinned: &HashSet<String>,
    now_ms: u64,
) -> HashMap<String, (String, VerifiedBinding)> {
    let mut out: HashMap<String, (String, VerifiedBinding)> = HashMap::new();
    for w in wires {
        if (w.version != 1 && w.version != 2)
            || w.role != "release-key"
            || w.subject_id != PQ_SUBJECT
        {
            continue;
        }
        let (ed, ml) = (lower(&w.ed25519_pub_hex), lower(&w.mldsa_pub_hex));
        if !is_hex(&ed, 64) || ml.len() != 3904 || out.contains_key(&ed) {
            continue;
        }
        let Some(id) = binding_key_id(&ed, &ml) else {
            continue;
        };
        if !pinned.contains(&id) {
            continue;
        }
        let wire = BindingWire {
            version: w.version,
            role: "release-key",
            subject_id: PQ_SUBJECT,
            ed25519_pub_hex: &ed,
            mldsa_pub_hex: &ml,
            issued_at: w.issued_at,
            signature_hex: &w.signature_hex,
        };
        let expect = Expectation {
            role: Role::ReleaseKey,
            subject_id: PQ_SUBJECT,
            ed25519_pub_hex: &ed,
            mldsa_pub_hex: None,
            now: now_ms,
            min_issued_at: None,
        };
        if let Ok(b) = verify_binding(&wire, &expect) {
            out.insert(ed, (id, b));
        }
    }
    out
}

/// Verifies `file` against `artifact` and the pinned trust.
///
/// # Errors
/// The first failed check, as a [`Refusal`] carrying the shell verifier's code.
pub fn verify(
    file: &ManifestFile,
    artifact: &Path,
    trust: &Trust,
    expect: &Expect,
) -> Result<Verified, Refusal> {
    let m = &file.manifest;
    let canonical = m.canonical();
    let authorised = trust_set(trust)?;

    let v1_digest = sha256_hex(canonical.as_bytes());
    let pinned: HashSet<String> = trust.pq_key_ids.iter().map(|k| lower(k)).collect();
    if trust.pq_key_ids.iter().any(|k| !is_hex(&lower(k), 64)) {
        return Err(Refusal::with("bad-trust", "pq-key-id"));
    }
    let need_pq = !pinned.is_empty()
        && !trust
            .legacy_manifests
            .iter()
            .any(|d| d.eq_ignore_ascii_case(&v1_digest));
    let bound = if need_pq {
        bound_keys(&file.pq_bindings, &pinned, expect.now_ms)
    } else {
        HashMap::new()
    };

    let mut signed: HashSet<String> = HashSet::new();
    let mut classical_only = 0usize;
    for s in &file.signatures {
        let key = lower(&s.key_hex);
        if !authorised.contains(&key) || signed.contains(&key) || !is_hex(&s.signature_hex, 128) {
            continue;
        }
        let ed_ok = verify_critical_signature(
            canonical.as_bytes(),
            TAG_V1,
            Envelope {
                suite: SUITE_ED,
                signature_hex: &s.signature_hex,
            },
            &key,
            None,
            &legacy_policy(),
        )
        .is_ok();
        if !ed_ok {
            continue;
        }
        if need_pq {
            let companion_ok = match (&s.pq, bound.get(&key)) {
                (Some(pq), Some((id, binding))) if pq.key_id == *id => {
                    let statement = format!("{TAG_V2}|{v1_digest}|{key}|{id}");
                    verify_critical_signature(
                        statement.as_bytes(),
                        TAG_V2,
                        Envelope {
                            suite: SUITE_HYBRID,
                            signature_hex: &pq.signature_hex,
                        },
                        &key,
                        Some(binding),
                        &pq_policy(),
                    )
                    .is_ok()
                }
                _ => false,
            };
            if !companion_ok {
                classical_only = classical_only.saturating_add(1);
                continue;
            }
        }
        signed.insert(key);
    }
    let threshold = usize::try_from(trust.threshold).unwrap_or(usize::MAX);
    if signed.len() < threshold {
        if need_pq && signed.len().saturating_add(classical_only) >= threshold {
            return Err(Refusal::with(
                "pq-signature-required",
                format!(
                    "{} of {} with their PQ signature",
                    signed.len(),
                    trust.threshold
                ),
            ));
        }
        return Err(Refusal::with(
            "not-enough-signatures",
            format!("{} of {}", signed.len(), trust.threshold),
        ));
    }

    if !expect.sha256.eq_ignore_ascii_case(&m.artifact_sha256) {
        return Err(Refusal::with("digest-mismatch", "recipe"));
    }
    let measured = sha256_file(artifact)
        .map_err(|e| Refusal::with("bad-manifest", format!("artifact unreadable: {e}")))?;
    if measured != m.artifact_sha256 {
        return Err(Refusal::with("digest-mismatch", "file"));
    }
    let size = std::fs::metadata(artifact)
        .map_err(|e| Refusal::with("bad-manifest", format!("artifact unreadable: {e}")))?
        .len();
    if size != m.artifact_bytes {
        return Err(Refusal::new("size-mismatch"));
    }
    if !expect.commit.eq_ignore_ascii_case(&m.commit) {
        return Err(Refusal::new("commit-mismatch"));
    }
    if expect.arch != m.arch {
        return Err(Refusal::new("arch-mismatch"));
    }
    if m.min_verifier > VERIFIER_VERSION {
        return Err(Refusal::new("verifier-too-old"));
    }
    if let Some(last) = expect.last_sequence
        && m.sequence <= last
    {
        return Err(Refusal::new("rollback"));
    }
    if let Some(floor) = &expect.node_floor {
        let f = semver_tuple(floor).ok_or_else(|| Refusal::with("node-below-floor", "floor"))?;
        let v = semver_tuple(&m.node_version)
            .ok_or_else(|| Refusal::with("bad-manifest", "nodeVersion"))?;
        if v < f {
            return Err(Refusal::with("node-below-floor", m.node_version.clone()));
        }
    }
    Ok(Verified {
        commit: m.commit.clone(),
        arch: m.arch.clone(),
        sequence: m.sequence,
        signers: signed.len(),
    })
}
