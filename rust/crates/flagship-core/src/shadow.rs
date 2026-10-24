//! The shadow run on a real box (broker-runtime-core.md §9.2): core compares what the TS
//! controller says it runs (its checkpoint) with what the engine reports through the broker, and
//! journals every change of verdict. It decides nothing and asks for no effect.

use crate::handover::TsCheckpoint;
use std::collections::{BTreeMap, BTreeSet};

/// One workload as the broker's `ListWorkloads` answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Seen {
    pub installation: String,
    pub state: String,
}

/// Engine workloads that belong to the box itself, not to an app.
pub const PLATFORM_WORKLOADS: &[&str] = &["postgres", "forgejo", "chromium", "egress-dns"];

fn platform(name: &str) -> bool {
    PLATFORM_WORKLOADS.contains(&name) || name.starts_with("stg-")
}

/// The verdict for every installation either side knows, keyed by installation.
pub fn compare(cp: &TsCheckpoint, seen: &[Seen]) -> BTreeMap<String, String> {
    let engine: BTreeMap<&str, &str> = seen
        .iter()
        .map(|s| (s.installation.as_str(), s.state.as_str()))
        .collect();
    let mut out = BTreeMap::new();
    let mut listed = BTreeSet::new();
    for w in &cp.workloads {
        let id = w.installation.as_str();
        listed.insert(id);
        let verdict = match (engine.get(id), w.running) {
            (Some(&"running"), true) => "agree".to_owned(),
            (Some(state), false) if *state != "running" => "agree".to_owned(),
            (Some(state), true) => format!("diverge: expected running, engine reports {state}"),
            (Some(_), false) => "diverge: expected stopped, engine reports running".to_owned(),
            (None, true) => "diverge: expected running, engine has no workload".to_owned(),
            (None, false) => "agree".to_owned(),
        };
        out.insert(id.to_owned(), verdict);
    }
    for s in seen {
        let id = s.installation.as_str();
        if listed.contains(id) || platform(id) {
            continue;
        }
        out.insert(
            id.to_owned(),
            format!("unmanaged: engine reports {}", s.state),
        );
    }
    out
}

/// How many verdicts are not `agree`.
pub fn divergent(v: &BTreeMap<String, String>) -> usize {
    v.values().filter(|d| d.as_str() != "agree").count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handover::CheckpointWorkload;
    use flagship_runtime::InstallationId;

    fn cp(items: &[(&str, bool)]) -> TsCheckpoint {
        TsCheckpoint {
            taken_at: 1,
            ts_controller_paused: false,
            workloads: items
                .iter()
                .filter_map(|(i, r)| {
                    Some(CheckpointWorkload {
                        installation: InstallationId::parse(i).ok()?,
                        generation: 0,
                        image: String::new(),
                        running: *r,
                    })
                })
                .collect(),
        }
    }

    fn seen(items: &[(&str, &str)]) -> Vec<Seen> {
        items
            .iter()
            .map(|(i, s)| Seen {
                installation: (*i).to_owned(),
                state: (*s).to_owned(),
            })
            .collect()
    }

    #[test]
    fn agreement_and_every_divergence() {
        let c = cp(&[
            ("alice--notes", true),
            ("alice--chess", true),
            ("alice--gone", true),
            ("alice--off", false),
        ]);
        let s = seen(&[
            ("alice--notes", "running"),
            ("alice--chess", "exited"),
            ("alice--off", "exited"),
            ("bob--stray", "running"),
            ("postgres", "running"),
            ("stg-123", "running"),
        ]);
        let v = compare(&c, &s);
        assert_eq!(v.get("alice--notes").map(String::as_str), Some("agree"));
        assert_eq!(v.get("alice--off").map(String::as_str), Some("agree"));
        assert!(v.get("alice--chess").is_some_and(|d| d.contains("exited")));
        assert!(
            v.get("alice--gone")
                .is_some_and(|d| d.contains("no workload"))
        );
        assert!(
            v.get("bob--stray")
                .is_some_and(|d| d.starts_with("unmanaged"))
        );
        assert!(!v.contains_key("postgres"));
        assert!(!v.contains_key("stg-123"));
        assert_eq!(divergent(&v), 3);
    }
}
