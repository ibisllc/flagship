use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::limits::{Ceilings, Limits};

pub const MANIFEST_SCHEMA: &str = "flagship/wasi-capabilities/v1";
/// Where `data.stores.files` appears in the guest, like `/data` in an OCI app.
pub const FILES_GUEST_PATH: &str = "/data";
/// Ephemeral scratch, like the OCI manifest's `data.path`.
pub const SCRATCH_GUEST_PATH: &str = "/scratch";

const MAX_ARGS: usize = 64;
const MAX_ENV: usize = 64;
const MAX_ARG_BYTES: usize = 4096;

/// What a WASI app asks for, in the same shape the OCI manifest
/// (`docs/manifest.md`) uses for data stores and egress. It is a request:
/// nothing in it takes effect until [`WasiGrant::admit`] has checked it
/// against the owner-approved module digest and the platform ceilings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WasiCapabilityManifest {
    pub schema: String,
    pub module: ModuleRef,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub data: DataSection,
    #[serde(default)]
    pub network: NetworkSection,
    #[serde(default)]
    pub limits: Limits,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleRef {
    /// `sha256:<64 hex>` of the `.wasm` (or WAT) bytes the owner approved.
    pub digest: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataSection {
    #[serde(default)]
    pub stores: DataStores,
    /// Ask for an ephemeral `/scratch` directory, emptied after every run.
    #[serde(default)]
    pub scratch: bool,
}

/// Mirrors `data.stores` in `flagship.app.json`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataStores {
    /// The app's one writable files folder, preopened at `/data`.
    #[serde(default)]
    pub files: bool,
    /// Same forms as the OCI manifest (`true` or a list of names). A WASI app
    /// has no sockets, so asking for Postgres is refused rather than ignored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub postgres: Option<PostgresStores>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PostgresStores {
    Flag(bool),
    Named(Vec<String>),
}

impl PostgresStores {
    fn requested(&self) -> bool {
        match self {
            Self::Flag(on) => *on,
            Self::Named(names) => !names.is_empty(),
        }
    }
}

/// Mirrors `network.egress` in `flagship.app.json`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkSection {
    #[serde(default)]
    pub egress: Vec<EgressHost>,
}

/// One declared egress host: a bare host or `{ host, why }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EgressHost {
    Host(String),
    Detailed { host: String, why: String },
}

impl EgressHost {
    pub fn host(&self) -> &str {
        match self {
            Self::Host(h) | Self::Detailed { host: h, .. } => h,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum PreopenPerms {
    ReadOnly,
    ReadWrite,
}

/// A host directory the broker opened for this run and the guest path it
/// appears at. The worker accepts it only if the grant names that guest path
/// with at least these permissions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preopen {
    pub guest: String,
    pub host: PathBuf,
    pub perms: PreopenPerms,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ManifestError {
    #[error("manifest schema must be {MANIFEST_SCHEMA}")]
    Schema,
    #[error("module digest must be sha256:<64 lowercase hex>")]
    DigestFormat,
    #[error("module digest does not match the approved module")]
    DigestNotApproved,
    #[error("env name {0:?} is not a valid variable name")]
    EnvName(String),
    #[error("env name {0:?} is reserved for the platform")]
    EnvReserved(String),
    #[error("too many {0}")]
    TooMany(&'static str),
    #[error("{0} contains a NUL byte or is too long")]
    BadString(&'static str),
    #[error("unsupported for WASI apps: {0}")]
    Unsupported(&'static str),
    #[error("egress host {0:?} is not a valid host name")]
    EgressHost(String),
    #[error("limit {0} is above the platform ceiling")]
    AboveCeiling(&'static str),
}

/// What the worker will actually let a run do. Built only by
/// [`WasiGrant::admit`]; a manifest never grants itself anything.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WasiGrant {
    pub(crate) module_digest: String,
    pub(crate) args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
    pub(crate) preopens: Vec<(String, PreopenPerms)>,
    pub(crate) limits: Limits,
}

impl WasiGrant {
    /// Check a manifest against the owner-approved module digest and the
    /// platform ceilings. Anything the worker cannot enforce is refused, not
    /// dropped: a WASI app that declares egress or Postgres gets an error
    /// until brokered network capabilities exist.
    pub fn admit(
        manifest: &WasiCapabilityManifest,
        approved_digest: &str,
        ceilings: &Ceilings,
    ) -> Result<Self, ManifestError> {
        if manifest.schema != MANIFEST_SCHEMA {
            return Err(ManifestError::Schema);
        }
        if !is_sha256_digest(&manifest.module.digest) {
            return Err(ManifestError::DigestFormat);
        }
        if manifest.module.digest != approved_digest {
            return Err(ManifestError::DigestNotApproved);
        }
        if manifest.args.len() > MAX_ARGS {
            return Err(ManifestError::TooMany("args"));
        }
        for a in &manifest.args {
            if a.contains('\0') || a.len() > MAX_ARG_BYTES {
                return Err(ManifestError::BadString("arg"));
            }
        }
        if manifest.env.len() > MAX_ENV {
            return Err(ManifestError::TooMany("env"));
        }
        for (k, v) in &manifest.env {
            if !is_env_name(k) {
                return Err(ManifestError::EnvName(k.clone()));
            }
            if k.starts_with("FLAGSHIP_") {
                return Err(ManifestError::EnvReserved(k.clone()));
            }
            if v.contains('\0') || v.len() > MAX_ARG_BYTES {
                return Err(ManifestError::BadString("env value"));
            }
        }
        if manifest
            .data
            .stores
            .postgres
            .as_ref()
            .is_some_and(PostgresStores::requested)
        {
            return Err(ManifestError::Unsupported(
                "data.stores.postgres (a WASI app has no sockets)",
            ));
        }
        for e in &manifest.network.egress {
            if !is_host_name(e.host()) {
                return Err(ManifestError::EgressHost(e.host().to_owned()));
            }
        }
        if !manifest.network.egress.is_empty() {
            return Err(ManifestError::Unsupported(
                "network.egress (brokered egress for WASI is not built yet)",
            ));
        }
        if let Some(field) = ceilings.exceeded_by(&manifest.limits) {
            return Err(ManifestError::AboveCeiling(field));
        }

        let mut env: Vec<(String, String)> = manifest
            .env
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let mut preopens = Vec::new();
        if manifest.data.stores.files {
            preopens.push((FILES_GUEST_PATH.to_owned(), PreopenPerms::ReadWrite));
            env.push(("FLAGSHIP_FILES_DIR".to_owned(), FILES_GUEST_PATH.to_owned()));
        }
        if manifest.data.scratch {
            preopens.push((SCRATCH_GUEST_PATH.to_owned(), PreopenPerms::ReadWrite));
        }
        Ok(Self {
            module_digest: manifest.module.digest.clone(),
            args: manifest.args.clone(),
            env,
            preopens,
            limits: manifest.limits,
        })
    }

    pub fn module_digest(&self) -> &str {
        &self.module_digest
    }

    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    pub fn env(&self) -> &[(String, String)] {
        &self.env
    }

    /// Guest paths this grant lets the broker preopen, with their maximum perms.
    pub fn preopens(&self) -> &[(String, PreopenPerms)] {
        &self.preopens
    }

    pub(crate) fn allows(&self, p: &Preopen) -> bool {
        self.preopens
            .iter()
            .any(|(guest, max)| *guest == p.guest && p.perms <= *max)
    }
}

pub(crate) fn is_sha256_digest(d: &str) -> bool {
    d.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn is_env_name(k: &str) -> bool {
    let mut bytes = k.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    k.len() <= 128
        && (first.is_ascii_alphabetic() || first == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn is_host_name(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && h.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

    fn manifest(json: &str) -> WasiCapabilityManifest {
        serde_json::from_str(json).unwrap_or_else(|e| unreachable!("fixture: {e}"))
    }

    #[test]
    fn files_store_preopens_data_and_sets_env() {
        let m = manifest(&format!(
            r#"{{"schema":"{MANIFEST_SCHEMA}","module":{{"digest":"{DIGEST}"}},
                "data":{{"stores":{{"files":true}}}},"env":{{"LOG_LEVEL":"info"}}}}"#
        ));
        let g = WasiGrant::admit(&m, DIGEST, &Ceilings::default());
        let g = g.unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!(
            g.preopens(),
            &[("/data".to_owned(), PreopenPerms::ReadWrite)]
        );
        assert!(
            g.env()
                .contains(&("FLAGSHIP_FILES_DIR".to_owned(), "/data".to_owned()))
        );
    }

    #[test]
    fn refuses_what_it_cannot_enforce() {
        let base = format!(r#""schema":"{MANIFEST_SCHEMA}","module":{{"digest":"{DIGEST}"}}"#);
        let c = Ceilings::default();
        let pg = manifest(&format!(
            r#"{{{base},"data":{{"stores":{{"postgres":true}}}}}}"#
        ));
        assert!(matches!(
            WasiGrant::admit(&pg, DIGEST, &c),
            Err(ManifestError::Unsupported(_))
        ));
        let eg = manifest(&format!(
            r#"{{{base},"network":{{"egress":[{{"host":"api.example.com","why":"sync"}}]}}}}"#
        ));
        assert!(matches!(
            WasiGrant::admit(&eg, DIGEST, &c),
            Err(ManifestError::Unsupported(_))
        ));
        let rsv = manifest(&format!(r#"{{{base},"env":{{"FLAGSHIP_APP_TOKEN":"x"}}}}"#));
        assert!(matches!(
            WasiGrant::admit(&rsv, DIGEST, &c),
            Err(ManifestError::EnvReserved(_))
        ));
        let big = manifest(&format!(
            r#"{{{base},"limits":{{"memoryMiB":999999,"tableElements":1,"fuel":1,
                "wallTimeMs":1,"stdoutBytes":1,"stderrBytes":1}}}}"#
        ));
        assert_eq!(
            WasiGrant::admit(&big, DIGEST, &c),
            Err(ManifestError::AboveCeiling("memoryMiB"))
        );
        let other = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
        let m = manifest(&format!("{{{base}}}"));
        assert_eq!(
            WasiGrant::admit(&m, other, &c),
            Err(ManifestError::DigestNotApproved)
        );
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let r: Result<WasiCapabilityManifest, _> = serde_json::from_str(&format!(
            r#"{{"schema":"{MANIFEST_SCHEMA}","module":{{"digest":"{DIGEST}"}},"privileged":true}}"#
        ));
        assert!(r.is_err());
    }
}
