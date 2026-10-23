//! Bounded box→visitor byte queues with a per-tunnel budget.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio::sync::Notify;

/// Bytes queued toward visitors across every stream of one tunnel.
#[derive(Debug)]
pub struct Budget {
    used: AtomicUsize,
    cap: usize,
    freed: Notify,
}

impl Budget {
    pub fn new(cap: usize) -> Arc<Self> {
        Arc::new(Self {
            used: AtomicUsize::new(0),
            cap,
            freed: Notify::new(),
        })
    }

    pub fn used(&self) -> usize {
        self.used.load(Ordering::Acquire)
    }

    fn try_take(&self, n: usize) -> bool {
        let mut cur = self.used.load(Ordering::Acquire);
        loop {
            let next = cur.saturating_add(n);
            if cur > 0 && next > self.cap {
                return false;
            }
            match self
                .used
                .compare_exchange_weak(cur, next, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => return true,
                Err(v) => cur = v,
            }
        }
    }

    fn give(&self, n: usize) {
        let mut cur = self.used.load(Ordering::Acquire);
        while let Err(v) = self.used.compare_exchange_weak(
            cur,
            cur.saturating_sub(n),
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            cur = v;
        }
        self.freed.notify_waiters();
    }
}

#[derive(Debug, Default)]
struct State {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    ended: bool,
    aborted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushError {
    Full,
    Closed,
}

/// One stream's downlink. A chunk is admitted while the stream holds less than `cap` bytes and
/// the tunnel budget has room; an empty queue always admits one chunk (a single v1 frame may
/// be up to 1 MiB), so memory per stream is at most `cap` + one frame.
#[derive(Debug)]
pub struct DownQueue {
    state: Mutex<State>,
    readable: Notify,
    writable: Notify,
    cap: usize,
    budget: Arc<Budget>,
}

impl DownQueue {
    pub fn new(cap: usize, budget: Arc<Budget>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            readable: Notify::new(),
            writable: Notify::new(),
            cap,
            budget,
        })
    }

    pub fn queued(&self) -> usize {
        self.state.lock().map_or(0, |s| s.bytes)
    }

    pub fn try_push(&self, data: Vec<u8>) -> Result<(), (PushError, Vec<u8>)> {
        let Ok(mut s) = self.state.lock() else {
            return Err((PushError::Closed, data));
        };
        if s.ended || s.aborted {
            return Err((PushError::Closed, data));
        }
        if s.bytes > 0 && s.bytes.saturating_add(data.len()) > self.cap {
            return Err((PushError::Full, data));
        }
        if !self.budget.try_take(data.len()) {
            return Err((PushError::Full, data));
        }
        s.bytes = s.bytes.saturating_add(data.len());
        s.chunks.push_back(data);
        drop(s);
        self.readable.notify_one();
        Ok(())
    }

    /// Wait up to `grace` for room. Used for peers without credit (v1), where waiting stalls
    /// the tunnel reader and is therefore bounded.
    pub async fn push_within(&self, mut data: Vec<u8>, grace: Duration) -> Result<(), PushError> {
        let deadline = tokio::time::Instant::now().checked_add(grace);
        loop {
            let notified = self.writable.notified();
            let freed = self.budget.freed.notified();
            match self.try_push(data) {
                Ok(()) => return Ok(()),
                Err((PushError::Closed, _)) => return Err(PushError::Closed),
                Err((PushError::Full, d)) => data = d,
            }
            let Some(deadline) = deadline else {
                return Err(PushError::Full);
            };
            tokio::select! {
                _ = notified => {}
                _ = freed => {}
                _ = tokio::time::sleep_until(deadline) => return Err(PushError::Full),
            }
        }
    }

    /// Next chunk; `None` once ended and drained, or aborted.
    pub async fn pop(&self) -> Option<Vec<u8>> {
        loop {
            let notified = self.readable.notified();
            {
                let mut s = self.state.lock().ok()?;
                if s.aborted {
                    return None;
                }
                if let Some(c) = s.chunks.pop_front() {
                    s.bytes = s.bytes.saturating_sub(c.len());
                    drop(s);
                    self.budget.give(c.len());
                    self.writable.notify_waiters();
                    return Some(c);
                }
                if s.ended {
                    return None;
                }
            }
            notified.await;
        }
    }

    /// No more data will come; what is queued still drains.
    pub fn end(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.ended = true;
        }
        self.readable.notify_waiters();
        self.readable.notify_one();
    }

    /// Drop everything queued and wake the consumer.
    pub fn abort(&self) {
        let freed = match self.state.lock() {
            Ok(mut s) => {
                s.aborted = true;
                s.chunks.clear();
                std::mem::take(&mut s.bytes)
            }
            Err(_) => 0,
        };
        self.budget.give(freed);
        self.readable.notify_waiters();
        self.readable.notify_one();
        self.writable.notify_waiters();
    }
}
