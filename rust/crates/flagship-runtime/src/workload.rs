//! What an adapter is allowed to run: an [`ExecutionPlan`] whose references the broker has
//! resolved. Every host object here has a constructor that only accepts the shapes the box itself
//! creates, so an adapter can never be handed an arbitrary host path.

use crate::error::{PlanError, RuntimeError};
use crate::ids::{Digest, EnvName, InstallationId, SecretHandle, VolumeId, WorkloadName};
use crate::plan::{
    ExecutionPlan, LinuxCapability, NetworkAttachment, Publish, Resources, RestartPolicy,
};
use std::net::Ipv4Addr;

/// The bridge every app joins (`DEFAULT_CONTAINER_LIMITS.network`).
pub const APPS_BRIDGE: &str = "flagship-apps";
/// The alias wired to the data services (`DEFAULT_CONTAINER_LIMITS.dataHostAlias`).
pub const DATA_HOST_ALIAS: &str = "host.flagship.internal";
/// Where files-volume images live (`appQuota/loopVolumes.ts` FILES_IMAGE_ROOT).
pub const FILES_IMAGE_ROOT: &str = "/var/lib/flagship-files";
/// Where an app's files volume appears inside its sandbox (`dataLayer/naming.ts` FILES_MOUNT).
pub const FILES_MOUNT: &str = "/data";

pub const LABEL_INSTALLATION: &str = "flagship.installation";
pub const LABEL_GENERATION: &str = "flagship.generation";
pub const LABEL_PLAN: &str = "flagship.plan";

fn is_label32(s: &str) -> bool {
    // `[a-z0-9](?:-?[a-z0-9]){0,31}` from dataLayer/naming.ts
    let b = s.as_bytes();
    let alnum = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    let letters = b.iter().filter(|c| alnum(c)).count();
    !b.is_empty()
        && (1..=32).contains(&letters)
        && b.iter().all(|c| alnum(c) || *c == b'-')
        && b.first().is_some_and(alnum)
        && b.last().is_some_and(alnum)
        && !s.contains("--")
}

/// A files volume name exactly as `isFilesVolume` accepts it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FilesVolumeName(String);

impl FilesVolumeName {
    pub fn parse(s: &str) -> Result<Self, PlanError> {
        let rest = s
            .strip_prefix("flagship-files-")
            .or_else(|| s.strip_prefix("flagship-devfiles-"));
        let ok = rest
            .and_then(|r| r.split_once("--"))
            .is_some_and(|(a, b)| is_label32(a) && is_label32(b));
        if ok {
            Ok(Self(s.to_owned()))
        } else {
            Err(PlanError::invalid("volume", "is not a files volume name"))
        }
    }
    /// The production volume of an installation: `flagship-files-<creator>--<slug>`.
    pub fn for_installation(id: &InstallationId) -> Result<Self, PlanError> {
        Self::parse(&format!("flagship-files-{id}"))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    /// The folder the volume binds: `<root>/<volume>/data`, inside the volume's mounted image.
    pub fn bind_device(&self) -> String {
        format!("{FILES_IMAGE_ROOT}/{}/data", self.0)
    }
}

/// The egress gateway's resolver file for a bridge, as `sandboxRunArgs` mounts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvConf(String);

impl ResolvConf {
    pub fn for_bridge_key(key: &str) -> Result<Self, PlanError> {
        let ok = !key.is_empty()
            && key.len() <= 64
            && key
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if ok {
            Ok(Self(format!("/run/flagship-resolv-{key}.conf")))
        } else {
            Err(PlanError::invalid("resolvConf", "bad bridge key"))
        }
    }
    pub fn path(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedNetwork {
    None,
    /// The apps bridge. `sandbox` is set once the egress gateway is up (today's `sandboxRunArgs`);
    /// without it the data alias goes to Docker's host gateway as it does today.
    Apps {
        sandbox: Option<SandboxDns>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxDns {
    pub gateway: Ipv4Addr,
    pub resolv: Option<ResolvConf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedMount {
    FilesVolume {
        volume: FilesVolumeName,
        read_only: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedWorkload {
    pub(crate) installation: InstallationId,
    pub(crate) generation: u64,
    pub(crate) plan_digest: Digest,
    pub(crate) name: WorkloadName,
    pub(crate) image_reference: String,
    pub(crate) network: ResolvedNetwork,
    pub(crate) resources: Resources,
    pub(crate) linux_capabilities: Vec<LinuxCapability>,
    pub(crate) env: Vec<(EnvName, String)>,
    pub(crate) publish: Option<Publish>,
    pub(crate) mounts: Vec<ResolvedMount>,
    pub(crate) restart: RestartPolicy,
}

impl ResolvedWorkload {
    /// Joins a validated plan with what the broker resolved for it. Every reference in the plan
    /// must be resolved, and nothing beyond the plan's references may be supplied.
    pub fn resolve(
        plan: &ExecutionPlan,
        network: ResolvedNetwork,
        volumes: &[(VolumeId, FilesVolumeName)],
        secrets: &[(SecretHandle, String)],
    ) -> Result<Self, RuntimeError> {
        plan.validate()
            .map_err(|e| RuntimeError::Refused(e.to_string()))?;
        if plan.device_claim.is_some() {
            return Err(RuntimeError::Unsupported(
                "device claims need the GPU claim journal (G02)".to_owned(),
            ));
        }
        match (plan.capabilities.network, &network) {
            (NetworkAttachment::None, ResolvedNetwork::None)
            | (NetworkAttachment::Apps, ResolvedNetwork::Apps { .. }) => {}
            _ => {
                return Err(RuntimeError::Refused(
                    "the resolved network is not the one the plan names".to_owned(),
                ));
            }
        }
        if volumes.len() != plan.volumes.len() || secrets.len() != plan.secrets.len() {
            return Err(RuntimeError::Refused(
                "resolutions do not match the plan's references".to_owned(),
            ));
        }
        let mut mounts = Vec::new();
        for claim in &plan.volumes {
            let (_, name) = volumes
                .iter()
                .find(|(id, _)| *id == claim.id)
                .ok_or_else(|| {
                    RuntimeError::Refused(format!("volume {} is not resolved", claim.id))
                })?;
            mounts.push(ResolvedMount::FilesVolume {
                volume: name.clone(),
                read_only: claim.read_only,
            });
        }
        let mut env: Vec<(EnvName, String)> = plan
            .environment
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for s in &plan.secrets {
            let (_, value) = secrets
                .iter()
                .find(|(h, _)| *h == s.handle)
                .ok_or_else(|| {
                    RuntimeError::Refused(format!("secret {} is not resolved", s.handle))
                })?;
            if value.contains('\0') || value.len() > 32 * 1024 {
                return Err(RuntimeError::Refused(
                    "a secret value is too long or has a NUL".to_owned(),
                ));
            }
            env.push((s.env.clone(), value.clone()));
        }
        Ok(Self {
            installation: plan.installation.clone(),
            generation: plan.generation,
            plan_digest: plan.digest(),
            name: WorkloadName::for_installation(&plan.installation),
            image_reference: plan.image_reference(),
            network,
            resources: plan.resources,
            linux_capabilities: plan.capabilities.linux_capabilities.clone(),
            env,
            publish: plan.capabilities.publish,
            mounts,
            restart: plan.restart,
        })
    }

    pub fn name(&self) -> &WorkloadName {
        &self.name
    }
    pub fn installation(&self) -> &InstallationId {
        &self.installation
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn plan_digest(&self) -> Digest {
        self.plan_digest
    }
    pub fn image_reference(&self) -> &str {
        &self.image_reference
    }
}
