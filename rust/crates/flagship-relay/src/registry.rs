//! Tunnel registry (`apps/web/src/tunnel/registry.ts`): pod canonical → tunnel, the allocator
//! behind it, the custom-domain redirection table and the known-box roster used by the
//! park-on-miss rule. Generic over the tunnel handle so routing is testable without sockets.

use std::collections::{HashMap, HashSet};

use crate::allocator::{AddPodResult, Allocator, RemovePodResult, SetKey, Snapshot, TransferError};

/// A box's serving decision as routing sees it (`serving-wiring.md` §2): its exact control name routes while `control`,
/// every other name only while `apps` too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServingView {
    pub control: bool,
    pub apps: bool,
}

pub type PhoneLookupFn<T> = dyn Fn(&str) -> Option<T> + Send + Sync;

/// Who holds each account's bare name (the phone routes); unset, the bare name never routes.
pub struct PhoneLookup<T>(pub Box<PhoneLookupFn<T>>);

impl<T> std::fmt::Debug for PhoneLookup<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PhoneLookup")
    }
}

#[derive(Debug)]
pub struct Registry<T> {
    tunnels: HashMap<String, T>,
    phone: Option<PhoneLookup<T>>,
    /// Per pod, set by the serving gate; absent = no serving authority wired (every name routes).
    serving: HashMap<String, ServingView>,
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

/// `<account>.<apex>` with an account label (`barePhoneAccount`).
pub fn bare_account(lower: &str, apex: &str) -> bool {
    let Some(head) = lower.strip_suffix(apex).and_then(|h| h.strip_suffix('.')) else {
        return false;
    };
    let b = head.as_bytes();
    let alnum = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    !b.is_empty()
        && b.len() <= 63
        && b.first().is_some_and(alnum)
        && b.last().is_some_and(alnum)
        && b.iter().all(|c| alnum(c) || *c == b'-')
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
            phone: None,
            serving: HashMap::new(),
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
        let apps = self.serving.get(&pc).is_none_or(|v| v.apps);
        self.allocator
            .add_pod_serving(&pc, canonicals, now_ms, apps)
    }

    /// The serving gate decided for this pod: remember it for routing, and hand its app slots on (or take free ones
    /// back). Returns the sets whose snapshot changed.
    pub fn set_serving(&mut self, pod_canonical: &str, view: ServingView) -> Vec<SetKey> {
        let pc = pod_canonical.to_lowercase();
        self.serving.insert(pc.clone(), view);
        if !self.tunnels.contains_key(&pc) {
            return Vec::new();
        }
        self.allocator
            .set_apps_allowed(&pc, view.apps)
            .affected_sets
    }

    /// Route each account's bare name to the phone that holds it.
    pub fn set_phone_routes(&mut self, lookup: Option<PhoneLookup<T>>) {
        self.phone = lookup;
    }

    pub fn serving_of(&self, pod_canonical: &str) -> Option<ServingView> {
        self.serving.get(&pod_canonical.to_lowercase()).copied()
    }

    /// Is `pc`'s registered tunnel the one `is_current` names?
    pub fn is_current(&self, pod_canonical: &str, is_current: impl Fn(&T) -> bool) -> bool {
        self.tunnels
            .get(&pod_canonical.to_lowercase())
            .is_some_and(is_current)
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
        self.serving.remove(&pc);
        Some(self.allocator.remove_pod(&pc))
    }

    pub fn unregister(&mut self, pod_canonical: &str) -> RemovePodResult {
        let pc = pod_canonical.to_lowercase();
        self.tunnels.remove(&pc);
        self.serving.remove(&pc);
        self.allocator.remove_pod(&pc)
    }

    /// Exact (canonical or held slot), then one leftmost-label strip, then the pod's own
    /// canonical, then custom-domain redirections, in that order (`findBySni`).
    ///
    /// An account's bare `<account>.<apex>` name is its admin phones' (plan H3): it resolves only from the phone routes,
    /// never to a box. A box whose serving decision refuses a name resolves to
    /// nothing for it, so the router closes it exactly like a name nobody registered.
    pub fn find_by_sni(&self, sni: &str) -> Option<T> {
        let lower = sni.to_lowercase();
        if bare_account(&lower, &self.apex) {
            return self.phone.as_ref().and_then(|p| (p.0)(&lower));
        }
        let pc = self.resolve(&lower)?;
        match self.serving.get(&pc) {
            None => self.tunnels.get(&pc).cloned(),
            Some(v) if !v.control => None,
            Some(v) if v.apps || lower == pc => self.tunnels.get(&pc).cloned(),
            Some(_) => None,
        }
    }

    /// The pod canonical a name resolves to (`resolveSni`).
    fn resolve(&self, lower: &str) -> Option<String> {
        if lower.contains('*') {
            return None;
        }
        if let Some(h) = self.allocator.find_holder(lower) {
            return self.tunnels.contains_key(&h).then_some(h);
        }
        let (_, parent) = lower.split_once('.')?;
        if let Some(h) = self.allocator.find_holder(parent) {
            return self.tunnels.contains_key(&h).then_some(h);
        }
        if self.tunnels.contains_key(parent) {
            return Some(parent.to_owned());
        }
        let pod = self.redirections.get(lower)?;
        self.tunnels.contains_key(pod).then(|| pod.clone())
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
