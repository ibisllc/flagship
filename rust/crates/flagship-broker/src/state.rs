//! The broker's own durable state: per-scope revisions and admitted generations, consumed
//! capability ids, the revocation epoch, the volume registry and the installed network policies.
//! It lives outside app backups and rollback snapshots (IMPLEMENTATION-PLAN.md §4.3), and one
//! broker process holds it exclusively.

use crate::capability::Capability;
use flagship_runtime::{Digest, InstallationId, VolumeId};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    Revoked { epoch: u64, current: u64 },
    Replayed,
    Stale { expected: u64, found: u64 },
    Store(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScopeRow {
    pub revision: u64,
    pub admitted_generation: u64,
    pub admitted_plan: Option<Digest>,
    pub policy_digest: Option<Digest>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VolumeRow {
    pub volume_id: VolumeId,
    pub installation: InstallationId,
    pub name: String,
    pub ready: bool,
}

/// What admission records in the same transaction that consumes the capability.
#[derive(Debug, Clone)]
pub enum AdmitUpdate {
    Nothing,
    Generation {
        generation: u64,
        plan: Option<Digest>,
    },
    RegisterVolume {
        volume_id: VolumeId,
        installation: InstallationId,
        name: String,
    },
}

/// What a successful effect records afterwards.
#[derive(Debug, Clone)]
pub enum PostUpdate {
    Nothing,
    PolicyInstalled { scope: String, digest: Digest },
    VolumeReady { volume_id: VolumeId },
}

#[derive(Debug)]
pub struct BrokerState {
    conn: Connection,
}

fn store(e: rusqlite::Error) -> Refusal {
    Refusal::Store(e.to_string())
}

fn to_i64(v: u64) -> i64 {
    i64::try_from(v).unwrap_or(i64::MAX)
}

fn to_u64(v: i64) -> u64 {
    u64::try_from(v).unwrap_or(0)
}

fn digest_col(s: Option<String>) -> Option<Digest> {
    s.and_then(|t| Digest::parse(&t).ok())
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS scopes (
  scope TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  admitted_generation INTEGER NOT NULL DEFAULT 0,
  admitted_plan TEXT,
  policy_digest TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS consumed (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS epoch (k INTEGER PRIMARY KEY CHECK (k = 1), value INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS volumes (
  volume_id TEXT PRIMARY KEY,
  installation TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  ready INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  op TEXT NOT NULL,
  scope TEXT NOT NULL,
  capability TEXT NOT NULL,
  outcome TEXT NOT NULL
) STRICT;
INSERT OR IGNORE INTO epoch (k, value) VALUES (1, 0);
";

impl BrokerState {
    pub fn open(path: &Path) -> Result<Self, Refusal> {
        let conn = Connection::open(path).map_err(store)?;
        conn.pragma_update(None, "locking_mode", "EXCLUSIVE")
            .map_err(store)?;
        let mode: String = conn
            .pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0))
            .map_err(store)?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(Refusal::Store(format!("journal_mode is {mode}, not wal")));
        }
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(store)?;
        let sync: i64 = conn
            .pragma_query_value(None, "synchronous", |r| r.get(0))
            .map_err(store)?;
        if sync != 2 {
            return Err(Refusal::Store("synchronous is not FULL".into()));
        }
        conn.execute_batch(SCHEMA).map_err(store)?;
        Ok(Self { conn })
    }

    pub fn epoch(&self) -> Result<u64, Refusal> {
        self.conn
            .query_row("SELECT value FROM epoch WHERE k = 1", [], |r| {
                r.get::<_, i64>(0)
            })
            .map(to_u64)
            .map_err(store)
    }

    pub fn is_consumed(&self, id: &str) -> Result<bool, Refusal> {
        let seen: Option<i64> = self
            .conn
            .query_row("SELECT 1 FROM consumed WHERE id = ?1", [id], |r| r.get(0))
            .optional()
            .map_err(store)?;
        Ok(seen.is_some())
    }

    pub fn scope(&self, scope: &str) -> Result<ScopeRow, Refusal> {
        let row = self
            .conn
            .query_row("SELECT revision, admitted_generation, admitted_plan, policy_digest FROM scopes WHERE scope = ?1", [scope], |r| {
                Ok(ScopeRow {
                    revision: to_u64(r.get(0)?),
                    admitted_generation: to_u64(r.get(1)?),
                    admitted_plan: digest_col(r.get(2)?),
                    policy_digest: digest_col(r.get(3)?),
                })
            })
            .optional()
            .map_err(store)?;
        Ok(row.unwrap_or_default())
    }

    fn volume_where(&self, sql: &str, key: &str) -> Result<Option<VolumeRow>, Refusal> {
        self.conn
            .query_row(sql, [key], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .optional()
            .map_err(store)?
            .map(|(v, i, n, ready)| {
                Ok(VolumeRow {
                    volume_id: VolumeId::parse(&v).map_err(|e| Refusal::Store(e.to_string()))?,
                    installation: InstallationId::parse(&i)
                        .map_err(|e| Refusal::Store(e.to_string()))?,
                    name: n,
                    ready: ready != 0,
                })
            })
            .transpose()
    }

    pub fn volume(&self, id: &VolumeId) -> Result<Option<VolumeRow>, Refusal> {
        self.volume_where(
            "SELECT volume_id, installation, name, ready FROM volumes WHERE volume_id = ?1",
            id.as_str(),
        )
    }

    pub fn volume_of(&self, installation: &InstallationId) -> Result<Option<VolumeRow>, Refusal> {
        self.volume_where(
            "SELECT volume_id, installation, name, ready FROM volumes WHERE installation = ?1",
            installation.as_str(),
        )
    }

    /// Consume the capability and move the scope's revision on, in one durable transaction,
    /// before any effect runs. A crash after this leaves the capability spent: a retry needs a
    /// fresh one issued against the new revision, so no effect can be applied twice by replay.
    pub fn admit(
        &mut self,
        cap: &Capability,
        scope: &str,
        now: u64,
        update: &AdmitUpdate,
    ) -> Result<i64, Refusal> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store)?;
        let current: u64 = to_u64(
            tx.query_row("SELECT value FROM epoch WHERE k = 1", [], |r| r.get(0))
                .map_err(store)?,
        );
        if cap.revocation_epoch < current {
            return Err(Refusal::Revoked {
                epoch: cap.revocation_epoch,
                current,
            });
        }
        let seen: Option<i64> = tx
            .query_row("SELECT 1 FROM consumed WHERE id = ?1", [&cap.id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(store)?;
        if seen.is_some() {
            return Err(Refusal::Replayed);
        }
        let revision: u64 = tx
            .query_row(
                "SELECT revision FROM scopes WHERE scope = ?1",
                [scope],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .map_err(store)?
            .map_or(0, to_u64);
        if revision != cap.expected_prior_revision {
            return Err(Refusal::Stale {
                expected: cap.expected_prior_revision,
                found: revision,
            });
        }
        let next = to_i64(revision.saturating_add(1));
        tx.execute(
            "INSERT INTO consumed (id, expires_at) VALUES (?1, ?2)",
            params![cap.id, to_i64(cap.expires_at)],
        )
        .map_err(store)?;
        tx.execute(
            "UPDATE epoch SET value = ?1 WHERE k = 1 AND value < ?1",
            [to_i64(cap.revocation_epoch)],
        )
        .map_err(store)?;
        tx.execute(
            "INSERT INTO scopes (scope, revision) VALUES (?1, ?2) ON CONFLICT (scope) DO UPDATE SET revision = excluded.revision",
            params![scope, next],
        )
        .map_err(store)?;
        match update {
            AdmitUpdate::Nothing => {}
            AdmitUpdate::Generation { generation, plan } => {
                tx.execute(
                    "UPDATE scopes SET admitted_generation = ?2, admitted_plan = ?3 WHERE scope = ?1",
                    params![scope, to_i64(*generation), plan.map(|d| d.to_string())],
                )
                .map_err(store)?;
            }
            AdmitUpdate::RegisterVolume {
                volume_id,
                installation,
                name,
            } => {
                tx.execute(
                    "INSERT INTO volumes (volume_id, installation, name, ready) VALUES (?1, ?2, ?3, 0) ON CONFLICT (volume_id) DO NOTHING",
                    params![volume_id.as_str(), installation.as_str(), name],
                )
                .map_err(store)?;
            }
        }
        tx.execute(
            "INSERT INTO effects (at, op, scope, capability, outcome) VALUES (?1, ?2, ?3, ?4, 'admitted')",
            params![to_i64(now), cap.op.as_str(), scope, cap.id],
        )
        .map_err(store)?;
        let id = tx.last_insert_rowid();
        tx.execute(
            "DELETE FROM consumed WHERE expires_at < ?1",
            [to_i64(now.saturating_sub(24 * 3600))],
        )
        .map_err(store)?;
        tx.commit().map_err(store)?;
        Ok(id)
    }

    pub fn finish(&mut self, effect: i64, outcome: &str, post: &PostUpdate) -> Result<(), Refusal> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store)?;
        tx.execute(
            "UPDATE effects SET outcome = ?2 WHERE id = ?1",
            params![effect, outcome],
        )
        .map_err(store)?;
        match post {
            PostUpdate::Nothing => {}
            PostUpdate::PolicyInstalled { scope, digest } => {
                tx.execute(
                    "UPDATE scopes SET policy_digest = ?2 WHERE scope = ?1",
                    params![scope, digest.to_string()],
                )
                .map_err(store)?;
            }
            PostUpdate::VolumeReady { volume_id } => {
                tx.execute(
                    "UPDATE volumes SET ready = 1 WHERE volume_id = ?1",
                    [volume_id.as_str()],
                )
                .map_err(store)?;
            }
        }
        tx.commit().map_err(store)
    }

    /// Move the epoch forward (never back). Returns the epoch now in force.
    pub fn advance_epoch(&mut self, epoch: u64) -> Result<u64, Refusal> {
        self.conn
            .execute(
                "UPDATE epoch SET value = ?1 WHERE k = 1 AND value < ?1",
                [to_i64(epoch)],
            )
            .map_err(store)?;
        self.epoch()
    }

    pub fn effect_outcomes(&self) -> Result<Vec<(String, String)>, Refusal> {
        let mut st = self
            .conn
            .prepare("SELECT op, outcome FROM effects ORDER BY id")
            .map_err(store)?;
        let rows = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(store)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(store)
    }
}
