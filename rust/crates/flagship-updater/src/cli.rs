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
//! ```

use crate::manifest;
use crate::recover::{DEFAULT_MAX_STARTS, GuardAction, guard, reconcile};
use crate::release::{InstallArgs, Paths, install, restore};
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
        other => usage(err, &format!("unknown command {other}")),
    }
}
