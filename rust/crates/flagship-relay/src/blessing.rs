//! The relay's own key and the daily `.com`-CA-signed blessing for it (`hubBlessingProvider.ts`,
//! docs/maintainer-trust-enforcement.md "The relay blessing").
//!
//! The hub holds an Ed25519 key (ephemeral per boot, or kept in a file on a mounted volume), asks `.com`
//! (`POST /api/services/hub-blessing`) to bless its public key, refreshes the answer every 12 hours and keeps the
//! last good one in memory. Each accepting HELLO_ACK carries the blessing and a signature over the box's HELLO
//! nonce made with the blessed key, so a box can tell that the relay it reached holds the blessed key. A relay
//! with no blessing yet (startup race, `.com` down) sends a plain ack: a box keeps relaying.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};

use crate::hub::BlessingSource;
use crate::outbound::com_policy::HttpPost;
use crate::payload::HelloAckTrust;

pub const DEFAULT_REFRESH: Duration = Duration::from_secs(12 * 60 * 60);

fn hex(b: &[u8]) -> String {
    flagship_crypto::trust::hex(b)
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || !s.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    s.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).ok()?, 16).ok())
        .collect()
}

/// Load the persisted key (64 hex digits) or make a fresh one, writing it back only when `path` is given and
/// writable; a write failure (no volume) is not fatal: ephemeral per boot is the documented default.
///
/// # Errors
/// The OS refused randomness.
pub fn load_or_create_key(path: Option<&Path>) -> Result<SigningKey, getrandom::Error> {
    let kept = path
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| unhex(t.trim()))
        .and_then(|v| <[u8; 32]>::try_from(v.as_slice()).ok());
    if let Some(seed) = kept {
        return Ok(SigningKey::from_bytes(&seed));
    }
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed)?;
    if let Some(p) = path {
        write_private(p, &hex(&seed));
    }
    Ok(SigningKey::from_bytes(&seed))
}

fn write_private(p: &Path, text: &str) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let _ = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(p)
        .and_then(|mut f| f.write_all(text.as_bytes()));
}

pub struct HubBlessing {
    key: SigningKey,
    hub_host: String,
    url: String,
    shared_secret: Option<String>,
    current: Mutex<Option<Value>>,
    log: Box<dyn Fn(&str) + Send + Sync>,
}

impl std::fmt::Debug for HubBlessing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HubBlessing")
            .field("hub_host", &self.hub_host)
            .finish_non_exhaustive()
    }
}

impl HubBlessing {
    #[must_use]
    pub fn new(
        key: SigningKey,
        hub_host: &str,
        com_base_url: &str,
        shared_secret: Option<&str>,
        log: Box<dyn Fn(&str) + Send + Sync>,
    ) -> Self {
        Self {
            key,
            hub_host: hub_host.to_owned(),
            url: format!(
                "{}/api/services/hub-blessing",
                com_base_url.trim_end_matches('/')
            ),
            shared_secret: shared_secret.map(str::to_owned),
            current: Mutex::new(None),
            log,
        }
    }

    /// Lower-hex public key, the one `.com` blesses.
    #[must_use]
    pub fn hub_key_pub_hex(&self) -> String {
        hex(self.key.verifying_key().as_bytes())
    }

    #[must_use]
    pub fn has_blessing(&self) -> bool {
        self.current.lock().is_ok_and(|c| c.is_some())
    }

    /// Fetch a fresh blessing. Best effort: on any failure the previous blessing (or none) stays and the reason is logged.
    pub fn refresh(&self, http: &dyn HttpPost) {
        let body = json!({ "hubKeyPub": self.hub_key_pub_hex(), "hubHost": self.hub_host });
        let auth = self.shared_secret.as_ref().map(|s| format!("Bearer {s}"));
        let headers: Vec<(&str, &str)> =
            auth.iter().map(|a| ("authorization", a.as_str())).collect();
        match http.post_json(&self.url, &headers, &body) {
            Ok((status, json)) if (200..300).contains(&status) => {
                let b = json.get("blessing").filter(|b| b.is_object());
                let ours = b.is_some_and(|b| {
                    b.get("kind").and_then(Value::as_str) == Some("ServiceBlessing")
                        && b.get("hubKeyPub")
                            .and_then(Value::as_str)
                            .is_some_and(|k| k.eq_ignore_ascii_case(&self.hub_key_pub_hex()))
                });
                match (ours, b) {
                    (true, Some(b)) => {
                        (self.log)(&format!(
                            "[relay-blessing] refreshed expiresAt={} signedBy={}",
                            b.get("expiresAt")
                                .map_or_else(|| "?".to_owned(), ToString::to_string),
                            b.get("signedBy").and_then(Value::as_str).unwrap_or("?")
                        ));
                        if let Ok(mut c) = self.current.lock() {
                            *c = Some(b.clone());
                        }
                    }
                    _ => (self.log)(
                        "[relay-blessing] refresh returned no usable blessing (keeping prior)",
                    ),
                }
            }
            Ok((status, _)) => (self.log)(&format!(
                "[relay-blessing] refresh failed status={status} (keeping prior blessing)"
            )),
            Err(e) => (self.log)(&format!(
                "[relay-blessing] refresh error={e} (keeping prior blessing)"
            )),
        }
    }

    /// Refresh now, then on `every`; the blocking post runs off the async threads.
    pub fn spawn(
        self: &Arc<Self>,
        http: Arc<dyn HttpPost>,
        every: Duration,
    ) -> tokio::task::JoinHandle<()> {
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let mut t = tokio::time::interval(every);
            t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                t.tick().await;
                let (m, h) = (Arc::clone(&me), Arc::clone(&http));
                if tokio::task::spawn_blocking(move || m.refresh(h.as_ref()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        })
    }
}

impl BlessingSource for HubBlessing {
    fn trust_for(&self, nonce_hex: &str) -> Option<HelloAckTrust> {
        let blessing = self.current.lock().ok()?.clone()?;
        let nonce = unhex(nonce_hex)?;
        Some(HelloAckTrust {
            service_blessing_json: Some(blessing.to_string()),
            hub_sig: Some(hex(&self.key.sign(&nonce).to_bytes())),
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use ed25519_dalek::Verifier;
    use std::sync::atomic::{AtomicUsize, Ordering};

    type Call = (String, Vec<(String, String)>, Value);

    struct Fake {
        reply: Mutex<Result<(u16, Value), String>>,
        seen: Mutex<Vec<Call>>,
    }

    impl HttpPost for Fake {
        fn post_json(
            &self,
            url: &str,
            headers: &[(&str, &str)],
            body: &Value,
        ) -> Result<(u16, Value), String> {
            self.seen.lock().unwrap().push((
                url.into(),
                headers
                    .iter()
                    .map(|(k, v)| ((*k).into(), (*v).into()))
                    .collect(),
                body.clone(),
            ));
            self.reply.lock().unwrap().clone()
        }
    }

    fn provider() -> (HubBlessing, Arc<AtomicUsize>) {
        let logs = Arc::new(AtomicUsize::new(0));
        let l = Arc::clone(&logs);
        let p = HubBlessing::new(
            SigningKey::from_bytes(&[3; 32]),
            "flagship.services",
            "https://com.test/",
            Some("s"),
            Box::new(move |_| {
                l.fetch_add(1, Ordering::Relaxed);
            }),
        );
        (p, logs)
    }

    fn blessing_for(p: &HubBlessing) -> Value {
        json!({"kind":"ServiceBlessing","hubKeyPub":p.hub_key_pub_hex().to_uppercase(),"hubHost":"flagship.services","expiresAt":1,"signedBy":"ca"})
    }

    #[test]
    fn no_blessing_means_a_plain_ack_and_a_good_one_signs_the_box_nonce() {
        let (p, _) = provider();
        assert!(p.trust_for("00ff").is_none());
        let http = Fake {
            reply: Mutex::new(Ok((200, json!({"blessing": blessing_for(&p)})))),
            seen: Mutex::new(Vec::new()),
        };
        p.refresh(&http);
        let seen = http.seen.lock().unwrap();
        assert_eq!(seen[0].0, "https://com.test/api/services/hub-blessing");
        assert_eq!(
            seen[0].1,
            vec![("authorization".to_owned(), "Bearer s".to_owned())]
        );
        assert_eq!(
            seen[0].2,
            json!({"hubKeyPub": p.hub_key_pub_hex(), "hubHost": "flagship.services"})
        );
        drop(seen);
        let t = p.trust_for("00ff10").unwrap();
        let b: Value = serde_json::from_str(&t.service_blessing_json.unwrap()).unwrap();
        assert_eq!(b["kind"], "ServiceBlessing");
        let sig =
            ed25519_dalek::Signature::from_slice(&unhex(&t.hub_sig.unwrap()).unwrap()).unwrap();
        assert!(
            p.key
                .verifying_key()
                .verify(&[0x00, 0xff, 0x10], &sig)
                .is_ok(),
            "signed over the nonce bytes, not its hex text"
        );
        assert!(
            p.trust_for("zz").is_none(),
            "a nonce that is not hex gets a plain ack"
        );
    }

    #[test]
    fn a_bad_answer_keeps_the_prior_blessing() {
        let (p, logs) = provider();
        let http = Fake {
            reply: Mutex::new(Ok((200, json!({"blessing": blessing_for(&p)})))),
            seen: Mutex::new(Vec::new()),
        };
        p.refresh(&http);
        for bad in [
            Ok((500, json!({}))),
            Err("down".to_owned()),
            Ok((
                200,
                json!({"blessing": {"kind":"ServiceBlessing","hubKeyPub": hex(&[9; 32])}}),
            )),
            Ok((
                200,
                json!({"blessing": {"kind":"Other","hubKeyPub": p.hub_key_pub_hex()}}),
            )),
            Ok((200, json!({}))),
        ] {
            *http.reply.lock().unwrap() = bad;
            p.refresh(&http);
            assert!(p.has_blessing());
        }
        assert_eq!(logs.load(Ordering::Relaxed), 6);
    }

    #[test]
    fn a_key_file_is_reused_and_a_missing_one_is_created_private() {
        let dir = std::env::temp_dir().join(format!("blessing-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("hub.key");
        let a = load_or_create_key(Some(&f)).unwrap();
        let b = load_or_create_key(Some(&f)).unwrap();
        assert_eq!(a.to_bytes(), b.to_bytes());
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&f).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let c = load_or_create_key(None).unwrap();
        assert_ne!(a.to_bytes(), c.to_bytes());
        std::fs::write(&f, "not hex").unwrap();
        assert_ne!(
            load_or_create_key(Some(&f)).unwrap().to_bytes(),
            a.to_bytes(),
            "garbage is replaced"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
