//! Interconnect topology for gang reservations.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::device::DeviceRecord;
use crate::ids::LocalDeviceId;

/// Best first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Link {
    /// NVLink, AMD xGMI/Infinity Fabric or Intel Xe Link.
    PeerFabric,
    /// Same PCIe switch.
    PcieSwitch,
    /// Same host bridge / NUMA node.
    PcieHostBridge,
    /// Across NUMA nodes.
    PcieCrossNuma,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GangRequirement {
    #[default]
    Any,
    SameNuma,
    PeerFabric,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Topology {
    links: BTreeMap<(LocalDeviceId, LocalDeviceId), Link>,
}

impl Topology {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&mut self, a: &LocalDeviceId, b: &LocalDeviceId, link: Link) {
        self.links.insert(Self::key(a, b), link);
    }

    pub fn link(&self, a: &LocalDeviceId, b: &LocalDeviceId) -> Option<Link> {
        self.links.get(&Self::key(a, b)).copied()
    }

    fn key(a: &LocalDeviceId, b: &LocalDeviceId) -> (LocalDeviceId, LocalDeviceId) {
        if a <= b {
            (a.clone(), b.clone())
        } else {
            (b.clone(), a.clone())
        }
    }

    /// Parse `nvidia-smi topo -m`. GPU columns map to devices by their CDI
    /// index name.
    pub fn from_nvidia_topo(text: &str, devices: &[DeviceRecord]) -> Self {
        let mut t = Self::new();
        let mut lines = text.lines().filter(|l| !l.trim().is_empty());
        let Some(header) = lines.next() else {
            return t;
        };
        let cols: Vec<&str> = header.split_whitespace().collect();
        let by_index = |name: &str| {
            let idx = name.strip_prefix("GPU")?;
            devices
                .iter()
                .find(|d| d.cdi_name == idx)
                .map(|d| d.id.clone())
        };
        for line in lines {
            let mut cells = line.split_whitespace();
            let Some(row) = cells.next().and_then(by_index) else {
                continue;
            };
            for (col, cell) in cols.iter().zip(cells) {
                let Some(other) = by_index(col) else {
                    continue;
                };
                if other == row {
                    continue;
                }
                let link = match cell {
                    c if c.starts_with("NV") => Link::PeerFabric,
                    "PIX" | "PXB" => Link::PcieSwitch,
                    "PHB" | "NODE" => Link::PcieHostBridge,
                    "SYS" => Link::PcieCrossNuma,
                    _ => continue,
                };
                t.set(&row, &other, link);
            }
        }
        t
    }
}

/// Every pair of devices in a gang meets the requirement. Unknown links
/// fail anything stricter than `Any`.
pub fn check_gang(
    devices: &[&DeviceRecord],
    topo: &Topology,
    req: GangRequirement,
) -> Result<(), String> {
    for (i, a) in devices.iter().enumerate() {
        for b in devices.iter().skip(i.saturating_add(1)) {
            if a.id == b.id {
                return Err("a gang names the same device twice".into());
            }
            if a.backend != b.backend {
                return Err("a gang mixes backends".into());
            }
            let ok = match req {
                GangRequirement::Any => true,
                GangRequirement::SameNuma => {
                    (a.numa_node.is_some() && a.numa_node == b.numa_node)
                        || topo
                            .link(&a.id, &b.id)
                            .is_some_and(|l| l <= Link::PcieHostBridge)
                }
                GangRequirement::PeerFabric => topo.link(&a.id, &b.id) == Some(Link::PeerFabric),
            };
            if !ok {
                return Err(format!("{} and {} do not meet {req:?}", a.id, b.id));
            }
        }
    }
    Ok(())
}
