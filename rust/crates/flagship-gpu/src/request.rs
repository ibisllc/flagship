//! What an app asks for and what the owner approved.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::device::{Backend, Capability};
use crate::policy::{AllocationPolicy, PolicyKind};
use crate::provider::IsolationProfile;
use crate::topology::GangRequirement;

/// Most devices one job may hold.
pub const MAX_GANG: u32 = 16;

/// One installed generation of one app. Every device in an allocation
/// belongs to exactly this generation.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInstallation {
    pub app_id: String,
    pub installation_id: String,
    pub generation: u64,
}

/// The manifest's `accelerator` field (§8.1). Unknown fields are refused,
/// so a GPU requirement is never silently ignored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceleratorRequirement {
    pub backend: Backend,
    #[serde(default = "one")]
    pub count: u32,
    #[serde(rename = "minimumMemoryMiB", default)]
    pub minimum_memory_mib: u64,
    pub capabilities: BTreeSet<Capability>,
    #[serde(default = "exclusive")]
    pub sharing: PolicyKind,
    #[serde(default)]
    pub fallback: Fallback,
    #[serde(default)]
    pub topology: GangRequirement,
}

fn one() -> u32 {
    1
}

fn exclusive() -> PolicyKind {
    PolicyKind::Exclusive
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Fallback {
    #[default]
    None,
    /// Only valid when the app ships a tested CPU path and the approval
    /// permits it; it never relaxes isolation or sends data elsewhere.
    CpuIfSupported,
}

/// The owner's effective approval for one app generation, as the broker
/// resolved it. The broker verifies the signed approval; this is its result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuApproval {
    pub app: AppInstallation,
    pub backend: Backend,
    pub max_count: u32,
    pub capabilities: BTreeSet<Capability>,
    pub policies: BTreeSet<PolicyKind>,
    pub isolation: IsolationProfile,
    /// The app's data must stay secret from every other app.
    pub secrecy: bool,
    /// For cooperative sharing: the owner's chosen trust domain and the id
    /// of the owner's signed consent.
    pub trust_domain: Option<String>,
    pub owner_consent: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuRequest {
    pub app: AppInstallation,
    pub operation_id: String,
    pub backend: Backend,
    pub count: u32,
    pub minimum_memory_mib: u64,
    pub capabilities: BTreeSet<Capability>,
    pub policy: AllocationPolicy,
    pub isolation: IsolationProfile,
    pub gang: GangRequirement,
    /// Catalog image purpose (`cuda-12.9-runtime`); first approved if unset.
    pub userspace: Option<String>,
}

impl GpuRequest {
    /// Build from the manifest requirement plus the approval: the policy's
    /// trust domain and consent come from the approval, never the app.
    pub fn from_manifest(
        app: AppInstallation,
        operation_id: &str,
        req: &AcceleratorRequirement,
        approval: &GpuApproval,
    ) -> Self {
        let policy = match req.sharing {
            PolicyKind::Exclusive => AllocationPolicy::Exclusive,
            PolicyKind::Partition => AllocationPolicy::Partition,
            PolicyKind::Cooperative => AllocationPolicy::Cooperative {
                trust_domain: approval.trust_domain.clone().unwrap_or_default(),
                owner_consent: approval.owner_consent.clone().unwrap_or_default(),
            },
        };
        Self {
            app,
            operation_id: operation_id.to_owned(),
            backend: req.backend,
            count: req.count,
            minimum_memory_mib: req.minimum_memory_mib,
            capabilities: req.capabilities.clone(),
            policy,
            isolation: approval.isolation,
            gang: req.topology,
            userspace: None,
        }
    }

    pub fn shape_error(&self) -> Option<&'static str> {
        if self.count == 0 || self.count > MAX_GANG {
            return Some("device count must be 1 to 16");
        }
        if self.capabilities.is_empty() {
            return Some("a GPU request names at least one capability");
        }
        if self.count > 1 && self.policy.kind() != PolicyKind::Exclusive {
            return Some("multi-GPU jobs use exclusive devices");
        }
        if self.policy.kind() == PolicyKind::Partition
            && self.isolation == IsolationProfile::VmPassthrough
        {
            return Some("a partition cannot be passed through to a VM");
        }
        None
    }
}

impl GpuApproval {
    /// Why this approval doesn't cover `req`, if it doesn't.
    pub fn refuses(&self, req: &GpuRequest) -> Option<String> {
        if self.app != req.app {
            return Some("approval is for a different app installation or generation".into());
        }
        if self.backend != req.backend {
            return Some(format!(
                "approved for {}, not {}",
                self.backend, req.backend
            ));
        }
        if req.count > self.max_count {
            return Some(format!("approved for at most {} devices", self.max_count));
        }
        if !req.capabilities.is_subset(&self.capabilities) {
            return Some("a requested capability is not approved".into());
        }
        if !self.policies.contains(&req.policy.kind()) {
            return Some(format!(
                "sharing policy {:?} is not approved",
                req.policy.kind()
            ));
        }
        if self.isolation != req.isolation {
            return Some("isolation profile differs from the approval".into());
        }
        None
    }
}
