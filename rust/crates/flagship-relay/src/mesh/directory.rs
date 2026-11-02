//! The relay's identity in the mesh (relay-mesh.md §3): its own RelayBlessing, asked for with proof of possession of
//! the relay key (`POST /api/services/relay-blessing`) and renewed while half of its life is left (owner decision
//! 2026-11-01: blessings are short-lived and renewed with proof of key; no other relay→`.com` handshake), and the
//! CA-signed directory with every relay's current blessing (`directory.json`, gossiped on bridges). Both verify against
//! the CA keys authorized now ([`super::ca`]); a directory never goes back a version.

use std::sync::Arc;
use std::time::Duration;

use ed25519_dalek::Signer;
use flagship_crypto::relay_mesh::{
    RelayBlessing, RelayBlessingRequest, RelayDirectory, RelayKind, directory_relay,
    newer_relay_directory, relay_blessing_request_canonical, sign_canonical, verify_relay_blessing,
    verify_relay_directory,
};
use serde_json::{Value, json};

use super::{Mesh, Own, now, wire};
use crate::authority::BoxFut;
use crate::hub::BlessingSource;
use crate::payload::HelloAckTrust;

/// Asks `.com` for this relay's blessing: the body is `{relayId, relayKey, servicesApex, issuedAt, signature}`, the
/// answer `{relayBlessing, serviceBlessing}` (plus, with an encrypted feed, the sealed mesh key).
pub trait BlessingIssuer: Send + Sync + 'static {
    fn issue<'a>(&'a self, body: Value) -> BoxFut<'a, Result<Value, String>>;
}

/// `POST <com>/api/services/relay-blessing`.
pub struct HttpIssuer {
    url: String,
    agent: ureq::Agent,
}

impl std::fmt::Debug for HttpIssuer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpIssuer")
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

impl HttpIssuer {
    #[must_use]
    pub fn new(com_base_url: &str) -> Arc<Self> {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(10)))
            .max_redirects(0)
            .http_status_as_error(false)
            .build();
        Arc::new(Self {
            url: format!(
                "{}/api/services/relay-blessing",
                com_base_url.trim_end_matches('/')
            ),
            agent: ureq::Agent::new_with_config(config),
        })
    }
}

impl BlessingIssuer for HttpIssuer {
    fn issue<'a>(&'a self, body: Value) -> BoxFut<'a, Result<Value, String>> {
        let (url, agent) = (self.url.clone(), self.agent.clone());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let mut r = agent
                    .post(&url)
                    .header("content-type", "application/json")
                    .send(body.to_string())
                    .map_err(|e| e.to_string())?;
                let status = r.status().as_u16();
                let text = r
                    .body_mut()
                    .with_config()
                    .limit(1 << 20)
                    .read_to_string()
                    .map_err(|e| e.to_string())?;
                if status != 200 {
                    return Err(format!("status {status}"));
                }
                serde_json::from_str(&text).map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())?
        })
    }
}

/// How often the blessing task looks (and retries after a failure).
const BLESSING_CHECK: Duration = Duration::from_secs(60);
/// A blessing is renewed once a day (§3.2 as amended: TTL 30 d, renewed every 24 h).
const BLESSING_RENEW_MS: u64 = 24 * 60 * 60 * 1000;

impl Mesh {
    pub(crate) fn spawn_blessing(&self) -> tokio::task::AbortHandle {
        let me = self.clone();
        tokio::spawn(async move {
            let mut t = tokio::time::interval(BLESSING_CHECK);
            loop {
                t.tick().await;
                if me.blessing_due() {
                    me.refresh_blessing().await;
                }
            }
        })
        .abort_handle()
    }

    /// No valid blessing, one a day old (`.com` renews every 24 h, §3.2 as amended), or one past half its life (a
    /// 26 h blessing of chunk A's constants).
    fn blessing_due(&self) -> bool {
        let t = now();
        self.with_state(|s| {
            s.own.as_ref().is_none_or(|o| {
                let b = &o.blessing.body;
                let half = b.expires_at.saturating_sub(b.issued_at) / 2;
                t.saturating_sub(b.issued_at) >= BLESSING_RENEW_MS.min(half)
            })
        })
        .unwrap_or(true)
    }

    /// Ask `.com` for a fresh blessing (proof of possession). Returns whether one was adopted.
    pub async fn refresh_blessing(&self) -> bool {
        let req = RelayBlessingRequest {
            relay_id: self.relay_id().to_owned(),
            relay_key: self.0.relay_pub.clone(),
            services_apex: self.0.cfg.apex.clone(),
            issued_at: now(),
        };
        let Ok(canonical) = relay_blessing_request_canonical(&req) else {
            return false;
        };
        let body = json!({"relayId": req.relay_id, "relayKey": req.relay_key, "servicesApex": req.services_apex,
            "issuedAt": req.issued_at, "signature": sign_canonical(&self.0.key, &canonical)});
        let answer = match self.0.parts.issuer.issue(body).await {
            Ok(a) => a,
            Err(e) => {
                self.log(&format!(
                    "blessing request failed ({e}); keeping the one held"
                ));
                return false;
            }
        };
        let raw = answer.get("relayBlessing").cloned().unwrap_or(Value::Null);
        let Some(b) = wire::blessing_from_json(&raw) else {
            self.log("blessing answer holds no RelayBlessing");
            return false;
        };
        if !self.adopt_blessing(&b, &raw) {
            self.log("blessing answer did not verify for this relay");
            return false;
        }
        let service = answer
            .get("serviceBlessing")
            .filter(|v| v.is_object())
            .cloned();
        self.with_state(|s| {
            if let Some(o) = s.own.as_mut() {
                o.service = service;
            }
        });
        self.0.parts.decrypt.adopt(&answer, &self.0.key);
        self.log(&format!(
            "blessed until {} ({})",
            b.body.expires_at,
            b.body.relay_kind.as_str()
        ));
        true
    }

    /// A RelayBlessing from `.com`, `directory.json` or a peer: verified, kept per relay when newer; this relay's own
    /// becomes the one it serves.
    pub(crate) fn adopt_blessing(&self, b: &RelayBlessing, raw: &Value) -> bool {
        let keys = self.ca_keys();
        if verify_relay_blessing(b, &keys, now(), &self.0.cfg.apex).is_err() {
            return false;
        }
        let me = self.relay_id().to_owned();
        let mine = b.body.relay_id == me && b.body.relay_key == self.0.relay_pub;
        if b.body.relay_id == me && !mine {
            return false;
        }
        self.with_state(|s| {
            let newer = s
                .blessings
                .get(&b.body.relay_id)
                .is_none_or(|(had, _)| b.body.issued_at > had.body.issued_at);
            if newer {
                s.blessings
                    .insert(b.body.relay_id.clone(), (b.clone(), raw.clone()));
            }
            if mine
                && s.own
                    .as_ref()
                    .is_none_or(|o| b.body.issued_at > o.blessing.body.issued_at)
            {
                let service = s.own.as_ref().and_then(|o| o.service.clone());
                s.own = Some(Own {
                    blessing: b.clone(),
                    raw: raw.clone(),
                    service,
                });
            }
        });
        true
    }

    /// `directory.json`: `{directory, blessings}`.
    pub(crate) fn adopt_directory_file(&self, v: &Value) {
        if let Some(d) = v.get("directory").and_then(wire::directory_from_json) {
            self.adopt_directory(&d, v.get("directory").cloned().unwrap_or(Value::Null));
        }
        for raw in v
            .get("blessings")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(b) = wire::blessing_from_json(raw) {
                self.adopt_blessing(&b, raw);
            }
        }
    }

    /// A directory from the feed or a peer: verified under the CA keys, adopted only when newer (§3.3).
    pub(crate) fn adopt_directory(&self, d: &RelayDirectory, raw: Value) -> bool {
        let keys = self.ca_keys();
        if verify_relay_directory(d, &keys, now(), &self.0.cfg.apex).is_err() {
            return false;
        }
        let changed = self
            .with_state(|s| {
                if !newer_relay_directory(s.directory.as_ref().map(|x| &x.body), &d.body) {
                    return false;
                }
                let version_changed = s
                    .directory
                    .as_ref()
                    .is_none_or(|x| x.body.directory_version != d.body.directory_version);
                s.directory = Some(d.clone());
                s.directory_raw = Some(raw.clone());
                version_changed
            })
            .unwrap_or(false);
        if changed {
            self.on_directory_changed();
        }
        changed
    }

    fn on_directory_changed(&self) {
        let (version, gone) = self
            .with_state(|s| {
                let dir = s.directory.as_ref().map(|d| &d.body);
                let gone: Vec<String> = s
                    .store
                    .per_relay()
                    .keys()
                    .filter(|r| {
                        directory_relay(dir, r).is_none_or(|e| e.relay_kind != RelayKind::Full)
                            && **r != self.0.cfg.relay_id
                    })
                    .cloned()
                    .collect();
                (dir.map_or(0, |d| d.directory_version), gone)
            })
            .unwrap_or((0, Vec::new()));
        // Re-check the items of relays that left or are no longer `full` (legacy items need a full relay).
        let _ = self.with_ctx(|ctx, store| {
            store.retain_boxes(None, |i| {
                !gone.contains(&i.attachment.relay_id)
                    || flagship_crypto::relay_mesh::check_attachment_item(i, ctx, None).is_ok()
            });
        });
        self.log(&format!("directory version {version}"));
        self.sync_dialers();
        for p in self.live_peers() {
            if p.directory_version() < version {
                self.send_directory(&p);
            }
            let listed = self
                .with_state(|s| {
                    directory_relay(s.directory.as_ref().map(|d| &d.body), &p.relay_id).is_some()
                })
                .unwrap_or(false);
            if !listed {
                p.close(4401, "not-in-directory");
            }
        }
    }

    pub(crate) fn send_directory(&self, p: &super::bridge::Peer) {
        let msg = self
            .with_state(|s| {
                let raw = s.directory_raw.clone()?;
                let blessings: Vec<Value> = s.blessings.values().map(|(_, r)| r.clone()).collect();
                Some(json!({"type": "directory", "directory": raw, "blessings": blessings}))
            })
            .flatten();
        if let Some(m) = msg {
            p.send_json(&m);
        }
    }

    pub(crate) fn directory_version(&self) -> u64 {
        self.with_state(|s| s.directory.as_ref().map_or(0, |d| d.body.directory_version))
            .unwrap_or(0)
    }

    /// The blessing held for a relay (the copy a restarted peer is let in with, a move hint's target).
    pub(crate) fn held_blessing(&self, relay_id: &str) -> Option<(RelayBlessing, Value)> {
        self.with_state(|s| s.blessings.get(relay_id).cloned())
            .flatten()
    }

    /// HELLO_ACK's mesh fields for a `mesh-v1` box: this relay's id and its blessing's JSON.
    #[must_use]
    pub fn ack_fields(&self) -> Option<(String, String)> {
        let raw = self
            .with_state(|s| s.own.as_ref().map(|o| o.raw.to_string()))
            .flatten()?;
        Some((self.relay_id().to_owned(), raw))
    }

    /// Is this relay blessed now?
    #[must_use]
    pub fn blessed(&self) -> bool {
        let t = now();
        self.with_state(|s| {
            s.own
                .as_ref()
                .is_some_and(|o| o.blessing.body.expires_at > t)
        })
        .unwrap_or(false)
    }

    /// Adopt this relay's own blessing directly (tests, and a harness without `.com`).
    pub fn adopt_own_blessing(&self, raw: &Value, service: Option<Value>) -> bool {
        let Some(b) = wire::blessing_from_json(raw) else {
            return false;
        };
        let ok = self.adopt_blessing(&b, raw);
        if ok {
            self.with_state(|s| {
                if let Some(o) = s.own.as_mut() {
                    o.service = service;
                }
            });
        }
        ok
    }
}

/// HELLO_ACK trust from the mesh: the relay key (from the seed, never per boot) signs the box's nonce; the v1
/// ServiceBlessing (`hubKeyPub` = the relay key) keeps old boxes' observe-mode check passing (§13.1).
impl BlessingSource for Mesh {
    fn trust_for(&self, nonce_hex: &str) -> Option<HelloAckTrust> {
        let service = self
            .with_state(|s| s.own.as_ref().map(|o| o.service.clone()))
            .flatten()?;
        let nonce = decode_hex(nonce_hex)?;
        Some(HelloAckTrust {
            service_blessing_json: service.map(|v| v.to_string()),
            hub_sig: Some(flagship_crypto::trust::hex(
                &self.0.key.sign(&nonce).to_bytes(),
            )),
            ..HelloAckTrust::default()
        })
    }
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    s.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).ok()?, 16).ok())
        .collect()
}
