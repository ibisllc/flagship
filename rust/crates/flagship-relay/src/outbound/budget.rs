//! Per-box budgets (`outboundRelay.ts` `TokenBucket` / `BoxBudget`): bytes per second both ways, new streams per minute, and
//! how many hosts a box may ask about for the first time in an hour. Keyed by the box's verified pod canonical, so opening
//! more WebSockets does not widen a box's limits.

use std::collections::HashMap;
use std::time::Duration;
use tokio::time::Instant;

/// A token bucket. `spend` may go into debt and says how long to wait; `try_take` only spends what is there.
#[derive(Debug)]
pub struct TokenBucket {
    tokens: f64,
    last: Instant,
    per_second: f64,
    capacity: f64,
}

impl TokenBucket {
    #[must_use]
    pub fn new(per_second: f64, capacity: f64) -> Self {
        Self {
            tokens: capacity,
            last: Instant::now(),
            per_second,
            capacity,
        }
    }

    fn refill(&mut self) {
        let now = Instant::now();
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + elapsed * self.per_second).min(self.capacity);
    }

    /// Spends `n` (possibly into debt); returns how long to wait before the next spend.
    pub fn spend(&mut self, n: f64) -> Duration {
        self.refill();
        self.tokens -= n;
        if self.tokens >= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(-self.tokens / self.per_second)
        }
    }

    /// Spends `n` only if it is available.
    pub fn try_take(&mut self, n: f64) -> bool {
        self.refill();
        if self.tokens < n {
            return false;
        }
        self.tokens -= n;
        true
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub bytes_per_second: f64,
    pub burst_bytes: f64,
    pub opens_per_minute: f64,
    pub new_hosts_per_hour: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            bytes_per_second: 4.0 * 1024.0 * 1024.0,
            burst_bytes: 16.0 * 1024.0 * 1024.0,
            opens_per_minute: 120.0,
            new_hosts_per_hour: 10,
        }
    }
}

/// The providers baked into the apps, allowed even when `.com` cannot be asked and never counted against the new-host limit.
pub const KNOWN_AI_HOSTS: [&str; 4] = [
    "api.anthropic.com",
    "api.openai.com",
    "generativelanguage.googleapis.com",
    "openrouter.ai",
];

#[derive(Debug)]
pub struct BoxBudget {
    pub sessions: usize,
    pub streams: usize,
    pub bytes: TokenBucket,
    pub opens: TokenBucket,
    seen: HashMap<String, Instant>,
    new_hosts_per_hour: usize,
}

impl BoxBudget {
    #[must_use]
    pub fn new(l: Limits) -> Self {
        Self {
            sessions: 0,
            streams: 0,
            bytes: TokenBucket::new(l.bytes_per_second, l.burst_bytes),
            opens: TokenBucket::new(l.opens_per_minute / 60.0, l.opens_per_minute),
            seen: HashMap::new(),
            new_hosts_per_hour: l.new_hosts_per_hour,
        }
    }

    /// False when this would be one new host too many in the hour; a known provider or a repeat always passes.
    pub fn admit_host(&mut self, host: &str) -> bool {
        let h = host.to_ascii_lowercase();
        if KNOWN_AI_HOSTS.contains(&h.as_str()) {
            return true;
        }
        let now = Instant::now();
        self.seen
            .retain(|_, at| now.saturating_duration_since(*at) < Duration::from_secs(3600));
        if self.seen.contains_key(&h) {
            return true;
        }
        if self.seen.len() >= self.new_hosts_per_hour {
            return false;
        }
        self.seen.insert(h, now);
        true
    }
}
