//! Numerical acceptance (§9.4): the expected answers for the vendor
//! workloads in `tools/gpu/` (CUDA, HIP and SYCL vector add; a PyTorch
//! forward pass of a fixed tiny MLP). A device passes when the workload,
//! run on it under the qualified isolation profile, prints a report that
//! matches. `nvidia-smi` answering is not acceptance.

use serde::{Deserialize, Serialize};

pub const VECTOR_ADD_SCHEMA: &str = "flagship/gpu-vector-add/v1";
pub const MLP_SCHEMA: &str = "flagship/gpu-mlp-forward/v1";
pub const VECTOR_ADD_N: u64 = 1 << 20;
pub const MLP_TOLERANCE: f64 = 1e-4;

/// `a[i] = i * 0.5`, `b[i] = (n - i) * 0.25`: every sum is exact in f32
/// for n up to 2^20, so the device's answer must match bit for bit.
pub fn vector_add_value(n: u64, i: u64) -> f64 {
    (i as f64) * 0.5 + ((n.saturating_sub(i)) as f64) * 0.25
}

pub fn vector_add_checksum(n: u64) -> f64 {
    (0..n).map(|i| vector_add_value(n, i)).sum()
}

/// Indices every report samples.
pub fn vector_add_sample_indices(n: u64) -> Vec<u64> {
    vec![0, 1, n / 3, n / 2, n.saturating_sub(2), n.saturating_sub(1)]
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VectorAddReport {
    pub schema: String,
    /// `cuda`, `hip` or `sycl`.
    pub api: String,
    pub n: u64,
    pub checksum: f64,
    pub samples: Vec<(u64, f64)>,
}

pub fn verify_vector_add(r: &VectorAddReport, api: &str) -> Result<(), String> {
    if r.schema != VECTOR_ADD_SCHEMA || r.api != api {
        return Err(format!("not a {api} vector-add report"));
    }
    if r.n != VECTOR_ADD_N {
        return Err(format!("ran {} elements, expected {VECTOR_ADD_N}", r.n));
    }
    let want = vector_add_checksum(r.n);
    if (r.checksum - want).abs() > want.abs() * 1e-9 {
        return Err(format!("checksum {} differs from {want}", r.checksum));
    }
    let idx = vector_add_sample_indices(r.n);
    if r.samples.len() != idx.len() {
        return Err("the report must carry every sample".into());
    }
    for ((i, got), want_i) in r.samples.iter().zip(idx) {
        if *i != want_i || *got != vector_add_value(r.n, want_i) {
            return Err(format!("element {i} is {got}"));
        }
    }
    Ok(())
}

/// The fixed MLP the PyTorch check runs: 16 inputs, 32 hidden (ReLU), 4
/// outputs, with weights from closed formulas so both sides need no file.
pub fn mlp_expected() -> [f64; 4] {
    let x: Vec<f64> = (0..16u32).map(|j| f64::from(j % 7) / 7.0).collect();
    let mut hidden = [0f64; 32];
    for (i, h) in hidden.iter_mut().enumerate() {
        let i32_ = i32::try_from(i).unwrap_or(0);
        let mut s = f64::from(i32_.wrapping_rem(3).wrapping_sub(1)) / 10.0;
        for (j, xj) in x.iter().enumerate() {
            let j32 = i32::try_from(j).unwrap_or(0);
            s += f64::from(
                i32_.wrapping_mul(16)
                    .wrapping_add(j32)
                    .wrapping_rem(11)
                    .wrapping_sub(5),
            ) / 10.0
                * xj;
        }
        *h = s.max(0.0);
    }
    let mut out = [0f64; 4];
    for (k, o) in out.iter_mut().enumerate() {
        let k32 = i32::try_from(k).unwrap_or(0);
        let mut s = f64::from(k32) / 10.0;
        for (i, h) in hidden.iter().enumerate() {
            let i32_ = i32::try_from(i).unwrap_or(0);
            s += f64::from(
                k32.wrapping_mul(32)
                    .wrapping_add(i32_)
                    .wrapping_rem(13)
                    .wrapping_sub(6),
            ) / 12.0
                * h;
        }
        *o = s;
    }
    out
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MlpReport {
    pub schema: String,
    /// `cuda`, `rocm` or `xpu` (PyTorch's device type).
    pub device: String,
    pub logits: Vec<f64>,
}

pub fn verify_mlp(r: &MlpReport, device: &str) -> Result<(), String> {
    if r.schema != MLP_SCHEMA || r.device != device {
        return Err(format!("not a {device} MLP report"));
    }
    let want = mlp_expected();
    if r.logits.len() != want.len() {
        return Err("expected 4 logits".into());
    }
    for (g, w) in r.logits.iter().zip(want.iter()) {
        if (g - w).abs() > MLP_TOLERANCE {
            return Err(format!("logit {g} differs from {w}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vector_add_fixture_is_self_consistent() {
        let n = VECTOR_ADD_N;
        let r = VectorAddReport {
            schema: VECTOR_ADD_SCHEMA.into(),
            api: "cuda".into(),
            n,
            checksum: vector_add_checksum(n),
            samples: vector_add_sample_indices(n)
                .into_iter()
                .map(|i| (i, vector_add_value(n, i)))
                .collect(),
        };
        assert_eq!(verify_vector_add(&r, "cuda"), Ok(()));
        assert!(verify_vector_add(&r, "hip").is_err());
        let mut bad = r.clone();
        if let Some(s) = bad.samples.get_mut(2) {
            s.1 += 1.0;
        }
        assert!(verify_vector_add(&bad, "cuda").is_err());
    }

    #[test]
    fn mlp_expected_is_stable() {
        let a = mlp_expected();
        assert_eq!(a, mlp_expected());
        let r = MlpReport {
            schema: MLP_SCHEMA.into(),
            device: "cuda".into(),
            logits: a.iter().map(|v| v + 1e-6).collect(),
        };
        assert_eq!(verify_mlp(&r, "cuda"), Ok(()));
        let r2 = MlpReport {
            logits: a.iter().map(|v| v + 1e-2).collect(),
            ..r
        };
        assert!(verify_mlp(&r2, "cuda").is_err());
    }
}
