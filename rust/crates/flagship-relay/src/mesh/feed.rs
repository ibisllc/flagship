//! The public relay feed (relay-mesh.md §4): poll `head.json` every 5 s, fetch only the log pages past the applied
//! sequence, apply them with chunk A's `apply_relay_log` under the pinned log key, and act on what changed: the serving
//! gate decides again, attachments the log no longer admits are dropped, phones are re-checked, revoked relays are cut.
//! Heads and entries also arrive from peers (§6.3) and are verified the same way; a relay takes the newest head it can
//! verify wherever it came from.
//!
//! The head and the pages are encrypted to the mesh key of an epoch (owner decision 2026-11-01, §4.5.1):
//! [`SealedFeed`] opens them with the epoch keys sealed to this relay's key (delivered with its blessing, or read from
//! `keys/<relayId>.json` when a file names an epoch it lacks); the signatures stay over the plaintext canonical bytes,
//! so nothing else changes. [`PlainFeed`] is the identity (a clear feed, and tests).

use std::sync::Arc;
use std::time::{Duration, Instant};

use flagship_crypto::relay_mesh::{
    self as rm, FEED_PAGE_ENTRIES, MESH_LOG_PUSH_MAX, MESH_LOG_SINCE_MAX, RelayLogApply,
    RelayLogEntry, RelayLogHead, apply_relay_log, check_attachment_item, check_phone_item,
    newer_relay_log_head, relay_log_head_status, relay_log_revocations, verify_relay_log_head,
};
use serde_json::{Value, json};

use super::{Mesh, ms, now, wire};
use crate::authority::BoxFut;

/// Which feed file a body is (the decryptor's context: the page number is in clear, §4.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedFile {
    Head,
    Page(u64),
    Directory,
    /// `keys/<relayId>.json`: this relay's sealed epoch keys (in clear).
    Keys,
}

/// Fetches a feed file relative to `FLAGSHIP_RELAY_FEED_URL` (`head.json`, `log/<page>.json`, `directory.json`).
pub trait FeedFetch: Send + Sync + 'static {
    fn get<'a>(&'a self, path: &'a str) -> BoxFut<'a, Result<(u16, Vec<u8>), String>>;
}

/// Opens a fetched feed file. The format of an encrypted feed is `.com`'s (chunk B); this is where it plugs in.
pub trait FeedDecrypt: Send + Sync + 'static {
    /// # Errors
    /// The file cannot be opened (wrong epoch, no key yet, tampered).
    fn open(&self, file: FeedFile, body: &[u8]) -> Result<Vec<u8>, String>;
    /// The blessing issuer's whole answer, which carries this relay's sealed mesh key when the feed is encrypted.
    fn adopt(&self, _issued: &Value, _relay_key: &ed25519_dalek::SigningKey) {}
}

/// A clear feed: the bytes are the JSON.
#[derive(Debug, Clone, Copy, Default)]
pub struct PlainFeed;

/// The reason [`SealedFeed`] gives for a file whose epoch it holds no key for.
pub const NO_KEY: &str = "no-key";

/// The encrypted feed (§4.5.1): `RelayFeedSealed` heads and pages, opened with the epoch keys this relay received
/// sealed to its relay key. The directory and the key file are in clear.
pub struct SealedFeed {
    apex: String,
    relay_id: String,
    seed: zeroize::Zeroizing<[u8; 32]>,
    keys: std::sync::Mutex<std::collections::BTreeMap<u64, zeroize::Zeroizing<[u8; 32]>>>,
}

impl std::fmt::Debug for SealedFeed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SealedFeed")
            .field("relay", &self.relay_id)
            .field("epochs", &self.epochs())
            .finish_non_exhaustive()
    }
}

/// Standard base64 with padding (the sealed files' `ciphertext`).
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if !b.len().is_multiple_of(4) {
        return None;
    }
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => u32::from(c.checked_sub(b'A')?),
            b'a'..=b'z' => u32::from(c.checked_sub(b'a')?).checked_add(26)?,
            b'0'..=b'9' => u32::from(c.checked_sub(b'0')?).checked_add(52)?,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        })
    };
    let mut out = Vec::with_capacity((b.len() / 4).saturating_mul(3));
    let chunks = b.as_chunks::<4>().0;
    let last = chunks.len().saturating_sub(1);
    for (i, c) in chunks.iter().enumerate() {
        let pad = c.iter().rev().take_while(|x| **x == b'=').count();
        if pad > 2 || (pad > 0 && i != last) {
            return None;
        }
        let mut n: u32 = 0;
        for (j, x) in c.iter().enumerate() {
            let v = if j >= 4usize.saturating_sub(pad) {
                0
            } else {
                val(*x)?
            };
            n = (n << 6) | v;
        }
        let bytes = n.to_be_bytes();
        out.extend_from_slice(bytes.get(1..4usize.saturating_sub(pad))?);
    }
    Some(out)
}

impl SealedFeed {
    #[must_use]
    pub fn new(apex: &str, relay_id: &str, seed: [u8; 32]) -> Arc<Self> {
        Arc::new(Self {
            apex: apex.to_owned(),
            relay_id: relay_id.to_owned(),
            seed: zeroize::Zeroizing::new(seed),
            keys: std::sync::Mutex::new(std::collections::BTreeMap::new()),
        })
    }

    /// The epochs this relay holds a key for.
    #[must_use]
    pub fn epochs(&self) -> Vec<u64> {
        self.keys
            .lock()
            .map(|k| k.keys().copied().collect())
            .unwrap_or_default()
    }

    /// `openRelayMeshKeys`: keep every sealed line that names this apex, this relay and the epoch it is filed under.
    /// Returns how many keys were added.
    pub fn adopt_keys(&self, doc: &Value) -> usize {
        let s = |k: &str| doc.get(k).and_then(Value::as_str);
        if s("kind") != Some("RelayMeshKeys")
            || doc.get("version").and_then(Value::as_u64) != Some(1)
            || s("servicesApex") != Some(self.apex.as_str())
            || s("relayId") != Some(self.relay_id.as_str())
        {
            return 0;
        }
        let mut added = 0usize;
        for e in doc
            .get("epochs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (Some(epoch), Some(sealed)) = (
                e.get("epoch").and_then(Value::as_u64).filter(|x| *x >= 1),
                e.get("sealed").and_then(Value::as_str).and_then(decode_hex),
            ) else {
                continue;
            };
            let Ok(line) = flagship_crypto::relay_feed_seal::open_sealed_from_ed25519_seed(
                &sealed, &self.seed,
            ) else {
                continue;
            };
            let Some(key) = std::str::from_utf8(&line).ok().and_then(|l| {
                flagship_crypto::relay_feed_seal::mesh_key_from_line(
                    l,
                    &self.apex,
                    &self.relay_id,
                    epoch,
                )
            }) else {
                continue;
            };
            if let Ok(mut k) = self.keys.lock()
                && k.insert(epoch, zeroize::Zeroizing::new(key)).is_none()
            {
                added = added.saturating_add(1);
            }
        }
        added
    }
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2)
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    s.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).ok()?, 16).ok())
        .collect()
}

impl FeedDecrypt for SealedFeed {
    /// `openRelayFeedObject`: `malformed`, `wrong-place`, [`NO_KEY`] or `undecryptable`.
    fn open(&self, file: FeedFile, body: &[u8]) -> Result<Vec<u8>, String> {
        let (object, page) = match file {
            FeedFile::Directory | FeedFile::Keys => return Ok(body.to_vec()),
            FeedFile::Head => ("head", None),
            FeedFile::Page(p) => ("log", Some(p)),
        };
        let o: Value = serde_json::from_slice(body).map_err(|_| "malformed".to_owned())?;
        let s = |k: &str| o.get(k).and_then(Value::as_str);
        let epoch = o.get("epoch").and_then(Value::as_u64).filter(|e| *e >= 1);
        let nonce = s("nonce")
            .filter(|n| n.len() == 24)
            .and_then(decode_hex)
            .and_then(|n| <[u8; 12]>::try_from(n.as_slice()).ok());
        let (Some(epoch), Some(nonce), Some(ct)) = (epoch, nonce, s("ciphertext")) else {
            return Err("malformed".into());
        };
        if s("kind") != Some("RelayFeedSealed")
            || o.get("version").and_then(Value::as_u64) != Some(1)
        {
            return Err("malformed".into());
        }
        let page_ok = match (page, o.get("page")) {
            (None, None | Some(Value::Null)) => true,
            (Some(p), Some(v)) => v.as_u64() == Some(p),
            _ => false,
        };
        if s("servicesApex") != Some(self.apex.as_str()) || s("object") != Some(object) || !page_ok
        {
            return Err("wrong-place".into());
        }
        let key = self
            .keys
            .lock()
            .ok()
            .and_then(|k| k.get(&epoch).map(|x| **x))
            .ok_or_else(|| NO_KEY.to_owned())?;
        let ct = base64_decode(ct).ok_or_else(|| "malformed".to_owned())?;
        let aad = flagship_crypto::relay_feed_seal::relay_feed_aad(&self.apex, object, page, epoch);
        flagship_crypto::relay_feed_seal::open_relay_feed(&key, &nonce, &aad, &ct)
            .map_err(|_| "undecryptable".to_owned())
    }

    fn adopt(&self, issued: &Value, _relay_key: &ed25519_dalek::SigningKey) {
        if let Some(doc) = issued.get("meshKeys").filter(|d| d.is_object()) {
            self.adopt_keys(doc);
        }
    }
}

impl FeedDecrypt for PlainFeed {
    fn open(&self, _file: FeedFile, body: &[u8]) -> Result<Vec<u8>, String> {
        Ok(body.to_vec())
    }
}

/// The feed over HTTPS (R2 behind Cloudflare's cache). Requests carry nothing about the relay.
pub struct HttpFeed {
    base: String,
    agent: ureq::Agent,
}

impl std::fmt::Debug for HttpFeed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpFeed")
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

/// Largest feed file read (a full page is ~512 entries of a few hundred bytes).
const MAX_FEED_FILE: u64 = 16 * 1024 * 1024;

impl HttpFeed {
    #[must_use]
    pub fn new(base: &str) -> Arc<Self> {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(10)))
            .max_redirects(0)
            .http_status_as_error(false)
            .build();
        Arc::new(Self {
            base: base.trim_end_matches('/').to_owned(),
            agent: ureq::Agent::new_with_config(config),
        })
    }
}

impl FeedFetch for HttpFeed {
    fn get<'a>(&'a self, path: &'a str) -> BoxFut<'a, Result<(u16, Vec<u8>), String>> {
        let url = format!("{}/{path}", self.base);
        let agent = self.agent.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let mut r = agent.get(&url).call().map_err(|e| e.to_string())?;
                let status = r.status().as_u16();
                let body = r
                    .body_mut()
                    .with_config()
                    .limit(MAX_FEED_FILE)
                    .read_to_vec()
                    .map_err(|e| e.to_string())?;
                Ok((status, body))
            })
            .await
            .map_err(|e| e.to_string())?
        })
    }
}

/// Which consequences an applied batch has (one pass over the entries).
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    const VECTORS: &str =
        include_str!("../../../../../packages/control-plane/tests/vectors/relay-feed-seal.json");

    #[test]
    fn sealed_files_open_like_relay_feed_seal_ts() {
        let v: Value = serde_json::from_str(VECTORS).unwrap();
        let mk = &v["meshKeys"];
        let seed: [u8; 32] = decode_hex(mk["relaySeed"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let f = SealedFeed::new(
            v["servicesApex"].as_str().unwrap(),
            mk["relayId"].as_str().unwrap(),
            seed,
        );
        let head = v["sealed"][0]["object"].to_string();
        assert_eq!(
            f.open(FeedFile::Head, head.as_bytes()),
            Err(NO_KEY.to_owned())
        );
        f.adopt(
            &json!({"meshKeys": mk["document"]}),
            &ed25519_dalek::SigningKey::from_bytes(&seed),
        );
        assert_eq!(f.epochs(), vec![1, 2]);
        for c in v["sealed"].as_array().unwrap() {
            let o = &c["object"];
            let file = match o["page"].as_u64() {
                Some(p) => FeedFile::Page(p),
                None => FeedFile::Head,
            };
            let pt = f.open(file, o.to_string().as_bytes()).unwrap();
            assert_eq!(
                String::from_utf8(pt).unwrap(),
                c["plaintext"].as_str().unwrap(),
                "{}",
                c["name"]
            );
        }
        for c in v["negative"].as_array().unwrap() {
            let e = &c["expect"];
            if e["servicesApex"] != v["servicesApex"] {
                let other = SealedFeed::new(e["servicesApex"].as_str().unwrap(), "iad1", seed);
                let file = e["page"].as_u64().map_or(FeedFile::Head, FeedFile::Page);
                assert_eq!(
                    other
                        .open(file, c["object"].to_string().as_bytes())
                        .unwrap_err(),
                    c["reason"].as_str().unwrap()
                );
                continue;
            }
            let file = match (e["object"].as_str(), e["page"].as_u64()) {
                (Some("log"), Some(p)) => FeedFile::Page(p),
                _ => FeedFile::Head,
            };
            assert_eq!(
                f.open(file, c["object"].to_string().as_bytes())
                    .unwrap_err(),
                c["reason"].as_str().unwrap(),
                "{}",
                c["name"]
            );
        }
        assert_eq!(base64_decode("aGk="), Some(b"hi".to_vec()));
        assert_eq!(base64_decode("aGk"), None);
        let wrong = SealedFeed::new(v["servicesApex"].as_str().unwrap(), "ams1", seed);
        assert_eq!(
            wrong.adopt_keys(&mk["document"]),
            0,
            "another relay's key file opens nothing"
        );
    }
}

#[derive(Debug, Default)]
struct Effects {
    names: Vec<String>,
    box_pubs: Vec<String>,
    relays: Vec<String>,
    refresh_gate: bool,
    phones: bool,
}

impl Mesh {
    pub(crate) fn spawn_feed(&self) -> tokio::task::AbortHandle {
        let me = self.clone();
        tokio::spawn(async move {
            let mut t = tokio::time::interval(me.0.cfg.feed_poll);
            t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                t.tick().await;
                me.poll_feed().await;
                me.note_contact();
            }
        })
        .abort_handle()
    }

    async fn fetch(&self, path: &str, file: FeedFile) -> Option<Value> {
        match self.fetch_once(path, file).await {
            Err(e) if e == NO_KEY => {
                // A file under an epoch this relay holds no key for: read its key file once, then retry (§4.5.1).
                let keys = format!("keys/{}.json", self.relay_id());
                if let Ok(doc) = self.fetch_once(&keys, FeedFile::Keys).await {
                    self.0
                        .parts
                        .decrypt
                        .adopt(&json!({ "meshKeys": doc }), &self.0.key);
                }
                self.fetch_once(path, file).await.ok()
            }
            other => other.ok(),
        }
    }

    async fn fetch_once(&self, path: &str, file: FeedFile) -> Result<Value, String> {
        let got = self.0.parts.feed.get(path).await;
        let body = match got {
            Ok((200, b)) => b,
            Ok((s, _)) => return Err(format!("status {s}")),
            Err(e) => return Err(e),
        };
        let plain = match self.0.parts.decrypt.open(file, &body) {
            Ok(p) => p,
            Err(e) => {
                if e != NO_KEY {
                    self.log(&format!("feed {path}: cannot open ({e})"));
                }
                return Err(e);
            }
        };
        serde_json::from_slice(&plain).map_err(|_| "not json".to_owned())
    }

    /// One poll: the head, the pages past the applied sequence, and the directory when the head names a newer one or it
    /// is due.
    pub async fn poll_feed(&self) {
        self.0
            .stats
            .feed_polls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let head = self.fetch("head.json", FeedFile::Head).await;
        match head.as_ref().and_then(wire::head_from_json) {
            Some((h, sig)) => {
                self.offer_head(&h, &sig, None);
            }
            None => {
                self.0
                    .stats
                    .feed_errors
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        }
        for _ in 0..64 {
            let (want, have) = self
                .with_state(|s| {
                    (
                        s.newest_head.as_ref().map_or(0, |(h, _)| h.sequence),
                        s.log.sequence,
                    )
                })
                .unwrap_or((0, 0));
            if want <= have {
                break;
            }
            let page = have.saturating_add(1) / FEED_PAGE_ENTRIES;
            let Some(body) = self
                .fetch(&format!("log/{page}.json"), FeedFile::Page(page))
                .await
            else {
                break;
            };
            let entries: Vec<(RelayLogEntry, String)> = body
                .get("entries")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(wire::log_entry_from_json).collect())
                .unwrap_or_default();
            if self.apply_entries(&entries, "feed") == 0 {
                break;
            }
        }
        let (dir_have, dir_want, due) = self
            .with_state(|s| {
                (
                    s.directory.as_ref().map_or(0, |d| d.body.directory_version),
                    s.newest_head
                        .as_ref()
                        .map_or(0, |(h, _)| h.directory_version),
                    now().saturating_sub(s.directory_checked_at) >= ms(self.0.cfg.directory_poll),
                )
            })
            .unwrap_or((0, 0, true));
        if dir_want > dir_have || due {
            if let Some(d) = self.fetch("directory.json", FeedFile::Directory).await {
                self.adopt_directory_file(&d);
            }
            self.with_state(|s| s.directory_checked_at = now());
        }
    }

    /// A head from the feed or a peer: verified under the log key, kept when newer. Returns whether it was newer.
    pub(crate) fn offer_head(&self, h: &RelayLogHead, sig: &str, from: Option<&str>) -> bool {
        if verify_relay_log_head(h, sig, &self.0.cfg.log_key, &self.0.cfg.apex).is_err() {
            self.0
                .stats
                .bad_entries
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if let Some(p) = from.and_then(|f| self.peer(f)) {
                p.reject();
            }
            return false;
        }
        let (newer, behind) = self
            .with_state(|s| {
                let newer = newer_relay_log_head(s.newest_head.as_ref().map(|(x, _)| x), h);
                if newer {
                    s.newest_head = Some((h.clone(), sig.to_owned()));
                    if relay_log_head_status(&s.log, h) == "applied" {
                        s.applied_head = Some(h.clone());
                    }
                }
                (newer, h.sequence > s.log.sequence)
            })
            .unwrap_or((false, false));
        if newer {
            let msg = json!({"type": "head", "head": wire::head_to_json(h, sig).get("head").cloned(), "signature": sig});
            for p in self.live_peers() {
                if Some(p.relay_id.as_str()) != from {
                    p.send_head(&msg);
                }
            }
        }
        if behind && let Some(p) = from.and_then(|f| self.peer(f)) {
            let since = self.with_state(|s| s.log.sequence).unwrap_or(0);
            p.send_json(&json!({"type": "log-since", "since": since}));
        }
        newer
    }

    /// Apply entries (feed or peer). Returns how many were new and valid.
    pub(crate) fn apply_entries(&self, entries: &[(RelayLogEntry, String)], from: &str) -> u64 {
        if entries.is_empty() {
            return 0;
        }
        let outcome = self.with_state(|s| {
            let before = s.log.sequence;
            let (next, applied, failed) =
                match apply_relay_log(&s.log, entries, &self.0.cfg.log_key) {
                    RelayLogApply::Applied { state, applied } => (state, applied, None),
                    RelayLogApply::Failed {
                        reason,
                        at,
                        state,
                        applied,
                    } => (state, applied, Some((reason, at))),
                };
            s.log = next;
            let new: Vec<(RelayLogEntry, String)> = entries
                .iter()
                .filter(|(e, _)| e.sequence > before && e.sequence <= s.log.sequence)
                .cloned()
                .collect();
            for e in &new {
                s.recent.push_back(e.clone());
            }
            while s.recent.len() > MESH_LOG_SINCE_MAX.saturating_mul(2) {
                s.recent.pop_front();
            }
            if let Some((h, _)) = &s.newest_head
                && relay_log_head_status(&s.log, h) == "applied"
            {
                s.applied_head = Some(h.clone());
            }
            (applied, failed, new)
        });
        let Some((applied, failed, new)) = outcome else {
            return 0;
        };
        if let Some((reason, at)) = failed {
            self.0
                .stats
                .bad_entries
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if reason != "gap" {
                self.log(&format!("log from {from}: {reason} at {at}"));
                if let Some(p) = self.peer(from) {
                    p.reject();
                }
            }
        }
        if applied > 0 {
            self.after_apply(&new);
        }
        applied
    }

    fn after_apply(&self, applied: &[(RelayLogEntry, String)]) {
        let mut fx = Effects::default();
        for (e, _) in applied {
            match e.kind.as_str() {
                "box-register" => {
                    fx.names.push(e.f1.clone());
                    fx.refresh_gate = true;
                }
                "box-revoke" => {
                    fx.box_pubs.push(e.f1.clone());
                    fx.refresh_gate = true;
                }
                "account-authority" => {
                    fx.refresh_gate = true;
                    fx.phones = true;
                }
                "policy-head" => fx.refresh_gate = true,
                "device-grant-revoke" => fx.phones = true,
                "relay-revoke" => fx.relays.push(e.f1.clone()),
                _ => {}
            }
        }
        let revocations = self.with_ctx(|ctx, store| {
            for r in &fx.relays {
                store.remove_relay(r);
            }
            let mut names: Vec<String> = fx
                .names
                .iter()
                .filter_map(|h| store.name_of_hash(h))
                .collect();
            for b in &fx.box_pubs {
                names.extend(store.names_of_box(b));
            }
            if !names.is_empty() {
                store.retain_boxes(Some(&names), |i| {
                    check_attachment_item(i, ctx, None).is_ok()
                });
            }
            if !fx.relays.is_empty() {
                store.retain_phones(|p| check_phone_item(p, &p.grant.holder_relay_id, ctx).is_ok());
            }
            relay_log_revocations(ctx.log)
        });
        for r in &fx.relays {
            if let Some(p) = self.peer(r) {
                p.close(4403, "revoked");
            }
            if let Ok(mut d) = self.0.dialers.lock()
                && let Some(h) = d.remove(r)
            {
                h.abort();
            }
        }
        if let Some(h) = self.hooks() {
            if let (Some(g), Some(revs)) = (&h.gate, revocations) {
                g.adopt_revocations(revs);
                if fx.refresh_gate {
                    let g = g.clone();
                    tokio::spawn(async move { g.refresh_all().await });
                }
            }
            if fx.phones
                && let Some(p) = h.phone.clone()
            {
                tokio::spawn(async move { p.recheck_all().await });
            }
        }
        for p in self.live_peers() {
            self.push_log(&p);
        }
    }

    /// Send a peer the entries newer than the last it was sent (≤ 256 per message).
    pub(crate) fn push_log(&self, p: &super::bridge::Peer) {
        let sent = p.log_sent();
        let entries: Vec<Value> = self
            .with_state(|s| {
                s.recent
                    .iter()
                    .filter(|(e, _)| e.sequence > sent)
                    .take(MESH_LOG_PUSH_MAX)
                    .map(|(e, sig)| wire::log_entry_to_json(e, sig))
                    .collect()
            })
            .unwrap_or_default();
        let top = entries
            .last()
            .and_then(|e| e.get("entry")?.get("sequence")?.as_u64());
        if let Some(top) = top {
            p.send_json(&json!({"type": "log", "entries": entries}));
            p.set_log_sent(top);
        }
    }

    /// `log-since`: what this relay still holds after `since` (≤ 1024).
    pub(crate) fn log_since(&self, since: u64) -> Vec<Value> {
        self.with_state(|s| {
            s.recent
                .iter()
                .filter(|(e, _)| e.sequence > since)
                .take(MESH_LOG_SINCE_MAX)
                .map(|(e, sig)| wire::log_entry_to_json(e, sig))
                .collect()
        })
        .unwrap_or_default()
    }

    /// The serving gate's contact clock (§4.6, §15.4.1): the issue time of the newest head this relay applied (a relay
    /// that applied none counts from its start). Returning to fresh re-decides every box against the new state; past
    /// close-all, phone tunnels are closed (they follow the strict rule).
    pub(crate) fn note_contact(&self) {
        let Some(hooks) = self.hooks() else { return };
        let fresh = self.fresh();
        let back = self
            .with_state(|s| std::mem::replace(&mut s.was_fresh, fresh) != fresh && fresh)
            .unwrap_or(false);
        let Some(gate) = hooks.gate.clone() else {
            return;
        };
        let applied = self
            .with_state(|s| {
                s.applied_head
                    .as_ref()
                    .filter(|h| relay_log_head_status(&s.log, h) == "applied")
                    .map(|h| h.issued_at)
            })
            .flatten();
        if let Some(at) = applied {
            let age = Duration::from_millis(now().saturating_sub(at));
            if let Some(when) = Instant::now().checked_sub(age) {
                gate.note_contact_at(when);
            }
        }
        if back {
            let g = gate.clone();
            tokio::spawn(async move { g.refresh_all().await });
        }
        if gate.contact() == crate::serving::Contact::Lost
            && let Some(p) = &hooks.phone
        {
            p.close_all(1013, "serving-feed-lost");
        }
    }

    /// New tunnels (and phone begins) are taken exactly while the relay is fresh (§4.6, §15.4.1).
    #[must_use]
    pub fn accepting_new(&self) -> bool {
        self.fresh()
    }

    /// The sequence of the applied log and its head (tests).
    #[must_use]
    pub fn log_sequence(&self) -> u64 {
        self.with_state(|s| s.log.sequence).unwrap_or(0)
    }

    /// Is this pod name registered and unrevoked in the applied log?
    #[must_use]
    pub fn log_knows(&self, pod: &str) -> bool {
        self.with_state(|s| {
            rm::relay_log_box(&s.log, pod).is_some_and(|b| {
                s.log.revoked_boxes.get(&b.box_pub).copied().unwrap_or(0) < b.reg_gen
            })
        })
        .unwrap_or(false)
    }
}
