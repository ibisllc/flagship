//! Admission of a deploy against the box's memory (G3): a new workload is started only while the
//! memory limits of what runs, plus its own, stay within the box's memory times the overcommit
//! factor. Running workloads are never evicted to make room; a workload that does not fit waits
//! with the reason. CPU is shared (a limit, not a reservation) and is not admitted on.

use serde::{Deserialize, Serialize};

/// Limits are ceilings, not use: twice the box's memory in limits is still admitted.
pub const MEMORY_OVERCOMMIT: u64 = 2;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capacity {
    /// The box's memory after its own reserve; zero = not known (nothing is refused).
    pub memory_bytes: u64,
    #[serde(default)]
    pub cpu_millis: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fit {
    Yes,
    No(String),
}

pub fn fits(cap: &Capacity, committed_bytes: u64, want: &crate::apps::Resources) -> Fit {
    if cap.memory_bytes == 0 {
        return Fit::Yes;
    }
    let budget = cap.memory_bytes.saturating_mul(MEMORY_OVERCOMMIT);
    let total = committed_bytes.saturating_add(want.memory_bytes);
    if total <= budget {
        return Fit::Yes;
    }
    let mib = |b: u64| b / (1024 * 1024);
    Fit::No(format!(
        "not enough memory on this server: it needs {} MiB, and {} MiB of {} MiB is already promised to running apps",
        mib(want.memory_bytes),
        mib(committed_bytes),
        mib(budget)
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::arithmetic_side_effects)]
mod tests {
    use super::*;
    use crate::apps::Resources;

    const MIB: u64 = 1024 * 1024;

    #[test]
    fn admits_within_the_overcommitted_budget() {
        let cap = Capacity {
            memory_bytes: 1024 * MIB,
            cpu_millis: 2000,
        };
        let r = |m| Resources {
            memory_bytes: m * MIB,
            cpu_millis: 500,
        };
        assert_eq!(fits(&cap, 0, &r(512)), Fit::Yes);
        assert_eq!(fits(&cap, 1536 * MIB, &r(512)), Fit::Yes);
        assert!(matches!(fits(&cap, 1600 * MIB, &r(512)), Fit::No(m) if m.contains("512 MiB")));
        assert_eq!(fits(&Capacity::default(), u64::MAX, &r(512)), Fit::Yes);
        assert!(matches!(fits(&cap, u64::MAX, &r(1)), Fit::No(_)));
    }
}
