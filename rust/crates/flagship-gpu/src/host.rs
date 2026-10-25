//! The real host's adapters for `flagship-gpud`: the container engine as
//! [`WorkloadRuntime`] and [`PidOwner`], the scrub image as [`ScrubRunner`],
//! and apt/dpkg/systemd as [`HostPackages`]. Every command is an absolute
//! path with fixed arguments (`provider::run_fixed`); the only values that
//! reach an argv are validated allocation ids, CDI names, VFIO group
//! numbers, digest-pinned image references and catalog package pins.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::attach::{ALLOCATION_LABEL, RuntimeNames};
use crate::catalog::{DriverPackage, ResetKind, is_pinned_reference, sha256_hex};
use crate::coop::PidOwner;
use crate::device::{DeviceRecord, PartitionId, Vendor};
use crate::ids::LocalDeviceId;
use crate::maintenance::HostPackages;
use crate::manager::{Presence, WorkloadRuntime};
use crate::policy::AllocationId;
use crate::provider::{Tool, ToolRunner, run_fixed};
use crate::scrub::{ScrubReport, ScrubRunner};
use crate::vfio::VfioHost;

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| (*x).to_owned()).collect()
}

/// Podman or Docker, found by absolute path.
#[derive(Clone, Debug)]
pub struct EngineRuntime {
    pub engine: PathBuf,
    pub timeout: Duration,
    pub proc_root: PathBuf,
}

impl EngineRuntime {
    fn ids(&self, id: &AllocationId) -> Option<Vec<String>> {
        let filter = format!("label={ALLOCATION_LABEL}={id}");
        let (ok, out) = run_fixed(
            &self.engine,
            &[s(&["ps", "-a", "-q", "--filter"]), vec![filter]].concat(),
            self.timeout,
        )
        .ok()?;
        ok.then(|| {
            out.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && l.bytes().all(|b| b.is_ascii_hexdigit()))
                .map(str::to_owned)
                .collect()
        })
    }
}

impl WorkloadRuntime for EngineRuntime {
    fn presence(&self, id: &AllocationId) -> Presence {
        let filter = format!("label={ALLOCATION_LABEL}={id}");
        match run_fixed(
            &self.engine,
            &[
                s(&["ps", "-a", "--filter"]),
                vec![filter],
                s(&["--format", "{{.State}}"]),
            ]
            .concat(),
            self.timeout,
        ) {
            Ok((true, out)) => {
                let live = out.lines().map(str::trim).any(|st| {
                    matches!(
                        st,
                        "running" | "created" | "paused" | "restarting" | "stopping"
                    )
                });
                if live {
                    Presence::Present
                } else {
                    Presence::Absent
                }
            }
            _ => Presence::Unknown,
        }
    }

    fn stop(&self, id: &AllocationId) -> Result<(), String> {
        let ids = self.ids(id).ok_or("the engine did not list containers")?;
        for c in ids {
            let _ = run_fixed(
                &self.engine,
                &[s(&["stop", "-t", "10"]), vec![c.clone()]].concat(),
                self.timeout,
            );
            let _ = run_fixed(
                &self.engine,
                &[s(&["rm", "-f"]), vec![c]].concat(),
                self.timeout,
            );
        }
        Ok(())
    }
}

impl PidOwner for EngineRuntime {
    fn allocation_of(&self, pid: u32) -> Option<AllocationId> {
        let cg = fs::read_to_string(self.proc_root.join(format!("{pid}/cgroup"))).ok()?;
        let cid = cg
            .split(['/', '-', '.'])
            .find(|p| p.len() == 64 && p.bytes().all(|b| b.is_ascii_hexdigit()))?
            .to_owned();
        let fmt = format!("{{{{index .Config.Labels \"{ALLOCATION_LABEL}\"}}}}");
        let (ok, out) = run_fixed(
            &self.engine,
            &[s(&["inspect", "--format"]), vec![fmt, cid]].concat(),
            self.timeout,
        )
        .ok()?;
        ok.then(|| AllocationId::new(out.trim())).flatten()
    }
}

/// Where and how a device's scrub runs, set from its catalog entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScrubTarget {
    pub image: String,
    /// The CDI name for gVisor; `None` runs the scrub in a VM over VFIO.
    pub cdi_device: Option<String>,
    pub partition_cdi: BTreeMap<String, String>,
}

/// The scrub image under the device's qualified isolation profile.
#[derive(Debug)]
pub struct EngineScrubRunner {
    pub engine: PathBuf,
    pub names: RuntimeNames,
    pub tools: Arc<dyn ToolRunner>,
    pub vfio: VfioHost,
    pub timeout: Duration,
    targets: Mutex<BTreeMap<LocalDeviceId, ScrubTarget>>,
}

impl EngineScrubRunner {
    pub fn new(
        engine: PathBuf,
        names: RuntimeNames,
        tools: Arc<dyn ToolRunner>,
        vfio: VfioHost,
    ) -> Self {
        Self {
            engine,
            names,
            tools,
            vfio,
            timeout: Duration::from_secs(600),
            targets: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn set_target(&self, device: &LocalDeviceId, t: ScrubTarget) {
        if let Ok(mut m) = self.targets.lock() {
            m.insert(device.clone(), t);
        }
    }

    fn target(&self, device: &LocalDeviceId) -> Option<ScrubTarget> {
        self.targets.lock().ok()?.get(device).cloned()
    }
}

impl ScrubRunner for EngineScrubRunner {
    fn reset(
        &self,
        device: &DeviceRecord,
        _p: Option<&PartitionId>,
        kind: ResetKind,
    ) -> Result<(), String> {
        match (kind, device.vendor) {
            (ResetKind::None | ResetKind::MigRecreate, _) => Ok(()),
            (ResetKind::Flr, Vendor::Nvidia) => self
                .tools
                .output(&Tool::NvidiaSmiReset(device.pci.clone()))
                .map(|_| ())
                .map_err(|e| e.to_string()),
            (ResetKind::Flr, _) => {
                let q = self.vfio.qualify(device).map_err(|w| w.join("; "))?;
                let b = self.vfio.bind(&q)?;
                self.vfio.release(&b)
            }
        }
    }

    fn scrub(
        &self,
        device: &DeviceRecord,
        partition: Option<&PartitionId>,
    ) -> Result<ScrubReport, String> {
        let t = self
            .target(&device.id)
            .ok_or("no scrub image is qualified for this device")?;
        if !is_pinned_reference(&t.image) {
            return Err("the scrub image is not digest-pinned".into());
        }
        let mut args = s(&[
            "run",
            "--rm",
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
        ]);
        let mut binding = None;
        match &t.cdi_device {
            Some(cdi) => {
                let name = match partition {
                    Some(p) => t
                        .partition_cdi
                        .get(&p.to_string())
                        .ok_or("no CDI name for that partition")?
                        .clone(),
                    None => cdi.clone(),
                };
                args.push(format!("--runtime={}", self.names.gvisor_gpu));
                args.push("--device".into());
                args.push(name);
            }
            None => {
                let q = self.vfio.qualify(device).map_err(|w| w.join("; "))?;
                let b = self.vfio.bind(&q)?;
                args.push(format!("--runtime={}", self.names.vm));
                args.push("--device".into());
                args.push(b.device_node());
                binding = Some(b);
            }
        }
        args.push(t.image.clone());
        let out = run_fixed(&self.engine, &args, self.timeout);
        if let Some(b) = binding {
            self.vfio.release(&b)?;
        }
        match out {
            Ok((true, text)) => {
                serde_json::from_str(text.trim()).map_err(|_| "the scrub printed no report".into())
            }
            _ => Err("the scrub image failed".into()),
        }
    }

    fn configure(
        &self,
        device: &DeviceRecord,
        entry: &crate::catalog::CatalogEntry,
        profile: crate::provider::IsolationProfile,
    ) {
        let Some(image) = entry.images.iter().find(|i| i.purpose == "scrub") else {
            return;
        };
        let gvisor = profile == crate::provider::IsolationProfile::GvisorNvproxy;
        let kind = device.backend.cdi_kind();
        self.set_target(
            &device.id,
            ScrubTarget {
                image: image.reference.clone(),
                cdi_device: gvisor.then(|| format!("{kind}={}", device.cdi_name)),
                partition_cdi: device
                    .partitions
                    .iter()
                    .map(|p| (p.id.to_string(), format!("{kind}={}", p.cdi_name)))
                    .collect(),
            },
        );
    }
}

/// apt/dpkg on Debian, systemd for the reboot.
#[derive(Clone, Debug)]
pub struct AptPackages {
    pub apt_get: PathBuf,
    pub dpkg: PathBuf,
    pub dpkg_query: PathBuf,
    pub systemctl: PathBuf,
    pub timeout: Duration,
}

impl Default for AptPackages {
    fn default() -> Self {
        Self {
            apt_get: "/usr/bin/apt-get".into(),
            dpkg: "/usr/bin/dpkg".into(),
            dpkg_query: "/usr/bin/dpkg-query".into(),
            systemctl: "/usr/bin/systemctl".into(),
            timeout: Duration::from_secs(1800),
        }
    }
}

fn pkg_ok(n: &str) -> bool {
    !n.is_empty()
        && n.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"+-.:~".contains(&b))
}

impl HostPackages for AptPackages {
    fn installed(&self, names: &[String]) -> Result<Vec<(String, String)>, String> {
        let mut out = Vec::new();
        for n in names.iter().filter(|n| pkg_ok(n)) {
            if let Ok((true, v)) = run_fixed(
                &self.dpkg_query,
                &[s(&["-W", "-f=${Version}"]), vec![n.clone()]].concat(),
                self.timeout,
            ) {
                let v = v.trim();
                if !v.is_empty() {
                    out.push((n.clone(), v.to_owned()));
                }
            }
        }
        Ok(out)
    }

    fn fetch(&self, pkg: &DriverPackage, dir: &Path) -> Result<PathBuf, String> {
        if !pkg_ok(&pkg.name) || !pkg_ok(&pkg.version) {
            return Err("package pin is malformed".into());
        }
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let before: Vec<_> = fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .collect();
        let spec = format!("{}={}", pkg.name, pkg.version);
        let dir_opt = format!("-oDir::Cache::archives={}", dir.display());
        let (ok, _) = run_fixed(
            &self.apt_get,
            &[s(&["download", "-q"]), vec![dir_opt, spec]].concat(),
            self.timeout,
        )
        .map_err(|_| "apt-get could not run".to_owned())?;
        if !ok {
            return Err("apt-get download failed".into());
        }
        let prefix = format!("{}_", pkg.name);
        fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| {
                !before.contains(p)
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with(&prefix) && n.ends_with(".deb"))
            })
            .or_else(|| {
                fs::read_dir(dir)
                    .ok()?
                    .filter_map(Result::ok)
                    .map(|e| e.path())
                    .find(|p| {
                        p.file_name()
                            .and_then(|n| n.to_str())
                            .is_some_and(|n| n.starts_with(&prefix) && n.ends_with(".deb"))
                    })
            })
            .ok_or_else(|| "the downloaded package was not found".into())
    }

    fn sha256(&self, path: &Path) -> Result<String, String> {
        Ok(sha256_hex(&fs::read(path).map_err(|e| e.to_string())?))
    }

    fn install_files(&self, files: &[PathBuf]) -> Result<(), String> {
        let mut args = s(&["--install"]);
        args.extend(files.iter().map(|f| f.display().to_string()));
        match run_fixed(&self.dpkg, &args, self.timeout) {
            Ok((true, _)) => Ok(()),
            _ => Err("dpkg --install failed".into()),
        }
    }

    fn install_versions(&self, pkgs: &[(String, String)]) -> Result<(), String> {
        let mut args = s(&[
            "install",
            "-y",
            "-q",
            "--allow-downgrades",
            "--no-install-recommends",
        ]);
        for (n, v) in pkgs {
            if !pkg_ok(n) || !pkg_ok(v) {
                return Err("package pin is malformed".into());
            }
            args.push(format!("{n}={v}"));
        }
        match run_fixed(&self.apt_get, &args, self.timeout) {
            Ok((true, _)) => Ok(()),
            _ => Err("apt-get install of the previous versions failed".into()),
        }
    }

    fn request_reboot(&self) -> Result<(), String> {
        match run_fixed(
            &self.systemctl,
            &s(&["reboot", "--no-block"]),
            Duration::from_secs(30),
        ) {
            Ok((true, _)) => Ok(()),
            _ => Err("systemctl reboot failed".into()),
        }
    }
}
