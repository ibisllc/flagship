//! An installation's approved network policy, as the broker installs it before the workload may
//! start. The plan binds this policy's digest; the broker refuses a start whose policy is not the
//! one it installed.

use flagship_runtime::{Digest, InstallationId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const POLICY_TAG: &str = "flagship/network-policy/v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkPolicy {
    pub schema: u32,
    pub installation: InstallationId,
    pub generation: u64,
    pub egress: Vec<EgressRule>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EgressRule {
    pub host: String,
    pub port: u16,
}

/// A lowercase DNS name, optionally `*.`-prefixed. IP literals are refused: an approval names
/// hosts, so a metadata address or a LAN address can never be granted by number.
fn is_host(h: &str) -> bool {
    let name = h.strip_prefix("*.").unwrap_or(h);
    let labels: Vec<&str> = name.split('.').collect();
    let label_ok = |l: &&str| {
        !l.is_empty()
            && l.len() <= 63
            && l.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && !l.starts_with('-')
            && !l.ends_with('-')
    };
    !name.is_empty()
        && name.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(label_ok)
        && labels
            .last()
            .is_some_and(|t| !t.bytes().all(|b| b.is_ascii_digit()))
}

impl NetworkPolicy {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != 1 {
            return Err("unsupported network policy schema".into());
        }
        if self.generation == 0 || self.generation > i64::MAX as u64 {
            return Err("generation out of range".into());
        }
        if self.egress.len() > 256 {
            return Err("too many egress rules".into());
        }
        let mut seen = BTreeSet::new();
        for r in &self.egress {
            if !is_host(&r.host) || r.port == 0 {
                return Err(format!(
                    "egress rule {}:{} is not a host name and port",
                    r.host, r.port
                ));
            }
            if !seen.insert(r) {
                return Err("an egress rule is listed twice".into());
            }
        }
        Ok(())
    }

    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut rules: Vec<String> = self
            .egress
            .iter()
            .map(|r| format!("{}:{}", r.host, r.port))
            .collect();
        rules.sort();
        let egress = if rules.is_empty() {
            "-".to_owned()
        } else {
            rules.join(",")
        };
        format!(
            "{POLICY_TAG}|installation={}|generation={}|egress={egress}",
            self.installation, self.generation
        )
        .into_bytes()
    }

    pub fn digest(&self) -> Digest {
        Digest::of(&self.canonical_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::is_host;

    #[test]
    fn hosts_not_numbers() {
        for ok in ["api.openai.com", "*.example.org", "a-b.c1.io"] {
            assert!(is_host(ok), "{ok}");
        }
        for bad in [
            "169.254.169.254",
            "10.0.0.1",
            "localhost",
            "",
            "A.com",
            "-a.com",
            "a..com",
            "*.",
            "a.com:443",
            "[::1]",
        ] {
            assert!(!is_host(bad), "{bad}");
        }
    }
}
