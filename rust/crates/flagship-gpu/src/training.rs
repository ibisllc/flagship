//! Single-server training and fine-tuning (§9.5, G05): dataset binding,
//! checkpoint integrity and resume, disk budgets, and a deterministic
//! synthetic trainer the self-test and CI use to prove that a job cancelled
//! and resumed from its checkpoint ends exactly where an uninterrupted run
//! does. Real jobs (`tools/gpu/train_synthetic.py`) write the same
//! checkpoint layout from inside the app's sandbox; the broker checks it.
//!
//! A checkpoint is one directory per step: safetensors files plus a
//! manifest whose MAC (HMAC-SHA256 under the box's job key) binds the job,
//! the app installation and generation, the dataset digest, the step and
//! every file's digest. Resume takes the newest checkpoint that verifies
//! for exactly this binding; anything else is skipped, never loaded.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::catalog::sha256_hex;
use crate::request::AppInstallation;
use crate::safetensors::{FormatError, SafeTensors, write_f64};

pub const CHECKPOINT_SCHEMA: &str = "flagship/gpu-checkpoint/v1";
const MANIFEST: &str = "manifest.json";

/// `(file name, bytes)` of one checkpoint.
pub type CheckpointFiles = Vec<(String, Vec<u8>)>;
pub type LoadedCheckpoint = (CheckpointManifest, CheckpointFiles);

#[derive(Clone)]
pub struct CheckpointKey([u8; 32]);

impl CheckpointKey {
    pub fn new(b: [u8; 32]) -> Self {
        Self(b)
    }
}

impl std::fmt::Debug for CheckpointKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CheckpointKey(<redacted>)")
    }
}

/// What a job's checkpoints must belong to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobBinding {
    pub job_id: String,
    pub app: AppInstallation,
    /// `sha256:` of the dataset manifest ([`dataset_digest`]).
    pub dataset_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointFile {
    pub name: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointManifest {
    pub schema: String,
    pub binding: JobBinding,
    pub step: u64,
    pub files: Vec<CheckpointFile>,
    pub mac: String,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum TrainError {
    #[error(transparent)]
    Format(#[from] FormatError),
    #[error("the checkpoint would exceed the job's disk budget ({used} of {budget} bytes)")]
    DiskBudget { used: u64, budget: u64 },
    #[error("checkpoint {0}")]
    Invalid(String),
    #[error("storage: {0}")]
    Io(String),
    #[error("the dataset does not match the job's binding")]
    Dataset,
}

fn mac_input(m: &CheckpointManifest) -> Vec<u8> {
    let mut s = format!(
        "{CHECKPOINT_SCHEMA}|{}|{}|{}|{}|{}|{}",
        m.binding.job_id,
        m.binding.app.app_id,
        m.binding.app.installation_id,
        m.binding.app.generation,
        m.binding.dataset_digest,
        m.step
    );
    for f in &m.files {
        s.push_str(&format!("|{}:{}:{}", f.name, f.sha256, f.bytes));
    }
    s.into_bytes()
}

fn mac_hex(key: &CheckpointKey, m: &CheckpointManifest) -> String {
    let Ok(mut h) = Hmac::<Sha256>::new_from_slice(&key.0) else {
        return String::new();
    };
    h.update(&mac_input(m));
    sha256_hex_of(&h.finalize().into_bytes())
}

fn sha256_hex_of(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The digest a job binds: one line `name|sha256|bytes` per file, sorted.
pub fn dataset_digest(files: &[(String, Vec<u8>)]) -> String {
    let mut lines: Vec<String> = files
        .iter()
        .map(|(n, b)| format!("{n}|{}|{}", sha256_hex(b), b.len()))
        .collect();
    lines.sort();
    format!("sha256:{}", sha256_hex(lines.join("\n").as_bytes()))
}

fn name_ok(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 128
        && n.ends_with(".safetensors")
        && n.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && !n.starts_with('.')
}

fn dir_bytes(dir: &Path) -> u64 {
    let Ok(rd) = fs::read_dir(dir) else {
        return 0;
    };
    rd.filter_map(Result::ok)
        .map(|e| {
            let p = e.path();
            if p.is_dir() {
                dir_bytes(&p)
            } else {
                e.metadata().map_or(0, |m| m.len())
            }
        })
        .fold(0u64, u64::saturating_add)
}

/// One job's checkpoint directory on the app's own data volume.
#[derive(Debug)]
pub struct CheckpointStore {
    dir: PathBuf,
    key: CheckpointKey,
    keep: usize,
    budget_bytes: u64,
}

impl CheckpointStore {
    pub fn new(
        dir: impl Into<PathBuf>,
        key: CheckpointKey,
        keep: usize,
        budget_bytes: u64,
    ) -> Self {
        Self {
            dir: dir.into(),
            key,
            keep: keep.max(1),
            budget_bytes,
        }
    }

    fn io(e: &std::io::Error) -> TrainError {
        TrainError::Io(format!("{:?}", e.kind()))
    }

    /// Write one step. Every file must be safetensors; a write that would go
    /// over budget fails and leaves the earlier checkpoints as they were.
    pub fn save(
        &self,
        binding: &JobBinding,
        step: u64,
        files: &[(String, Vec<u8>)],
    ) -> Result<CheckpointManifest, TrainError> {
        let mut entries = Vec::new();
        let mut new_bytes = 0u64;
        for (name, bytes) in files {
            if !name_ok(name) {
                return Err(TrainError::Invalid(format!(
                    "file name {name} is not allowed"
                )));
            }
            SafeTensors::parse(bytes)?;
            let len = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
            new_bytes = new_bytes.saturating_add(len);
            entries.push(CheckpointFile {
                name: name.clone(),
                sha256: sha256_hex(bytes),
                bytes: len,
            });
        }
        let used = dir_bytes(&self.dir).saturating_add(new_bytes);
        if used > self.budget_bytes {
            return Err(TrainError::DiskBudget {
                used,
                budget: self.budget_bytes,
            });
        }
        let mut m = CheckpointManifest {
            schema: CHECKPOINT_SCHEMA.into(),
            binding: binding.clone(),
            step,
            files: entries,
            mac: String::new(),
        };
        m.mac = mac_hex(&self.key, &m);
        fs::create_dir_all(&self.dir).map_err(|e| Self::io(&e))?;
        let final_dir = self.dir.join(format!("step-{step:012}"));
        let tmp = self.dir.join(format!(".tmp-step-{step:012}"));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).map_err(|e| Self::io(&e))?;
        let write = |p: PathBuf, b: &[u8]| -> Result<(), TrainError> {
            let mut f = fs::File::create(p).map_err(|e| Self::io(&e))?;
            f.write_all(b).map_err(|e| Self::io(&e))?;
            f.sync_all().map_err(|e| Self::io(&e))
        };
        for (name, bytes) in files {
            write(tmp.join(name), bytes)?;
        }
        let text = serde_json::to_vec_pretty(&m).map_err(|e| TrainError::Io(e.to_string()))?;
        write(tmp.join(MANIFEST), &text)?;
        let _ = fs::remove_dir_all(&final_dir);
        fs::rename(&tmp, &final_dir).map_err(|e| Self::io(&e))?;
        self.prune();
        Ok(m)
    }

    fn steps(&self) -> Vec<PathBuf> {
        let Ok(rd) = fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut v: Vec<PathBuf> = rd
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("step-"))
            })
            .collect();
        v.sort();
        v
    }

    fn prune(&self) {
        let steps = self.steps();
        let drop = steps.len().saturating_sub(self.keep);
        for p in steps.iter().take(drop) {
            let _ = fs::remove_dir_all(p);
        }
    }

    fn load_dir(&self, dir: &Path, binding: &JobBinding) -> Result<LoadedCheckpoint, TrainError> {
        let text = fs::read(dir.join(MANIFEST)).map_err(|e| Self::io(&e))?;
        let m: CheckpointManifest =
            serde_json::from_slice(&text).map_err(|_| TrainError::Invalid("manifest".into()))?;
        if m.schema != CHECKPOINT_SCHEMA {
            return Err(TrainError::Invalid("schema".into()));
        }
        let want = mac_hex(&self.key, &m);
        if want.is_empty() || want != m.mac {
            return Err(TrainError::Invalid("MAC does not verify".into()));
        }
        if m.binding != *binding {
            return Err(TrainError::Invalid(
                "belongs to another job, app generation or dataset".into(),
            ));
        }
        let mut files = Vec::new();
        for f in &m.files {
            if !name_ok(&f.name) {
                return Err(TrainError::Invalid("file name".into()));
            }
            let b = fs::read(dir.join(&f.name)).map_err(|e| Self::io(&e))?;
            if sha256_hex(&b) != f.sha256 || u64::try_from(b.len()).ok() != Some(f.bytes) {
                return Err(TrainError::Invalid(format!("{} was changed", f.name)));
            }
            SafeTensors::parse(&b)?;
            files.push((f.name.clone(), b));
        }
        Ok((m, files))
    }

    /// The newest checkpoint that verifies for `binding`, with the reasons
    /// newer ones were skipped.
    pub fn latest(&self, binding: &JobBinding) -> (Option<LoadedCheckpoint>, Vec<String>) {
        let mut skipped = Vec::new();
        for dir in self.steps().iter().rev() {
            match self.load_dir(dir, binding) {
                Ok(c) => return (Some(c), skipped),
                Err(e) => skipped.push(format!(
                    "{}: {e}",
                    dir.file_name().and_then(|n| n.to_str()).unwrap_or("?")
                )),
            }
        }
        (None, skipped)
    }
}

/// A deterministic regression dataset: `y = w·x + b + noise` from a seeded
/// generator, written as one safetensors file (`x`, `y`).
#[derive(Clone, Debug, PartialEq)]
pub struct SyntheticDataset {
    pub features: usize,
    pub x: Vec<f64>,
    pub y: Vec<f64>,
}

fn lcg(state: &mut u64) -> f64 {
    *state = state
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    ((*state >> 11) as f64) / ((1u64 << 53) as f64) - 0.5
}

impl SyntheticDataset {
    pub fn generate(seed: u64, samples: usize, features: usize) -> Self {
        let mut s = seed;
        let truth: Vec<f64> = (0..features).map(|i| (i as f64 + 1.0) * 0.5).collect();
        let mut x = Vec::with_capacity(samples.saturating_mul(features));
        let mut y = Vec::with_capacity(samples);
        for _ in 0..samples {
            let row: Vec<f64> = (0..features).map(|_| lcg(&mut s) * 4.0).collect();
            let t =
                row.iter().zip(&truth).map(|(a, b)| a * b).sum::<f64>() + 0.75 + lcg(&mut s) * 0.01;
            x.extend_from_slice(&row);
            y.push(t);
        }
        Self { features, x, y }
    }

    pub fn samples(&self) -> usize {
        self.y.len()
    }

    pub fn to_file(&self) -> Vec<u8> {
        write_f64(
            &[
                (
                    "x",
                    vec![self.samples() as u64, self.features as u64],
                    &self.x,
                ),
                ("y", vec![self.samples() as u64], &self.y),
            ],
            &std::collections::BTreeMap::new(),
        )
    }

    pub fn from_file(bytes: &[u8]) -> Result<Self, TrainError> {
        let st = SafeTensors::parse(bytes)?;
        let x = st.f64s("x").ok_or(TrainError::Dataset)?;
        let y = st.f64s("y").ok_or(TrainError::Dataset)?;
        let features = st
            .tensors
            .get("x")
            .and_then(|t| t.shape.get(1))
            .and_then(|f| usize::try_from(*f).ok())
            .ok_or(TrainError::Dataset)?;
        if features == 0 || x.len() != y.len().saturating_mul(features) {
            return Err(TrainError::Dataset);
        }
        Ok(Self { features, x, y })
    }
}

/// Data-parallel SGD over `ranks` simulated devices: each rank takes its
/// shard of the step's batch, gradients are summed in rank order (the
/// all-reduce) and averaged, so the result doesn't depend on timing.
#[derive(Clone, Debug)]
pub struct SyntheticTrainer {
    pub ranks: usize,
    pub batch: usize,
    pub lr: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Weights {
    pub w: Vec<f64>,
    pub b: f64,
}

impl Weights {
    pub fn zero(features: usize) -> Self {
        Self {
            w: vec![0.0; features],
            b: 0.0,
        }
    }

    pub fn to_file(&self, step: u64) -> Vec<u8> {
        let mut meta = std::collections::BTreeMap::new();
        meta.insert("step".to_owned(), step.to_string());
        write_f64(
            &[
                ("w", vec![self.w.len() as u64], &self.w),
                ("b", vec![1], &[self.b]),
            ],
            &meta,
        )
    }

    pub fn from_file(bytes: &[u8]) -> Result<Self, TrainError> {
        let st = SafeTensors::parse(bytes)?;
        let w = st.f64s("w").ok_or(TrainError::Invalid("weights".into()))?;
        let b = st
            .f64s("b")
            .and_then(|v| v.first().copied())
            .ok_or(TrainError::Invalid("bias".into()))?;
        Ok(Self { w, b })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum TrainOutcome {
    Completed {
        weights: Weights,
        loss: f64,
        resumed_from: Option<u64>,
    },
    Cancelled {
        at_step: u64,
    },
}

impl SyntheticTrainer {
    pub fn loss(&self, d: &SyntheticDataset, w: &Weights) -> f64 {
        let n = d.samples().max(1) as f64;
        d.y.iter()
            .enumerate()
            .map(|(i, y)| {
                let row =
                    d.x.get(
                        i.saturating_mul(d.features)
                            ..i.saturating_add(1).saturating_mul(d.features),
                    )
                    .unwrap_or(&[]);
                let p = row.iter().zip(&w.w).map(|(a, b)| a * b).sum::<f64>() + w.b;
                (p - y) * (p - y)
            })
            .sum::<f64>()
            / n
    }

    fn step(&self, d: &SyntheticDataset, w: &mut Weights, step: u64) {
        let n = d.samples().max(1);
        let ranks = self.ranks.max(1);
        let per_rank = self.batch.checked_div(ranks).unwrap_or(1).max(1);
        let mut gw = vec![0.0; d.features];
        let mut gb = 0.0;
        let mut count = 0usize;
        for r in 0..ranks {
            for k in 0..per_rank {
                let idx = usize::try_from(step)
                    .unwrap_or(0)
                    .wrapping_mul(self.batch.max(1))
                    .wrapping_add(r.wrapping_mul(per_rank))
                    .wrapping_add(k)
                    .checked_rem(n)
                    .unwrap_or(0);
                let row =
                    d.x.get(
                        idx.saturating_mul(d.features)
                            ..idx.saturating_add(1).saturating_mul(d.features),
                    )
                    .unwrap_or(&[]);
                let p = row.iter().zip(&w.w).map(|(a, b)| a * b).sum::<f64>() + w.b;
                let e = p - d.y.get(idx).copied().unwrap_or(0.0);
                for (g, a) in gw.iter_mut().zip(row) {
                    *g += 2.0 * e * a;
                }
                gb += 2.0 * e;
                count = count.saturating_add(1);
            }
        }
        let c = count.max(1) as f64;
        for (wi, g) in w.w.iter_mut().zip(&gw) {
            *wi -= self.lr * g / c;
        }
        w.b -= self.lr * gb / c;
    }

    /// Train to `steps`, checkpointing every `every` steps, resuming from
    /// the newest valid checkpoint. `cancel(step)` stops the job before that
    /// step runs.
    pub fn train(
        &self,
        d: &SyntheticDataset,
        store: &CheckpointStore,
        binding: &JobBinding,
        steps: u64,
        every: u64,
        cancel: &dyn Fn(u64) -> bool,
    ) -> Result<TrainOutcome, TrainError> {
        let (latest, _) = store.latest(binding);
        let (mut w, start, resumed_from) = match latest {
            Some((m, files)) => {
                let f = files
                    .iter()
                    .find(|(n, _)| n == "weights.safetensors")
                    .ok_or(TrainError::Invalid("no weights file".into()))?;
                (Weights::from_file(&f.1)?, m.step, Some(m.step))
            }
            None => (Weights::zero(d.features), 0, None),
        };
        for s in start..steps {
            if cancel(s) {
                return Ok(TrainOutcome::Cancelled { at_step: s });
            }
            self.step(d, &mut w, s);
            let done = s.saturating_add(1);
            if every > 0 && done.is_multiple_of(every) {
                store.save(
                    binding,
                    done,
                    &[("weights.safetensors".into(), w.to_file(done))],
                )?;
            }
        }
        Ok(TrainOutcome::Completed {
            loss: self.loss(d, &w),
            weights: w,
            resumed_from,
        })
    }
}

/// `sha256:` of a byte string (helper for callers binding a dataset file).
pub fn digest_bytes(b: &[u8]) -> String {
    format!("sha256:{}", sha256_hex_of(&Sha256::digest(b)))
}
