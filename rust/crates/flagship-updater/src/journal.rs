//! The update intent: what the updater is doing to `/opt/flagship`, written whole and fsynced at
//! each stage. A power loss between two stages leaves a file [`crate::recover::reconcile`] can
//! finish or undo; there is no state in which the box does not know what it was doing.
//!
//! Stages, in order: `staged` (the new release is on disk, the link is untouched), `switching`
//! (about to flip the link), `switched` (the link and every state file name the new release;
//! waiting for the daemon's health gate, which owns `update-pending.json`).

use crate::fsutil::{read_regular, write_durable};
use serde_json::{Map, Value};
use std::io;
use std::path::{Path, PathBuf};

pub const INTENT_FILE: &str = "update-intent.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Staged,
    Switching,
    Switched,
}

impl Phase {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Staged => "staged",
            Self::Switching => "switching",
            Self::Switched => "switched",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "staged" => Some(Self::Staged),
            "switching" => Some(Self::Switching),
            "switched" => Some(Self::Switched),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Intent {
    pub phase: Phase,
    pub commit: String,
    /// The release that was running when the intent began (the rollback target).
    pub previous: Option<String>,
    pub sequence: u64,
    pub at_ms: u64,
}

#[must_use]
pub fn path(state: &Path) -> PathBuf {
    state.join(INTENT_FILE)
}

impl Intent {
    /// Writes the intent durably.
    ///
    /// # Errors
    /// An I/O error.
    pub fn write(&self, state: &Path) -> io::Result<()> {
        let mut m = Map::new();
        m.insert("v".into(), Value::from(1u64));
        m.insert("phase".into(), Value::from(self.phase.as_str()));
        m.insert("commit".into(), Value::from(self.commit.clone()));
        m.insert(
            "previous".into(),
            self.previous.clone().map_or(Value::Null, Value::from),
        );
        m.insert("sequence".into(), Value::from(self.sequence));
        m.insert("at".into(), Value::from(self.at_ms));
        write_durable(&path(state), Value::Object(m).to_string().as_bytes(), 0o600)
    }

    /// The intent on disk; `None` when there is none or it cannot be read (the caller treats an
    /// unreadable intent as "unknown" and reconciles from the release link instead).
    #[must_use]
    pub fn read(state: &Path) -> Option<Self> {
        let v: Value = serde_json::from_str(&read_regular(&path(state))?).ok()?;
        let hex40 =
            |s: &str| s.len() == 40 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
        let commit = v.get("commit")?.as_str().filter(|c| hex40(c))?.to_owned();
        let previous = match v.get("previous") {
            Some(Value::String(p)) if hex40(p) => Some(p.clone()),
            Some(Value::Null) | None => None,
            _ => return None,
        };
        Some(Self {
            phase: Phase::parse(v.get("phase")?.as_str()?)?,
            commit,
            previous,
            sequence: v.get("sequence")?.as_u64()?,
            at_ms: v.get("at")?.as_u64()?,
        })
    }

    /// Removes the intent (an update finished or was undone).
    ///
    /// # Errors
    /// An I/O error other than "not there".
    pub fn clear(state: &Path) -> io::Result<()> {
        match std::fs::remove_file(path(state)) {
            Ok(()) => crate::fsutil::sync_dir(state),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
}
