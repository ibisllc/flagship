//! Fixtures: a throwaway directory, a tar.gz writer (including hostile archives), and signed
//! release manifests. The signer seeds are public constants: nothing signed here can verify against
//! a box's real trust file.

#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use ed25519_dalek::Signer as _;
use flagship_crypto::HybridSigningKey;
use flagship_crypto::trust::{TAG_PQ_KEY_BINDING, canonical_binding, hex};
use flagship_updater::manifest::Manifest;
use flagship_updater::release::{InstallArgs, Paths};
use flagship_updater::verify::Trust;
use flate2::Compression;
use flate2::write::GzEncoder;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static N: AtomicU32 = AtomicU32::new(0);

pub struct Tmp(pub PathBuf);

impl Tmp {
    pub fn new(label: &str) -> Self {
        let p = std::env::temp_dir().join(format!(
            "flagship-updater-{label}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub enum Entry {
    File(&'static str, Vec<u8>, u32),
    Dir(&'static str),
    Symlink(&'static str, &'static str),
    Hard(&'static str, &'static str),
    Device(&'static str),
    /// A file whose name is this owned string.
    LongFile(String, Vec<u8>),
    /// A GNU `L` long name for the next entry, then the entry.
    GnuLong(String, Vec<u8>),
    /// A pax `path` record for the next entry.
    PaxPath(String, Vec<u8>),
    BadChecksum(&'static str),
}

fn put(buf: &mut [u8], at: usize, s: &[u8]) {
    buf[at..at + s.len()].copy_from_slice(s);
}

fn header(name: &[u8], size: u64, typeflag: u8, link: &[u8], mode: u32) -> [u8; 512] {
    let mut h = [0u8; 512];
    put(&mut h, 0, &name[..name.len().min(100)]);
    put(&mut h, 100, format!("{mode:07o}\0").as_bytes());
    put(&mut h, 108, b"0000000\0");
    put(&mut h, 116, b"0000000\0");
    put(&mut h, 124, format!("{size:011o}\0").as_bytes());
    put(&mut h, 136, b"00000000000\0");
    h[156] = typeflag;
    put(&mut h, 157, &link[..link.len().min(100)]);
    put(&mut h, 257, b"ustar\0");
    put(&mut h, 263, b"00");
    put(&mut h, 148, b"        ");
    let sum: u32 = h.iter().map(|b| u32::from(*b)).sum();
    put(&mut h, 148, format!("{sum:06o}\0 ").as_bytes());
    h
}

fn pad(out: &mut Vec<u8>, len: usize) {
    out.extend(std::iter::repeat_n(0u8, (512 - len % 512) % 512));
}

fn emit(out: &mut Vec<u8>, name: &str, data: &[u8], typeflag: u8, link: &str, mode: u32) {
    out.extend_from_slice(&header(
        name.as_bytes(),
        data.len() as u64,
        typeflag,
        link.as_bytes(),
        mode,
    ));
    out.extend_from_slice(data);
    pad(out, data.len());
}

pub fn tar_gz(entries: &[Entry]) -> Vec<u8> {
    let mut t = Vec::new();
    for e in entries {
        match e {
            Entry::File(n, d, m) => emit(&mut t, n, d, b'0', "", *m),
            Entry::Dir(n) => emit(&mut t, n, b"", b'5', "", 0o755),
            Entry::Symlink(n, l) => emit(&mut t, n, b"", b'2', l, 0o777),
            Entry::Hard(n, l) => emit(&mut t, n, b"", b'1', l, 0o644),
            Entry::Device(n) => emit(&mut t, n, b"", b'3', "", 0o600),
            Entry::LongFile(n, d) => {
                emit(&mut t, "placeholder", n.as_bytes(), b'L', "", 0o644);
                emit(&mut t, "truncated", d, b'0', "", 0o644);
            }
            Entry::GnuLong(n, d) => {
                let mut name = n.clone().into_bytes();
                name.push(0);
                emit(&mut t, "././@LongLink", &name, b'L', "", 0o644);
                emit(&mut t, "short", d, b'0', "", 0o644);
            }
            Entry::PaxPath(n, d) => {
                let body = format!("{} path={n}\n", 0);
                let mut len = body.len();
                let rec = loop {
                    let r = format!("{len} path={n}\n");
                    if r.len() == len {
                        break r;
                    }
                    len = r.len();
                };
                emit(&mut t, "PaxHeader", rec.as_bytes(), b'x', "", 0o644);
                emit(&mut t, "short", d, b'0', "", 0o644);
            }
            Entry::BadChecksum(n) => {
                let mut h = header(n.as_bytes(), 0, b'0', b"", 0o644);
                h[148] = b'9';
                t.extend_from_slice(&h);
            }
        }
    }
    t.extend(std::iter::repeat_n(0u8, 1024));
    let mut gz = GzEncoder::new(Vec::new(), Compression::fast());
    gz.write_all(&t).unwrap();
    gz.finish().unwrap()
}

/// The tree a real artifact has, under its top directory.
pub fn release_entries(commit: &str, arch: &str, node_body: &[u8]) -> Vec<Entry> {
    let info = format!("{{\"commit\":\"{commit}\",\"arch\":\"{arch}\"}}").into_bytes();
    vec![
        Entry::Dir("flagship-box/"),
        Entry::File("flagship-box/BUILD-INFO.json", info, 0o644),
        Entry::Dir("flagship-box/app/"),
        Entry::File("flagship-box/app/package.json", b"{}".to_vec(), 0o644),
        Entry::File("flagship-box/app/package-lock.json", b"{}".to_vec(), 0o644),
        Entry::Dir("flagship-box/app/installer/"),
        Entry::File(
            "flagship-box/app/installer/flagship-unseal",
            b"#!/bin/sh\n".to_vec(),
            0o755,
        ),
        Entry::Dir("flagship-box/app/scripts/"),
        Entry::File(
            "flagship-box/app/scripts/install-helper.ts",
            b"//".to_vec(),
            0o644,
        ),
        Entry::Dir("flagship-box/app/.runtime/"),
        Entry::Dir("flagship-box/app/.runtime/node/"),
        Entry::Dir("flagship-box/app/.runtime/node/bin/"),
        Entry::File(
            "flagship-box/app/.runtime/node/bin/node",
            node_body.to_vec(),
            0o755,
        ),
        Entry::Dir("flagship-box/app/node_modules/"),
        Entry::Dir("flagship-box/app/node_modules/tsx/"),
        Entry::Dir("flagship-box/app/node_modules/tsx/dist/"),
        Entry::File(
            "flagship-box/app/node_modules/tsx/dist/cli.mjs",
            b"//".to_vec(),
            0o644,
        ),
        Entry::Dir("flagship-box/app/node_modules/.bin/"),
        Entry::Symlink(
            "flagship-box/app/node_modules/.bin/tsx",
            "../tsx/dist/cli.mjs",
        ),
    ]
}

pub struct Signer {
    ed: ed25519_dalek::SigningKey,
    hybrid: HybridSigningKey,
}

impl Signer {
    pub fn new(seed: u8) -> Self {
        let ed_seed = [seed; 32];
        let ml_seed = [seed.wrapping_add(0x80); 32];
        Self {
            ed: ed25519_dalek::SigningKey::from_bytes(&ed_seed),
            hybrid: HybridSigningKey::from_seeds(&ed_seed, &ml_seed).unwrap(),
        }
    }
    pub fn ed_hex(&self) -> String {
        hex(&self.ed.verifying_key().to_bytes())
    }
    pub fn pq_id(&self) -> String {
        hex(&self.hybrid.verifying_key().key_id())
    }
    fn ml_hex(&self) -> String {
        hex(&self.hybrid.verifying_key().as_bytes()[32..])
    }
    pub fn binding_json(&self, issued_at: u64) -> serde_json::Value {
        let (ed, ml) = (self.ed_hex(), self.ml_hex());
        let stmt =
            canonical_binding("release-key", "flagship-box-artifact", &ed, &ml, issued_at).unwrap();
        let sig = self
            .hybrid
            .sign_deterministic(TAG_PQ_KEY_BINDING, &stmt)
            .unwrap();
        serde_json::json!({"v":1,"role":"release-key","subjectId":"flagship-box-artifact","ed25519PubHex":ed,"mldsaPubHex":ml,"issuedAt":issued_at,"signature":hex(&sig)})
    }
}

pub fn sha256_hex(b: &[u8]) -> String {
    hex(&Sha256::digest(b))
}

pub struct Built {
    pub dir: Tmp,
    pub artifact: PathBuf,
    pub manifest: PathBuf,
    pub manifest_struct: Manifest,
    pub sha: String,
    pub trust: Trust,
    pub commit: String,
}

pub struct Spec {
    pub commit_char: char,
    pub sequence: u64,
    pub node_version: &'static str,
    pub node_body: &'static [u8],
    pub signers: Vec<u8>,
    pub threshold: u64,
    pub pq: bool,
    pub tamper: bool,
    /// BUILD-INFO.json names this commit instead of the manifest's.
    pub build_info_commit: Option<String>,
    /// Leave this path out of the tree.
    pub omit: Option<&'static str>,
    /// Ship a runtime lock in the tree: Some(true) names the bundled node's real digest, Some(false) another.
    pub runtime_lock: Option<bool>,
}

impl Spec {
    pub fn new(commit_char: char, sequence: u64) -> Self {
        Self {
            commit_char,
            sequence,
            node_version: "24.1.0",
            node_body: b"node",
            signers: vec![1],
            threshold: 1,
            pq: false,
            tamper: false,
            build_info_commit: None,
            omit: None,
            runtime_lock: None,
        }
    }
}

pub fn build(spec: &Spec) -> Built {
    let dir = Tmp::new("art");
    let commit: String = std::iter::repeat_n(spec.commit_char, 40).collect();
    let info_commit = spec
        .build_info_commit
        .clone()
        .unwrap_or_else(|| commit.clone());
    let mut entries = release_entries(&info_commit, "amd64", spec.node_body);
    if let Some(omit) = spec.omit {
        entries.retain(|e| !matches!(e, Entry::File(n, _, _) if *n == omit));
    }
    if let Some(honest) = spec.runtime_lock {
        let digest = if honest {
            sha256_hex(spec.node_body)
        } else {
            "0".repeat(64)
        };
        let lock = serde_json::json!({
            "schema": 1, "runtime": "node", "version": "24.22.1", "securityFloor": "24.22.1",
            "upstream": {"base": "https://nodejs.org/dist/v24.22.1/", "shasums": "SHASUMS256.txt", "shasumsSignature": "SHASUMS256.txt.sig", "allowedHosts": ["nodejs.org"]},
            "keyring": {"signers": [{"fingerprint": "0".repeat(40), "armored": "x"}]},
            "targets": {"linux-amd64": {"file": "node-v24.22.1-linux-x64.tar.gz", "bytes": 1, "sha256": "1".repeat(64), "executable": "bin/node", "executableBytes": spec.node_body.len(), "executableSha256": digest}}
        });
        entries.push(Entry::Dir("flagship-box/app/release/"));
        entries.push(Entry::File(
            "flagship-box/app/release/runtime-lock.json",
            lock.to_string().into_bytes(),
            0o644,
        ));
    }
    let artifact_bytes = tar_gz(&entries);
    let sha = sha256_hex(&artifact_bytes);
    let artifact = dir.path().join("a.tar.gz");
    fs::write(&artifact, &artifact_bytes).unwrap();
    let m = Manifest {
        commit: commit.clone(),
        arch: "amd64".into(),
        artifact_sha256: sha.clone(),
        artifact_bytes: artifact_bytes.len() as u64,
        node_version: spec.node_version.into(),
        node_sha256: "1".repeat(64),
        lock_sha256: "2".repeat(64),
        sbom_sha256: "3".repeat(64),
        provenance_sha256: "4".repeat(64),
        min_verifier: 1,
        sequence: spec.sequence,
        issued_at: 1_700_000_000_000,
    };
    let canonical = m.canonical();
    let v1_digest = sha256_hex(canonical.as_bytes());
    let signers: Vec<Signer> = spec.signers.iter().map(|s| Signer::new(*s)).collect();
    let mut sigs = Vec::new();
    let mut bindings = Vec::new();
    for s in &signers {
        let sig = s.ed.sign(canonical.as_bytes());
        let mut e = serde_json::json!({"keyHex": s.ed_hex(), "signatureHex": hex(&sig.to_bytes())});
        if spec.pq {
            let id = s.pq_id();
            let stmt = format!("flagship/box-artifact/v2|{v1_digest}|{}|{id}", s.ed_hex());
            let psig = s
                .hybrid
                .sign_deterministic("flagship/box-artifact/v2", stmt.as_bytes())
                .unwrap();
            e["pq"] = serde_json::json!({"keyId": id, "signatureHex": hex(&psig)});
            bindings.push(s.binding_json(1_700_000_000_000));
        }
        sigs.push(e);
    }
    let mut manifest = serde_json::json!({
        "manifest": {
            "commit": m.commit, "arch": m.arch, "artifactSha256": m.artifact_sha256, "artifactBytes": m.artifact_bytes,
            "nodeVersion": m.node_version, "nodeSha256": m.node_sha256, "lockSha256": m.lock_sha256, "sbomSha256": m.sbom_sha256,
            "provenanceSha256": m.provenance_sha256, "minVerifier": m.min_verifier, "sequence": m.sequence, "issuedAt": m.issued_at
        },
        "signatures": sigs,
    });
    if spec.pq {
        manifest["pqBindings"] = serde_json::Value::Array(bindings);
    }
    if spec.tamper {
        manifest["manifest"]["sequence"] = serde_json::json!(m.sequence + 1);
    }
    let path = dir.path().join("a.manifest.json");
    fs::write(&path, manifest.to_string()).unwrap();
    let trust = Trust {
        keys: signers.iter().map(Signer::ed_hex).collect(),
        threshold: spec.threshold,
        pq_key_ids: if spec.pq {
            signers.iter().map(Signer::pq_id).collect()
        } else {
            vec![]
        },
        legacy_manifests: vec![],
    };
    Built {
        dir,
        artifact,
        manifest: path,
        manifest_struct: m,
        sha,
        trust,
        commit,
    }
}

pub fn temp_paths(t: &Tmp) -> Paths {
    Paths {
        releases: t.path().join("releases"),
        current: t.path().join("opt-flagship"),
        state: t.path().join("state"),
        bin: t.path().join("bin"),
    }
}

pub fn install_args(b: &Built, paths: &Paths) -> InstallArgs {
    InstallArgs {
        manifest: b.manifest.clone(),
        artifact: b.artifact.clone(),
        trust: b.trust.clone(),
        expect_sha256: b.sha.clone(),
        expect_commit: b.commit.clone(),
        arch: "amd64".into(),
        node_floor: "22.0.0".into(),
        min_sequence: None,
        paths: paths.clone(),
    }
}
