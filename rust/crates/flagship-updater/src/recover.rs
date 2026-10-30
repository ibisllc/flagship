//! Boot-time recovery: what the daemon's bash update guard did, plus the reconcile of a switch
//! that was cut short, with no Node and no dependence on the new release starting.
//!
//! The daemon owns `update-pending.json` (the marker its health gate reads) and
//! `update-outcome.json`. The guard runs before every daemon start (`ExecStartPre`) and rolls back
//! in exactly three cases, because each leaves code that may not run at all:
//!
//! - the apply was interrupted (`stage: applying`: power loss, a stopped VM, a crash mid-unpack);
//! - the new release starts but is never verified healthy (more than `max_starts` starts);
//! - the marker exists but cannot be read (cut short by a power loss): fall back to the last
//!   release this box verified healthy.
//!
//! A rollback only flips back to a release already on disk. It never touches keys, revocation
//! epochs or the minimum-security state (`artifact-sequence` stays where it is, so the rolled-back
//! box still refuses anything older than it ever ran).

use crate::fsutil::{read_regular, write_durable};
use crate::journal::{Intent, Phase};
use crate::release::{Paths, current_commit, restore};
use serde_json::{Map, Value};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_MAX_STARTS: u64 = 8;
const MARKER: &str = "update-pending.json";
const STARTS: &str = "update-guard-starts";
const OUTCOME: &str = "update-outcome.json";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GuardAction {
    /// No update is pending.
    NoMarker,
    /// A pending update, started `starts` times so far.
    Counted { starts: u64 },
    /// Flipped back to `to`.
    RolledBack { to: String },
    /// A rollback was needed and failed: left to the daemon.
    RollbackFailed { to: String, why: String },
    /// An unreadable marker and no known-good release: left to the daemon.
    NothingKnown,
}

fn is_commit(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

fn json(path: &Path) -> Option<Value> {
    serde_json::from_str(&read_regular(path)?).ok()
}

/// The uid and gid of a user from `/etc/passwd`, without NSS.
fn passwd(name: &str) -> Option<(u32, u32)> {
    let text = fs::read_to_string("/etc/passwd").ok()?;
    text.lines().find_map(|l| {
        let f: Vec<&str> = l.split(':').collect();
        (f.first() == Some(&name))
            .then(|| Some((f.get(2)?.parse().ok()?, f.get(3)?.parse().ok()?)))?
    })
}

fn hand_to_daemon(path: &Path) {
    if let Some((uid, gid)) = passwd("flagship") {
        let _ = rustix::fs::chown(
            path,
            Some(rustix::fs::Uid::from_raw(uid)),
            Some(rustix::fs::Gid::from_raw(gid)),
        );
    }
}

/// Finishes or undoes a switch that was cut short, and removes what an interrupted unpack left.
pub fn reconcile(paths: &Paths) {
    if let Ok(rd) = fs::read_dir(&paths.releases) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with(".incoming-") {
                let _ = fs::remove_dir_all(e.path());
            }
        }
    }
    let Some(intent) = Intent::read(&paths.state) else {
        return;
    };
    match intent.phase {
        // Nothing flipped yet: the old release is still the running one.
        Phase::Staged => {
            let _ = Intent::clear(&paths.state);
        }
        Phase::Switching | Phase::Switched => {
            if current_commit(paths).as_deref() != Some(intent.commit.as_str()) {
                // The link never moved: nothing to finish.
                let _ = Intent::clear(&paths.state);
                return;
            }
            let dest = paths.releases.join(&intent.commit);
            if let Some(record) = read_regular(&dest.join("INSTALLED.json")) {
                let _ = write_durable(
                    &paths.state.join("artifact-current.json"),
                    record.as_bytes(),
                    0o644,
                );
            }
            let seq_path = paths.state.join("artifact-sequence");
            let known = read_regular(&seq_path).and_then(|t| t.trim().parse::<u64>().ok());
            if known.is_none_or(|k| k < intent.sequence) {
                let _ = write_durable(
                    &seq_path,
                    format!("{}\n", intent.sequence).as_bytes(),
                    0o644,
                );
            }
            let _ = crate::fsutil::switch_symlink(
                &paths.bin.join("node"),
                &paths.current.join(".runtime/node/bin/node"),
            );
            if intent.phase == Phase::Switching {
                let done = Intent {
                    phase: Phase::Switched,
                    ..intent
                };
                let _ = done.write(&paths.state);
            }
        }
    }
}

fn write_outcome(paths: &Paths, prev: &str, target: &str, attempts: u64) {
    let mut m = Map::new();
    m.insert("outcome".into(), Value::from("rolled-back"));
    m.insert("at".into(), Value::from(now_ms()));
    m.insert("previousCommit".into(), Value::from(prev));
    m.insert("targetCommit".into(), Value::from(target));
    m.insert("bootAttempts".into(), Value::from(attempts));
    let path = paths.state.join(OUTCOME);
    if write_durable(&path, Value::Object(m).to_string().as_bytes(), 0o600).is_ok() {
        hand_to_daemon(&path);
    }
}

/// The guard (`flagship-updater guard`). Never panics and never refuses to let the daemon start:
/// the caller exits 0 whatever this returns.
pub fn guard(paths: &Paths, max_starts: u64) -> GuardAction {
    reconcile(paths);
    let marker_path = paths.state.join(MARKER);
    let starts_path = paths.state.join(STARTS);
    let Some(marker_text) = read_regular(&marker_path) else {
        // No readable marker. A file that exists but cannot be read is handled below.
        if fs::symlink_metadata(&marker_path).is_err() {
            let _ = fs::remove_file(&starts_path);
            if Intent::read(&paths.state).is_some_and(|i| i.phase == Phase::Switched) {
                let _ = Intent::clear(&paths.state);
            }
            return GuardAction::NoMarker;
        }
        return unreadable(paths, max_starts, &marker_path, &starts_path);
    };
    let marker: Option<Value> = serde_json::from_str(&marker_text).ok();
    let field = |k: &str| {
        marker
            .as_ref()
            .and_then(|m| m.get(k))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let prev = field("previousCommit").filter(|c| is_commit(c));
    let target = field("targetCommit").filter(|c| is_commit(c));
    let stage = field("stage").unwrap_or_else(|| "staged".into());
    let attempts = marker
        .as_ref()
        .and_then(|m| m.get("bootAttempts"))
        .map_or(Some(0), Value::as_u64);
    match (prev, target, attempts) {
        (Some(prev), Some(target), Some(attempts)) => decide(
            paths,
            max_starts,
            &marker_path,
            &starts_path,
            &prev,
            &target,
            &stage,
            attempts,
        ),
        _ => unreadable(paths, max_starts, &marker_path, &starts_path),
    }
}

fn unreadable(
    paths: &Paths,
    max_starts: u64,
    marker_path: &Path,
    starts_path: &Path,
) -> GuardAction {
    let outcome = json(&paths.state.join(OUTCOME));
    let get = |k: &str| {
        outcome
            .as_ref()
            .and_then(|o| o.get(k))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let prev = match get("outcome").as_deref() {
        Some("applied") => get("targetCommit"),
        Some("rolled-back") => get("previousCommit"),
        _ => None,
    }
    .filter(|c| is_commit(c));
    let Some(prev) = prev else {
        return GuardAction::NothingKnown;
    };
    let target = json(&paths.state.join("artifact-current.json"))
        .and_then(|j| j.get("commit").and_then(Value::as_str).map(str::to_owned))
        .filter(|c| is_commit(c))
        .unwrap_or_else(|| prev.clone());
    decide(
        paths,
        max_starts,
        marker_path,
        starts_path,
        &prev,
        &target,
        "applying",
        0,
    )
}

#[allow(clippy::too_many_arguments)]
fn decide(
    paths: &Paths,
    max_starts: u64,
    marker_path: &Path,
    starts_path: &Path,
    prev: &str,
    target: &str,
    stage: &str,
    attempts: u64,
) -> GuardAction {
    // Counted per target, so a count left by an earlier update never carries over.
    let counted = read_regular(starts_path).and_then(|t| {
        let mut it = t.split_whitespace();
        let (c, n) = (it.next()?.to_owned(), it.next()?.parse::<u64>().ok()?);
        (c == target).then_some(n)
    });
    let starts = counted.unwrap_or(0).saturating_add(1);
    let _ = write_durable(
        starts_path,
        format!("{target} {starts}\n").as_bytes(),
        0o600,
    );
    let interrupted = stage == "applying";
    if !interrupted && starts <= max_starts {
        return GuardAction::Counted { starts };
    }
    match restore(paths, prev) {
        Ok(()) => {
            let _ = fs::remove_file(marker_path);
            let _ = fs::remove_file(starts_path);
            write_outcome(paths, prev, target, attempts);
            GuardAction::RolledBack {
                to: prev.to_owned(),
            }
        }
        Err(f) => GuardAction::RollbackFailed {
            to: prev.to_owned(),
            why: f.refusal.to_string(),
        },
    }
}
