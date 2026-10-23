//! Per-stream credit and fair scheduling.
//!
//! Credit (`stream-credit-v1`) is the outbound-v1 scheme applied to hub-opened streams: each
//! direction starts with [`STREAM_INITIAL_WINDOW`] bytes, DATA spends it, a STREAM_CREDIT frame
//! returns it as the receiver's sink drains. A peer that did not negotiate the capability gets
//! no credit frames and is not held to a window; the relay then bounds memory by pausing the
//! tunnel reader and, past a grace period, closing the slow stream.
//!
//! The scheduler is deficit round robin over streams with queued DATA, so one bulk stream
//! cannot starve the others sharing a tunnel; interleaving frames is legal in v1, so it needs
//! no negotiation.

use std::collections::{HashMap, VecDeque};

pub const STREAM_INITIAL_WINDOW: u32 = 256 * 1024;
/// A peer granting past this is confused or hostile; the excess is ignored (as outbound-v1).
pub const STREAM_MAX_WINDOW: u64 = STREAM_INITIAL_WINDOW as u64 * 4;
pub const DEFAULT_QUANTUM: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowError {
    /// The peer sent more DATA than the credit it was given.
    Overrun,
}

/// Bytes we may still send.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SendWindow {
    credit: u64,
}

impl Default for SendWindow {
    fn default() -> Self {
        Self::new(STREAM_INITIAL_WINDOW)
    }
}

impl SendWindow {
    pub fn new(initial: u32) -> Self {
        Self {
            credit: u64::from(initial),
        }
    }

    pub fn available(&self) -> u64 {
        self.credit
    }

    pub fn consume(&mut self, n: usize) {
        self.credit = self.credit.saturating_sub(n as u64);
    }

    pub fn grant(&mut self, n: u32) {
        self.credit = self
            .credit
            .saturating_add(u64::from(n))
            .min(STREAM_MAX_WINDOW);
    }
}

/// Bytes the peer may still send; grants are batched so credit frames stay rare.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecvWindow {
    window: u64,
    outstanding: u64,
    unreported: u64,
}

impl Default for RecvWindow {
    fn default() -> Self {
        Self::new(STREAM_INITIAL_WINDOW)
    }
}

impl RecvWindow {
    pub fn new(window: u32) -> Self {
        Self {
            window: u64::from(window),
            outstanding: 0,
            unreported: 0,
        }
    }

    pub fn on_data(&mut self, n: usize) -> Result<(), FlowError> {
        let next = self.outstanding.saturating_add(n as u64);
        if next > self.window {
            return Err(FlowError::Overrun);
        }
        self.outstanding = next;
        Ok(())
    }

    /// The sink took `n` bytes; returns a grant to send once a quarter window has drained.
    pub fn on_consumed(&mut self, n: usize) -> Option<u32> {
        let n = (n as u64).min(self.outstanding);
        self.outstanding = self.outstanding.saturating_sub(n);
        self.unreported = self.unreported.saturating_add(n);
        if self.unreported >= self.window / 4 {
            let g = u32::try_from(self.unreported).unwrap_or(u32::MAX);
            self.unreported = self.unreported.saturating_sub(u64::from(g));
            return Some(g);
        }
        None
    }

    pub fn outstanding(&self) -> u64 {
        self.outstanding
    }
}

#[derive(Debug)]
struct Lane {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    deficit: usize,
    credit: Option<SendWindow>,
    queued: bool,
}

/// Deficit round robin over per-stream byte queues, with optional per-stream credit.
#[derive(Debug)]
pub struct FairQueue {
    lanes: HashMap<u32, Lane>,
    ring: VecDeque<u32>,
    quantum: usize,
    total: usize,
}

impl FairQueue {
    pub fn new(quantum: usize) -> Self {
        Self {
            lanes: HashMap::new(),
            ring: VecDeque::new(),
            quantum: quantum.max(1),
            total: 0,
        }
    }

    /// Start tracking a stream; `credit` is `Some` only under `stream-credit-v1`.
    pub fn open(&mut self, id: u32, credit: Option<SendWindow>) {
        self.lanes.entry(id).or_insert(Lane {
            chunks: VecDeque::new(),
            bytes: 0,
            deficit: 0,
            credit,
            queued: false,
        });
    }

    /// Forget a stream and whatever it still had queued; returns the bytes dropped.
    pub fn remove(&mut self, id: u32) -> usize {
        let Some(l) = self.lanes.remove(&id) else {
            return 0;
        };
        self.ring.retain(|x| *x != id);
        self.total = self.total.saturating_sub(l.bytes);
        l.bytes
    }

    pub fn queued_bytes(&self, id: u32) -> usize {
        self.lanes.get(&id).map_or(0, |l| l.bytes)
    }

    pub fn total_bytes(&self) -> usize {
        self.total
    }

    pub fn contains(&self, id: u32) -> bool {
        self.lanes.contains_key(&id)
    }

    fn sendable(l: &Lane) -> bool {
        !l.chunks.is_empty() && l.credit.is_none_or(|c| c.available() > 0)
    }

    fn requeue(&mut self, id: u32) {
        if let Some(l) = self.lanes.get_mut(&id)
            && !l.queued
            && Self::sendable(l)
        {
            l.queued = true;
            self.ring.push_back(id);
        }
    }

    /// Queue bytes for a stream. Returns false for an unknown stream.
    pub fn push(&mut self, id: u32, data: Vec<u8>) -> bool {
        let Some(l) = self.lanes.get_mut(&id) else {
            return false;
        };
        if data.is_empty() {
            return true;
        }
        l.bytes = l.bytes.saturating_add(data.len());
        self.total = self.total.saturating_add(data.len());
        l.chunks.push_back(data);
        self.requeue(id);
        true
    }

    pub fn grant(&mut self, id: u32, n: u32) {
        if let Some(c) = self.lanes.get_mut(&id).and_then(|l| l.credit.as_mut()) {
            c.grant(n);
        }
        self.requeue(id);
    }

    /// Next chunk to put on the wire, never larger than `max` nor the stream's credit.
    pub fn pop(&mut self, max: usize) -> Option<(u32, Vec<u8>)> {
        while let Some(id) = self.ring.pop_front() {
            let quantum = self.quantum;
            let Some(l) = self.lanes.get_mut(&id) else {
                continue;
            };
            l.queued = false;
            if !Self::sendable(l) {
                l.deficit = 0;
                continue;
            }
            if l.deficit == 0 {
                l.deficit = quantum;
            }
            let credit = l.credit.map_or(usize::MAX, |c| {
                usize::try_from(c.available()).unwrap_or(usize::MAX)
            });
            let limit = max.min(l.deficit).min(credit).max(1);
            let Some(head) = l.chunks.front_mut() else {
                continue;
            };
            let out = if head.len() <= limit {
                l.chunks.pop_front().unwrap_or_default()
            } else {
                let rest = head.split_off(limit);
                std::mem::replace(head, rest)
            };
            let n = out.len();
            l.bytes = l.bytes.saturating_sub(n);
            self.total = self.total.saturating_sub(n);
            l.deficit = l.deficit.saturating_sub(n);
            if let Some(c) = l.credit.as_mut() {
                c.consume(n);
            }
            if l.deficit > 0 && Self::sendable(l) {
                l.queued = true;
                self.ring.push_front(id);
            } else {
                l.deficit = 0;
                self.requeue(id);
            }
            return Some((id, out));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_robin_bulk_does_not_starve_small() {
        let mut q = FairQueue::new(1024);
        q.open(1, None);
        q.open(2, None);
        q.push(1, vec![1; 64 * 1024]);
        q.push(2, vec![2; 100]);
        let mut order = Vec::new();
        while let Some((id, c)) = q.pop(16 * 1024) {
            order.push((id, c.len()));
        }
        assert_eq!(order.first(), Some(&(1, 1024)));
        assert_eq!(order.get(1), Some(&(2, 100)));
        assert_eq!(order.iter().map(|x| x.1).sum::<usize>(), 64 * 1024 + 100);
        assert_eq!(q.total_bytes(), 0);
    }

    #[test]
    fn credit_blocks_and_grant_resumes() {
        let mut q = FairQueue::new(DEFAULT_QUANTUM);
        q.open(7, Some(SendWindow::new(10)));
        q.push(7, vec![0; 25]);
        assert_eq!(q.pop(1000).map(|x| x.1.len()), Some(10));
        assert_eq!(q.pop(1000), None);
        q.grant(7, 20);
        assert_eq!(q.pop(1000).map(|x| x.1.len()), Some(15));
        assert_eq!(q.queued_bytes(7), 0);
    }

    #[test]
    fn recv_window_overrun_and_batched_grants() {
        let mut w = RecvWindow::new(100);
        assert!(w.on_data(100).is_ok());
        assert_eq!(w.on_data(1), Err(FlowError::Overrun));
        assert_eq!(w.on_consumed(10), None);
        assert_eq!(w.on_consumed(15), Some(25));
        assert!(w.on_data(25).is_ok());
    }
}
