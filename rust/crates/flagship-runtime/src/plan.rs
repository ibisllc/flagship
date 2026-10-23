//! The ExecutionPlan (IMPLEMENTATION-PLAN.md §4.3): everything an approval binds, normalised so
//! one digest names exactly one workload. A plan carries references (volume IDs, secret handles,
//! a network-policy digest), never host paths, command lines, mounts or hooks: the broker resolves
//! the references itself and an adapter generates the argv.

use crate::error::PlanError;
use crate::hex;
use crate::ids::{Digest, EnvName, InstallationId, Repository, SecretHandle, VolumeId};
use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub const PLAN_SCHEMA: u32 = 1;
pub const PLAN_TAG: &str = "flagship/execution-plan/v1";
pub const MAX_PLAN_BYTES: usize = 256 * 1024;
const MIB: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionPlan {
    pub schema: u32,
    pub installation: InstallationId,
    pub generation: u64,
    pub image: ImageSpec,
    pub manifest_digest: Digest,
    pub capabilities: EffectiveCapabilities,
    pub resources: Resources,
    #[serde(default)]
    pub volumes: Vec<VolumeClaim>,
    pub network_policy_digest: Digest,
    #[serde(default, deserialize_with = "unique_env")]
    pub environment: BTreeMap<EnvName, String>,
    #[serde(default)]
    pub secrets: Vec<SecretRef>,
    pub health: HealthPolicy,
    pub restart: RestartPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_claim: Option<DeviceClaim>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageSpec {
    pub repository: Repository,
    /// The multi-platform index the publisher signed.
    pub index_digest: Digest,
    /// The one platform manifest selected from it; this is what the engine runs.
    pub platform_manifest_digest: Digest,
    pub platform: Platform,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Platform {
    pub os: Os,
    pub architecture: Arch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Os {
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Arch {
    Amd64,
    Arm64,
}

impl Arch {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Amd64 => "amd64",
            Self::Arm64 => "arm64",
        }
    }
}

/// What the approval actually grants. There is no field for privileged mode, host namespaces,
/// devices or extra capabilities beyond the closed enum: a plan cannot even express them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectiveCapabilities {
    pub network: NetworkAttachment,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publish: Option<Publish>,
    #[serde(default)]
    pub linux_capabilities: Vec<LinuxCapability>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkAttachment {
    /// The dedicated `flagship-apps` bridge, as every app runs today.
    Apps,
    /// No network at all.
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Publish {
    /// The per-service host loopback port the app proxy dials.
    pub host_port: u16,
    /// The port the app listens on inside its sandbox.
    pub container_port: u16,
}

/// The one capability an operator could re-add today (`ContainerLimits.capAdd`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum LinuxCapability {
    #[serde(rename = "NET_BIND_SERVICE")]
    NetBindService,
}

impl LinuxCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NetBindService => "NET_BIND_SERVICE",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resources {
    pub memory_bytes: u64,
    pub cpu_millis: u32,
    pub pids_limit: u32,
    pub tmpfs_bytes: u64,
}

impl Resources {
    /// `DEFAULT_CONTAINER_LIMITS` in serviceRunner.ts.
    pub const TODAY_DEFAULT: Self = Self {
        memory_bytes: 512 * MIB,
        cpu_millis: 1000,
        pids_limit: 256,
        tmpfs_bytes: 64 * MIB,
    };
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VolumeClaim {
    pub id: VolumeId,
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretRef {
    pub env: EnvName,
    pub handle: SecretHandle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum HealthPolicy {
    /// Any HTTP answer on the published port means up (today's `buildStartCheck`).
    #[serde(rename_all = "camelCase")]
    Http {
        startup_timeout_secs: u32,
        interval_secs: u32,
    },
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum RestartPolicy {
    Never,
    #[serde(rename_all = "camelCase")]
    OnFailure {
        max_retries: u8,
    },
}

/// A reference to a claim in the GPU claim journal (G02). Never a device path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceClaim {
    pub claim_id: String,
    pub class: DeviceClass,
    pub count: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceClass {
    Gpu,
}

fn unique_env<'de, D: Deserializer<'de>>(d: D) -> Result<BTreeMap<EnvName, String>, D::Error> {
    struct V;
    impl<'de> Visitor<'de> for V {
        type Value = BTreeMap<EnvName, String>;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("an object of environment variables")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Self::Value, A::Error> {
            let mut out = BTreeMap::new();
            while let Some((k, v)) = m.next_entry::<EnvName, String>()? {
                if out.insert(k.clone(), v).is_some() {
                    return Err(serde::de::Error::custom(format!(
                        "environment variable {k} is given twice"
                    )));
                }
            }
            Ok(out)
        }
    }
    d.deserialize_map(V)
}

/// Keys that would ask the engine for host authority. Matched case-insensitively with `_` and `-`
/// removed, anywhere in the plan except inside `environment` (whose keys are data).
const FORBIDDEN_KEYS: &[(&str, &str)] = &[
    ("privileged", "privileged mode"),
    ("command", "a command line"),
    ("cmd", "a command line"),
    ("entrypoint", "a command line"),
    ("args", "a command line"),
    ("argv", "a command line"),
    ("shell", "a shell"),
    ("exec", "a command line"),
    ("mounts", "a mount"),
    ("mount", "a mount"),
    ("binds", "a mount"),
    ("bind", "a mount"),
    ("hostpath", "a host path"),
    ("path", "a host path"),
    ("volumesfrom", "another workload's mounts"),
    ("tmpfs", "a mount"),
    ("hooks", "a hook"),
    ("hook", "a hook"),
    ("prestart", "a hook"),
    ("poststart", "a hook"),
    ("createruntime", "a hook"),
    ("devices", "a raw device"),
    ("device", "a raw device"),
    ("devicecgrouprules", "a raw device"),
    ("devicerequests", "a raw device"),
    ("cdi", "a raw device"),
    ("pid", "a host namespace"),
    ("pidmode", "a host namespace"),
    ("ipc", "a host namespace"),
    ("ipcmode", "a host namespace"),
    ("uts", "a host namespace"),
    ("utsmode", "a host namespace"),
    ("userns", "a host namespace"),
    ("usernsmode", "a host namespace"),
    ("cgroupns", "a host namespace"),
    ("cgroupnsmode", "a host namespace"),
    ("networkmode", "a host namespace"),
    ("hostnetwork", "a host namespace"),
    ("capadd", "extra Linux capabilities"),
    ("securityopt", "a weaker security profile"),
    ("seccomp", "a weaker security profile"),
    ("apparmor", "a weaker security profile"),
    ("sysctls", "kernel parameters"),
    ("sysctl", "kernel parameters"),
    ("runtime", "a different container runtime"),
    ("ocispec", "a raw OCI spec"),
    ("annotations", "raw runtime annotations"),
    ("user", "a chosen user"),
];

fn scan_forbidden(v: &serde_json::Value, depth: usize) -> Result<(), PlanError> {
    if depth > 8 {
        return Err(PlanError::invalid("plan", "is nested too deeply"));
    }
    match v {
        serde_json::Value::Object(map) => {
            for (k, child) in map {
                let norm: String = k
                    .chars()
                    .filter(|c| *c != '_' && *c != '-')
                    .flat_map(char::to_lowercase)
                    .collect();
                if let Some((_, what)) = FORBIDDEN_KEYS.iter().find(|(key, _)| *key == norm) {
                    return Err(PlanError::Forbidden((*what).to_owned()));
                }
                if norm == "network"
                    && child
                        .as_str()
                        .is_some_and(|s| s.eq_ignore_ascii_case("host"))
                {
                    return Err(PlanError::Forbidden("host networking".to_owned()));
                }
                if depth == 0 && k == "environment" {
                    continue;
                }
                scan_forbidden(child, depth.saturating_add(1))?;
            }
            Ok(())
        }
        serde_json::Value::Array(items) => items
            .iter()
            .try_for_each(|i| scan_forbidden(i, depth.saturating_add(1))),
        _ => Ok(()),
    }
}

impl ExecutionPlan {
    /// Parses and validates. A plan that names anything outside the schema is refused, and one
    /// that asks for host authority is refused with the reason.
    pub fn from_json(bytes: &[u8]) -> Result<Self, PlanError> {
        if bytes.len() > MAX_PLAN_BYTES {
            return Err(PlanError::invalid("plan", "is too large"));
        }
        let value: serde_json::Value =
            serde_json::from_slice(bytes).map_err(|e| PlanError::Json(e.to_string()))?;
        Self::from_value_checked(&value, bytes)
    }

    fn from_value_checked(value: &serde_json::Value, bytes: &[u8]) -> Result<Self, PlanError> {
        if !value.is_object() {
            return Err(PlanError::invalid("plan", "must be an object"));
        }
        scan_forbidden(value, 0)?;
        let plan: Self =
            serde_json::from_slice(bytes).map_err(|e| PlanError::Json(e.to_string()))?;
        plan.validate()?;
        Ok(plan)
    }

    /// Parses a plan nested in a larger message (the broker's IPC payload).
    pub fn from_value(value: &serde_json::Value) -> Result<Self, PlanError> {
        let bytes = serde_json::to_vec(value).map_err(|e| PlanError::Json(e.to_string()))?;
        if bytes.len() > MAX_PLAN_BYTES {
            return Err(PlanError::invalid("plan", "is too large"));
        }
        Self::from_value_checked(value, &bytes)
    }

    pub fn to_json(&self) -> Result<String, PlanError> {
        serde_json::to_string(self).map_err(|e| PlanError::Json(e.to_string()))
    }

    pub fn validate(&self) -> Result<(), PlanError> {
        if self.schema != PLAN_SCHEMA {
            return Err(PlanError::Version(self.schema));
        }
        if self.generation == 0 || self.generation > i64::MAX as u64 {
            return Err(PlanError::invalid(
                "generation",
                "must be between 1 and 2^63-1",
            ));
        }
        let r = &self.resources;
        if !(16 * MIB..=64 * 1024 * MIB).contains(&r.memory_bytes)
            || !r.memory_bytes.is_multiple_of(MIB)
        {
            return Err(PlanError::invalid(
                "resources.memoryBytes",
                "must be whole MiB between 16 MiB and 64 GiB",
            ));
        }
        if !(100..=64_000).contains(&r.cpu_millis) {
            return Err(PlanError::invalid(
                "resources.cpuMillis",
                "must be between 100 and 64000",
            ));
        }
        if !(16..=32_768).contains(&r.pids_limit) {
            return Err(PlanError::invalid(
                "resources.pidsLimit",
                "must be between 16 and 32768",
            ));
        }
        if !(MIB..=4 * 1024 * MIB).contains(&r.tmpfs_bytes) || !r.tmpfs_bytes.is_multiple_of(MIB) {
            return Err(PlanError::invalid(
                "resources.tmpfsBytes",
                "must be whole MiB between 1 MiB and 4 GiB",
            ));
        }
        let caps = &self.capabilities;
        if let Some(p) = caps.publish {
            if p.host_port < 1024 || p.container_port == 0 {
                return Err(PlanError::invalid(
                    "capabilities.publish",
                    "host port must be 1024-65535 and the container port non-zero",
                ));
            }
            if caps.network == NetworkAttachment::None {
                return Err(PlanError::invalid(
                    "capabilities.publish",
                    "a workload with no network publishes nothing",
                ));
            }
        }
        let unique_caps: BTreeSet<_> = caps.linux_capabilities.iter().collect();
        if unique_caps.len() != caps.linux_capabilities.len() {
            return Err(PlanError::invalid(
                "capabilities.linuxCapabilities",
                "lists a capability twice",
            ));
        }
        if self.volumes.len() > 1 {
            return Err(PlanError::invalid(
                "volumes",
                "an app has at most one files volume, at /data",
            ));
        }
        if self.environment.len() > 256 {
            return Err(PlanError::invalid("environment", "has too many variables"));
        }
        for (k, v) in &self.environment {
            if v.len() > 32 * 1024 || v.contains('\0') {
                return Err(PlanError::Invalid {
                    field: "environment",
                    why: format!("{k} is too long or has a NUL"),
                });
            }
        }
        if self.secrets.len() > 64 {
            return Err(PlanError::invalid("secrets", "has too many references"));
        }
        let mut names: BTreeSet<&EnvName> = self.environment.keys().collect();
        let mut handles = BTreeSet::new();
        for s in &self.secrets {
            if !names.insert(&s.env) {
                return Err(PlanError::Invalid {
                    field: "secrets",
                    why: format!("{} is set twice", s.env),
                });
            }
            if !handles.insert(&s.handle) {
                return Err(PlanError::invalid(
                    "secrets",
                    "a handle is referenced twice",
                ));
            }
        }
        match self.health {
            HealthPolicy::Http {
                startup_timeout_secs,
                interval_secs,
            } => {
                if caps.publish.is_none() {
                    return Err(PlanError::invalid(
                        "health",
                        "an HTTP check needs a published port",
                    ));
                }
                if !(1..=600).contains(&startup_timeout_secs) || !(1..=60).contains(&interval_secs)
                {
                    return Err(PlanError::invalid("health", "timeouts are out of range"));
                }
            }
            HealthPolicy::None => {}
        }
        if let RestartPolicy::OnFailure { max_retries } = self.restart
            && !(1..=10).contains(&max_retries)
        {
            return Err(PlanError::invalid(
                "restart.maxRetries",
                "must be between 1 and 10",
            ));
        }
        if let Some(d) = &self.device_claim {
            let ok = !d.claim_id.is_empty()
                && d.claim_id.len() <= 64
                && d.claim_id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
            if !ok || d.count == 0 || d.count > 8 {
                return Err(PlanError::invalid(
                    "deviceClaim",
                    "must name a claim id and a count of 1-8",
                ));
            }
        }
        Ok(())
    }

    /// The bytes an approval signs over. `|`-separated, `flagship/<purpose>/v1` prefixed, every
    /// field present and in a fixed order; lists are sorted; free-form values are hex.
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let caps = &self.capabilities;
        let publish = caps.publish.map_or_else(
            || "-".to_owned(),
            |p| format!("{}:{}", p.host_port, p.container_port),
        );
        let mut linux: Vec<&str> = caps.linux_capabilities.iter().map(|c| c.as_str()).collect();
        linux.sort_unstable();
        let mut volumes: Vec<String> = self
            .volumes
            .iter()
            .map(|v| format!("{}:{}", v.id, if v.read_only { "ro" } else { "rw" }))
            .collect();
        volumes.sort();
        let env: Vec<String> = self
            .environment
            .iter()
            .map(|(k, v)| format!("{k}={}", hex::encode(v.as_bytes())))
            .collect();
        let mut secrets: Vec<String> = self
            .secrets
            .iter()
            .map(|s| format!("{}={}", s.env, s.handle))
            .collect();
        secrets.sort();
        let health = match self.health {
            HealthPolicy::Http {
                startup_timeout_secs,
                interval_secs,
            } => format!("http:{startup_timeout_secs}:{interval_secs}"),
            HealthPolicy::None => "none".to_owned(),
        };
        let restart = match self.restart {
            RestartPolicy::Never => "never".to_owned(),
            RestartPolicy::OnFailure { max_retries } => format!("on-failure:{max_retries}"),
        };
        let device = self.device_claim.as_ref().map_or_else(
            || "-".to_owned(),
            |d| format!("{}:gpu:{}", d.claim_id, d.count),
        );
        let r = &self.resources;
        let net = match caps.network {
            NetworkAttachment::Apps => "apps",
            NetworkAttachment::None => "none",
        };
        let fields: Vec<String> = vec![
            PLAN_TAG.to_owned(),
            format!("installation={}", self.installation),
            format!("generation={}", self.generation),
            format!("image.repository={}", self.image.repository),
            format!("image.index={}", self.image.index_digest),
            format!("image.manifest={}", self.image.platform_manifest_digest),
            format!(
                "image.platform=linux/{}",
                self.image.platform.architecture.as_str()
            ),
            format!("manifest={}", self.manifest_digest),
            format!("caps.network={net}"),
            format!("caps.publish={publish}"),
            format!("caps.linux={}", join_or_dash(&linux)),
            format!("res.memory={}", r.memory_bytes),
            format!("res.cpu={}", r.cpu_millis),
            format!("res.pids={}", r.pids_limit),
            format!("res.tmpfs={}", r.tmpfs_bytes),
            format!("volumes={}", join_or_dash(&volumes)),
            format!("netpolicy={}", self.network_policy_digest),
            format!("env={}", join_or_dash(&env)),
            format!("secrets={}", join_or_dash(&secrets)),
            format!("health={health}"),
            format!("restart={restart}"),
            format!("device={device}"),
        ];
        fields.join("|").into_bytes()
    }

    pub fn digest(&self) -> Digest {
        Digest::of(&self.canonical_bytes())
    }

    /// The reference the engine pulls and runs: the selected platform manifest, by digest.
    pub fn image_reference(&self) -> String {
        format!(
            "{}@{}",
            self.image.repository, self.image.platform_manifest_digest
        )
    }
}

fn join_or_dash<S: AsRef<str>>(items: &[S]) -> String {
    if items.is_empty() {
        "-".to_owned()
    } else {
        items
            .iter()
            .map(AsRef::as_ref)
            .collect::<Vec<_>>()
            .join(",")
    }
}
