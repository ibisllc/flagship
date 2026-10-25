//! The driver maintenance pipeline (§9.3, G01): a driver change is host
//! maintenance, never something an app can start. One owner-ordered
//! maintenance at a time moves through
//!
//! ```text
//! proposed → staged → draining → installed (reboot) → verifying → committed
//!                                         ↘ rolling-back (reboot) → rolled-back | failed
//! ```
//!
//! - **proposed**: the target driver is in the verified catalog for this
//!   backend and this exact kernel, and its packages are pinned by digest.
//! - **staged**: every package is fetched and its SHA-256 matches the
//!   catalog; nothing is installed yet.
//! - **draining**: GPU admission pauses and every allocation drains. CPU
//!   apps keep running.
//! - **installed**: the previous package versions are recorded, the new
//!   ones installed, and a reboot requested.
//! - **verifying** (after the reboot): the driver the device reports is the
//!   target, the module is signed when Secure Boot enforces signing, the
//!   catalog qualifies the device again, and a numerical smoke test passes.
//!   Then admission resumes on the new driver.
//! - Any failed check rolls back to the recorded versions and reboots; a
//!   rollback that can't be verified leaves admission paused (`failed`).
//!
//! Every state is written to SQLite before the step it names runs, so a
//! crash or the reboot itself resumes where it was.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::catalog::{DriverPackage, HostFacts, VerifiedCatalog};
use crate::device::Backend;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MaintState {
    Proposed,
    Staged,
    Draining,
    Installed,
    Verifying,
    Committed,
    RollingBack,
    RolledBack,
    Failed,
}

impl MaintState {
    pub fn is_final(self) -> bool {
        matches!(self, Self::Committed | Self::RolledBack | Self::Failed)
    }

    /// Admission stays paused from draining until a final state says
    /// otherwise.
    pub fn pauses_admission(self) -> bool {
        matches!(
            self,
            Self::Draining | Self::Installed | Self::Verifying | Self::RollingBack | Self::Failed
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedPackage {
    pub name: String,
    pub version: String,
    pub path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceRecord {
    pub id: String,
    /// The owner's signed maintenance order this runs under.
    pub order_ref: String,
    pub backend: Backend,
    pub catalog_serial: u64,
    pub entry_id: String,
    pub target_driver: String,
    pub packages: Vec<DriverPackage>,
    pub staged: Vec<StagedPackage>,
    /// `(name, version)` installed before the change.
    pub previous: Vec<(String, String)>,
    pub previous_driver: Option<String>,
    pub state: MaintState,
    pub reason: Option<String>,
    pub history: Vec<(MaintState, String)>,
}

/// The host package manager and boot facts, behind a trait so the
/// simulated host can stand in for apt/dpkg, mokutil and `reboot`.
pub trait HostPackages: Send + Sync + std::fmt::Debug {
    fn installed(&self, names: &[String]) -> Result<Vec<(String, String)>, String>;
    /// Download one package into the root-owned staging directory.
    fn fetch(&self, pkg: &DriverPackage, dir: &Path) -> Result<PathBuf, String>;
    fn sha256(&self, path: &Path) -> Result<String, String>;
    fn install_files(&self, files: &[PathBuf]) -> Result<(), String>;
    /// Reinstall exact versions (the rollback set) from the package cache.
    fn install_versions(&self, pkgs: &[(String, String)]) -> Result<(), String>;
    fn request_reboot(&self) -> Result<(), String>;
    /// `modinfo -F signer <module>` of the vendor's kernel module.
    fn module_signer(&self, _module: &str) -> Option<String> {
        None
    }
}

/// Shares one package manager between the service and its maintenance.
#[derive(Clone, Debug)]
pub struct SharedPackages(pub std::sync::Arc<dyn HostPackages>);

impl HostPackages for SharedPackages {
    fn installed(&self, names: &[String]) -> Result<Vec<(String, String)>, String> {
        self.0.installed(names)
    }
    fn fetch(&self, pkg: &DriverPackage, dir: &Path) -> Result<PathBuf, String> {
        self.0.fetch(pkg, dir)
    }
    fn sha256(&self, path: &Path) -> Result<String, String> {
        self.0.sha256(path)
    }
    fn install_files(&self, files: &[PathBuf]) -> Result<(), String> {
        self.0.install_files(files)
    }
    fn install_versions(&self, pkgs: &[(String, String)]) -> Result<(), String> {
        self.0.install_versions(pkgs)
    }
    fn request_reboot(&self) -> Result<(), String> {
        self.0.request_reboot()
    }
    fn module_signer(&self, module: &str) -> Option<String> {
        self.0.module_signer(module)
    }
}

/// What the box measured after the reboot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PostBoot {
    pub host: HostFacts,
    /// The driver every device of the backend now reports.
    pub drivers: Vec<String>,
    /// `modinfo -F signer` of the vendor module, when one is loaded.
    pub module_signer: Option<String>,
    /// The catalog qualified every device of the backend again.
    pub qualified: Result<(), String>,
    /// The numerical smoke test (vector add) on one device.
    pub smoke: Result<(), String>,
}

/// One owner-ordered driver change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    /// The owner's signed maintenance order.
    pub order_ref: String,
    pub backend: Backend,
    pub driver: String,
    /// The driver the devices report now (the rollback target).
    pub current_driver: Option<String>,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum MaintError {
    #[error("{0}")]
    Refused(String),
    #[error("maintenance is {0:?}; that step doesn't apply")]
    WrongState(MaintState),
    #[error("storage: {0}")]
    Storage(String),
}

fn storage(e: impl std::fmt::Display) -> MaintError {
    MaintError::Storage(e.to_string())
}

#[derive(Debug)]
pub struct MaintenanceStore {
    conn: Mutex<Connection>,
}

impl MaintenanceStore {
    pub fn open(path: &Path) -> Result<Self, MaintError> {
        Self::init(Connection::open(path).map_err(storage)?)
    }

    pub fn open_in_memory() -> Result<Self, MaintError> {
        Self::init(Connection::open_in_memory().map_err(storage)?)
    }

    fn init(conn: Connection) -> Result<Self, MaintError> {
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(storage)?;
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(storage)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS driver_maintenance (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                record TEXT NOT NULL
            );",
        )
        .map_err(storage)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, MaintError> {
        self.conn.lock().map_err(|_| storage("lock poisoned"))
    }

    pub fn latest(&self) -> Result<Option<MaintenanceRecord>, MaintError> {
        let c = self.lock()?;
        let r: Option<String> = c
            .query_row(
                "SELECT record FROM driver_maintenance ORDER BY seq DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage)?;
        r.map(|s| serde_json::from_str(&s).map_err(storage))
            .transpose()
    }

    fn save(&self, rec: &MaintenanceRecord) -> Result<(), MaintError> {
        let c = self.lock()?;
        let text = serde_json::to_string(rec).map_err(storage)?;
        c.execute(
            "INSERT INTO driver_maintenance (id, record) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET record = excluded.record",
            params![rec.id, text],
        )
        .map_err(storage)?;
        Ok(())
    }
}

#[derive(Debug)]
pub struct DriverMaintenance<P: HostPackages> {
    store: MaintenanceStore,
    packages: P,
    staging: PathBuf,
    arch: String,
}

impl<P: HostPackages> DriverMaintenance<P> {
    pub fn new(
        store: MaintenanceStore,
        packages: P,
        staging: impl Into<PathBuf>,
        arch: &str,
    ) -> Self {
        Self {
            store,
            packages,
            staging: staging.into(),
            arch: arch.to_owned(),
        }
    }

    pub fn packages(&self) -> &P {
        &self.packages
    }

    pub fn current(&self) -> Result<Option<MaintenanceRecord>, MaintError> {
        self.store.latest()
    }

    /// The reason admission is paused, if maintenance pauses it.
    pub fn admission_pause(&self) -> Result<Option<String>, MaintError> {
        Ok(self.current()?.and_then(|r| {
            r.state.pauses_admission().then(|| match r.state {
                MaintState::Failed => format!(
                    "driver maintenance failed: {}",
                    r.reason.unwrap_or_default()
                ),
                _ => format!("driver maintenance to {} is running", r.target_driver),
            })
        }))
    }

    fn step(
        &self,
        rec: &mut MaintenanceRecord,
        to: MaintState,
        note: &str,
    ) -> Result<(), MaintError> {
        rec.state = to;
        rec.history.push((to, note.to_owned()));
        self.store.save(rec)
    }

    fn active(&self, want: &[MaintState]) -> Result<MaintenanceRecord, MaintError> {
        let rec = self
            .current()?
            .ok_or_else(|| MaintError::Refused("no driver maintenance is running".into()))?;
        if !want.contains(&rec.state) {
            return Err(MaintError::WrongState(rec.state));
        }
        Ok(rec)
    }

    /// Start a maintenance to `driver`, which the catalog must list for this
    /// backend and this kernel with pinned packages for this architecture.
    pub fn propose(
        &self,
        p: &Proposal,
        catalog: &VerifiedCatalog,
        host: &HostFacts,
    ) -> Result<MaintenanceRecord, MaintError> {
        let Proposal {
            id,
            order_ref,
            backend,
            driver,
            current_driver,
        } = p;
        let (backend, driver) = (*backend, driver.as_str());
        if order_ref.is_empty() {
            return Err(MaintError::Refused(
                "driver maintenance needs the owner's maintenance order".into(),
            ));
        }
        if let Some(r) = self.current()?
            && !r.state.is_final()
        {
            return Err(MaintError::Refused(format!(
                "maintenance {} is still {:?}",
                r.id, r.state
            )));
        }
        if catalog.revoked(backend, driver).is_some() {
            return Err(MaintError::Refused(format!(
                "driver {driver} is withdrawn by an advisory"
            )));
        }
        let entry = catalog
            .entries()
            .iter()
            .find(|e| {
                e.backend == backend
                    && e.drivers.iter().any(|d| d == driver)
                    && e.kernels.contains(&host.kernel)
            })
            .ok_or_else(|| {
                MaintError::Refused(format!(
                    "the catalog qualifies no {backend} driver {driver} on kernel {}",
                    host.kernel
                ))
            })?;
        let packages: Vec<DriverPackage> = entry
            .driver_packages
            .iter()
            .filter(|p| p.arch == self.arch)
            .cloned()
            .collect();
        if packages.is_empty() {
            return Err(MaintError::Refused(format!(
                "the catalog pins no {} packages for this driver",
                self.arch
            )));
        }
        let mut rec = MaintenanceRecord {
            id: id.clone(),
            order_ref: order_ref.clone(),
            backend,
            catalog_serial: catalog.serial(),
            entry_id: entry.id.clone(),
            target_driver: driver.to_owned(),
            packages,
            staged: Vec::new(),
            previous: Vec::new(),
            previous_driver: current_driver.clone(),
            state: MaintState::Proposed,
            reason: None,
            history: Vec::new(),
        };
        self.step(&mut rec, MaintState::Proposed, "proposed")?;
        Ok(rec)
    }

    /// Fetch and check every package; a digest mismatch ends the
    /// maintenance with nothing installed.
    pub fn stage(&self) -> Result<MaintenanceRecord, MaintError> {
        let mut rec = self.active(&[MaintState::Proposed])?;
        let mut staged = Vec::new();
        for p in &rec.packages {
            let fetched = self
                .packages
                .fetch(p, &self.staging)
                .and_then(|path| self.packages.sha256(&path).map(|d| (path, d)));
            match fetched {
                Ok((path, digest)) if digest == p.sha256 => staged.push(StagedPackage {
                    name: p.name.clone(),
                    version: p.version.clone(),
                    path,
                }),
                Ok(_) => {
                    rec.reason = Some(format!("{} does not match its pinned digest", p.name));
                    self.step(
                        &mut rec,
                        MaintState::RolledBack,
                        "digest mismatch; nothing installed",
                    )?;
                    return Ok(rec);
                }
                Err(e) => {
                    rec.reason = Some(format!("{} could not be fetched: {e}", p.name));
                    self.step(
                        &mut rec,
                        MaintState::RolledBack,
                        "fetch failed; nothing installed",
                    )?;
                    return Ok(rec);
                }
            }
        }
        rec.staged = staged;
        self.step(
            &mut rec,
            MaintState::Staged,
            "every package matches the catalog",
        )?;
        Ok(rec)
    }

    /// Admission pauses here; the caller drains every allocation.
    pub fn begin_drain(&self) -> Result<MaintenanceRecord, MaintError> {
        let mut rec = self.active(&[MaintState::Staged])?;
        self.step(&mut rec, MaintState::Draining, "admission paused")?;
        Ok(rec)
    }

    /// Install once nothing holds a device of this backend.
    pub fn install(&self, open_allocations: usize) -> Result<MaintenanceRecord, MaintError> {
        let mut rec = self.active(&[MaintState::Draining])?;
        if open_allocations > 0 {
            return Err(MaintError::Refused(format!(
                "{open_allocations} GPU allocations are still open; wait for them to drain"
            )));
        }
        let names: Vec<String> = rec.packages.iter().map(|p| p.name.clone()).collect();
        rec.previous = self
            .packages
            .installed(&names)
            .map_err(MaintError::Refused)?;
        self.store.save(&rec)?;
        let files: Vec<PathBuf> = rec.staged.iter().map(|s| s.path.clone()).collect();
        if let Err(e) = self.packages.install_files(&files) {
            rec.reason = Some(format!("install failed: {e}"));
            return self.roll_back(rec);
        }
        self.step(
            &mut rec,
            MaintState::Installed,
            "installed; reboot requested",
        )?;
        self.packages
            .request_reboot()
            .map_err(MaintError::Refused)?;
        Ok(rec)
    }

    fn roll_back(&self, mut rec: MaintenanceRecord) -> Result<MaintenanceRecord, MaintError> {
        self.step(&mut rec, MaintState::RollingBack, "rolling back")?;
        if rec.previous.is_empty() {
            self.step(
                &mut rec,
                MaintState::Failed,
                "no previous packages to restore",
            )?;
            return Ok(rec);
        }
        if let Err(e) = self.packages.install_versions(&rec.previous) {
            rec.reason = Some(format!(
                "{}; rollback install failed: {e}",
                rec.reason.clone().unwrap_or_default()
            ));
            self.step(&mut rec, MaintState::Failed, "rollback failed")?;
            return Ok(rec);
        }
        self.packages
            .request_reboot()
            .map_err(MaintError::Refused)?;
        Ok(rec)
    }

    /// Run after the reboot, with what the box measured.
    pub fn after_boot(
        &self,
        facts: &PostBoot,
        secure_boot_signer: Option<&str>,
    ) -> Result<MaintenanceRecord, MaintError> {
        let mut rec = self.active(&[
            MaintState::Installed,
            MaintState::Verifying,
            MaintState::RollingBack,
        ])?;
        let rolling_back = rec.state == MaintState::RollingBack;
        if !rolling_back {
            self.step(&mut rec, MaintState::Verifying, "verifying after reboot")?;
        }
        let want = if rolling_back {
            rec.previous_driver.clone().unwrap_or_default()
        } else {
            rec.target_driver.clone()
        };
        let mut why = Vec::new();
        if facts.drivers.is_empty() || facts.drivers.iter().any(|d| *d != want) {
            why.push(format!(
                "devices report {:?}, expected {want}",
                facts.drivers
            ));
        }
        if facts.host.module_signing_enforced {
            match (facts.module_signer.as_deref(), secure_boot_signer) {
                (None, _) => why.push(
                    "the driver module is unsigned while Secure Boot enforces signing".into(),
                ),
                (Some(s), Some(enrolled)) if s != enrolled => {
                    why.push("the driver module is not signed by the box's enrolled key".into());
                }
                _ => {}
            }
        }
        if let Err(e) = &facts.qualified {
            why.push(format!("not qualified: {e}"));
        }
        if let Err(e) = &facts.smoke {
            why.push(format!("smoke test failed: {e}"));
        }
        if why.is_empty() {
            let to = if rolling_back {
                MaintState::RolledBack
            } else {
                MaintState::Committed
            };
            self.step(&mut rec, to, "verified")?;
            return Ok(rec);
        }
        rec.reason = Some(why.join("; "));
        if rolling_back {
            self.step(
                &mut rec,
                MaintState::Failed,
                "the restored driver did not verify",
            )?;
            return Ok(rec);
        }
        self.roll_back(rec)
    }
}
