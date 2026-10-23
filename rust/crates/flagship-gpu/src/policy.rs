//! Allocation policies and the one function that decides whether a new
//! holding may coexist with the holdings already on a device. The journal
//! calls it inside the reservation transaction, so it is authoritative.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::device::PartitionId;
use crate::ids::LocalDeviceId;

/// At most this many cooperative workloads share one device.
pub const MAX_COOPERATIVE_SHARERS: usize = 4;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AllocationId(String);

impl AllocationId {
    pub fn new(s: &str) -> Option<Self> {
        let ok = !s.is_empty()
            && s.len() <= 128
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
        ok.then(|| Self(s.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AllocationId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PolicyKind {
    Exclusive,
    Partition,
    Cooperative,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AllocationPolicy {
    /// The whole device, nobody else. The default.
    Exclusive,
    /// One hardware partition (MIG) on a qualified device.
    Partition,
    /// Time-sliced sharing the owner selected, only within one trust domain.
    /// `owner_consent` names the owner's signed sharing decision.
    #[serde(rename_all = "camelCase")]
    Cooperative {
        trust_domain: String,
        owner_consent: String,
    },
}

impl AllocationPolicy {
    pub fn kind(&self) -> PolicyKind {
        match self {
            Self::Exclusive => PolicyKind::Exclusive,
            Self::Partition => PolicyKind::Partition,
            Self::Cooperative { .. } => PolicyKind::Cooperative,
        }
    }
}

/// One allocation's hold on one device or partition.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Holding {
    pub allocation: AllocationId,
    pub app_id: String,
    pub device: LocalDeviceId,
    pub partition: Option<PartitionId>,
    pub policy: AllocationPolicy,
    /// The app's approval says its data must stay secret from other apps.
    pub secrecy: bool,
    /// Memory budget counted against the device (admission, not a hard
    /// partition on cards that can't enforce one).
    pub memory_mib: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Conflict {
    Quarantined,
    Held(AllocationId),
    PartitionHeld(AllocationId),
    PolicyClaimMismatch,
    NoOwnerConsent,
    TrustDomain,
    Secrecy,
    TooManySharers,
    MemoryOversubscribed,
}

impl fmt::Display for Conflict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Quarantined => f.write_str("device is quarantined until maintenance"),
            Self::Held(a) => write!(f, "device is held by {a}"),
            Self::PartitionHeld(a) => write!(f, "partition is held by {a}"),
            Self::PolicyClaimMismatch => f.write_str("policy does not match the claim"),
            Self::NoOwnerConsent => f.write_str("cooperative sharing needs the owner's consent"),
            Self::TrustDomain => f.write_str("cooperative sharing is only within one trust domain"),
            Self::Secrecy => {
                f.write_str("an app that requires secrecy never shares a device with another app")
            }
            Self::TooManySharers => f.write_str("device already has the maximum number of sharers"),
            Self::MemoryOversubscribed => f.write_str("device memory would be oversubscribed"),
        }
    }
}

/// May `new` join `existing` (all holdings on the same physical device)?
pub fn admissible(
    existing: &[Holding],
    new: &Holding,
    device_memory_mib: u64,
) -> Result<(), Conflict> {
    match (&new.policy, &new.partition) {
        (AllocationPolicy::Partition, None) => return Err(Conflict::PolicyClaimMismatch),
        (AllocationPolicy::Exclusive | AllocationPolicy::Cooperative { .. }, Some(_)) => {
            return Err(Conflict::PolicyClaimMismatch);
        }
        _ => {}
    }
    match &new.policy {
        AllocationPolicy::Exclusive => {
            if let Some(h) = existing.first() {
                return Err(Conflict::Held(h.allocation.clone()));
            }
        }
        AllocationPolicy::Partition => {
            for h in existing {
                match &h.partition {
                    None => return Err(Conflict::Held(h.allocation.clone())),
                    Some(p) if Some(p) == new.partition.as_ref() => {
                        return Err(Conflict::PartitionHeld(h.allocation.clone()));
                    }
                    Some(_) => {}
                }
            }
        }
        AllocationPolicy::Cooperative {
            trust_domain,
            owner_consent,
        } => {
            if trust_domain.is_empty() || owner_consent.is_empty() {
                return Err(Conflict::NoOwnerConsent);
            }
            let mut used = new.memory_mib;
            for h in existing {
                let AllocationPolicy::Cooperative {
                    trust_domain: theirs,
                    ..
                } = &h.policy
                else {
                    return Err(Conflict::Held(h.allocation.clone()));
                };
                if theirs != trust_domain {
                    return Err(Conflict::TrustDomain);
                }
                if h.app_id != new.app_id && (h.secrecy || new.secrecy) {
                    return Err(Conflict::Secrecy);
                }
                used = used.saturating_add(h.memory_mib);
            }
            if existing.len() >= MAX_COOPERATIVE_SHARERS {
                return Err(Conflict::TooManySharers);
            }
            if new.memory_mib == 0 || used > device_memory_mib {
                return Err(Conflict::MemoryOversubscribed);
            }
        }
    }
    Ok(())
}
