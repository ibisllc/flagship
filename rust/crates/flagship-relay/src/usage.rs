//! Per-account public-egress metering with budget leases from `.com` (`usageMeter.ts`, billing's `LeaseBook`
//! in `packages/metering/src/edge.ts`, `billing/docs/spec/report-and-lease-v1.md`).
//!
//! The relay counts bytes per account in RAM, reports them to `POST /api/usage/report` (a batch keeps its id across
//! retries, so `.com` counts it once) and enforces the lease `.com` answers with: an account may carry its grant at full
//! speed before the relay must hear back; a throttle lease or a spent grant SLOWS it, never refuses it, so an owner over
//! the Free allowance can still reach their own box. While `.com` is unreachable the relay fails open.
//!
//! [`LeaseBook`] does no I/O and reads no clock (the host passes `now` in milliseconds); [`UsageMeter`] wraps it as the
//! [`Meter`] the SNI splice calls.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::outbound::com_policy::HttpPost;
use crate::throttle::{AccountThrottle, DEFAULT_THROTTLE_BYTES_PER_SEC, Meter};

const MIB: u64 = 1024 * 1024;
/// What a relay may carry for an account before `.com` has answered for it.
pub const INITIAL_GRANT_BYTES: u64 = 32 * MIB;
const MAX_BATCHES_PER_FLUSH: usize = 4;
const RETRY_BACKOFF_MS: [u64; 5] = [1_000, 2_000, 5_000, 10_000, 30_000];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Allow,
    Throttle,
    Stop,
}

impl Action {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "allow" => Some(Self::Allow),
            "throttle" => Some(Self::Throttle),
            "stop" => Some(Self::Stop),
            _ => None,
        }
    }
}

/// The lease in one result of a report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EdgeLease {
    pub action: Action,
    pub grant: u64,
    pub policy: Action,
    pub ttl_ms: u64,
}

#[derive(Debug, Clone, Copy)]
struct HeldLease {
    action: Action,
    grant: u64,
    policy: Action,
    expires_at: u64,
}

#[derive(Debug)]
struct AccountState {
    pending: u64,
    spent: u64,
    last_use_at: u64,
    lease: Option<HeldLease>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Batch {
    pub id: String,
    pub items: Vec<(String, u64)>,
    pub taken_at: u64,
    pub attempts: u32,
    pub retry_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Due,
    All,
}

#[derive(Debug, Clone)]
pub struct LeaseBookOptions {
    pub initial_grant: u64,
    pub unknown_policy: Action,
    /// Report an account once it has spent this share of its grant.
    pub renew_at: f64,
    pub fail_open: bool,
    pub max_items: usize,
    pub retry_for_ms: u64,
    pub forget_after_ms: u64,
}

impl Default for LeaseBookOptions {
    fn default() -> Self {
        Self {
            initial_grant: INITIAL_GRANT_BYTES,
            unknown_policy: Action::Throttle,
            renew_at: 0.5,
            fail_open: true,
            max_items: 500,
            retry_for_ms: 10 * 60_000,
            forget_after_ms: 60 * 60_000,
        }
    }
}

pub struct LeaseBook {
    opts: LeaseBookOptions,
    states: HashMap<String, AccountState>,
    due: HashSet<String>,
    retained: Option<Batch>,
    in_flight: Option<String>,
    unreachable: bool,
    new_batch_id: Box<dyn Fn() -> String + Send>,
    /// Batches dropped unconfirmed (after `retry_for_ms`, or refused by `.com`).
    pub dropped_batches: u64,
}

impl std::fmt::Debug for LeaseBook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LeaseBook")
            .field("accounts", &self.states.len())
            .finish_non_exhaustive()
    }
}

impl LeaseBook {
    pub fn new(opts: LeaseBookOptions, new_batch_id: Box<dyn Fn() -> String + Send>) -> Self {
        Self {
            opts,
            states: HashMap::new(),
            due: HashSet::new(),
            retained: None,
            in_flight: None,
            unreachable: false,
            new_batch_id,
            dropped_batches: 0,
        }
    }

    /// Count `amount` bytes for the account; true when that made it due.
    pub fn use_bytes(&mut self, account: &str, amount: u64, now: u64) -> bool {
        if amount == 0 {
            return false;
        }
        let st = self
            .states
            .entry(account.to_owned())
            .or_insert(AccountState {
                pending: 0,
                spent: 0,
                last_use_at: now,
                lease: None,
            });
        st.pending = st.pending.saturating_add(amount);
        st.spent = st.spent.saturating_add(amount);
        st.last_use_at = now;
        if !self.due.contains(account) && is_due(&self.opts, st, now) {
            self.due.insert(account.to_owned());
            return true;
        }
        false
    }

    #[must_use]
    pub fn action(&self, account: &str) -> Action {
        let Some(st) = self.states.get(account) else {
            return Action::Allow;
        };
        match st.lease {
            None => {
                if st.spent >= self.opts.initial_grant {
                    self.restrict(self.opts.unknown_policy)
                } else {
                    Action::Allow
                }
            }
            Some(l) if l.action != Action::Allow => l.action,
            Some(l) => {
                if st.spent >= l.grant {
                    self.restrict(l.policy)
                } else {
                    Action::Allow
                }
            }
        }
    }

    #[must_use]
    pub fn has_due(&self, now: u64) -> bool {
        if self.in_flight.is_some() {
            return false;
        }
        match &self.retained {
            Some(b) => b.retry_at <= now,
            None => !self.due.is_empty(),
        }
    }

    /// The next batch to send: a failed one first (same id), else the due accounts or every account with unreported
    /// usage. `None` when there is nothing to send or a batch is in flight.
    pub fn take_batch(&mut self, now: u64, mode: Mode) -> Option<Batch> {
        if self.in_flight.is_some() {
            return None;
        }
        if self
            .retained
            .as_ref()
            .is_some_and(|b| now.saturating_sub(b.taken_at) > self.opts.retry_for_ms)
        {
            self.retained = None;
            self.dropped_batches = self.dropped_batches.saturating_add(1);
        }
        if let Some(mut b) = self.retained.take() {
            b.attempts = b.attempts.saturating_add(1);
            self.in_flight = Some(b.id.clone());
            return Some(b);
        }
        let mut items: Vec<(String, u64)> = Vec::new();
        let max = self.opts.max_items;
        let due: Vec<String> = self.due.iter().cloned().collect();
        for a in due {
            if items.len() >= max {
                break;
            }
            match self.states.get_mut(&a) {
                Some(st) if st.pending > 0 => {
                    items.push((a.clone(), st.pending));
                    st.pending = 0;
                    self.due.remove(&a);
                }
                _ => {
                    self.due.remove(&a);
                }
            }
        }
        if mode == Mode::All {
            let mut overflow = Vec::new();
            for (a, st) in &mut self.states {
                if st.pending == 0 {
                    continue;
                }
                if items.len() >= max {
                    overflow.push(a.clone());
                    continue;
                }
                items.push((a.clone(), st.pending));
                st.pending = 0;
                self.due.remove(a);
            }
            // The overflow goes in the next early report.
            self.due.extend(overflow);
        }
        if items.is_empty() {
            return None;
        }
        let b = Batch {
            id: (self.new_batch_id)(),
            items,
            taken_at: now,
            attempts: 1,
            retry_at: now,
        };
        self.in_flight = Some(b.id.clone());
        Some(b)
    }

    /// `.com` answered `batch`. Accounts missing from `leases` keep the lease they had.
    pub fn settle(&mut self, batch: &Batch, leases: &HashMap<String, EdgeLease>, now: u64) {
        if self.in_flight.as_deref() == Some(batch.id.as_str()) {
            self.in_flight = None;
        }
        self.unreachable = false;
        for (account, _) in &batch.items {
            let st = self.states.entry(account.clone()).or_insert(AccountState {
                pending: 0,
                spent: 0,
                last_use_at: now,
                lease: None,
            });
            if let Some(l) = leases.get(account) {
                st.lease = Some(HeldLease {
                    action: l.action,
                    grant: l.grant,
                    policy: l.policy,
                    expires_at: now.saturating_add(l.ttl_ms),
                });
            }
            // The grant is relative to central's total, which includes this batch and nothing used since it was taken.
            st.spent = st.pending;
            if is_due(&self.opts, st, now) {
                self.due.insert(account.clone());
            } else {
                self.due.remove(account);
            }
        }
    }

    /// The send failed. `retry`: the network or `.com` failed, so try the same batch again later; otherwise `.com`
    /// refused it and it is dropped.
    pub fn failed(&mut self, mut batch: Batch, now: u64, retry: bool) {
        if self.in_flight.as_deref() == Some(batch.id.as_str()) {
            self.in_flight = None;
        }
        if !retry {
            self.dropped_batches = self.dropped_batches.saturating_add(1);
            return;
        }
        self.unreachable = true;
        let i = usize::try_from(batch.attempts.saturating_sub(1))
            .unwrap_or(usize::MAX)
            .min(RETRY_BACKOFF_MS.len().saturating_sub(1));
        batch.retry_at = now.saturating_add(RETRY_BACKOFF_MS.get(i).copied().unwrap_or(30_000));
        self.retained = Some(batch);
    }

    /// Drop idle accounts whose lease lapsed `forget_after_ms` ago.
    pub fn prune(&mut self, now: u64) {
        let forget = self.opts.forget_after_ms;
        let due = &self.due;
        self.states.retain(|a, st| {
            if st.pending > 0 || due.contains(a) {
                return true;
            }
            let since = st.lease.map_or(st.last_use_at, |l| l.expires_at);
            now.saturating_sub(since) < forget
        });
    }

    #[must_use]
    pub fn restricted_count(&self) -> usize {
        self.states
            .keys()
            .filter(|a| self.action(a) != Action::Allow)
            .count()
    }

    #[must_use]
    pub fn size(&self) -> usize {
        self.states.len()
    }

    fn restrict(&self, p: Action) -> Action {
        if p == Action::Allow || (self.opts.fail_open && self.unreachable) {
            Action::Allow
        } else {
            p
        }
    }
}

fn is_due(opts: &LeaseBookOptions, st: &AccountState, now: u64) -> bool {
    if st.pending == 0 {
        return false;
    }
    let Some(l) = st.lease else {
        return true;
    };
    if l.expires_at <= now {
        return true;
    }
    #[allow(clippy::cast_precision_loss)]
    let renew = (l.grant as f64) * opts.renew_at;
    #[allow(clippy::cast_precision_loss)]
    let spent = st.spent as f64;
    l.action == Action::Allow && spent >= renew
}

/// The lease in one result. A `.com` from before leases sends only `admit`: no local limit, throttle on `admit: false`.
fn lease_from(r: &Value, flush_interval_ms: u64) -> Option<EdgeLease> {
    if let Some(l) = r.get("lease").filter(|l| l.is_object()) {
        let action = l
            .get("action")
            .and_then(Value::as_str)
            .and_then(Action::parse);
        let policy = l
            .get("policy")
            .and_then(Value::as_str)
            .and_then(Action::parse);
        let grant = l.get("grantBytes").and_then(Value::as_f64);
        let ttl = l.get("ttlMs").and_then(Value::as_f64);
        if let (Some(action), Some(policy), Some(grant), Some(ttl)) = (action, policy, grant, ttl) {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            return Some(EdgeLease {
                action,
                grant: grant.max(0.0).floor() as u64,
                policy,
                ttl_ms: ttl.max(0.0) as u64,
            });
        }
    }
    let admit = r.get("admit").and_then(Value::as_bool)?;
    Some(if admit {
        EdgeLease {
            action: Action::Allow,
            grant: 256 * MIB,
            policy: Action::Allow,
            ttl_ms: flush_interval_ms,
        }
    } else {
        EdgeLease {
            action: Action::Throttle,
            grant: 0,
            policy: Action::Throttle,
            ttl_ms: flush_interval_ms,
        }
    })
}

#[derive(Debug, Clone)]
pub struct UsageConfig {
    pub report_url: String,
    pub secret: String,
    /// Slow pass: everyone with unreported usage.
    pub flush_interval: Duration,
    /// Fast pass for due accounts.
    pub due_check: Duration,
    pub throttle_bytes_per_sec: f64,
}

impl UsageConfig {
    #[must_use]
    pub fn new(report_url: &str, secret: &str) -> Self {
        Self {
            report_url: report_url.to_owned(),
            secret: secret.to_owned(),
            flush_interval: Duration::from_secs(60),
            due_check: Duration::from_millis(500),
            throttle_bytes_per_sec: DEFAULT_THROTTLE_BYTES_PER_SEC,
        }
    }
}

struct Inner {
    book: LeaseBook,
    throttle: AccountThrottle,
    last_full_at: u64,
}

/// The relay's [`Meter`]: RAM counting on the hot path, reporting from a background task.
pub struct UsageMeter {
    inner: Mutex<Inner>,
    epoch: Instant,
    cfg: UsageConfig,
    flushing: AtomicBool,
}

impl std::fmt::Debug for UsageMeter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UsageMeter").finish_non_exhaustive()
    }
}

/// What one tick did (for tests and logs).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Flushed {
    pub batches: usize,
    pub accounts: usize,
    pub failed: usize,
}

impl UsageMeter {
    /// `None` when the throttle rate is unusable.
    #[must_use]
    pub fn new(cfg: UsageConfig, new_batch_id: Box<dyn Fn() -> String + Send>) -> Option<Self> {
        let throttle = AccountThrottle::new(cfg.throttle_bytes_per_sec, None)?;
        Some(Self {
            inner: Mutex::new(Inner {
                book: LeaseBook::new(LeaseBookOptions::default(), new_batch_id),
                throttle,
                last_full_at: 0,
            }),
            epoch: Instant::now(),
            cfg,
            flushing: AtomicBool::new(false),
        })
    }

    fn now_ms(&self) -> u64 {
        u64::try_from(self.epoch.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    /// Accounts currently slowed.
    #[must_use]
    pub fn blocked_count(&self) -> usize {
        self.inner.lock().map_or(0, |i| i.book.restricted_count())
    }

    #[must_use]
    pub fn tracked_count(&self) -> usize {
        self.inner.lock().map_or(0, |i| i.book.size())
    }

    /// One timer tick (blocking: it posts): the slow pass when it is time, else the due accounts.
    pub fn tick(&self, http: &dyn HttpPost) -> Flushed {
        let now = self.now_ms();
        let mode = {
            let Ok(mut i) = self.inner.lock() else {
                return Flushed::default();
            };
            let slow = u64::try_from(self.cfg.flush_interval.as_millis()).unwrap_or(u64::MAX);
            if now.saturating_sub(i.last_full_at) >= slow {
                i.last_full_at = now;
                i.book.prune(now);
                Mode::All
            } else if i.book.has_due(now) {
                Mode::Due
            } else {
                return Flushed::default();
            }
        };
        self.flush(http, mode)
    }

    /// Report everything unreported now (shutdown).
    pub fn flush_all(&self, http: &dyn HttpPost) -> Flushed {
        self.flush(http, Mode::All)
    }

    fn flush(&self, http: &dyn HttpPost, mode: Mode) -> Flushed {
        if self.flushing.swap(true, Ordering::AcqRel) {
            return Flushed::default();
        }
        let mut out = Flushed::default();
        for _ in 0..MAX_BATCHES_PER_FLUSH {
            let batch = {
                let Ok(mut i) = self.inner.lock() else { break };
                i.book.take_batch(self.now_ms(), mode)
            };
            let Some(batch) = batch else { break };
            out.batches = out.batches.saturating_add(1);
            out.accounts = out.accounts.saturating_add(batch.items.len());
            if !self.send(http, batch) {
                out.failed = out.failed.saturating_add(1);
                break;
            }
        }
        self.flushing.store(false, Ordering::Release);
        out
    }

    fn send(&self, http: &dyn HttpPost, batch: Batch) -> bool {
        let body = json!({
            "batchId": batch.id,
            "items": batch.items.iter().map(|(a, n)| json!({ "username": a, "bytes": n })).collect::<Vec<_>>(),
        });
        let res = http.post_json(
            &self.cfg.report_url,
            &[("x-usage-secret", self.cfg.secret.as_str())],
            &body,
        );
        let now = self.now_ms();
        let Ok(mut i) = self.inner.lock() else {
            return false;
        };
        match res {
            Ok((status, json)) if (200..300).contains(&status) => {
                let slow = u64::try_from(self.cfg.flush_interval.as_millis()).unwrap_or(u64::MAX);
                let mut leases = HashMap::new();
                for r in json
                    .get("results")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let (Some(u), Some(l)) = (
                        r.get("username").and_then(Value::as_str),
                        lease_from(r, slow),
                    ) else {
                        continue;
                    };
                    leases.insert(u.to_owned(), l);
                }
                i.book.settle(&batch, &leases, now);
                for (a, _) in &batch.items {
                    if i.book.action(a) == Action::Allow {
                        i.throttle.forget(a);
                    }
                }
                true
            }
            Ok((status, _)) => {
                // 5xx / 408 / 429: try the same batch again; any other refusal won't change on a retry.
                let retry = status >= 500 || status == 408 || status == 429;
                i.book.failed(batch, now, retry);
                false
            }
            Err(_) => {
                // Keep serving: a metering outage must never hiccup the data plane.
                i.book.failed(batch, now, true);
                false
            }
        }
    }

    /// The background reporter: ticks every `due_check`; the blocking post runs off the async threads.
    pub fn spawn(self: &Arc<Self>, http: Arc<dyn HttpPost>) -> tokio::task::JoinHandle<()> {
        let me = Arc::clone(self);
        let every = me.cfg.due_check;
        tokio::spawn(async move {
            let mut t = tokio::time::interval(every);
            t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                t.tick().await;
                let (m, h) = (Arc::clone(&me), Arc::clone(&http));
                // A panic or a closed runtime ends the task; the data plane keeps serving unmetered.
                if tokio::task::spawn_blocking(move || m.tick(h.as_ref()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        })
    }
}

impl Meter for UsageMeter {
    fn add(&self, account: Option<&str>, bytes: usize) {
        let (Some(a), Ok(mut i)) = (account, self.inner.lock()) else {
            return;
        };
        let now = self.now_ms();
        i.book.use_bytes(a, bytes as u64, now);
    }

    fn throttle_delay(&self, account: Option<&str>, bytes: usize) -> Duration {
        let (Some(a), Ok(mut i)) = (account, self.inner.lock()) else {
            return Duration::ZERO;
        };
        if i.book.action(a) == Action::Allow {
            return Duration::ZERO;
        }
        i.throttle.charge_at(a, bytes, Instant::now())
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    fn ids() -> Box<dyn Fn() -> String + Send> {
        let n = AtomicU64::new(0);
        Box::new(move || format!("b{}", n.fetch_add(1, Ordering::Relaxed)))
    }

    fn book() -> LeaseBook {
        LeaseBook::new(LeaseBookOptions::default(), ids())
    }

    #[test]
    fn an_unseen_account_is_allowed_until_its_initial_grant_is_spent() {
        let mut b = book();
        assert_eq!(b.action("a"), Action::Allow);
        assert!(
            b.use_bytes("a", INITIAL_GRANT_BYTES - 1, 0),
            "no lease: due at once"
        );
        assert_eq!(b.action("a"), Action::Allow);
        b.use_bytes("a", 1, 0);
        assert_eq!(
            b.action("a"),
            Action::Throttle,
            "unknown policy is throttle"
        );
    }

    #[test]
    fn a_lease_sets_the_grant_and_a_spent_grant_follows_its_policy() {
        let mut b = book();
        b.use_bytes("a", 10, 0);
        let batch = b.take_batch(0, Mode::Due).unwrap();
        assert_eq!(batch.items, vec![("a".into(), 10)]);
        let l = EdgeLease {
            action: Action::Allow,
            grant: 100,
            policy: Action::Throttle,
            ttl_ms: 60_000,
        };
        b.settle(&batch, &HashMap::from([("a".into(), l)]), 0);
        assert_eq!(b.action("a"), Action::Allow);
        b.use_bytes("a", 100, 1);
        assert_eq!(
            b.action("a"),
            Action::Throttle,
            "the whole grant is spent since the batch"
        );
        let stop = EdgeLease {
            action: Action::Stop,
            grant: 0,
            policy: Action::Stop,
            ttl_ms: 1000,
        };
        let batch2 = b.take_batch(2, Mode::All).unwrap();
        b.settle(&batch2, &HashMap::from([("a".into(), stop)]), 2);
        assert_eq!(b.action("a"), Action::Stop);
    }

    #[test]
    fn an_account_is_due_at_half_its_grant_and_when_its_lease_lapses() {
        let mut b = book();
        b.use_bytes("a", 1, 0);
        let batch = b.take_batch(0, Mode::Due).unwrap();
        let l = EdgeLease {
            action: Action::Allow,
            grant: 1000,
            policy: Action::Allow,
            ttl_ms: 5000,
        };
        b.settle(&batch, &HashMap::from([("a".into(), l)]), 0);
        assert!(!b.use_bytes("a", 100, 10), "10% of the grant");
        assert!(b.use_bytes("a", 400, 20), "half the grant is spent");
        let _ = b.take_batch(30, Mode::Due).unwrap();
        b.settle(
            &Batch {
                id: "b1".into(),
                items: vec![("a".into(), 500)],
                taken_at: 0,
                attempts: 1,
                retry_at: 0,
            },
            &HashMap::new(),
            30,
        );
        assert!(b.use_bytes("a", 1, 6000), "the lease lapsed at 5000");
    }

    #[test]
    fn a_failed_batch_is_retried_with_the_same_id_then_dropped() {
        let mut b = book();
        b.use_bytes("a", 5, 0);
        let first = b.take_batch(0, Mode::All).unwrap();
        assert!(
            b.take_batch(0, Mode::All).is_none(),
            "one in flight at a time"
        );
        b.failed(first.clone(), 0, true);
        assert!(!b.has_due(500), "backoff of a second");
        assert!(b.has_due(1000));
        let again = b.take_batch(1000, Mode::Due).unwrap();
        assert_eq!((again.id.clone(), again.attempts), (first.id.clone(), 2));
        b.failed(again, 1000, true);
        assert!(
            b.take_batch(10 * 60_000 + 1, Mode::All).is_none(),
            "dropped after ten minutes"
        );
        assert_eq!(b.dropped_batches, 1);
        b.use_bytes("a", 1, 10 * 60_000 + 2);
        let fresh = b.take_batch(10 * 60_000 + 2, Mode::All).unwrap();
        assert_ne!(fresh.id, first.id);
    }

    #[test]
    fn a_refused_batch_is_dropped_and_an_outage_fails_open() {
        let mut b = book();
        b.use_bytes("a", INITIAL_GRANT_BYTES + 1, 0);
        assert_eq!(b.action("a"), Action::Throttle);
        let batch = b.take_batch(0, Mode::All).unwrap();
        b.failed(batch, 0, true);
        assert_eq!(
            b.action("a"),
            Action::Allow,
            "central is unreachable: a spent grant stops restricting"
        );
        let batch = b.take_batch(2000, Mode::All).unwrap();
        b.failed(batch, 2000, false);
        assert_eq!(b.dropped_batches, 1);
    }

    #[test]
    fn idle_accounts_are_forgotten_an_hour_after_their_lease_lapsed() {
        let mut b = book();
        b.use_bytes("a", 1, 0);
        let batch = b.take_batch(0, Mode::All).unwrap();
        let l = EdgeLease {
            action: Action::Allow,
            grant: 10,
            policy: Action::Allow,
            ttl_ms: 1000,
        };
        b.settle(&batch, &HashMap::from([("a".into(), l)]), 0);
        b.prune(1000 + 59 * 60_000);
        assert_eq!(b.size(), 1);
        b.prune(1000 + 60 * 60_000);
        assert_eq!(b.size(), 0);
    }

    #[test]
    fn leases_parse_from_the_report_and_from_a_com_without_leases() {
        let full = json!({"username":"a","lease":{"action":"throttle","grantBytes":1024.9,"policy":"stop","ttlMs":500}});
        assert_eq!(
            lease_from(&full, 60_000),
            Some(EdgeLease {
                action: Action::Throttle,
                grant: 1024,
                policy: Action::Stop,
                ttl_ms: 500
            })
        );
        let bad = json!({"username":"a","lease":{"action":"nope","grantBytes":1,"policy":"allow","ttlMs":1}});
        assert_eq!(lease_from(&bad, 60_000), None);
        assert_eq!(
            lease_from(&json!({"admit":true}), 60_000).unwrap().grant,
            256 * MIB
        );
        assert_eq!(
            lease_from(&json!({"admit":false}), 60_000).unwrap().action,
            Action::Throttle
        );
        assert_eq!(lease_from(&json!({}), 60_000), None);
    }

    type Call = (String, Vec<(String, String)>, Value);

    struct Fake {
        calls: Mutex<Vec<Call>>,
        reply: Mutex<Result<(u16, Value), String>>,
    }

    impl HttpPost for Fake {
        fn post_json(
            &self,
            url: &str,
            headers: &[(&str, &str)],
            body: &Value,
        ) -> Result<(u16, Value), String> {
            self.calls.lock().unwrap().push((
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

    fn meter() -> UsageMeter {
        let mut cfg = UsageConfig::new("https://com.test/api/usage/report", "s3cret");
        cfg.flush_interval = Duration::from_secs(3600);
        UsageMeter::new(cfg, ids()).unwrap()
    }

    #[test]
    fn the_meter_reports_a_batch_with_the_secret_and_applies_the_lease() {
        let m = meter();
        m.add(Some("alice"), 1000);
        m.add(None, 5);
        let http = Fake {
            calls: Mutex::new(Vec::new()),
            reply: Mutex::new(Ok((
                200,
                json!({"results":[{"username":"alice","lease":{"action":"throttle","grantBytes":0,"policy":"throttle","ttlMs":60000}}]}),
            ))),
        };
        let f = m.tick(&http);
        assert_eq!((f.batches, f.accounts, f.failed), (1, 1, 0));
        let calls = http.calls.lock().unwrap();
        assert_eq!(calls[0].0, "https://com.test/api/usage/report");
        assert_eq!(
            calls[0].1,
            vec![("x-usage-secret".to_owned(), "s3cret".to_owned())]
        );
        assert_eq!(calls[0].2["batchId"], "b0");
        assert_eq!(
            calls[0].2["items"],
            json!([{"username":"alice","bytes":1000}])
        );
        drop(calls);
        assert_eq!(m.blocked_count(), 1);
        assert!(
            m.throttle_delay(Some("alice"), 64_000) > Duration::ZERO,
            "a throttled account pauses its source"
        );
        assert_eq!(m.throttle_delay(Some("bob"), 64_000), Duration::ZERO);
        assert_eq!(m.throttle_delay(None, 64_000), Duration::ZERO);
    }

    #[test]
    fn an_unreachable_com_keeps_the_batch_and_never_slows_anyone_without_a_lease() {
        let m = meter();
        m.add(Some("alice"), INITIAL_GRANT_BYTES as usize + 1);
        let http = Fake {
            calls: Mutex::new(Vec::new()),
            reply: Mutex::new(Err("down".into())),
        };
        let f = m.tick(&http);
        assert_eq!((f.batches, f.failed), (1, 1));
        assert_eq!(
            m.throttle_delay(Some("alice"), 1 << 20),
            Duration::ZERO,
            "fail open"
        );
        *http.reply.lock().unwrap() = Ok((200, json!({"results":[]})));
        assert_eq!(
            m.flush_all(&http).batches,
            1,
            "a shutdown flush resends the kept batch"
        );
        let ids: Vec<Value> = http
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|c| c.2["batchId"].clone())
            .collect();
        assert_eq!(
            ids,
            vec![json!("b0"), json!("b0")],
            "same id, so .com counts it once"
        );
    }
}
