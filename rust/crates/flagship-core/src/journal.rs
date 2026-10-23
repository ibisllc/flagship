//! The durable journal: desired state, an operation log written as intent before each effect and
//! completed with what was observed after it, adopted legacy workloads, handover checkpoints and
//! shadow-mode decisions. Every write checks the controller term it was opened under, so a writer
//! that lost the lock cannot write.

use flagship_runtime::plan::ExecutionPlan;
use flagship_runtime::{Digest, InstallationId};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum JournalError {
    #[error("journal store: {0}")]
    Store(String),
    #[error("another controller term ({0}) owns this journal")]
    Fenced(u64),
    #[error("journal content is invalid: {0}")]
    Corrupt(String),
}

fn store(e: rusqlite::Error) -> JournalError {
    JournalError::Store(e.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpKind {
    Pull,
    Create,
    Start,
    Stop,
    Delete,
}

impl OpKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pull => "pull",
            Self::Create => "create",
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Delete => "delete",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "pull" => Self::Pull,
            "create" => Self::Create,
            "start" => Self::Start,
            "stop" => Self::Stop,
            "delete" => Self::Delete,
            _ => return None,
        })
    }
    /// Effects that destroy something; an unknown outcome goes to inspection, never a retry.
    pub fn destructive(self) -> bool {
        matches!(self, Self::Stop | Self::Delete)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpState {
    Intent,
    Done,
    Failed,
    /// A non-destructive intent from an earlier life whose effect is not visible: safe to redo.
    Abandoned,
    /// A destructive intent whose outcome inspection could not establish. Blocks the
    /// installation until someone resolves it.
    NeedsReview,
}

impl OpState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Intent => "intent",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Abandoned => "abandoned",
            Self::NeedsReview => "needs-review",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "intent" => Self::Intent,
            "done" => Self::Done,
            "failed" => Self::Failed,
            "abandoned" => Self::Abandoned,
            "needs-review" => Self::NeedsReview,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Op {
    pub id: i64,
    pub installation: InstallationId,
    pub generation: u64,
    pub kind: OpKind,
    pub plan_digest: Option<Digest>,
    pub state: OpState,
    pub runtime_id: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Desired {
    pub plan: ExecutionPlan,
    pub digest: Digest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Adopted {
    pub installation: InstallationId,
    pub generation: u64,
    pub runtime_id: String,
    pub image: String,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS desired (
  installation TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  plan_json TEXT NOT NULL,
  plan_digest TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation TEXT NOT NULL,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pull','create','start','stop','delete')),
  plan_digest TEXT,
  state TEXT NOT NULL CHECK (state IN ('intent','done','failed','abandoned','needs-review')),
  runtime_id TEXT,
  detail TEXT,
  term INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ops_open ON ops (state) WHERE state IN ('intent','needs-review');
CREATE TABLE IF NOT EXISTS adopted (
  installation TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  runtime_id TEXT NOT NULL,
  image TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, taken_at INTEGER NOT NULL, body TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS shadow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  installation TEXT NOT NULL,
  decision TEXT NOT NULL
) STRICT;
INSERT OR IGNORE INTO meta (key, value) VALUES ('term', '0'), ('effects_enabled', '0');
";

#[derive(Debug)]
pub struct Journal {
    conn: Connection,
    term: u64,
}

fn i(v: u64) -> i64 {
    i64::try_from(v).unwrap_or(i64::MAX)
}
fn u(v: i64) -> u64 {
    u64::try_from(v).unwrap_or(0)
}

impl Journal {
    /// Open and take the next controller term. Call only while holding the [`crate::ControllerLock`].
    pub fn open(path: &Path) -> Result<Self, JournalError> {
        let conn = Connection::open(path).map_err(store)?;
        let mode: String = conn
            .pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0))
            .map_err(store)?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(JournalError::Store(format!("journal_mode is {mode}")));
        }
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(store)?;
        let sync: i64 = conn
            .pragma_query_value(None, "synchronous", |r| r.get(0))
            .map_err(store)?;
        if sync != 2 {
            return Err(JournalError::Store("synchronous is not FULL".into()));
        }
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(store)?;
        conn.execute_batch(SCHEMA).map_err(store)?;
        let mut j = Self { conn, term: 0 };
        let tx = j
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store)?;
        let term: u64 = tx
            .query_row("SELECT value FROM meta WHERE key = 'term'", [], |r| {
                r.get::<_, String>(0)
            })
            .map_err(store)?
            .parse::<u64>()
            .map_err(|e| JournalError::Corrupt(e.to_string()))?
            .saturating_add(1);
        tx.execute(
            "UPDATE meta SET value = ?1 WHERE key = 'term'",
            [term.to_string()],
        )
        .map_err(store)?;
        // A new controller starts with effects off until it has reconciled or completed handover.
        tx.commit().map_err(store)?;
        j.term = term;
        Ok(j)
    }

    pub fn term(&self) -> u64 {
        self.term
    }

    /// A write transaction that refuses to run if another controller took a later term.
    fn write(&mut self) -> Result<Transaction<'_>, JournalError> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store)?;
        let term: u64 = tx
            .query_row("SELECT value FROM meta WHERE key = 'term'", [], |r| {
                r.get::<_, String>(0)
            })
            .map_err(store)?
            .parse()
            .map_err(|e: std::num::ParseIntError| JournalError::Corrupt(e.to_string()))?;
        if term != self.term {
            return Err(JournalError::Fenced(term));
        }
        Ok(tx)
    }

    pub fn effects_enabled(&self) -> Result<bool, JournalError> {
        let v: String = self
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'effects_enabled'",
                [],
                |r| r.get(0),
            )
            .map_err(store)?;
        Ok(v == "1")
    }

    pub fn set_effects_enabled(&mut self, on: bool) -> Result<(), JournalError> {
        let tx = self.write()?;
        tx.execute(
            "UPDATE meta SET value = ?1 WHERE key = 'effects_enabled'",
            [if on { "1" } else { "0" }],
        )
        .map_err(store)?;
        tx.commit().map_err(store)
    }

    pub fn set_desired(&mut self, plan: &ExecutionPlan) -> Result<(), JournalError> {
        plan.validate()
            .map_err(|e| JournalError::Corrupt(e.to_string()))?;
        let json = plan
            .to_json()
            .map_err(|e| JournalError::Corrupt(e.to_string()))?;
        let tx = self.write()?;
        tx.execute(
            "INSERT INTO desired (installation, generation, plan_json, plan_digest) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (installation) DO UPDATE SET generation = excluded.generation, plan_json = excluded.plan_json, plan_digest = excluded.plan_digest",
            params![plan.installation.as_str(), i(plan.generation), json, plan.digest().to_string()],
        )
        .map_err(store)?;
        tx.commit().map_err(store)
    }

    pub fn remove_desired(&mut self, installation: &InstallationId) -> Result<(), JournalError> {
        let tx = self.write()?;
        tx.execute(
            "DELETE FROM desired WHERE installation = ?1",
            [installation.as_str()],
        )
        .map_err(store)?;
        tx.commit().map_err(store)
    }

    pub fn desired(&self) -> Result<Vec<Desired>, JournalError> {
        let mut st = self
            .conn
            .prepare("SELECT plan_json, plan_digest FROM desired ORDER BY installation")
            .map_err(store)?;
        let rows = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(store)?;
        let mut out = Vec::new();
        for row in rows {
            let (json, digest) = row.map_err(store)?;
            let plan = ExecutionPlan::from_json(json.as_bytes())
                .map_err(|e| JournalError::Corrupt(e.to_string()))?;
            let digest =
                Digest::parse(&digest).map_err(|e| JournalError::Corrupt(e.to_string()))?;
            if plan.digest() != digest {
                return Err(JournalError::Corrupt(format!(
                    "desired plan for {} does not match its digest",
                    plan.installation
                )));
            }
            out.push(Desired { plan, digest });
        }
        Ok(out)
    }

    /// Record that an effect is about to happen. Committed (fsynced) before the effect runs.
    pub fn intent(
        &mut self,
        inst: &InstallationId,
        generation: u64,
        kind: OpKind,
        plan: Option<Digest>,
        now: u64,
    ) -> Result<i64, JournalError> {
        let term = self.term;
        let tx = self.write()?;
        tx.execute(
            "INSERT INTO ops (installation, generation, kind, plan_digest, state, term, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'intent', ?5, ?6, ?6)",
            params![inst.as_str(), i(generation), kind.as_str(), plan.map(|d| d.to_string()), i(term), i(now)],
        )
        .map_err(store)?;
        let id = tx.last_insert_rowid();
        tx.commit().map_err(store)?;
        Ok(id)
    }

    pub fn settle(
        &mut self,
        op: i64,
        state: OpState,
        runtime_id: Option<&str>,
        detail: Option<&str>,
        now: u64,
    ) -> Result<(), JournalError> {
        let tx = self.write()?;
        tx.execute(
            "UPDATE ops SET state = ?2, runtime_id = COALESCE(?3, runtime_id), detail = ?4, updated_at = ?5 WHERE id = ?1",
            params![op, state.as_str(), runtime_id, detail, i(now)],
        )
        .map_err(store)?;
        tx.commit().map_err(store)
    }

    fn ops_where(&self, clause: &str) -> Result<Vec<Op>, JournalError> {
        let sql = format!(
            "SELECT id, installation, generation, kind, plan_digest, state, runtime_id, detail FROM ops WHERE {clause} ORDER BY id"
        );
        let mut st = self.conn.prepare(&sql).map_err(store)?;
        let rows = st
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<String>>(7)?,
                ))
            })
            .map_err(store)?;
        let mut out = Vec::new();
        for row in rows {
            let (id, inst, generation, kind, digest, state, runtime_id, detail) =
                row.map_err(store)?;
            let bad = |what: &str| JournalError::Corrupt(format!("op {id}: bad {what}"));
            out.push(Op {
                id,
                installation: InstallationId::parse(&inst).map_err(|_| bad("installation"))?,
                generation: u(generation),
                kind: OpKind::parse(&kind).ok_or_else(|| bad("kind"))?,
                plan_digest: digest
                    .map(|d| Digest::parse(&d))
                    .transpose()
                    .map_err(|_| bad("digest"))?,
                state: OpState::parse(&state).ok_or_else(|| bad("state"))?,
                runtime_id,
                detail,
            });
        }
        Ok(out)
    }

    pub fn pending(&self) -> Result<Vec<Op>, JournalError> {
        self.ops_where("state = 'intent'")
    }

    pub fn needs_review(&self) -> Result<Vec<Op>, JournalError> {
        self.ops_where("state = 'needs-review'")
    }

    pub fn all_ops(&self) -> Result<Vec<Op>, JournalError> {
        self.ops_where("1 = 1")
    }

    pub fn adopt(&mut self, a: &Adopted) -> Result<(), JournalError> {
        let tx = self.write()?;
        tx.execute(
            "INSERT INTO adopted (installation, generation, runtime_id, image) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (installation) DO UPDATE SET generation = excluded.generation, runtime_id = excluded.runtime_id, image = excluded.image",
            params![a.installation.as_str(), i(a.generation), a.runtime_id, a.image],
        )
        .map_err(store)?;
        tx.commit().map_err(store)
    }

    pub fn forget_adopted(&mut self, inst: &InstallationId) -> Result<(), JournalError> {
        let tx = self.write()?;
        tx.execute(
            "DELETE FROM adopted WHERE installation = ?1",
            [inst.as_str()],
        )
        .map_err(store)?;
        tx.commit().map_err(store)
    }

    pub fn adopted(&self, inst: &InstallationId) -> Result<Option<Adopted>, JournalError> {
        self.conn
            .query_row(
                "SELECT generation, runtime_id, image FROM adopted WHERE installation = ?1",
                [inst.as_str()],
                |r| {
                    Ok(Adopted {
                        installation: inst.clone(),
                        generation: u(r.get(0)?),
                        runtime_id: r.get(1)?,
                        image: r.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(store)
    }

    pub fn save_checkpoint(&mut self, body: &str, now: u64) -> Result<(), JournalError> {
        let tx = self.write()?;
        tx.execute(
            "INSERT INTO checkpoints (taken_at, body) VALUES (?1, ?2)",
            params![i(now), body],
        )
        .map_err(store)?;
        tx.commit().map_err(store)
    }

    pub fn record_shadow(
        &mut self,
        inst: &InstallationId,
        decision: &str,
        now: u64,
    ) -> Result<(), JournalError> {
        let tx = self.write()?;
        tx.execute(
            "INSERT INTO shadow (at, installation, decision) VALUES (?1, ?2, ?3)",
            params![i(now), inst.as_str(), decision],
        )
        .map_err(store)?;
        tx.commit().map_err(store)
    }

    pub fn shadow_decisions(&self) -> Result<Vec<(String, String)>, JournalError> {
        let mut st = self
            .conn
            .prepare("SELECT installation, decision FROM shadow ORDER BY id")
            .map_err(store)?;
        let rows = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(store)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(store)
    }
}
