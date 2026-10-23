//! Per-account slow-down for over-quota accounts (`throttle.ts`) and the metering hook the
//! SNI splice calls (`UsageMeter.add` / `throttleDelayMs`).

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 256 kbit/s.
pub const DEFAULT_THROTTLE_BYTES_PER_SEC: f64 = 32_000.0;

#[derive(Debug)]
struct Bucket {
    tokens: f64,
    at: Instant,
}

/// One token bucket per account; a charge that overdraws returns how long the caller's source
/// should pause. Nothing is ever queued here.
#[derive(Debug)]
pub struct AccountThrottle {
    buckets: HashMap<String, Bucket>,
    rate: f64,
    burst: f64,
}

impl AccountThrottle {
    pub fn new(bytes_per_sec: f64, burst: Option<f64>) -> Option<Self> {
        (bytes_per_sec > 0.0 && bytes_per_sec.is_finite()).then(|| Self {
            buckets: HashMap::new(),
            rate: bytes_per_sec,
            burst: burst.unwrap_or(bytes_per_sec),
        })
    }

    pub fn charge_at(&mut self, account: &str, bytes: usize, now: Instant) -> Duration {
        let burst = self.burst;
        let b = self.buckets.entry(account.to_owned()).or_insert(Bucket {
            tokens: burst,
            at: now,
        });
        let elapsed = now.saturating_duration_since(b.at).as_secs_f64();
        b.tokens = (b.tokens + elapsed * self.rate).min(burst);
        b.at = now;
        b.tokens -= bytes as f64;
        if b.tokens >= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_millis((-b.tokens * 1000.0 / self.rate).ceil() as u64)
        }
    }

    pub fn forget(&mut self, account: &str) {
        self.buckets.remove(account);
    }

    pub fn size(&self) -> usize {
        self.buckets.len()
    }
}

/// `overQuotaBytesPerSec`: kbit/s to bytes/s; anything unusable means "use the default".
pub fn over_quota_bytes_per_sec(kbps: Option<&str>) -> Option<f64> {
    let n: f64 = kbps?.trim().parse().ok()?;
    (n.is_finite() && n > 0.0).then_some(n * 1000.0 / 8.0)
}

/// What the router reports per byte it carries, and how long it must pause afterwards.
pub trait Meter: Send + Sync + 'static {
    fn add(&self, account: Option<&str>, bytes: usize);
    fn throttle_delay(&self, account: Option<&str>, bytes: usize) -> Duration;
}

/// In-memory meter: counts bytes per account and slows accounts marked over quota. The
/// `.com` lease protocol (report + budget lease) is not implemented here.
#[derive(Debug)]
pub struct LocalMeter {
    inner: Mutex<LocalMeterState>,
}

#[derive(Debug)]
struct LocalMeterState {
    totals: HashMap<String, u64>,
    over_quota: HashSet<String>,
    throttle: AccountThrottle,
}

impl LocalMeter {
    pub fn new(bytes_per_sec: f64) -> Option<Self> {
        Some(Self {
            inner: Mutex::new(LocalMeterState {
                totals: HashMap::new(),
                over_quota: HashSet::new(),
                throttle: AccountThrottle::new(bytes_per_sec, None)?,
            }),
        })
    }

    pub fn set_over_quota(&self, account: &str, over: bool) {
        if let Ok(mut s) = self.inner.lock() {
            if over {
                s.over_quota.insert(account.to_owned());
            } else {
                s.over_quota.remove(account);
                s.throttle.forget(account);
            }
        }
    }

    pub fn total(&self, account: &str) -> u64 {
        self.inner
            .lock()
            .ok()
            .and_then(|s| s.totals.get(account).copied())
            .unwrap_or(0)
    }
}

impl Meter for LocalMeter {
    fn add(&self, account: Option<&str>, bytes: usize) {
        let (Some(a), Ok(mut s)) = (account, self.inner.lock()) else {
            return;
        };
        let t = s.totals.entry(a.to_owned()).or_insert(0);
        *t = t.saturating_add(bytes as u64);
    }

    fn throttle_delay(&self, account: Option<&str>, bytes: usize) -> Duration {
        let (Some(a), Ok(mut s)) = (account, self.inner.lock()) else {
            return Duration::ZERO;
        };
        if !s.over_quota.contains(a) {
            return Duration::ZERO;
        }
        s.throttle.charge_at(a, bytes, Instant::now())
    }
}

/// `accountFromCanonical`, apex-relative: the last label before `.<apex>`. (The TS version
/// strips a hard-coded `.flagship.services`, so on the gym apex it attributes every account to
/// `gym`.)
pub fn account_from_canonical(pod_canonical: &str, apex: &str) -> Option<String> {
    let lower = pod_canonical.trim().to_lowercase();
    let stem = lower.strip_suffix(apex)?.strip_suffix('.')?;
    stem.split('.').rfind(|l| !l.is_empty()).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_pauses_after_burst() {
        let mut t = AccountThrottle::new(1000.0, None).unwrap_or_else(|| unreachable!());
        let now = Instant::now();
        assert_eq!(t.charge_at("a", 1000, now), Duration::ZERO);
        assert_eq!(t.charge_at("a", 500, now), Duration::from_millis(500));
        assert_eq!(
            t.charge_at("a", 0, now + Duration::from_millis(500)),
            Duration::ZERO
        );
        assert!(AccountThrottle::new(0.0, None).is_none());
        assert_eq!(over_quota_bytes_per_sec(Some("256")), Some(32_000.0));
        assert_eq!(over_quota_bytes_per_sec(Some("0")), None);
    }
}
