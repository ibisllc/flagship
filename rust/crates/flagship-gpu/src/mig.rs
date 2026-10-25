//! NVIDIA MIG administration (§9.5): broker-only. Apps never create or
//! destroy partitions and never receive a management capability. A layout
//! change needs a device nobody holds; afterwards the inventory fingerprint
//! changes, the topology generation moves, and nothing is admitted until
//! [`crate::manager::DeviceManager::reconcile`] has run.

use serde::{Deserialize, Serialize};

use crate::device::{DeviceRecord, PartitionMode};
use crate::provider::{ProviderError, Tool, ToolRunner, parse_err};

const TOOL: &str = "nvidia-smi mig";
/// Most instances one layout may ask for (an H100 offers seven).
pub const MAX_INSTANCES: usize = 7;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigProfile {
    pub id: u32,
    /// `1g.10gb`, `3g.40gb+me`.
    pub name: String,
    pub free: u32,
    pub total: u32,
    pub memory_mib: u64,
}

/// Parse `nvidia-smi mig -i <n> -lgip` (the GPU instance profile table in
/// NVIDIA's MIG user guide): one `MIG <name>` row per profile.
pub fn parse_lgip(text: &str) -> Result<Vec<MigProfile>, ProviderError> {
    let mut out = Vec::new();
    for line in text.lines() {
        let inner = line.trim().trim_matches('|');
        let t: Vec<&str> = inner.split_whitespace().collect();
        if t.get(1) != Some(&"MIG") {
            continue;
        }
        let (Some(name), Some(id), Some(inst), Some(mem)) =
            (t.get(2), t.get(3), t.get(4), t.get(5))
        else {
            return Err(parse_err(TOOL, "profile row is short"));
        };
        let (free, total) = inst
            .split_once('/')
            .ok_or_else(|| parse_err(TOOL, "instances column"))?;
        let gib: f64 = mem.parse().map_err(|_| parse_err(TOOL, "memory column"))?;
        if !(0.0..=1024.0).contains(&gib) {
            return Err(parse_err(TOOL, "memory column"));
        }
        out.push(MigProfile {
            id: id.parse().map_err(|_| parse_err(TOOL, "profile id"))?,
            name: (*name).to_owned(),
            free: free
                .parse()
                .map_err(|_| parse_err(TOOL, "free instances"))?,
            total: total
                .parse()
                .map_err(|_| parse_err(TOOL, "total instances"))?,
            memory_mib: (gib * 1024.0).round() as u64,
        });
    }
    if out.is_empty() {
        return Err(parse_err(TOOL, "no MIG profiles listed"));
    }
    Ok(out)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigPlan {
    /// nvidia-smi's device index (the CDI name of the whole device).
    pub index: u32,
    pub enable_mode: bool,
    pub destroy_existing: bool,
    pub profile_ids: Vec<u32>,
}

/// Check a requested layout against the device's profiles. `held` says
/// whether any allocation holds the device or one of its partitions.
pub fn plan(
    device: &DeviceRecord,
    profiles: &[MigProfile],
    desired: &[String],
    held: bool,
) -> Result<MigPlan, String> {
    if device.partition_mode == PartitionMode::Unsupported {
        return Err("this device has no MIG support".into());
    }
    if device.display_owned {
        return Err("a device that drives a display is never re-partitioned".into());
    }
    if held {
        return Err("drain every workload on the device before changing its partitions".into());
    }
    if desired.is_empty() || desired.len() > MAX_INSTANCES {
        return Err("a layout has 1 to 7 instances".into());
    }
    let index: u32 = device
        .cdi_name
        .parse()
        .map_err(|_| "the device has no nvidia-smi index".to_owned())?;
    let mut ids = Vec::new();
    let mut memory = 0u64;
    for name in desired {
        let p = profiles
            .iter()
            .find(|p| p.name == *name)
            .ok_or_else(|| format!("{name} is not a MIG profile on this device"))?;
        let used = u32::try_from(ids.iter().filter(|i| **i == p.id).count()).unwrap_or(u32::MAX);
        if used >= p.total {
            return Err(format!("at most {} {name} instances fit", p.total));
        }
        memory = memory.saturating_add(p.memory_mib);
        ids.push(p.id);
    }
    if memory > device.memory_mib {
        return Err("the layout needs more memory than the device has".into());
    }
    Ok(MigPlan {
        index,
        enable_mode: device.partition_mode == PartitionMode::Disabled,
        destroy_existing: !device.partitions.is_empty(),
        profile_ids: ids,
    })
}

/// Apply a checked plan through the pinned tool.
pub fn apply(tools: &dyn ToolRunner, p: &MigPlan) -> Result<(), String> {
    let run = |t: Tool| tools.output(&t).map(|_| ()).map_err(|e| e.to_string());
    if p.enable_mode {
        run(Tool::NvidiaSmiMigMode {
            index: p.index,
            enabled: true,
        })?;
    }
    if p.destroy_existing {
        run(Tool::NvidiaSmiMigDestroyCompute(p.index))?;
        run(Tool::NvidiaSmiMigDestroyGpu(p.index))?;
    }
    run(Tool::NvidiaSmiMigCreate {
        index: p.index,
        profiles: p.profile_ids.clone(),
    })
}
