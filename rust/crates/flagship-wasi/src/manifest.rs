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
const MAX_STORES: usize = 16;
const MAX_EGRESS: usize = 64;
const MAX_PLATFORM_ENV: usize = 128;
const MAX_PLATFORM_VALUE_BYTES: usize = 16 * 1024;

/// What a WASI app asks for, in the same shape the OCI manifest
/// (`docs/manifest.md`) uses for data stores and egress. It is a request:
/// nothing in it takes effect until [`WasiGrant::admit`] has checked it
/// against the owner-approved module digest and the platform ceilings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WasiCapabilityManifest {
    pub schema: String,
    /// The installation this manifest belongs to (`<creator>-<slug>`). A
    /// compiled module is bound to it and never serves another app.
    #[serde(default)]
    pub app_id: String,
    /// `command` runs `_start` once; `http-proxy` runs it once per HTTP
    /// request under the Flagship CGI profile (`docs/wasi-apps.md`).
    #[serde(default)]
    pub world: WasiWorld,
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

/// The two worlds the box runs. Both are WASI preview 1 core modules.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WasiWorld {
    #[default]
    Command,
    HttpProxy,
}

/// A host call an app may import from `flagship_v1`. Each one is behind a
/// manifest capability; a module that imports one its manifest did not ask
/// for is refused before it is linked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum HostCall {
    /// `network.egress`: an HTTP(S) request to a declared host, made by the
    /// box (which also checks the owner's access list), never by the guest.
    HttpFetch,
    /// `data.stores.postgres`: one SQL statement on the app's own database,
    /// run by the box as the app's own role.
    DbQuery,
    /// Fetch the full answer of the last call when the guest's buffer was
    /// too small. Available whenever one of the calls above is.
    LastResponse,
}

impl HostCall {
    pub const MODULE: &'static str = "flagship_v1";

    pub fn from_import(name: &str) -> Option<Self> {
        match name {
            "http_fetch" => Some(Self::HttpFetch),
            "db_query" => Some(Self::DbQuery),
            "last_response" => Some(Self::LastResponse),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::HttpFetch => "http_fetch",
            Self::DbQuery => "db_query",
            Self::LastResponse => "last_response",
        }
    }
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
    #[error("appId must be the installation id (lowercase letters, digits, dots and dashes)")]
    AppId,
    #[error("postgres store name {0:?} is not a valid name")]
    StoreName(String),
}

/// What the worker will actually let a run do. Built only by
/// [`WasiGrant::admit`]; a manifest never grants itself anything.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WasiGrant {
    pub(crate) app_id: String,
    pub(crate) world: WasiWorld,
    pub(crate) egress_hosts: Vec<String>,
    pub(crate) postgres_stores: Vec<String>,
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
        if !manifest.app_id.is_empty() && !is_app_id(&manifest.app_id) {
            return Err(ManifestError::AppId);
        }
        // A WASI app has no sockets: Postgres and egress are host calls the
        // box makes for it (`db_query`, `http_fetch`), never connections.
        let postgres_stores = match &manifest.data.stores.postgres {
            None | Some(PostgresStores::Flag(false)) => Vec::new(),
            Some(PostgresStores::Flag(true)) => vec!["default".to_owned()],
            Some(PostgresStores::Named(names)) => {
                if names.len() > MAX_STORES {
                    return Err(ManifestError::TooMany("postgres stores"));
                }
                for n in names {
                    if !is_label(n) {
                        return Err(ManifestError::StoreName(n.clone()));
                    }
                }
                names.clone()
            }
        };
        if manifest.network.egress.len() > MAX_EGRESS {
            return Err(ManifestError::TooMany("egress hosts"));
        }
        let mut egress_hosts = Vec::new();
        for e in &manifest.network.egress {
            if !is_host_name(e.host()) {
                return Err(ManifestError::EgressHost(e.host().to_owned()));
            }
            egress_hosts.push(e.host().to_owned());
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
            app_id: manifest.app_id.clone(),
            world: manifest.world,
            module_digest: manifest.module.digest.clone(),
            args: manifest.args.clone(),
            env,
            preopens,
            limits: manifest.limits,
            egress_hosts,
            postgres_stores,
        })
    }

    /// Variables the box adds at start: the owner's env and `FLAGSHIP_*`
    /// platform values. They are not part of the manifest (an app can't
    /// ask for them), and a manifest variable never shadows one.
    pub fn with_platform_env(
        mut self,
        vars: &BTreeMap<String, String>,
    ) -> Result<Self, ManifestError> {
        if vars.len() > MAX_PLATFORM_ENV {
            return Err(ManifestError::TooMany("platform env"));
        }
        for (k, v) in vars {
            if !is_env_name(k) {
                return Err(ManifestError::EnvName(k.clone()));
            }
            if v.contains('\0') || v.len() > MAX_PLATFORM_VALUE_BYTES {
                return Err(ManifestError::BadString("platform env value"));
            }
            self.env.retain(|(name, _)| name != k);
            self.env.push((k.clone(), v.clone()));
        }
        Ok(self)
    }

    pub fn app_id(&self) -> &str {
        &self.app_id
    }

    pub fn world(&self) -> WasiWorld {
        self.world
    }

    /// Hosts `http_fetch` may name. The box still checks the owner's
    /// access list for every call.
    pub fn egress_hosts(&self) -> &[String] {
        &self.egress_hosts
    }

    pub fn postgres_stores(&self) -> &[String] {
        &self.postgres_stores
    }

    /// Whether the manifest asked for the capability behind `call`.
    pub fn grants(&self, call: HostCall) -> bool {
        match call {
            HostCall::HttpFetch => !self.egress_hosts.is_empty(),
            HostCall::DbQuery => !self.postgres_stores.is_empty(),
            HostCall::LastResponse => {
                !self.egress_hosts.is_empty() || !self.postgres_stores.is_empty()
            }
        }
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

fn is_app_id(s: &str) -> bool {
    s.len() <= 128
        && s.bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
}

fn is_label(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 63
        && s.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
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
    fn postgres_and_egress_become_brokered_host_calls() {
        let base = format!(r#""schema":"{MANIFEST_SCHEMA}","module":{{"digest":"{DIGEST}"}}"#);
        let c = Ceilings::default();
        let none = WasiGrant::admit(&manifest(&format!("{{{base}}}")), DIGEST, &c)
            .unwrap_or_else(|e| unreachable!("{e}"));
        assert!(!none.grants(HostCall::HttpFetch));
        assert!(!none.grants(HostCall::DbQuery));
        assert!(!none.grants(HostCall::LastResponse));
        let pg = manifest(&format!(
            r#"{{{base},"data":{{"stores":{{"postgres":true}}}}}}"#
        ));
        let g = WasiGrant::admit(&pg, DIGEST, &c).unwrap_or_else(|e| unreachable!("{e}"));
        assert!(g.grants(HostCall::DbQuery));
        assert!(!g.grants(HostCall::HttpFetch));
        assert_eq!(g.postgres_stores(), &["default".to_owned()]);
        let eg = manifest(&format!(
            r#"{{{base},"network":{{"egress":[{{"host":"api.example.com","why":"sync"}}]}}}}"#
        ));
        let g = WasiGrant::admit(&eg, DIGEST, &c).unwrap_or_else(|e| unreachable!("{e}"));
        assert!(g.grants(HostCall::HttpFetch));
        assert_eq!(g.egress_hosts(), &["api.example.com".to_owned()]);
        let bad = manifest(&format!(
            r#"{{{base},"network":{{"egress":["Not A Host"]}}}}"#
        ));
        assert!(matches!(
            WasiGrant::admit(&bad, DIGEST, &c),
            Err(ManifestError::EgressHost(_))
        ));
        let bad_store = manifest(&format!(
            r#"{{{base},"data":{{"stores":{{"postgres":["../x"]}}}}}}"#
        ));
        assert!(matches!(
            WasiGrant::admit(&bad_store, DIGEST, &c),
            Err(ManifestError::StoreName(_))
        ));
        let bad_id = manifest(&format!(r#"{{{base},"appId":"../other"}}"#));
        assert_eq!(
            WasiGrant::admit(&bad_id, DIGEST, &c),
            Err(ManifestError::AppId)
        );
    }

    #[test]
    fn platform_env_wins_over_the_manifest() {
        let m = manifest(&format!(
            r#"{{"schema":"{MANIFEST_SCHEMA}","module":{{"digest":"{DIGEST}"}},"env":{{"PORT":"1"}}}}"#
        ));
        let g = WasiGrant::admit(&m, DIGEST, &Ceilings::default())
            .unwrap_or_else(|e| unreachable!("{e}"));
        let mut vars = BTreeMap::new();
        vars.insert("PORT".to_owned(), "2".to_owned());
        vars.insert("FLAGSHIP_APP_ID".to_owned(), "alice-notes".to_owned());
        let g = g
            .with_platform_env(&vars)
            .unwrap_or_else(|e| unreachable!("{e}"));
        assert!(g.env().contains(&("PORT".to_owned(), "2".to_owned())));
        assert!(!g.env().contains(&("PORT".to_owned(), "1".to_owned())));
        let mut bad = BTreeMap::new();
        bad.insert("1BAD".to_owned(), String::new());
        assert!(g.with_platform_env(&bad).is_err());
    }

    #[test]
    fn refuses_what_it_cannot_enforce() {
        let base = format!(r#""schema":"{MANIFEST_SCHEMA}","module":{{"digest":"{DIGEST}"}}"#);
        let c = Ceilings::default();
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
