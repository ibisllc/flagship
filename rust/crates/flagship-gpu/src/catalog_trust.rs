//! Who signs the GPU compatibility catalog, and how a box checks it. It is
//! the release-key trust model the box artifact uses
//! (`release/box-artifact-trust.json`): a threshold of the release signers'
//! Ed25519 keys (YubiKey PIV, the same holders that endorse releases) over
//! [`signing_bytes`], and, once that file's `pq.keyIds` names the hybrid
//! release key, a PQ companion from each counted signer under a
//! `release-key` binding for subject [`CATALOG_BINDING_SUBJECT`], checked by
//! `flagship-crypto`'s critical-signature gate in strict mode. The catalog
//! has no "signed before the cut-over" list: a new pin means re-signing the
//! catalog under the next serial.

use std::collections::BTreeSet;

use flagship_crypto::release::RELEASE_POLICY;
use flagship_crypto::trust::{
    BindingWire, Envelope, Expectation, PolicyState, Role, verify_binding,
    verify_critical_signature,
};
use serde::Deserialize;

use crate::catalog::{
    CATALOG_PQ_TAG, CATALOG_SCHEMA, CatalogEnvelope, CatalogVerifier, is_lower_hex64, pq_statement,
    signing_bytes,
};

pub const CATALOG_BINDING_SUBJECT: &str = "flagship-gpu-catalog";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogTrust {
    pub threshold: usize,
    /// Ed25519 public keys, lowercase hex.
    pub keys: Vec<String>,
    /// Hybrid release key ids; empty means classical k-of-n.
    pub pq_key_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrustFile {
    schema: u64,
    threshold: usize,
    keys: Vec<String>,
    #[serde(default)]
    pq: Option<TrustPq>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrustPq {
    #[serde(default)]
    key_ids: Vec<String>,
}

impl CatalogTrust {
    /// Reads `release/box-artifact-trust.json` from the box's own release.
    pub fn from_trust_json(text: &str) -> Result<Self, String> {
        let f: TrustFile = serde_json::from_str(text).map_err(|e| e.to_string())?;
        if f.schema != 1 {
            return Err("unknown trust file schema".into());
        }
        let keys: Vec<String> = f.keys.iter().map(|k| k.to_ascii_lowercase()).collect();
        if keys.iter().any(|k| !is_lower_hex64(k)) {
            return Err("trust keys must be 32-byte hex".into());
        }
        if f.threshold == 0 || f.threshold > keys.len() {
            return Err("threshold must be between 1 and the number of keys".into());
        }
        let pq_key_ids: Vec<String> =
            f.pq.map(|p| p.key_ids)
                .unwrap_or_default()
                .iter()
                .map(|k| k.to_ascii_lowercase())
                .collect();
        if pq_key_ids.iter().any(|k| !is_lower_hex64(k)) {
            return Err("pq key ids must be 32-byte hex".into());
        }
        Ok(Self {
            threshold: f.threshold,
            keys,
            pq_key_ids,
        })
    }

    pub fn pq_pinned(&self) -> bool {
        !self.pq_key_ids.is_empty()
    }
}

/// The production [`CatalogVerifier`].
#[derive(Clone, Debug)]
pub struct ReleaseKeyVerifier {
    trust: CatalogTrust,
    now_ms: u64,
}

impl ReleaseKeyVerifier {
    pub fn new(trust: CatalogTrust, now_ms: u64) -> Self {
        Self { trust, now_ms }
    }

    fn check_one(&self, env: &CatalogEnvelope, idx: usize) -> Result<String, String> {
        let s = env
            .signatures
            .get(idx)
            .ok_or_else(|| "no such signature".to_owned())?;
        let key = s.key_hex.to_ascii_lowercase();
        let short = key.get(..12).unwrap_or(&key).to_owned();
        if !self.trust.keys.contains(&key) {
            return Err(format!("{short}: not a release signer"));
        }
        verify_critical_signature(
            &signing_bytes(&key, env.serial, &env.payload),
            CATALOG_SCHEMA,
            Envelope {
                suite: "ed25519/v1",
                signature_hex: &s.signature_hex,
            },
            &key,
            None,
            &PolicyState::legacy(),
        )
        .map_err(|e| format!("{short}: {}", e.code()))?;
        if !self.trust.pq_pinned() {
            return Ok(key);
        }
        let pq =
            s.pq.as_ref()
                .ok_or_else(|| format!("{short}: pq-missing"))?;
        let pq_id = pq.key_id.to_ascii_lowercase();
        if !self.trust.pq_key_ids.contains(&pq_id) {
            return Err(format!("{short}: pq-key-not-pinned"));
        }
        let mut last = "no-binding".to_owned();
        for w in env.pq_bindings.iter().filter(|b| {
            b.subject_id == CATALOG_BINDING_SUBJECT && b.ed25519_pub_hex.eq_ignore_ascii_case(&key)
        }) {
            let wire = BindingWire {
                role: &w.role,
                subject_id: &w.subject_id,
                ed25519_pub_hex: &w.ed25519_pub_hex,
                mldsa_pub_hex: &w.mldsa_pub_hex,
                issued_at: w.issued_at,
                signature_hex: &w.signature,
            };
            let exp = Expectation {
                role: Role::ReleaseKey,
                subject_id: CATALOG_BINDING_SUBJECT,
                ed25519_pub_hex: &key,
                mldsa_pub_hex: None,
                now: self.now_ms,
                min_issued_at: None,
            };
            let b = match verify_binding(&wire, &exp) {
                Ok(b) => b,
                Err(e) => {
                    last = e.code().to_owned();
                    continue;
                }
            };
            if flagship_crypto::trust::hex(&b.hybrid_key().key_id()) != pq_id {
                last = "pq-key-not-bound".to_owned();
                continue;
            }
            return verify_critical_signature(
                &pq_statement(&key, env.serial, &env.payload, &pq_id),
                CATALOG_PQ_TAG,
                Envelope {
                    suite: &pq.suite,
                    signature_hex: &pq.signature_hex,
                },
                &key,
                Some(&b),
                &RELEASE_POLICY,
            )
            .map(|_| key.clone())
            .map_err(|e| format!("{short}: {}", e.code()));
        }
        Err(format!("{short}: {last}"))
    }
}

impl CatalogVerifier for ReleaseKeyVerifier {
    fn verify(&self, env: &CatalogEnvelope) -> Result<(), String> {
        let mut signers = BTreeSet::new();
        let mut errors = Vec::new();
        for i in 0..env.signatures.len() {
            match self.check_one(env, i) {
                Ok(k) => {
                    signers.insert(k);
                }
                Err(e) => errors.push(e),
            }
        }
        if signers.len() >= self.trust.threshold {
            return Ok(());
        }
        Err(format!(
            "{} of {} release signatures verify{}{}",
            signers.len(),
            self.trust.threshold,
            if errors.is_empty() { "" } else { ": " },
            errors.join("; ")
        ))
    }
}
