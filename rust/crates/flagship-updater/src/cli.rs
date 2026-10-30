//! The command line. `verify`, `install` and `restore` take the flags of the shell scripts they
//! replace and keep their exit codes (0 ok, 1 refused by the verifier, 2 usage, 3 the unpacked tree
//! or the switch failed), so the broker can exec this binary where it ran the scripts.
//!
//! ```text
//! flagship-updater verify  --manifest F --artifact F --trust-keys K1,K2 --threshold N --expect-sha256 H
//!                          --expect-commit C --arch A [--last-sequence N] [--node-floor V]
//!                          [--pq-key-ids K] [--legacy-manifests D] [--now MS]
//! flagship-updater install --manifest F --artifact F --trust-keys K --threshold N --expect-sha256 H
//!                          --expect-commit C --arch A --node-floor V [--min-sequence N] [--pq-key-ids K]
//!                          [--legacy-manifests D] [--releases D] [--current P] [--state D] [--bin D]
//! flagship-updater restore <commit> [--releases D] [--current P] [--state D] [--bin D]
//! flagship-updater guard     [--max-starts N] [--releases D] [--current P] [--state D] [--bin D]
//! flagship-updater reconcile [--releases D] [--current P] [--state D] [--bin D]
//! flagship-updater runtime verify  --lock F --target T --archive F --shasums F --shasums-sig F
//! flagship-updater runtime install --lock F --target T [--runtimes D] (--archive F --shasums F --shasums-sig F | --fetch [--cache D])
//! flagship-updater runtime status  --lock F --target T [--runtimes D]
//! flagship-updater runtime manifest --manifest F --trust F [--state D] [--now MS]
//! ```

use crate::manifest;
use crate::recover::{DEFAULT_MAX_STARTS, GuardAction, guard, reconcile};
use crate::release::{InstallArgs, Paths, install, restore};
use crate::runtime;
use crate::verify::{Expect, Trust, verify};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn flags(args: &[String]) -> Result<HashMap<String, String>, String> {
    let mut m = HashMap::new();
    let mut it = args.iter();
    while let Some(k) = it.next() {
        let key = k
            .strip_prefix("--")
            .ok_or_else(|| format!("unexpected argument {k}"))?;
        let v = it.next().ok_or_else(|| format!("--{key} needs a value"))?;
        if m.insert(key.to_owned(), v.clone()).is_some() {
            return Err(format!("--{key} given twice"));
        }
    }
    Ok(m)
}

fn paths_of(f: &HashMap<String, String>) -> Paths {
    let d = Paths::default();
    let pick = |k: &str, dflt: PathBuf| f.get(k).map_or(dflt, PathBuf::from);
    Paths {
        releases: pick("releases", d.releases),
        current: pick("current", d.current),
        state: pick("state", d.state),
        bin: pick("bin", d.bin),
    }
}

fn list(s: Option<&String>) -> Vec<String> {
    s.map(|v| {
        v.split(',')
            .filter(|x| !x.is_empty())
            .map(str::to_owned)
            .collect()
    })
    .unwrap_or_default()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

fn usage(err: &mut dyn Write, why: &str) -> u8 {
    let _ = writeln!(
        err,
        "{why}\nusage: flagship-updater verify|install|restore|guard|reconcile ... (see the crate docs)"
    );
    2
}

struct Common {
    trust: Trust,
    manifest: PathBuf,
    artifact: PathBuf,
    sha: String,
    commit: String,
    arch: String,
}

fn common(f: &HashMap<String, String>) -> Result<Common, String> {
    let need = |k: &str| {
        f.get(k)
            .cloned()
            .ok_or_else(|| format!("--{k} is required"))
    };
    Ok(Common {
        trust: Trust {
            keys: list(f.get("trust-keys")),
            threshold: need("threshold")?
                .parse()
                .map_err(|_| "--threshold is not a number".to_owned())?,
            pq_key_ids: list(f.get("pq-key-ids")),
            legacy_manifests: list(f.get("legacy-manifests")),
        },
        manifest: PathBuf::from(need("manifest")?),
        artifact: PathBuf::from(need("artifact")?),
        sha: need("expect-sha256")?,
        commit: need("expect-commit")?,
        arch: need("arch")?,
    })
}

/// Runs one command line; returns the process exit code.
pub fn run(args: &[String], out: &mut dyn Write, err: &mut dyn Write) -> u8 {
    let Some((cmd, rest)) = args.split_first() else {
        return usage(err, "no command");
    };
    match cmd.as_str() {
        "verify" => {
            let f = match flags(rest) {
                Ok(f) => f,
                Err(e) => return usage(err, &e),
            };
            let c = match common(&f) {
                Ok(c) => c,
                Err(e) => return usage(err, &e),
            };
            let text = match std::fs::read_to_string(&c.manifest) {
                Ok(t) => t,
                Err(e) => {
                    let _ = writeln!(err, "refused: bad-manifest ({e})");
                    return 1;
                }
            };
            let file = match manifest::parse(&text) {
                Ok(m) => m,
                Err(r) => {
                    let _ = writeln!(err, "{r}");
                    return 1;
                }
            };
            let expect = Expect {
                sha256: c.sha,
                commit: c.commit,
                arch: c.arch,
                last_sequence: f.get("last-sequence").and_then(|v| v.parse().ok()),
                node_floor: f.get("node-floor").cloned(),
                now_ms: f
                    .get("now")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(now_ms),
            };
            match verify(&file, &c.artifact, &c.trust, &expect) {
                Ok(v) => {
                    let _ = writeln!(
                        out,
                        "verified: {} {} sequence {} signed by {}",
                        v.commit, v.arch, v.sequence, v.signers
                    );
                    0
                }
                Err(r) => {
                    let _ = writeln!(err, "{r}");
                    1
                }
            }
        }
        "install" => {
            let f = match flags(rest) {
                Ok(f) => f,
                Err(e) => return usage(err, &e),
            };
            let c = match common(&f) {
                Ok(c) => c,
                Err(e) => return usage(err, &e),
            };
            let Some(floor) = f.get("node-floor").cloned() else {
                return usage(err, "--node-floor is required");
            };
            let a = InstallArgs {
                manifest: c.manifest,
                artifact: c.artifact,
                trust: c.trust,
                expect_sha256: c.sha,
                expect_commit: c.commit,
                arch: c.arch,
                node_floor: floor,
                min_sequence: f.get("min-sequence").and_then(|v| v.parse().ok()),
                paths: paths_of(&f),
            };
            match install(&a) {
                Ok(i) => {
                    let _ = writeln!(
                        out,
                        "installed: {} {} sequence {}",
                        i.commit, i.arch, i.sequence
                    );
                    0
                }
                Err(fail) => {
                    let _ = writeln!(err, "{}", fail.refusal);
                    fail.exit
                }
            }
        }
        "restore" => {
            let Some((commit, more)) = rest.split_first() else {
                return usage(err, "restore needs a commit");
            };
            let f = match flags(more) {
                Ok(f) => f,
                Err(e) => return usage(err, &e),
            };
            match restore(&paths_of(&f), commit) {
                Ok(()) => {
                    let _ = writeln!(out, "rolled back: {commit}");
                    0
                }
                Err(fail) => {
                    let _ = writeln!(err, "{}", fail.refusal);
                    fail.exit
                }
            }
        }
        "guard" => {
            let f = match flags(rest) {
                Ok(f) => f,
                Err(e) => return usage(err, &e),
            };
            let max = f
                .get("max-starts")
                .and_then(|v| v.parse().ok())
                .unwrap_or(DEFAULT_MAX_STARTS);
            match guard(&paths_of(&f), max) {
                GuardAction::NoMarker => {}
                GuardAction::Counted { starts } => {
                    let _ = writeln!(out, "[update-guard] pending update, start {starts}");
                }
                GuardAction::RolledBack { to } => {
                    let _ = writeln!(out, "[update-guard] rolled back to {to}");
                }
                GuardAction::RollbackFailed { to, why } => {
                    let _ = writeln!(
                        out,
                        "[update-guard] switching back to {to} failed ({why}); leaving it to the daemon"
                    );
                }
                GuardAction::NothingKnown => {
                    let _ = writeln!(
                        out,
                        "[update-guard] unreadable marker and no known-good commit; leaving it to the daemon"
                    );
                }
            }
            // The guard must never keep the daemon from starting.
            0
        }
        "reconcile" => {
            let f = match flags(rest) {
                Ok(f) => f,
                Err(e) => return usage(err, &e),
            };
            reconcile(&paths_of(&f));
            0
        }
        "runtime" => run_runtime(rest, out, err),
        other => usage(err, &format!("unknown command {other}")),
    }
}

fn fail(err: &mut dyn Write, r: &crate::refusal::Refusal) -> u8 {
    let _ = writeln!(err, "{r}");
    1
}

/// `flagship-updater runtime ...`
fn run_runtime(args: &[String], out: &mut dyn Write, err: &mut dyn Write) -> u8 {
    let Some((sub, rest)) = args.split_first() else {
        return usage(err, "runtime needs verify, install or status");
    };
    let f = match flags_with_switches(rest, &["fetch"]) {
        Ok(f) => f,
        Err(e) => return usage(err, &e),
    };
    if sub == "manifest" {
        return run_runtime_manifest(&f, out, err);
    }
    let need = |k: &str| {
        f.get(k)
            .cloned()
            .ok_or_else(|| format!("--{k} is required"))
    };
    let (lock_path, target) = match (need("lock"), need("target")) {
        (Ok(l), Ok(t)) => (l, t),
        (Err(e), _) | (_, Err(e)) => return usage(err, &e),
    };
    let lock = match std::fs::read_to_string(&lock_path)
        .map_err(|e| crate::refusal::Refusal::with("bad-runtime-lock", e.to_string()))
        .and_then(|t| runtime::Lock::parse(&t))
    {
        Ok(l) => l,
        Err(r) => return fail(err, &r),
    };
    let runtimes = f
        .get("runtimes")
        .map_or_else(|| PathBuf::from("/opt/flagship-runtimes"), PathBuf::from);
    if sub == "status" {
        return match runtime::status(&lock, &target, &runtimes) {
            Ok(s) => {
                let _ = writeln!(out, "{}", status_json(&s));
                0
            }
            Err(r) => fail(err, &r),
        };
    }
    let t = match lock.target(&target) {
        Ok(t) => t.clone(),
        Err(r) => return fail(err, &r),
    };
    let inputs = if f.contains_key("fetch") {
        fetch_inputs(&lock, &t, f.get("cache").map(PathBuf::from))
    } else {
        match (need("archive"), need("shasums"), need("shasums-sig")) {
            (Ok(a), Ok(s), Ok(g)) => read_inputs(&a, &s, &g),
            (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => return usage(err, &e),
        }
    };
    let (archive, shasums, sig) = match inputs {
        Ok(i) => i,
        Err(r) => return fail(err, &r),
    };
    match sub.as_str() {
        "verify" => match runtime::verify_archive(&lock, &t, &archive, &shasums, &sig) {
            Ok(e) => {
                let _ = writeln!(
                    out,
                    "verified: node {} {} signed by {}",
                    lock.version, t.name, e.signer
                );
                0
            }
            Err(r) => fail(err, &r),
        },
        "install" => match runtime::install(&lock, &t, &archive, &shasums, &sig, &runtimes) {
            Ok(i) => {
                let _ = writeln!(
                    out,
                    "{}: {}",
                    if i.new {
                        "installed"
                    } else {
                        "already installed"
                    },
                    i.dir.display()
                );
                0
            }
            Err(r) => fail(err, &r),
        },
        other => usage(err, &format!("unknown runtime command {other}")),
    }
}

type Inputs = (PathBuf, Vec<u8>, Vec<u8>);

fn read_inputs(archive: &str, shasums: &str, sig: &str) -> Result<Inputs, crate::refusal::Refusal> {
    let rd = |p: &str| {
        std::fs::read(p)
            .map_err(|e| crate::refusal::Refusal::with("download-failed", format!("{p}: {e}")))
    };
    Ok((PathBuf::from(archive), rd(shasums)?, rd(sig)?))
}

/// The inputs from the cache when it already holds a verified copy, else downloaded from the official upstream.
fn fetch_inputs(
    lock: &runtime::Lock,
    t: &runtime::Target,
    cache: Option<PathBuf>,
) -> Result<Inputs, crate::refusal::Refusal> {
    let cache = cache.unwrap_or_else(|| PathBuf::from("/var/cache/flagship-runtimes"));
    let client = runtime::fetch::Ureq::new(std::time::Duration::from_secs(30 * 60));
    let c = runtime::fetch::fetch_into_cache(&client, lock, t, &cache)?;
    read_inputs_paths(&c.archive, &c.shasums, &c.signature)
}

fn read_inputs_paths(
    archive: &std::path::Path,
    shasums: &std::path::Path,
    sig: &std::path::Path,
) -> Result<Inputs, crate::refusal::Refusal> {
    let rd = |p: &std::path::Path| {
        std::fs::read(p)
            .map_err(|e| crate::refusal::Refusal::with("download-failed", e.to_string()))
    };
    Ok((archive.to_path_buf(), rd(shasums)?, rd(sig)?))
}

fn status_json(s: &runtime::RuntimeStatus) -> String {
    let mut m = serde_json::Map::new();
    m.insert("runtime".into(), "node".into());
    m.insert("version".into(), s.version.clone().into());
    m.insert("target".into(), s.target.clone().into());
    m.insert("officialUrl".into(), s.official_url.clone().into());
    m.insert(
        "expectedArchiveSha256".into(),
        s.expected_archive_sha256.clone().into(),
    );
    m.insert(
        "expectedExecutableSha256".into(),
        s.expected_executable_sha256.clone().into(),
    );
    m.insert("installed".into(), s.installed.into());
    m.insert(
        "localExecutableSha256".into(),
        s.local_executable_sha256
            .clone()
            .map_or(serde_json::Value::Null, Into::into),
    );
    m.insert("matchesLock".into(), s.matches_lock.into());
    m.insert(
        "upstreamSigner".into(),
        s.upstream_signer
            .clone()
            .map_or(serde_json::Value::Null, Into::into),
    );
    m.insert("lockSha256".into(), s.lock_sha256.clone().into());
    serde_json::Value::Object(m).to_string()
}

fn flags_with_switches(
    args: &[String],
    switches: &[&str],
) -> Result<HashMap<String, String>, String> {
    let mut m = HashMap::new();
    let mut it = args.iter();
    while let Some(k) = it.next() {
        let key = k
            .strip_prefix("--")
            .ok_or_else(|| format!("unexpected argument {k}"))?;
        if switches.contains(&key) {
            m.insert(key.to_owned(), String::new());
            continue;
        }
        let v = it.next().ok_or_else(|| format!("--{key} needs a value"))?;
        if m.insert(key.to_owned(), v.clone()).is_some() {
            return Err(format!("--{key} given twice"));
        }
    }
    Ok(m)
}

/// The trust file's keys, threshold and PQ pin (`release/box-artifact-trust.json`).
fn trust_from_file(path: &str) -> Result<Trust, crate::refusal::Refusal> {
    let bad = |d: &str| crate::refusal::Refusal::with("bad-trust", d.to_owned());
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| bad(&e.to_string()))?)
            .map_err(|_| bad("not JSON"))?;
    let list = |x: Option<&serde_json::Value>| -> Vec<String> {
        x.and_then(serde_json::Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|k| k.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    Ok(Trust {
        keys: list(v.get("keys")),
        threshold: v
            .get("threshold")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| bad("threshold"))?,
        pq_key_ids: list(v.get("pq").and_then(|p| p.get("keyIds"))),
        legacy_manifests: list(v.get("pq").and_then(|p| p.get("legacyManifests"))),
    })
}

/// `runtime manifest`: verifies a signed runtime manifest; with `--state` it also refuses a replayed or older one and
/// records the accepted sequence.
fn run_runtime_manifest(
    f: &HashMap<String, String>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> u8 {
    let (Some(manifest), Some(trust)) = (f.get("manifest"), f.get("trust")) else {
        return usage(err, "--manifest and --trust are required");
    };
    let result = (|| {
        let file = runtime::manifest::parse(
            &std::fs::read_to_string(manifest)
                .map_err(|e| crate::refusal::Refusal::with("bad-manifest", e.to_string()))?,
        )?;
        let state = f.get("state").map(PathBuf::from);
        let seq_path = state.as_ref().map(|d| d.join("runtime-sequence"));
        let last = seq_path
            .as_ref()
            .and_then(|p| crate::fsutil::read_regular(p))
            .and_then(|t| t.trim().parse::<u64>().ok());
        let now = f
            .get("now")
            .and_then(|v| v.parse().ok())
            .unwrap_or_else(now_ms);
        let (v, _lock) =
            runtime::manifest::verify_file(&file, &trust_from_file(trust)?, now, last)?;
        if let Some(p) = seq_path {
            crate::fsutil::write_durable(&p, format!("{}\n", v.sequence).as_bytes(), 0o644)
                .map_err(|e| crate::refusal::Refusal::with("install-failed", e.to_string()))?;
        }
        Ok::<_, crate::refusal::Refusal>(v)
    })();
    match result {
        Ok(v) => {
            let _ = writeln!(
                out,
                "verified: node {} sequence {} valid until {} signed by {}",
                v.version, v.sequence, v.valid_until, v.signers
            );
            0
        }
        Err(r) => fail(err, &r),
    }
}
