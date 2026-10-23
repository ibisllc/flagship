//! Docker and Podman adapters. Both drive the engine's CLI by absolute path with an argv this
//! module generates from a [`ResolvedWorkload`]; nothing the caller wrote reaches the argv except
//! through a validated type. The hardening is the same as `AppRunner.deploy` in
//! packages/server-daemon/src/serviceRunner.ts (see tests/docker_argv.rs for the comparison).

use crate::engine::{EngineCapabilities, ObservedWorkload, Runtime, RuntimeEvent, WorkloadState};
use crate::error::RuntimeError;
use crate::exec::{Exec, ExecOutput, Executor};
use crate::ids::{Digest, InstallationId, WorkloadName};
use crate::plan::{ImageSpec, RestartPolicy};
use crate::workload::{
    APPS_BRIDGE, DATA_HOST_ALIAS, FILES_MOUNT, FilesVolumeName, LABEL_GENERATION,
    LABEL_INSTALLATION, LABEL_PLAN, ResolvedMount, ResolvedNetwork, ResolvedWorkload,
};
use serde_json::Value;
use std::time::Duration;

/// gVisor (docs/app-runtimes.md §5.1, `appSandbox/gvisor.ts` GVISOR_RUNTIME).
pub const SANDBOX_RUNTIME: &str = "runsc";
const MIB: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Docker,
    Podman,
}

impl Engine {
    pub fn binary(self) -> &'static str {
        match self {
            Self::Docker => "/usr/bin/docker",
            Self::Podman => "/usr/bin/podman",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Docker => "docker",
            Self::Podman => "podman",
        }
    }
}

#[derive(Debug)]
pub struct OciCli<E: Executor> {
    engine: Engine,
    executor: E,
}

fn megabytes(bytes: u64) -> String {
    if bytes.is_multiple_of(MIB) {
        format!("{}m", bytes / MIB)
    } else {
        format!("{bytes}b")
    }
}

/// `--cpus` the way serviceRunner writes it: "1.0", "0.5", "2.25".
fn cpus(millis: u32) -> String {
    let whole = millis / 1000;
    let frac = millis % 1000;
    if frac == 0 {
        return format!("{whole}.0");
    }
    let digits = format!("{frac:03}");
    format!("{whole}.{}", digits.trim_end_matches('0'))
}

/// The argv of `create` for a resolved workload. Pure, so it can be compared to fixtures.
pub fn create_argv(w: &ResolvedWorkload) -> Vec<String> {
    let mut a: Vec<String> = vec!["create".into(), "--name".into(), w.name.as_str().into()];
    for (k, v) in [
        (LABEL_INSTALLATION, w.installation.to_string()),
        (LABEL_GENERATION, w.generation.to_string()),
        (LABEL_PLAN, w.plan_digest.to_string()),
    ] {
        a.push("--label".into());
        a.push(format!("{k}={v}"));
    }
    a.push("--pull=never".into());
    a.push(format!("--runtime={SANDBOX_RUNTIME}"));
    a.push("--cap-drop=ALL".into());
    a.push("--security-opt=no-new-privileges".into());
    match &w.network {
        ResolvedNetwork::None => {
            a.push("--network".into());
            a.push("none".into());
        }
        ResolvedNetwork::Apps { sandbox } => {
            a.push("--network".into());
            a.push(APPS_BRIDGE.into());
            match sandbox {
                Some(s) => {
                    a.push("--dns".into());
                    a.push(s.gateway.to_string());
                    a.push("--add-host".into());
                    a.push(format!("{DATA_HOST_ALIAS}:{}", s.gateway));
                    if let Some(r) = &s.resolv {
                        a.push("--mount".into());
                        a.push(format!(
                            "type=bind,src={},dst=/etc/resolv.conf,readonly",
                            r.path()
                        ));
                    }
                }
                None => {
                    a.push("--add-host".into());
                    a.push(format!("{DATA_HOST_ALIAS}:host-gateway"));
                }
            }
        }
    }
    a.push("--memory".into());
    a.push(megabytes(w.resources.memory_bytes));
    a.push("--cpus".into());
    a.push(cpus(w.resources.cpu_millis));
    a.push("--pids-limit".into());
    a.push(w.resources.pids_limit.to_string());
    for cap in &w.linux_capabilities {
        a.push("--cap-add".into());
        a.push(cap.as_str().into());
    }
    a.push("--read-only".into());
    a.push("--tmpfs".into());
    a.push(format!(
        "/tmp:rw,size={}",
        megabytes(w.resources.tmpfs_bytes)
    ));
    if let RestartPolicy::OnFailure { max_retries } = w.restart {
        a.push(format!("--restart=on-failure:{max_retries}"));
    }
    for (k, v) in &w.env {
        a.push("-e".into());
        a.push(format!("{k}={v}"));
    }
    if let Some(p) = w.publish {
        a.push("-p".into());
        a.push(format!("127.0.0.1:{}:{}", p.host_port, p.container_port));
    }
    for m in &w.mounts {
        match m {
            ResolvedMount::FilesVolume { volume, read_only } => {
                a.push("--mount".into());
                a.push(format!(
                    "type=volume,src={},dst={FILES_MOUNT}{}",
                    volume.as_str(),
                    if *read_only { ",readonly" } else { "" }
                ));
            }
        }
    }
    a.push(w.image_reference.clone());
    a
}

fn classify(op: &'static str, out: &ExecOutput) -> Result<String, RuntimeError> {
    if out.timed_out {
        return Err(RuntimeError::TimedOut { op });
    }
    match out.code {
        Some(0) => Ok(out.stdout.clone()),
        None => Err(RuntimeError::Spawn(
            out.stderr.trim().chars().take(600).collect(),
        )),
        Some(code) => {
            let text = out.stderr.to_ascii_lowercase();
            if text.contains("no such container")
                || text.contains("no such object")
                || text.contains("no container with name")
            {
                return Err(RuntimeError::NotFound);
            }
            if text.contains("is already in use") || text.contains("conflict") {
                return Err(RuntimeError::Conflict);
            }
            let tail: Vec<&str> = out.stderr.trim().lines().rev().take(4).collect();
            let detail: String = tail
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join(" | ")
                .chars()
                .take(600)
                .collect();
            Err(RuntimeError::Engine {
                op,
                code: Some(code),
                detail,
            })
        }
    }
}

fn parse_err(op: &'static str, e: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::Parse {
        op,
        detail: e.to_string(),
    }
}

fn label_map(v: Option<&Value>) -> Vec<(String, String)> {
    match v {
        Some(Value::Object(m)) => m
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned())))
            .collect(),
        // `docker ps --format {{json .}}` writes labels as "k=v,k=v". Our values never hold commas.
        Some(Value::String(s)) => s
            .split(',')
            .filter_map(|kv| kv.split_once('='))
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect(),
        _ => Vec::new(),
    }
}

fn first_name(v: Option<&Value>) -> Option<String> {
    let raw = match v {
        Some(Value::String(s)) => s.split(',').next().map(str::to_owned),
        Some(Value::Array(a)) => a.first().and_then(Value::as_str).map(str::to_owned),
        _ => None,
    }?;
    Some(raw.trim_start_matches('/').to_owned())
}

fn str_field<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| v.get(*k).and_then(Value::as_str))
}

/// One observed workload from a `ps` row or an `inspect` object, or `None` if it is not one of
/// ours. Labels are trusted only when all three agree with the name.
pub fn observed_from(v: &Value) -> Option<ObservedWorkload> {
    let name = first_name(v.get("Names").or_else(|| v.get("Name")))?;
    let wname = WorkloadName::for_installation(
        &InstallationId::parse(name.strip_prefix("flagship-")?).ok()?,
    );
    if wname.as_str() != name {
        return None;
    }
    let installation = wname.installation()?;
    let config = v.get("Config");
    let labels = label_map(
        v.get("Labels")
            .or_else(|| config.and_then(|c| c.get("Labels"))),
    );
    let label = |k: &str| {
        labels
            .iter()
            .find(|(lk, _)| lk == k)
            .map(|(_, v)| v.as_str())
    };
    let labelled = label(LABEL_INSTALLATION) == Some(installation.as_str());
    let generation = if labelled {
        label(LABEL_GENERATION)
            .and_then(|g| g.parse::<u64>().ok())
            .filter(|g| *g > 0)
    } else {
        None
    };
    let plan_digest = if labelled {
        label(LABEL_PLAN).and_then(|d| Digest::parse(d).ok())
    } else {
        None
    };
    let state = v
        .get("State")
        .and_then(|s| {
            s.as_str()
                .or_else(|| s.get("Status").and_then(Value::as_str))
        })
        .map_or(WorkloadState::Unknown, WorkloadState::parse);
    let image = str_field(v, &["Image", "ImageName"])
        .or_else(|| config.and_then(|c| str_field(c, &["Image"])))
        .unwrap_or_default()
        .to_owned();
    let runtime_id = str_field(v, &["ID", "Id"]).unwrap_or_default().to_owned();
    if runtime_id.is_empty() {
        return None;
    }
    Some(ObservedWorkload {
        runtime_id,
        name: wname,
        installation,
        generation,
        plan_digest,
        image,
        state,
    })
}

impl<E: Executor> OciCli<E> {
    pub fn new(engine: Engine, executor: E) -> Self {
        Self { engine, executor }
    }

    pub fn engine(&self) -> Engine {
        self.engine
    }

    fn run(
        &self,
        op: &'static str,
        args: Vec<String>,
        timeout: Duration,
    ) -> Result<String, RuntimeError> {
        let out = self.executor.run(&Exec {
            file: self.engine.binary(),
            args,
            timeout,
            input: None,
        });
        classify(op, &out)
    }

    fn rows(&self, op: &'static str, text: &str) -> Result<Vec<Value>, RuntimeError> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        if trimmed.starts_with('[') {
            let v: Value = serde_json::from_str(trimmed).map_err(|e| parse_err(op, e))?;
            return Ok(v.as_array().cloned().unwrap_or_default());
        }
        trimmed
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).map_err(|e| parse_err(op, e)))
            .collect()
    }
}

fn s(x: &str) -> String {
    x.to_owned()
}

impl<E: Executor> Runtime for OciCli<E> {
    fn inspect_capabilities(&self) -> Result<EngineCapabilities, RuntimeError> {
        let fmt = match self.engine {
            Engine::Docker => s("{{json .}}"),
            Engine::Podman => s("json"),
        };
        let text = self.run(
            "info",
            vec![s("info"), s("--format"), fmt],
            Duration::from_secs(60),
        )?;
        let v: Value = serde_json::from_str(text.trim()).map_err(|e| parse_err("info", e))?;
        Ok(match self.engine {
            Engine::Docker => EngineCapabilities {
                engine: self.engine.name(),
                version: str_field(&v, &["ServerVersion"])
                    .unwrap_or_default()
                    .to_owned(),
                runsc: v
                    .get("Runtimes")
                    .and_then(|r| r.get(SANDBOX_RUNTIME))
                    .is_some(),
                rootless: v
                    .get("SecurityOptions")
                    .and_then(Value::as_array)
                    .is_some_and(|a| {
                        a.iter()
                            .any(|o| o.as_str().is_some_and(|s| s.contains("name=rootless")))
                    }),
                cdi: v
                    .get("CDISpecDirs")
                    .and_then(Value::as_array)
                    .is_some_and(|a| !a.is_empty()),
            },
            Engine::Podman => EngineCapabilities {
                engine: self.engine.name(),
                version: v
                    .get("version")
                    .and_then(|x| str_field(x, &["Version"]))
                    .unwrap_or_default()
                    .to_owned(),
                // Podman reports only its default runtime; anything else is treated as absent.
                runsc: v
                    .get("host")
                    .and_then(|h| h.get("ociRuntime"))
                    .and_then(|r| str_field(r, &["name"]))
                    == Some(SANDBOX_RUNTIME),
                rootless: v
                    .get("host")
                    .and_then(|h| h.get("security"))
                    .and_then(|x| x.get("rootless"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                cdi: false,
            },
        })
    }

    fn prepare_image(&self, image: &ImageSpec) -> Result<(), RuntimeError> {
        let reference = format!("{}@{}", image.repository, image.platform_manifest_digest);
        self.run(
            "pull",
            vec![s("pull"), reference],
            Duration::from_secs(20 * 60),
        )
        .map(|_| ())
    }

    fn ensure_files_volume(
        &self,
        volume: &FilesVolumeName,
        installation: &InstallationId,
    ) -> Result<(), RuntimeError> {
        let device = volume.bind_device();
        let inspect = self.run(
            "volume inspect",
            vec![
                s("volume"),
                s("inspect"),
                s("-f"),
                s("{{index .Options \"device\"}}"),
                volume.as_str().to_owned(),
            ],
            Duration::from_secs(60),
        );
        match inspect {
            Ok(found) if found.trim() == device => return Ok(()),
            Ok(_) => {
                return Err(RuntimeError::Refused(format!(
                    "{} exists but is not bound to its image",
                    volume.as_str()
                )));
            }
            Err(RuntimeError::NotFound) => {}
            Err(RuntimeError::Engine { detail, .. })
                if detail.to_ascii_lowercase().contains("no such volume") => {}
            Err(e) => return Err(e),
        }
        let args = vec![
            s("volume"),
            s("create"),
            s("--driver"),
            s("local"),
            s("--opt"),
            s("type=none"),
            s("--opt"),
            s("o=bind"),
            s("--opt"),
            format!("device={device}"),
            s("--label"),
            format!("{LABEL_INSTALLATION}={installation}"),
            s("--label"),
            s("flagship.quota=loop"),
            volume.as_str().to_owned(),
        ];
        self.run("volume create", args, Duration::from_secs(60))
            .map(|_| ())
    }

    fn create(&self, w: &ResolvedWorkload) -> Result<String, RuntimeError> {
        let id = self.run("create", create_argv(w), Duration::from_secs(120))?;
        Ok(id.trim().to_owned())
    }

    fn start(&self, name: &WorkloadName) -> Result<(), RuntimeError> {
        self.run(
            "start",
            vec![s("start"), name.as_str().to_owned()],
            Duration::from_secs(120),
        )
        .map(|_| ())
    }

    fn stop(&self, name: &WorkloadName, grace_secs: u32) -> Result<(), RuntimeError> {
        let grace = grace_secs.min(300);
        let timeout = Duration::from_secs(u64::from(grace).saturating_add(30));
        self.run(
            "stop",
            vec![
                s("stop"),
                s("-t"),
                grace.to_string(),
                name.as_str().to_owned(),
            ],
            timeout,
        )
        .map(|_| ())
    }

    fn inspect(&self, name: &WorkloadName) -> Result<Option<ObservedWorkload>, RuntimeError> {
        match self.run(
            "inspect",
            vec![
                s("inspect"),
                s("--type"),
                s("container"),
                name.as_str().to_owned(),
            ],
            Duration::from_secs(60),
        ) {
            Ok(text) => Ok(self.rows("inspect", &text)?.iter().find_map(observed_from)),
            Err(RuntimeError::NotFound) => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn list(&self) -> Result<Vec<ObservedWorkload>, RuntimeError> {
        let fmt = match self.engine {
            Engine::Docker => s("{{json .}}"),
            Engine::Podman => s("json"),
        };
        let text = self.run(
            "ps",
            vec![
                s("ps"),
                s("-a"),
                s("--no-trunc"),
                s("--filter"),
                s("name=flagship-"),
                s("--format"),
                fmt,
            ],
            Duration::from_secs(60),
        )?;
        Ok(self
            .rows("ps", &text)?
            .iter()
            .filter_map(observed_from)
            .collect())
    }

    fn events(&self, since_unix: u64, until_unix: u64) -> Result<Vec<RuntimeEvent>, RuntimeError> {
        let fmt = match self.engine {
            Engine::Docker => s("{{json .}}"),
            Engine::Podman => s("json"),
        };
        let args = vec![
            s("events"),
            s("--since"),
            since_unix.to_string(),
            s("--until"),
            until_unix.to_string(),
            s("--filter"),
            s("type=container"),
            s("--format"),
            fmt,
        ];
        let text = self.run("events", args, Duration::from_secs(60))?;
        let mut out = Vec::new();
        for v in self.rows("events", &text)? {
            let attrs = v
                .get("Actor")
                .and_then(|a| a.get("Attributes"))
                .or_else(|| v.get("Attributes"));
            let installation = attrs
                .and_then(|a| a.get(LABEL_INSTALLATION))
                .and_then(Value::as_str)
                .and_then(|s| InstallationId::parse(s).ok());
            let action = str_field(&v, &["Action", "status", "Status"])
                .unwrap_or_default()
                .to_owned();
            let runtime_id = str_field(&v, &["id", "ID"])
                .or_else(|| v.get("Actor").and_then(|a| str_field(a, &["ID"])))
                .unwrap_or_default()
                .to_owned();
            let time_unix = v
                .get("time")
                .or_else(|| v.get("Time"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            out.push(RuntimeEvent {
                time_unix,
                action,
                runtime_id,
                installation,
            });
        }
        Ok(out)
    }

    fn logs(&self, name: &WorkloadName, tail: u32) -> Result<String, RuntimeError> {
        let tail = tail.clamp(1, 10_000);
        let out = self.executor.run(&Exec {
            file: self.engine.binary(),
            args: vec![
                s("logs"),
                s("--tail"),
                tail.to_string(),
                name.as_str().to_owned(),
            ],
            timeout: Duration::from_secs(60),
            input: None,
        });
        classify("logs", &out)?;
        Ok(format!("{}{}", out.stdout, out.stderr))
    }

    fn delete(&self, name: &WorkloadName) -> Result<(), RuntimeError> {
        self.run(
            "rm",
            vec![s("rm"), name.as_str().to_owned()],
            Duration::from_secs(60),
        )
        .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_and_memory_render_like_service_runner() {
        assert_eq!(cpus(1000), "1.0");
        assert_eq!(cpus(4000), "4.0");
        assert_eq!(cpus(500), "0.5");
        assert_eq!(cpus(2250), "2.25");
        assert_eq!(megabytes(512 * MIB), "512m");
        assert_eq!(megabytes(64 * MIB), "64m");
    }
}
