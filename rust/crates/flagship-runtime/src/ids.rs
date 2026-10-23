//! Validated identifiers. Each type can only be built through its parser, so a value of the type
//! is proof that it passed validation. None of them can hold `|`, `,` or `=`, which keeps the
//! canonical bytes in [`crate::plan`] unambiguous.

use crate::error::PlanError;
use crate::hex;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

fn is_lower_alnum(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit()
}

/// `[a-z0-9]` runs joined by `-`, at most `max` characters, no leading/trailing/double dash.
fn is_dns_label(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.chars().all(|c| is_lower_alnum(c) || c == '-')
        && !s.starts_with('-')
        && !s.ends_with('-')
        && !s.contains("--")
}

macro_rules! string_id {
    ($name:ident, $field:literal, $check:expr, $why:literal) => {
        #[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(String);

        impl $name {
            pub fn parse(s: &str) -> Result<Self, PlanError> {
                let check: fn(&str) -> bool = $check;
                if check(s) {
                    Ok(Self(s.to_owned()))
                } else {
                    Err(PlanError::invalid($field, $why))
                }
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({:?})", stringify!($name), self.0)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = String::deserialize(d)?;
                Self::parse(&s).map_err(serde::de::Error::custom)
            }
        }
    };
}

string_id!(
    InstallationId,
    "installation",
    |s| {
        // Today's service id: `<creator>--<slug>` (two DNS labels of at most 32), or one label.
        let mut parts = s.split("--");
        let first = parts.next().unwrap_or_default();
        let second = parts.next();
        parts.next().is_none()
            && is_dns_label(first, 32)
            && second.is_none_or(|p| is_dns_label(p, 32))
    },
    "must be <creator>--<slug> of lowercase letters, digits and single dashes"
);

string_id!(
    VolumeId,
    "volumeId",
    |s| s.len() >= 3
        && s.len() <= 64
        && s.starts_with("v-")
        && s.chars().skip(2).all(is_lower_alnum),
    "must be v- followed by lowercase letters and digits"
);

string_id!(
    SecretHandle,
    "secretHandle",
    |s| s.len() >= 3
        && s.len() <= 64
        && s.starts_with("s-")
        && s.chars().skip(2).all(is_lower_alnum),
    "must be s- followed by lowercase letters and digits"
);

string_id!(
    EnvName,
    "env",
    |s| {
        let mut chars = s.chars();
        s.len() <= 128
            && chars
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    },
    "variable names are ^[A-Za-z_][A-Za-z0-9_]{0,127}$"
);

string_id!(
    Repository,
    "image.repository",
    is_repository,
    "must be an OCI repository name without tag or digest"
);

/// An OCI repository: optional `registry[:port]/` then lowercase path components.
fn is_repository(s: &str) -> bool {
    if s.is_empty() || s.len() > 255 {
        return false;
    }
    let mut comps: Vec<&str> = s.split('/').collect();
    let first = comps.first().copied().unwrap_or_default();
    let has_registry =
        comps.len() > 1 && (first.contains('.') || first.contains(':') || first == "localhost");
    if has_registry {
        let (host, port) = match first.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (first, None),
        };
        let host_ok = !host.is_empty()
            && host
                .split('.')
                .all(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
        let port_ok = port
            .is_none_or(|p| !p.is_empty() && p.len() <= 5 && p.chars().all(|c| c.is_ascii_digit()));
        if !host_ok || !port_ok {
            return false;
        }
        comps.remove(0);
    }
    !comps.is_empty() && comps.iter().all(|c| is_path_component(c))
}

/// `[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*`
fn is_path_component(c: &str) -> bool {
    let b = c.as_bytes();
    if b.is_empty()
        || !b.iter().all(|&x| {
            x.is_ascii_lowercase() || x.is_ascii_digit() || x == b'.' || x == b'_' || x == b'-'
        })
    {
        return false;
    }
    let first_ok = b.first().is_some_and(|x| x.is_ascii_alphanumeric());
    let last_ok = b.last().is_some_and(|x| x.is_ascii_alphanumeric());
    first_ok
        && last_ok
        && !c.contains("..")
        && !c.contains("___")
        && !c.contains("._")
        && !c.contains("_.")
        && !c.contains(".-")
        && !c.contains("-.")
        && !c.contains("_-")
        && !c.contains("-_")
}

/// A SHA-256 content digest, written `sha256:<64 lowercase hex>`.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Digest([u8; 32]);

impl Digest {
    pub fn parse(s: &str) -> Result<Self, PlanError> {
        let bad = || PlanError::invalid("digest", "must be sha256:<64 lowercase hex>");
        let hexpart = s.strip_prefix("sha256:").ok_or_else(bad)?;
        if hexpart.len() != 64 {
            return Err(bad());
        }
        let bytes = hex::decode(hexpart).ok_or_else(bad)?;
        let arr: [u8; 32] = bytes.try_into().map_err(|_| bad())?;
        Ok(Self(arr))
    }
    pub fn of(bytes: &[u8]) -> Self {
        use sha2::Digest as _;
        Self(sha2::Sha256::digest(bytes).into())
    }
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Display for Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "sha256:{}", hex::encode(&self.0))
    }
}

impl fmt::Debug for Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Digest({self})")
    }
}

impl Serialize for Digest {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Digest {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Self::parse(&s).map_err(serde::de::Error::custom)
    }
}

/// The engine-side name of an installation's one workload: `flagship-<installation>`, the same
/// name `AppRunner.containerName` gives it today, so existing containers are adopted by name and
/// the engine itself refuses a second copy.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct WorkloadName(String);

impl WorkloadName {
    pub fn for_installation(id: &InstallationId) -> Self {
        Self(format!("flagship-{}", id.as_str()))
    }
    pub fn installation(&self) -> Option<InstallationId> {
        self.0
            .strip_prefix("flagship-")
            .and_then(|s| InstallationId::parse(s).ok())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for WorkloadName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installation_ids_follow_service_ids() {
        for ok in ["alice--notes", "photos", "a1--b-2"] {
            assert!(InstallationId::parse(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "Alice--notes",
            "a---b",
            "a--b--c",
            "-a",
            "a-",
            "a/../b",
            "a b",
            "a|b",
            &"x".repeat(33),
        ] {
            assert!(InstallationId::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn repositories() {
        for ok in [
            "ghcr.io/flagship/photos",
            "localhost:5000/x",
            "library/nginx",
            "nginx",
            "a.b/c_d/e-f",
            "docker.io/pgvector/pgvector",
        ] {
            assert!(Repository::parse(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "Nginx",
            "nginx:latest",
            "nginx@sha256:00",
            "a//b",
            "/a",
            "a/",
            "a/-b",
            "x:99999999/y",
            "a|b",
        ] {
            assert!(Repository::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn digests() {
        let d = Digest::of(b"x");
        assert_eq!(Digest::parse(&d.to_string()), Ok(d));
        assert!(Digest::parse("sha256:ABCD").is_err());
        assert!(Digest::parse(&format!("sha512:{}", "a".repeat(64))).is_err());
        assert!(Digest::parse(&format!("sha256:{}", "A".repeat(64))).is_err());
    }

    #[test]
    fn workload_names_round_trip() {
        let id = InstallationId::parse("alice--notes");
        assert!(id.is_ok());
        if let Ok(id) = id {
            let n = WorkloadName::for_installation(&id);
            assert_eq!(n.as_str(), "flagship-alice--notes");
            assert_eq!(n.installation(), Some(id));
        }
    }
}
