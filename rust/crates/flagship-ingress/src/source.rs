//! The certificate in service, reloaded from keyd on a timer and on demand. A handshake
//! reads only memory; keyd is asked again in the background, so a renewal takes effect for
//! new connections while existing ones keep their session.

use std::fmt;
use std::sync::{Arc, PoisonError, RwLock};
use std::time::Duration;

use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use tokio::sync::Notify;

use crate::cert::{CertError, ServingCert};
use crate::keyd::{KeydClient, KeydError};
use crate::signer::{ActiveHandles, KeydSigningKey};

#[derive(Debug)]
pub struct Loaded {
    pub cert: ServingCert,
    pub chain_pem: String,
    pub key: Arc<CertifiedKey>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Reload {
    Loaded,
    Switched,
    Unchanged,
}

#[derive(Debug)]
pub enum ReloadError {
    Keyd(KeydError),
    NoneInService,
    Cert(CertError),
}

impl fmt::Display for ReloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Keyd(e) => e.fmt(f),
            Self::NoneInService => f.write_str("keyd has no certificate in service"),
            Self::Cert(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for ReloadError {}

#[derive(Debug)]
pub struct CertSource {
    keyd: Arc<KeydClient>,
    handles: Arc<ActiveHandles>,
    current: RwLock<Option<Arc<Loaded>>>,
    nudge: Notify,
}

impl CertSource {
    /// `grace`: how long a replaced key may still finish a handshake (the handshake deadline).
    pub fn new(keyd: Arc<KeydClient>, grace: Duration) -> Self {
        Self {
            keyd,
            handles: Arc::new(ActiveHandles::new(grace)),
            current: RwLock::new(None),
            nudge: Notify::new(),
        }
    }

    pub fn current(&self) -> Option<Arc<Loaded>> {
        self.current
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Ask keyd what is in service. On any failure the certificate already held stays in
    /// service (flagship-tlsd does the same); signing still needs keyd, so nothing is served
    /// without it.
    pub fn reload(&self) -> Result<Reload, ReloadError> {
        let active = self
            .keyd
            .active()
            .map_err(ReloadError::Keyd)?
            .ok_or(ReloadError::NoneInService)?;
        let had = self.current();
        if let Some(cur) = &had
            && cur.cert.handle == active.handle
            && cur.chain_pem == active.chain_pem
        {
            return Ok(Reload::Unchanged);
        }
        let cert = ServingCert::from_active(&active).map_err(ReloadError::Cert)?;
        let signing = KeydSigningKey::new(
            Arc::clone(&self.keyd),
            Arc::clone(&self.handles),
            cert.handle.clone(),
            cert.spki.clone(),
            cert.public_point().to_vec(),
        );
        let key = Arc::new(CertifiedKey::new(cert.chain.clone(), Arc::new(signing)));
        let handle = cert.handle.clone();
        let loaded = Arc::new(Loaded {
            cert,
            chain_pem: active.chain_pem,
            key,
        });
        // Permit the new key before any handshake can pick it; the old one keeps its grace.
        self.handles.switch_to(&handle);
        *self.current.write().unwrap_or_else(PoisonError::into_inner) = Some(loaded);
        Ok(if had.is_some() {
            Reload::Switched
        } else {
            Reload::Loaded
        })
    }

    /// Ask the reloader to go to keyd now.
    pub fn request_reload(&self) {
        self.nudge.notify_one();
    }

    /// Reload every `refresh`, and at once when asked (SIGHUP, or a handshake that found
    /// nothing in service), never more than once per `min_gap`.
    pub async fn run_reloader(
        self: Arc<Self>,
        refresh: Duration,
        min_gap: Duration,
        log: fn(&str),
    ) {
        // A failure is logged when it starts or changes, not every tick.
        let mut last_error = String::new();
        loop {
            tokio::select! {
                () = tokio::time::sleep(refresh) => {}
                () = self.nudge.notified() => {}
            }
            let me = Arc::clone(&self);
            let outcome = match tokio::task::spawn_blocking(move || me.reload()).await {
                Ok(Ok(r)) => Ok(r),
                Ok(Err(e)) => Err(format!("reload: {e}")),
                Err(_) => Err("reload task failed".to_owned()),
            };
            match outcome {
                Ok(r) => {
                    if !last_error.is_empty() {
                        log("keyd reachable again");
                        last_error.clear();
                    }
                    match r {
                        Reload::Switched => log("switched to the certificate keyd put in service"),
                        Reload::Loaded => log("loaded the certificate in service"),
                        Reload::Unchanged => {}
                    }
                }
                Err(e) if e != last_error => {
                    log(&e);
                    last_error = e;
                }
                Err(_) => {}
            }
            tokio::time::sleep(min_gap).await;
        }
    }
}

/// rustls's view of the source: a certificate only for a name it covers.
#[derive(Debug)]
pub struct Resolver(pub Arc<CertSource>);

impl ResolvesServerCert for Resolver {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let name = hello.server_name()?;
        let Some(cur) = self.0.current() else {
            self.0.request_reload();
            return None;
        };
        cur.cert.covers(name).then(|| Arc::clone(&cur.key))
    }
}
