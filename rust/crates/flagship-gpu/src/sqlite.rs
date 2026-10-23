//! SQLite journal. Every mutation is one `BEGIN IMMEDIATE` transaction with
//! `synchronous=FULL`, so a crash leaves either the old or the new state.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

use crate::ids::LocalDeviceId;
use crate::journal::{
    AllocationRecord, AllocationState, DeviceClaim, Finish, JournalError, JournalStore,
    TopologyState,
};
use crate::policy::{AllocationId, Holding, admissible};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS allocations (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS holdings (
    device TEXT NOT NULL,
    partition TEXT NOT NULL,
    allocation_id TEXT NOT NULL REFERENCES allocations(id),
    holding TEXT NOT NULL,
    PRIMARY KEY (device, partition, allocation_id)
);
CREATE TABLE IF NOT EXISTS quarantined_devices (
    device TEXT PRIMARY KEY,
    reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS topology (
    k INTEGER PRIMARY KEY CHECK (k = 1),
    generation INTEGER NOT NULL,
    reconciled INTEGER NOT NULL,
    fingerprint TEXT NOT NULL
);
INSERT OR IGNORE INTO topology (k, generation, reconciled, fingerprint) VALUES (1, 0, 0, '');
";

#[derive(Debug)]
pub struct SqliteJournal {
    conn: Mutex<Connection>,
}

fn storage(e: impl std::fmt::Display) -> JournalError {
    JournalError::Storage(e.to_string())
}

fn to_json<T: serde::Serialize>(v: &T) -> Result<String, JournalError> {
    serde_json::to_string(v).map_err(storage)
}

fn from_json<T: serde::de::DeserializeOwned>(s: &str) -> Result<T, JournalError> {
    serde_json::from_str(s).map_err(storage)
}

fn partition_key(claim: &DeviceClaim) -> String {
    claim
        .partition
        .as_ref()
        .map(ToString::to_string)
        .unwrap_or_default()
}

impl SqliteJournal {
    pub fn open(path: &Path) -> Result<Self, JournalError> {
        Self::init(Connection::open(path).map_err(storage)?)
    }

    pub fn open_in_memory() -> Result<Self, JournalError> {
        Self::init(Connection::open_in_memory().map_err(storage)?)
    }

    fn init(conn: Connection) -> Result<Self, JournalError> {
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(storage)?;
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(storage)?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(storage)?;
        conn.execute_batch(SCHEMA).map_err(storage)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, JournalError> {
        self.conn
            .lock()
            .map_err(|_| JournalError::Storage("journal lock poisoned".into()))
    }

    fn load(tx: &Transaction<'_>, id: &AllocationId) -> Result<AllocationRecord, JournalError> {
        let rec: Option<String> = tx
            .query_row(
                "SELECT record FROM allocations WHERE id = ?1",
                [id.as_str()],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage)?;
        from_json(&rec.ok_or_else(|| JournalError::NotFound(id.clone()))?)
    }

    fn save(tx: &Transaction<'_>, rec: &AllocationRecord) -> Result<(), JournalError> {
        tx.execute(
            "UPDATE allocations SET state = ?2, record = ?3 WHERE id = ?1",
            params![rec.id.as_str(), rec.state.as_str(), to_json(rec)?],
        )
        .map_err(storage)?;
        Ok(())
    }

    fn holdings_tx(
        tx: &Transaction<'_>,
        device: &LocalDeviceId,
    ) -> Result<Vec<Holding>, JournalError> {
        let mut st = tx
            .prepare("SELECT holding FROM holdings WHERE device = ?1 ORDER BY allocation_id")
            .map_err(storage)?;
        let rows = st
            .query_map([device.as_str()], |r| r.get::<_, String>(0))
            .map_err(storage)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(from_json(&r.map_err(storage)?)?);
        }
        Ok(out)
    }

    fn topology_tx(tx: &Transaction<'_>) -> Result<TopologyState, JournalError> {
        tx.query_row(
            "SELECT generation, reconciled, fingerprint FROM topology WHERE k = 1",
            [],
            |r| {
                Ok(TopologyState {
                    generation: r.get::<_, i64>(0)?.try_into().unwrap_or(0),
                    reconciled: r.get::<_, i64>(1)?.try_into().unwrap_or(0),
                    fingerprint: r.get(2)?,
                })
            },
        )
        .map_err(storage)
    }

    fn begin(conn: &mut Connection) -> Result<Transaction<'_>, JournalError> {
        conn.transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)
    }
}

fn expect(rec: &AllocationRecord, from: AllocationState) -> Result<(), JournalError> {
    if rec.state != from {
        return Err(JournalError::StateConflict {
            expected: from,
            actual: rec.state,
        });
    }
    Ok(())
}

fn i64_of(v: u64) -> i64 {
    i64::try_from(v).unwrap_or(i64::MAX)
}

impl JournalStore for SqliteJournal {
    fn create(&self, rec: &AllocationRecord) -> Result<(), JournalError> {
        let mut c = self.lock()?;
        let tx = Self::begin(&mut c)?;
        let exists: Option<i64> = tx
            .query_row(
                "SELECT seq FROM allocations WHERE id = ?1",
                [rec.id.as_str()],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage)?;
        if exists.is_some() {
            return Err(JournalError::Duplicate(rec.id.clone()));
        }
        tx.execute(
            "INSERT INTO allocations (id, state, record) VALUES (?1, ?2, ?3)",
            params![rec.id.as_str(), rec.state.as_str(), to_json(rec)?],
        )
        .map_err(storage)?;
        tx.commit().map_err(storage)
    }

    fn get(&self, id: &AllocationId) -> Result<Option<AllocationRecord>, JournalError> {
        let c = self.lock()?;
        let rec: Option<String> = c
            .query_row(
                "SELECT record FROM allocations WHERE id = ?1",
                [id.as_str()],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage)?;
        rec.map(|s| from_json(&s)).transpose()
    }

    fn list_open(&self) -> Result<Vec<AllocationRecord>, JournalError> {
        let c = self.lock()?;
        let mut st = c
            .prepare("SELECT record FROM allocations WHERE state NOT IN ('released', 'quarantined') ORDER BY seq")
            .map_err(storage)?;
        let rows = st
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(storage)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(from_json(&r.map_err(storage)?)?);
        }
        Ok(out)
    }

    fn transition(
        &self,
        id: &AllocationId,
        from: AllocationState,
        to: AllocationState,
        reason: Option<&str>,
    ) -> Result<AllocationRecord, JournalError> {
        if !from.can_transition_to(to)
            || matches!(to, AllocationState::Reserved)
            || to.is_terminal()
        {
            return Err(JournalError::IllegalTransition { from, to });
        }
        let mut c = self.lock()?;
        let tx = Self::begin(&mut c)?;
        let mut rec = Self::load(&tx, id)?;
        expect(&rec, from)?;
        rec.state = to;
        if let Some(r) = reason {
            rec.reason = Some(r.to_owned());
        }
        rec.revision = rec.revision.saturating_add(1);
        Self::save(&tx, &rec)?;
        tx.commit().map_err(storage)?;
        Ok(rec)
    }

    fn reserve(
        &self,
        id: &AllocationId,
        claims: &[DeviceClaim],
        device_memory: &[(LocalDeviceId, u64)],
        topology_generation: u64,
    ) -> Result<AllocationRecord, JournalError> {
        let mut c = self.lock()?;
        let tx = Self::begin(&mut c)?;
        let mut rec = Self::load(&tx, id)?;
        expect(&rec, AllocationState::Admitted)?;
        let topo = Self::topology_tx(&tx)?;
        if topo.generation != topo.reconciled || topo.generation != topology_generation {
            return Err(JournalError::ReconcileRequired);
        }
        for (i, claim) in claims.iter().enumerate() {
            if claims.iter().take(i).any(|c| c.device == claim.device) {
                return Err(JournalError::Conflict {
                    device: claim.device.clone(),
                    conflict: crate::policy::Conflict::Held(id.clone()),
                });
            }
            let q: Option<String> = tx
                .query_row(
                    "SELECT reason FROM quarantined_devices WHERE device = ?1",
                    [claim.device.as_str()],
                    |r| r.get(0),
                )
                .optional()
                .map_err(storage)?;
            if q.is_some() {
                return Err(JournalError::Conflict {
                    device: claim.device.clone(),
                    conflict: crate::policy::Conflict::Quarantined,
                });
            }
            let total = device_memory
                .iter()
                .find(|(d, _)| *d == claim.device)
                .map(|(_, m)| *m)
                .ok_or_else(|| JournalError::UnknownDevice(claim.device.clone()))?;
            let existing = Self::holdings_tx(&tx, &claim.device)?;
            let holding = rec.holding(claim);
            admissible(&existing, &holding, total).map_err(|conflict| JournalError::Conflict {
                device: claim.device.clone(),
                conflict,
            })?;
            tx.execute(
                "INSERT INTO holdings (device, partition, allocation_id, holding) VALUES (?1, ?2, ?3, ?4)",
                params![claim.device.as_str(), partition_key(claim), id.as_str(), to_json(&holding)?],
            )
            .map_err(storage)?;
        }
        rec.state = AllocationState::Reserved;
        rec.claims = claims.to_vec();
        rec.topology_generation = topology_generation;
        rec.revision = rec.revision.saturating_add(1);
        Self::save(&tx, &rec)?;
        tx.commit().map_err(storage)?;
        Ok(rec)
    }

    fn finish(
        &self,
        id: &AllocationId,
        from: AllocationState,
        how: &Finish,
    ) -> Result<AllocationRecord, JournalError> {
        let to = match how {
            Finish::Released => AllocationState::Released,
            Finish::Quarantined { .. } => AllocationState::Quarantined,
        };
        if !from.can_transition_to(to) {
            return Err(JournalError::IllegalTransition { from, to });
        }
        let mut c = self.lock()?;
        let tx = Self::begin(&mut c)?;
        let mut rec = Self::load(&tx, id)?;
        expect(&rec, from)?;
        if let Finish::Quarantined { devices, reason } = how {
            for d in devices {
                tx.execute(
                    "INSERT OR REPLACE INTO quarantined_devices (device, reason) VALUES (?1, ?2)",
                    params![d.as_str(), reason],
                )
                .map_err(storage)?;
            }
            rec.reason = Some(reason.clone());
        }
        tx.execute(
            "DELETE FROM holdings WHERE allocation_id = ?1",
            [id.as_str()],
        )
        .map_err(storage)?;
        rec.state = to;
        rec.revision = rec.revision.saturating_add(1);
        Self::save(&tx, &rec)?;
        tx.commit().map_err(storage)?;
        Ok(rec)
    }

    fn heartbeat(&self, id: &AllocationId, now_ms: u64) -> Result<(), JournalError> {
        let mut c = self.lock()?;
        let tx = Self::begin(&mut c)?;
        let mut rec = Self::load(&tx, id)?;
        rec.last_heartbeat_ms = Some(now_ms);
        Self::save(&tx, &rec)?;
        tx.commit().map_err(storage)
    }

    fn holdings(&self, device: &LocalDeviceId) -> Result<Vec<Holding>, JournalError> {
        let mut c = self.lock()?;
        let tx = Self::begin(&mut c)?;
        Self::holdings_tx(&tx, device)
    }

    fn quarantined(&self) -> Result<Vec<(LocalDeviceId, String)>, JournalError> {
        let c = self.lock()?;
        let mut st = c
            .prepare("SELECT device, reason FROM quarantined_devices ORDER BY device")
            .map_err(storage)?;
        let rows = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(storage)?;
        let mut out = Vec::new();
        for r in rows {
            let (d, reason) = r.map_err(storage)?;
            let d = LocalDeviceId::parse(&d).ok_or_else(|| storage("bad device id in journal"))?;
            out.push((d, reason));
        }
        Ok(out)
    }

    fn clear_quarantine(
        &self,
        device: &LocalDeviceId,
        maintenance_ref: &str,
    ) -> Result<(), JournalError> {
        if maintenance_ref.is_empty() {
            return Err(storage("clearing a quarantine needs a maintenance order"));
        }
        let mut c = self.lock()?;
        let tx = Self::begin(&mut c)?;
        tx.execute(
            "DELETE FROM quarantined_devices WHERE device = ?1",
            [device.as_str()],
        )
        .map_err(storage)?;
        tx.commit().map_err(storage)
    }

    fn topology(&self) -> Result<TopologyState, JournalError> {
        let mut c = self.lock()?;
        let tx = Self::begin(&mut c)?;
        Self::topology_tx(&tx)
    }

    fn record_topology(&self, fingerprint: &str) -> Result<TopologyState, JournalError> {
        let mut c = self.lock()?;
        let tx = Self::begin(&mut c)?;
        let mut t = Self::topology_tx(&tx)?;
        if t.fingerprint != fingerprint {
            let first = t.fingerprint.is_empty() && t.generation == 0;
            t.generation = t.generation.saturating_add(1);
            // The first inventory a fresh journal sees has nothing to reconcile.
            if first {
                t.reconciled = t.generation;
            }
            fingerprint.clone_into(&mut t.fingerprint);
            tx.execute(
                "UPDATE topology SET generation = ?1, reconciled = ?2, fingerprint = ?3 WHERE k = 1",
                params![i64_of(t.generation), i64_of(t.reconciled), fingerprint],
            )
            .map_err(storage)?;
        }
        tx.commit().map_err(storage)?;
        Ok(t)
    }

    fn mark_reconciled(&self, generation: u64) -> Result<(), JournalError> {
        let mut c = self.lock()?;
        let tx = Self::begin(&mut c)?;
        tx.execute(
            "UPDATE topology SET reconciled = ?1 WHERE k = 1 AND generation = ?1",
            [i64_of(generation)],
        )
        .map_err(storage)?;
        tx.commit().map_err(storage)
    }
}
