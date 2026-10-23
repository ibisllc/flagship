//! Bounded fair queue: one FIFO per app, served round-robin, so a single
//! app (inference holding a device, a training sweep) can't starve others.

use std::collections::{BTreeMap, VecDeque};

use crate::policy::AllocationId;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum QueueError {
    #[error("the GPU queue is full")]
    Full,
    #[error("this app already has the most queued GPU jobs allowed")]
    AppFull,
    #[error("already queued")]
    Duplicate,
}

#[derive(Debug)]
pub struct FairQueue {
    per_app: usize,
    total: usize,
    queues: BTreeMap<String, VecDeque<AllocationId>>,
    rotation: VecDeque<String>,
    len: usize,
}

impl FairQueue {
    pub fn new(per_app: usize, total: usize) -> Self {
        Self {
            per_app,
            total,
            queues: BTreeMap::new(),
            rotation: VecDeque::new(),
            len: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Returns the 0-based position within the app's own queue.
    pub fn enqueue(&mut self, app: &str, id: AllocationId) -> Result<usize, QueueError> {
        if self.queues.values().any(|q| q.contains(&id)) {
            return Err(QueueError::Duplicate);
        }
        if self.len >= self.total {
            return Err(QueueError::Full);
        }
        let q = self.queues.entry(app.to_owned()).or_default();
        if q.len() >= self.per_app {
            return Err(QueueError::AppFull);
        }
        q.push_back(id);
        let pos = q.len().saturating_sub(1);
        if !self.rotation.iter().any(|a| a == app) {
            self.rotation.push_back(app.to_owned());
        }
        self.len = self.len.saturating_add(1);
        Ok(pos)
    }

    /// The head of each app's queue, in the order they should be tried.
    pub fn candidates(&self) -> Vec<AllocationId> {
        self.rotation
            .iter()
            .filter_map(|a| self.queues.get(a).and_then(|q| q.front()).cloned())
            .collect()
    }

    /// Take `id` off the queue. If it was an app's head, that app moves to
    /// the back of the rotation.
    pub fn remove(&mut self, id: &AllocationId) -> bool {
        let Some((app, q)) = self.queues.iter_mut().find(|(_, q)| q.contains(id)) else {
            return false;
        };
        let was_head = q.front() == Some(id);
        q.retain(|x| x != id);
        let app = app.clone();
        let empty = q.is_empty();
        self.len = self.len.saturating_sub(1);
        if empty {
            self.queues.remove(&app);
            self.rotation.retain(|a| *a != app);
        } else if was_head {
            self.rotation.retain(|a| *a != app);
            self.rotation.push_back(app);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(s: &str) -> AllocationId {
        AllocationId::new(s).unwrap_or_else(|| unreachable!())
    }

    #[test]
    fn round_robin_and_bounded() {
        let mut q = FairQueue::new(2, 3);
        assert_eq!(q.enqueue("a", id("a1")), Ok(0));
        assert_eq!(q.enqueue("a", id("a2")), Ok(1));
        assert_eq!(q.enqueue("a", id("a3")), Err(QueueError::AppFull));
        assert_eq!(q.enqueue("b", id("b1")), Ok(0));
        assert_eq!(q.enqueue("c", id("c1")), Err(QueueError::Full));
        assert_eq!(q.enqueue("b", id("b1")), Err(QueueError::Duplicate));
        assert_eq!(q.candidates(), vec![id("a1"), id("b1")]);
        assert!(q.remove(&id("a1")));
        // a's next job waits behind b.
        assert_eq!(q.candidates(), vec![id("b1"), id("a2")]);
        assert!(q.remove(&id("b1")));
        assert!(q.remove(&id("a2")));
        assert!(q.is_empty());
    }
}
