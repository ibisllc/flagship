//! `.com` as the relay's [`Directory`](crate::authority::Directory): who an account's keys are, its signed revocation list,
//! the STK a server registered and whether a box was retired for its pod. The TypeScript hub's endpoints and caches
//! (`remoteUsernameResolver.ts`, `revocationCache.ts`, `evictionCache.ts`, `server.ts` `remoteAuthLookup`), with the same
//! lifetimes: five minutes for keys, revocations and STKs, thirty seconds for a negative key lookup and for the eviction
//! chain. A revocation list or eviction chain that cannot be had is "unknown", which the authority treats as the hub always
//! has (fail open): a `.com` outage must not brick live boxes.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use flagship_crypto::entitlements::EntitlementRevocationList;
use serde_json::Value;

use crate::authority::{AccountKeys, BoxFut, Directory, revocation_list_verifies};

/// One blocking GET returning the status and the JSON body (anything else is an `Err`). Production: [`UreqGet`].
pub trait HttpGet: Send + Sync + 'static {
    /// # Errors
    /// A transport failure, or a body that is not JSON.
    fn get_json(&self, url: &str) -> Result<(u16, Value), String>;
}

/// The production client: rustls, no proxy, no redirects, a body cap and a deadline.
#[derive(Debug)]
pub struct UreqGet {
    agent: ureq::Agent,
}

const MAX_BODY: u64 = 1 << 20;

impl UreqGet {
    #[must_use]
    pub fn new(timeout: Duration) -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .max_redirects(0)
            .max_redirects_will_error(false)
            .proxy(None)
            .http_status_as_error(false)
            .user_agent(concat!("flagship-relay/", env!("CARGO_PKG_VERSION")))
            .build();
        Self {
            agent: ureq::Agent::new_with_config(config),
        }
    }
}

impl HttpGet for UreqGet {
    fn get_json(&self, url: &str) -> Result<(u16, Value), String> {
        let mut resp = self.agent.get(url).call().map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let text = resp
            .body_mut()
            .with_config()
            .limit(MAX_BODY)
            .read_to_string()
            .map_err(|e| e.to_string())?;
        Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
    }
}

/// Percent-encodes one path segment (RFC 3986 unreserved characters pass).
fn segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[derive(Debug, Clone, Copy)]
pub struct Ttls {
    pub keys: Duration,
    pub negative_keys: Duration,
    pub revocations: Duration,
    pub stk: Duration,
    pub eviction: Duration,
}

impl Default for Ttls {
    fn default() -> Self {
        Self {
            keys: Duration::from_secs(300),
            negative_keys: Duration::from_secs(30),
            revocations: Duration::from_secs(300),
            stk: Duration::from_secs(300),
            eviction: Duration::from_secs(30),
        }
    }
}

type Cache<T> = Mutex<HashMap<String, (Instant, T)>>;

struct Inner<H> {
    base: String,
    http: H,
    ttl: Ttls,
    keys: Cache<Option<AccountKeys>>,
    revoked: Cache<HashSet<String>>,
    stk: Cache<String>,
    retired: Cache<HashSet<String>>,
}

#[derive(Clone)]
pub struct ComDirectory<H: HttpGet> {
    inner: Arc<Inner<H>>,
}

impl<H: HttpGet> std::fmt::Debug for ComDirectory<H> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ComDirectory")
            .field("base", &self.inner.base)
            .finish_non_exhaustive()
    }
}

fn fresh<T: Clone>(c: &Cache<T>, key: &str, ttl: Duration) -> Option<T> {
    let map = c.lock().ok()?;
    let (at, v) = map.get(key)?;
    (at.elapsed() < ttl).then(|| v.clone())
}

fn store<T>(c: &Cache<T>, key: &str, v: T) {
    if let Ok(mut m) = c.lock() {
        m.insert(key.to_owned(), (Instant::now(), v));
    }
}

impl<H: HttpGet> ComDirectory<H> {
    pub fn new(com_base_url: &str, http: H, ttl: Ttls) -> Self {
        Self {
            inner: Arc::new(Inner {
                base: com_base_url.trim_end_matches('/').to_owned(),
                http,
                ttl,
                keys: Mutex::new(HashMap::new()),
                revoked: Mutex::new(HashMap::new()),
                stk: Mutex::new(HashMap::new()),
                retired: Mutex::new(HashMap::new()),
            }),
        }
    }

    async fn get(&self, path: String) -> Option<(u16, Value)> {
        let inner = Arc::clone(&self.inner);
        let url = format!("{}{path}", inner.base);
        tokio::task::spawn_blocking(move || inner.http.get_json(&url))
            .await
            .ok()?
            .ok()
    }

    async fn account_inner(&self, username: &str) -> Option<AccountKeys> {
        let key = username.to_ascii_lowercase();
        if let Some(hit) = fresh(&self.inner.keys, &key, self.inner.ttl.keys) {
            return hit;
        }
        let (status, body) = self
            .get(format!("/api/username/{}", segment(username)))
            .await?;
        if status != 200 {
            store(&self.inner.keys, &key, None);
            return None;
        }
        let irk = body
            .get("irkPub")
            .and_then(Value::as_str)
            .filter(|k| is_hex64(k))?
            .to_owned();
        let admin = match body.get("adminRootPub") {
            None | Some(Value::Null) => None,
            Some(Value::String(a)) if is_hex64(a) => Some(a.clone()),
            Some(_) => return None,
        };
        let keys = AccountKeys {
            irk_pub_hex: irk,
            admin_root_pub_hex: admin,
        };
        store(&self.inner.keys, &key, Some(keys.clone()));
        Some(keys)
    }
}

impl<H: HttpGet> Directory for ComDirectory<H> {
    fn account<'a>(&'a self, username: &'a str) -> BoxFut<'a, Option<AccountKeys>> {
        Box::pin(self.account_inner(username))
    }

    fn revoked<'a>(&'a self, username: &'a str) -> BoxFut<'a, Option<HashSet<String>>> {
        Box::pin(async move {
            if let Some(hit) = fresh(&self.inner.revoked, username, self.inner.ttl.revocations) {
                return Some(hit);
            }
            // An unreachable or unverifiable list leaves the cache as it was: the last good answer, else unknown.
            let stale = || {
                self.inner
                    .revoked
                    .lock()
                    .ok()
                    .and_then(|m| m.get(username).map(|(_, v)| v.clone()))
            };
            let Some((200, body)) = self
                .get(format!("/api/cert-revocations/{}", segment(username)))
                .await
            else {
                return stale();
            };
            let ids: Vec<String> = match body.get("certIds") {
                None => Vec::new(),
                Some(Value::Array(a)) => a
                    .iter()
                    .filter_map(|x| x.as_str().map(str::to_owned))
                    .collect(),
                Some(_) => return stale(),
            };
            let signature = body.get("signature").and_then(Value::as_str);
            if ids.is_empty() && signature.is_none() {
                // "No list was ever posted": nothing to verify.
                store(&self.inner.revoked, username, HashSet::new());
                return Some(HashSet::new());
            }
            let (Some(sig), Some(issued_at)) =
                (signature, body.get("issuedAt").and_then(Value::as_u64))
            else {
                return stale();
            };
            let Some(keys) = self.account_inner(username).await else {
                return stale();
            };
            let list = EntitlementRevocationList {
                username: username.to_owned(),
                cert_ids: ids.clone(),
                issued_at,
            };
            if !revocation_list_verifies(&list, sig, &keys.irk_pub_hex) {
                return stale();
            }
            let set: HashSet<String> = ids.into_iter().collect();
            store(&self.inner.revoked, username, set.clone());
            Some(set)
        })
    }

    fn stk<'a>(&'a self, server_id: &'a str) -> BoxFut<'a, Option<String>> {
        Box::pin(async move {
            let key = server_id.to_ascii_lowercase();
            if let Some(hit) = fresh(&self.inner.stk, &key, self.inner.ttl.stk) {
                return Some(hit);
            }
            let (status, body) = self
                .get(format!("/api/server/by-domain/{}", segment(server_id)))
                .await?;
            if status != 200
                || body
                    .get("revoked")
                    .is_some_and(|r| !matches!(r, Value::Null | Value::Bool(false)))
            {
                return None;
            }
            let stk = body
                .get("identityPubKey")
                .and_then(Value::as_str)
                .filter(|k| is_hex64(k))?
                .to_owned();
            store(&self.inner.stk, &key, stk.clone());
            Some(stk)
        })
    }

    fn retired<'a>(&'a self, pod_canonical: &'a str, stk_hex: &'a str) -> BoxFut<'a, bool> {
        Box::pin(async move {
            let key = pod_canonical.to_ascii_lowercase();
            let set = if let Some(hit) = fresh(&self.inner.retired, &key, self.inner.ttl.eviction) {
                hit
            } else {
                let Some((200, body)) = self
                    .get(format!("/api/server/{}/eviction-chain", segment(&key)))
                    .await
                else {
                    return false;
                };
                let mut set = HashSet::new();
                for e in body
                    .get("evictions")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let Some(order) = e
                        .get("orderJson")
                        .and_then(Value::as_str)
                        .and_then(|t| serde_json::from_str::<Value>(t).ok())
                    else {
                        continue;
                    };
                    if let Some(r) = order.get("retiredStkPubHex").and_then(Value::as_str) {
                        set.insert(r.to_ascii_lowercase());
                    }
                }
                store(&self.inner.retired, &key, set.clone());
                set
            };
            set.contains(&stk_hex.to_ascii_lowercase())
        })
    }
}
