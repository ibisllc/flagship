//! Tunnel registry (`apps/web/src/tunnel/registry.ts`): pod canonical → tunnel, the allocator
//! behind it, the custom-domain redirection table and the known-box roster used by the
//! park-on-miss rule. Generic over the tunnel handle so routing is testable without sockets.

use std::collections::{HashMap, HashSet};

use crate::allocator::{AddPodResult, Allocator, RemovePodResult, SetKey, Snapshot, TransferError};

#[derive(Debug)]
pub struct Registry<T> {
    tunnels: HashMap<String, T>,
    redirections: HashMap<String, String>,
    known_box_canonicals: HashSet<String>,
    allocator: Allocator,
    apex: String,
}

fn user_label_ok(u: &str) -> bool {
    let b = u.as_bytes();
    let alnum = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    match b.split_first() {
        Some((f, rest)) => {
            alnum(f) && rest.len() <= 62 && rest.iter().all(|c| alnum(c) || *c == b'-')
        }
        None => false,
    }
}

/// The user-zone label: the last label of `<...>.<user>.<apex>` with at least two labels.
pub fn user_of(name: &str, apex: &str) -> Option<String> {
    let lower = name.to_lowercase();
    if lower.contains('*') {
        return None;
    }
    let head = lower.strip_suffix(apex)?.strip_suffix('.')?;
    if head.is_empty() {
        return None;
    }
    let parts: Vec<&str> = head.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let user = *parts.last()?;
    user_label_ok(user).then(|| user.to_owned())
}

impl<T: Clone> Registry<T> {
    pub fn new(apex: &str) -> Self {
        let apex = apex.to_lowercase();
        Self {
            tunnels: HashMap::new(),
            redirections: HashMap::new(),
            known_box_canonicals: HashSet::new(),
            allocator: Allocator::new(&apex),
            apex,
        }
    }

    pub fn apex(&self) -> &str {
        &self.apex
    }

    pub fn register(
        &mut self,
        pod_canonical: &str,
        tunnel: T,
        canonicals: &[String],
        now_ms: u64,
    ) -> AddPodResult {
        let pc = pod_canonical.to_lowercase();
        self.tunnels.insert(pc.clone(), tunnel);
        self.known_box_canonicals.insert(pc.clone());
        self.allocator.add_pod(&pc, canonicals, now_ms)
    }

    pub fn request_transfer(
        &mut self,
        pod_canonical: &str,
        fqdn: &str,
    ) -> Result<(SetKey, Option<String>), TransferError> {
        self.allocator.request_transfer(pod_canonical, fqdn)
    }

    /// Unregister only if `pod_canonical` is still held by `is_current` (a reconnect may have
    /// replaced it already, and the old tunnel's close must not evict the new one).
    pub fn unregister_if(
        &mut self,
        pod_canonical: &str,
        is_current: impl Fn(&T) -> bool,
    ) -> Option<RemovePodResult> {
        let pc = pod_canonical.to_lowercase();
        if !self.tunnels.get(&pc).is_some_and(&is_current) {
            return None;
        }
        self.tunnels.remove(&pc);
        Some(self.allocator.remove_pod(&pc))
    }

    pub fn unregister(&mut self, pod_canonical: &str) -> RemovePodResult {
        let pc = pod_canonical.to_lowercase();
        self.tunnels.remove(&pc);
        self.allocator.remove_pod(&pc)
    }

    /// Exact (canonical or held slot), then one leftmost-label strip, then the pod's own
    /// canonical, then custom-domain redirections, in that order (`findBySni`).
    pub fn find_by_sni(&self, sni: &str) -> Option<T> {
        let lower = sni.to_lowercase();
        if lower.contains('*') {
            return None;
        }
        if let Some(h) = self.allocator.find_holder(&lower) {
            return self.tunnels.get(&h).cloned();
        }
        let (_, parent) = lower.split_once('.')?;
        if let Some(h) = self.allocator.find_holder(parent) {
            return self.tunnels.get(&h).cloned();
        }
        if let Some(t) = self.tunnels.get(parent) {
            return Some(t.clone());
        }
        let pod = self.redirections.get(&lower)?;
        self.tunnels.get(pod).cloned()
    }

    pub fn add_redirection(&mut self, fqdn: &str, pod: &str) {
        self.redirections
            .insert(fqdn.to_lowercase(), pod.to_lowercase());
    }

    pub fn remove_redirection(&mut self, fqdn: &str) {
        self.redirections.remove(&fqdn.to_lowercase());
    }

    pub fn load_redirections<'a>(&mut self, entries: impl IntoIterator<Item = (&'a str, &'a str)>) {
        self.redirections.clear();
        for (f, p) in entries {
            self.add_redirection(f, p);
        }
    }

    pub fn redirection_count(&self) -> usize {
        self.redirections.len()
    }

    pub fn snapshot_by_key(&self, key: &SetKey) -> Option<Snapshot> {
        self.allocator.snapshot_by_key(key)
    }

    pub fn members_of(&self, key: &SetKey) -> Vec<T> {
        self.allocator
            .members_of(key)
            .iter()
            .filter_map(|pc| self.tunnels.get(pc).cloned())
            .collect()
    }

    pub fn user_of_sni(&self, sni: &str) -> Option<String> {
        user_of(sni, &self.apex)
    }

    pub fn tunnels_for_user(&self, username: &str) -> Vec<T> {
        let u = username.trim().to_lowercase();
        if u.is_empty() {
            return Vec::new();
        }
        self.tunnels
            .iter()
            .filter(|(pc, _)| user_of(pc, &self.apex).as_deref() == Some(u.as_str()))
            .map(|(_, t)| t.clone())
            .collect()
    }

    pub fn has_online_tunnels_for_user(&self, username: &str) -> bool {
        let u = username.trim().to_lowercase();
        !u.is_empty()
            && self
                .tunnels
                .keys()
                .any(|pc| user_of(pc, &self.apex).as_deref() == Some(u.as_str()))
    }

    /// A miss worth parking: a first-party name whose account has a box online and that is
    /// not itself a (current or past) box canonical.
    pub fn is_nudgeable_sni(&self, sni: &str) -> bool {
        let lower = sni.to_lowercase();
        let Some(user) = self.user_of_sni(&lower) else {
            return false;
        };
        !self.known_box_canonicals.contains(&lower) && self.has_online_tunnels_for_user(&user)
    }

    pub fn size(&self) -> usize {
        self.tunnels.len()
    }

    pub fn all(&self) -> Vec<T> {
        self.tunnels.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "flagship.services";

    #[test]
    fn routing_order_matches_ts() {
        let mut r: Registry<&'static str> = Registry::new(A);
        r.register(
            "home.alice.flagship.services",
            "home",
            &["chess.home.alice.flagship.services".into()],
            1,
        );
        assert_eq!(r.find_by_sni("HOME.alice.flagship.services"), Some("home"));
        assert_eq!(r.find_by_sni("chess.alice.flagship.services"), Some("home"));
        assert_eq!(
            r.find_by_sni("anything.home.alice.flagship.services"),
            Some("home")
        );
        assert_eq!(r.find_by_sni("a.b.home.alice.flagship.services"), None);
        assert_eq!(r.find_by_sni("*.home.alice.flagship.services"), None);
        r.add_redirection("www.example.com", "home.alice.flagship.services");
        assert_eq!(r.find_by_sni("www.example.com"), Some("home"));
    }

    #[test]
    fn nudge_rule() {
        let mut r: Registry<u8> = Registry::new(A);
        r.register("home.alice.flagship.services", 1, &[], 1);
        assert!(r.is_nudgeable_sni("notes.alice.flagship.services"));
        assert!(!r.is_nudgeable_sni("home.alice.flagship.services"));
        assert!(!r.is_nudgeable_sni("notes.bob.flagship.services"));
        assert!(!r.is_nudgeable_sni("www.example.com"));
        r.unregister("home.alice.flagship.services");
        assert!(!r.is_nudgeable_sni("notes.alice.flagship.services"));
    }
}
