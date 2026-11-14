//! The certificates in service, reloaded from keyd on a timer and on demand. A handshake
//! reads only memory; keyd is asked again in the background, so a renewal takes effect for
//! new connections while existing ones keep their session. A box holds up to two: a control
//! certificate for exactly its own name and an apps certificate for its app names, and each
//! handshake gets the one for its SNI (`pick`), as flagship-tlsd does.

use std::fmt;
use std::sync::{Arc, PoisonError, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use tokio::sync::Notify;

use crate::cert::{CertError, ServingCert};
use crate::keyd::{KeydClient, KeydError};
use crate::signer::{ActiveHandles, KeydSigningKey};

#[derive(Debug)]
pub struct Loaded {
    pub slot: &'static str,
    pub cert: ServingCert,
    pub chain_pem: String,
    /// keyd's not-after in Unix milliseconds; 0 when keyd did not say.
    pub not_after_ms: i64,
    /// The names keyd made the key for (the leaf's SANs are a subset).
    pub names: Vec<String>,
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
    current: RwLock<Option<Arc<Vec<Arc<Loaded>>>>>,
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

    pub fn current(&self) -> Option<Arc<Vec<Arc<Loaded>>>> {
        self.current
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Ask keyd what is in service. On any failure the certificates already held stay in
    /// service (flagship-tlsd does the same); signing still needs keyd, so nothing is served
    /// without it.
    pub fn reload(&self) -> Result<Reload, ReloadError> {
        let served = self.keyd.serving().map_err(ReloadError::Keyd)?;
        if served.is_empty() {
            return Err(ReloadError::NoneInService);
        }
        let had = self.current();
        if let Some(cur) = &had
            && cur.len() == served.len()
            && cur.iter().zip(&served).all(|(c, s)| {
                c.slot == s.slot
                    && c.cert.handle == s.cert.handle
                    && c.chain_pem == s.cert.chain_pem
            })
        {
            return Ok(Reload::Unchanged);
        }
        let mut next: Vec<Arc<Loaded>> = Vec::with_capacity(served.len());
        let mut first_error = None;
        for s in served {
            // The same key in two places (a slot and the default) shares one signer.
            let reused = had
                .iter()
                .flat_map(|v| v.iter())
                .chain(next.iter())
                .find(|c| c.cert.handle == s.cert.handle && c.chain_pem == s.cert.chain_pem)
                .map(|c| (c.cert.clone(), Arc::clone(&c.key)));
            let (cert, key) = match reused {
                Some(r) => r,
                None => match ServingCert::from_active(&s.cert) {
                    Ok(cert) => {
                        let signing = KeydSigningKey::new(
                            Arc::clone(&self.keyd),
                            Arc::clone(&self.handles),
                            cert.handle.clone(),
                            cert.spki.clone(),
                            cert.public_point().to_vec(),
                        );
                        let key =
                            Arc::new(CertifiedKey::new(cert.chain.clone(), Arc::new(signing)));
                        (cert, key)
                    }
                    Err(e) => {
                        first_error.get_or_insert(e);
                        continue;
                    }
                },
            };
            next.push(Arc::new(Loaded {
                slot: s.slot,
                cert,
                chain_pem: s.cert.chain_pem,
                not_after_ms: s.cert.not_after_ms,
                names: s.cert.names,
                key,
            }));
        }
        if next.is_empty() {
            return Err(first_error.map_or(ReloadError::NoneInService, ReloadError::Cert));
        }
        // Permit the new keys before any handshake can pick them; dropped ones keep their grace.
        let handles: Vec<String> = next.iter().map(|c| c.cert.handle.clone()).collect();
        self.handles.set(&handles);
        *self.current.write().unwrap_or_else(PoisonError::into_inner) = Some(Arc::new(next));
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

/// The certificate for a name: a direct name's certificate for exactly that name (and for no
/// other), the control certificate for exactly the name it was made for, the apps certificate
/// for any other, then whatever else covers the name. An in-date certificate wins over an
/// expired one; one that does not cover the name is never served.
pub fn pick<'a>(certs: &'a [Arc<Loaded>], name: &str, now_ms: i64) -> Option<&'a Arc<Loaded>> {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    let in_date = |c: &Loaded| c.not_after_ms == 0 || c.not_after_ms > now_ms;
    let direct = |c: &&Arc<Loaded>| {
        c.slot == "direct"
            && matches!(c.names.as_slice(), [n] if *n == name)
            && c.cert.covers(&name)
    };
    if let Some(c) = certs
        .iter()
        .filter(direct)
        .find(|c| in_date(c))
        .or_else(|| certs.iter().find(direct))
    {
        return Some(c);
    }
    let control_name = certs.iter().any(|c| {
        c.slot == "control"
            && c.names
                .iter()
                .any(|n| !n.starts_with("*.") && n.eq_ignore_ascii_case(&name))
    });
    let order: [&str; 3] = if control_name {
        ["control", "apps", "default"]
    } else {
        ["apps", "control", "default"]
    };
    for want_in_date in [true, false] {
        for slot in order {
            if let Some(c) = certs
                .iter()
                .find(|c| c.slot == slot && (!want_in_date || in_date(c)) && c.cert.covers(&name))
            {
                return Some(c);
            }
        }
    }
    None
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// rustls's view of the source: a certificate only for a name one covers.
#[derive(Debug)]
pub struct Resolver(pub Arc<CertSource>);

impl ResolvesServerCert for Resolver {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let name = hello.server_name()?;
        let Some(cur) = self.0.current() else {
            self.0.request_reload();
            return None;
        };
        pick(&cur, name, now_ms()).map(|c| Arc::clone(&c.key))
    }
}
