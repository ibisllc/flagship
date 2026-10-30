//! Which hosts a box's AI calls may leave through the relay (`docs/outbound-hosts.md`): `.com` keeps the list. A host not seen
//! before is allowed and recorded; the owner blocks one by flipping a flag. The relay asks with its own secret and sends only
//! the host, never a box, an account or an address, so what `.com` keeps cannot name a user. When `.com` cannot be reached the
//! last answer stands, and a host never seen is allowed only if it is one of the known AI providers.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tokio::time::Instant;

use super::budget::KNOWN_AI_HOSTS;
use super::session::{HostPolicy, HostRow};
use crate::authority::BoxFut;

/// One blocking POST of a JSON body with extra headers; the status and the JSON answer (anything else is an `Err`).
pub trait HttpPost: Send + Sync + 'static {
    /// # Errors
    /// A transport failure.
    fn post_json(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: &Value,
    ) -> Result<(u16, Value), String>;
}

/// The production client: rustls, no proxy, no redirects, a deadline.
#[derive(Debug)]
pub struct UreqPost {
    agent: ureq::Agent,
}

impl UreqPost {
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

impl HttpPost for UreqPost {
    fn post_json(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: &Value,
    ) -> Result<(u16, Value), String> {
        let mut req = self
            .agent
            .post(url)
            .header("content-type", "application/json");
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let mut resp = req
            .send(body.to_string().as_bytes())
            .map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let text = resp
            .body_mut()
            .with_config()
            .limit(1 << 20)
            .read_to_string()
            .map_err(|e| e.to_string())?;
        Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Ttls {
    pub allowed: Duration,
    pub blocked: Duration,
    pub max_cached: usize,
}

impl Default for Ttls {
    fn default() -> Self {
        Self {
            allowed: Duration::from_secs(120),
            blocked: Duration::from_secs(60),
            max_cached: 2000,
        }
    }
}

struct Inner<H> {
    base: String,
    secret: String,
    http: H,
    ttl: Ttls,
    cache: Mutex<HashMap<String, (bool, Instant)>>,
    /// Set when `.com` says today's new-host cap is reached: unseen hosts are refused here until then.
    cap_until: Mutex<Option<Instant>>,
}

pub struct ComHostPolicy<H: HttpPost> {
    inner: Arc<Inner<H>>,
}

impl<H: HttpPost> std::fmt::Debug for ComHostPolicy<H> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ComHostPolicy")
            .field("base", &self.inner.base)
            .finish_non_exhaustive()
    }
}

/// How long until 00:00 UTC: `.com` counts new hosts per UTC day.
fn until_next_utc_midnight() -> Duration {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    Duration::from_secs(86_400u64.saturating_sub(now % 86_400))
}

impl<H: HttpPost> ComHostPolicy<H> {
    pub fn new(base_url: &str, secret: &str, http: H, ttl: Ttls) -> Self {
        Self {
            inner: Arc::new(Inner {
                base: base_url.trim_end_matches('/').to_owned(),
                secret: secret.to_owned(),
                http,
                ttl,
                cache: Mutex::new(HashMap::new()),
                cap_until: Mutex::new(None),
            }),
        }
    }

    fn remember(&self, host: &str, ok: bool) {
        let ttl = if ok {
            self.inner.ttl.allowed
        } else {
            self.inner.ttl.blocked
        };
        if let Ok(mut c) = self.inner.cache.lock() {
            if !c.contains_key(host) && c.len() >= self.inner.ttl.max_cached {
                // Make room by dropping the entry that expires first.
                if let Some(oldest) = c
                    .iter()
                    .min_by_key(|(_, (_, until))| *until)
                    .map(|(k, _)| k.clone())
                {
                    c.remove(&oldest);
                }
            }
            c.insert(
                host.to_owned(),
                (
                    ok,
                    Instant::now().checked_add(ttl).unwrap_or_else(Instant::now),
                ),
            );
        }
    }
}

impl<H: HttpPost> HostPolicy for ComHostPolicy<H> {
    fn allowed<'a>(&'a self, raw_host: &'a str) -> BoxFut<'a, bool> {
        Box::pin(async move {
            let host = raw_host.to_ascii_lowercase();
            let known = KNOWN_AI_HOSTS.contains(&host.as_str());
            let hit = self
                .inner
                .cache
                .lock()
                .ok()
                .and_then(|c| c.get(&host).copied());
            if let Some((ok, until)) = hit
                && until > Instant::now()
            {
                return ok;
            }
            // Once `.com` has said the day's new hosts are used up, a name it has not just answered for is refused here:
            // asking again would cost it a request each and change nothing.
            let capped = self
                .inner
                .cap_until
                .lock()
                .ok()
                .and_then(|c| *c)
                .is_some_and(|u| u > Instant::now());
            if capped && hit.is_none() && !known {
                return false;
            }
            let inner = Arc::clone(&self.inner);
            let url = format!("{}/api/outbound/check", inner.base);
            let body = json!({ "host": host });
            let answer = tokio::task::spawn_blocking(move || {
                inner
                    .http
                    .post_json(&url, &[("x-usage-secret", &inner.secret)], &body)
            })
            .await;
            match answer {
                Ok(Ok((200, v))) => {
                    let ok = v.get("allowed") == Some(&Value::Bool(true));
                    if !ok
                        && v.get("reason").and_then(Value::as_str) == Some("new-host-cap")
                        && let Ok(mut c) = self.inner.cap_until.lock()
                    {
                        *c = Instant::now().checked_add(until_next_utc_midnight());
                    }
                    self.remember(&host, ok);
                    ok
                }
                // `.com` unreachable or unhappy: what we last knew, else only the known providers.
                _ => hit.map_or(known, |(ok, _)| ok),
            }
        })
    }

    fn report(&self, rows: Vec<HostRow>) {
        if rows.is_empty() {
            return;
        }
        let inner = Arc::clone(&self.inner);
        let body = json!({ "rows": rows.iter().take(500).map(|r| json!({"host": r.host, "streams": r.streams, "up": r.up, "down": r.down, "refused": r.refused})).collect::<Vec<_>>() });
        // Totals are best-effort: a lost report is a lost count, never a failed call.
        let url = format!("{}/api/outbound/report", inner.base);
        tokio::task::spawn_blocking(move || {
            let _ = inner
                .http
                .post_json(&url, &[("x-usage-secret", &inner.secret)], &body);
        });
    }
}
