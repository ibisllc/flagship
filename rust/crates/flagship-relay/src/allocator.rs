//! First-come-first-served slot allocator (`apps/web/src/tunnel/allocator.ts`), ported rule
//! for rule: same set keys, same derivable shortened names, same candidate queues and heir
//! choice, same snapshot ordering.

use std::collections::{BTreeMap, HashMap, HashSet};

pub const DEFAULT_APEX: &str = "flagship.services";

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SetKey {
    pub slug: String,
    pub author: String,
    pub user: String,
}

impl SetKey {
    fn encode(&self) -> String {
        format!("{}|{}|{}", self.slug, self.author, self.user)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotMember {
    pub pod_canonical: String,
    pub canonical_for_set: String,
    pub joined_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub key: SetKey,
    pub members: Vec<SnapshotMember>,
    /// `(fqdn, holder)`, sorted by fqdn.
    pub slot_holders: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AddPodResult {
    pub affected_sets: Vec<SetKey>,
    pub shorteneds_held: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransferError {
    NotDerivable,
    PodNotRegistered,
    NotParseable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redistributed {
    pub fqdn: String,
    pub from: String,
    pub to: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RemovePodResult {
    pub affected_sets: Vec<SetKey>,
    pub redistributed: Vec<Redistributed>,
}

#[derive(Debug)]
struct PodEntry {
    first_registered_at: u64,
    canonicals: HashSet<String>,
    derivable: HashSet<String>,
    set_keys: Vec<String>,
}

/// Insertion-ordered string map: JS `Map` iteration order is part of the observable behavior
/// (members and heirs are walked in insertion order).
#[derive(Debug, Default)]
struct OrderedMap {
    order: Vec<String>,
    values: HashMap<String, String>,
}

impl OrderedMap {
    fn get(&self, k: &str) -> Option<&String> {
        self.values.get(k)
    }
    fn contains(&self, k: &str) -> bool {
        self.values.contains_key(k)
    }
    fn set(&mut self, k: &str, v: &str) {
        if self.values.insert(k.to_owned(), v.to_owned()).is_none() {
            self.order.push(k.to_owned());
        }
    }
    fn delete(&mut self, k: &str) {
        if self.values.remove(k).is_some() {
            self.order.retain(|x| x != k);
        }
    }
    fn iter(&self) -> impl Iterator<Item = (&String, &String)> {
        self.order
            .iter()
            .filter_map(|k| self.values.get(k).map(|v| (k, v)))
    }
    fn len(&self) -> usize {
        self.values.len()
    }
}

#[derive(Debug)]
struct SetEntry {
    key: SetKey,
    members: OrderedMap,
    slot_holders: OrderedMap,
    candidate_queue: BTreeMap<String, Vec<String>>,
}

#[derive(Debug)]
pub struct Allocator {
    pods: HashMap<String, PodEntry>,
    sets: HashMap<String, SetEntry>,
    apex: String,
}

fn label_ok(s: &str) -> bool {
    let b = s.as_bytes();
    let alnum = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    match b.split_first() {
        Some((first, rest)) => {
            alnum(first) && rest.len() <= 62 && rest.iter().all(|c| alnum(c) || *c == b'-')
        }
        None => false,
    }
}

fn user_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 63
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn strip_apex<'a>(lower: &'a str, apex: &str) -> Option<&'a str> {
    let head = lower.strip_suffix(apex)?.strip_suffix('.')?;
    Some(head)
}

/// Split at the last `-` when it is neither first nor last: `<slug>-<author>`.
fn split_dash(leftmost: &str) -> Option<(&str, &str)> {
    let i = leftmost.rfind('-')?;
    if i == 0 || i.saturating_add(1) >= leftmost.len() {
        return None;
    }
    Some((leftmost.get(..i)?, leftmost.get(i.saturating_add(1)..)?))
}

pub fn parse_set_key(fqdn: &str, apex: &str) -> Option<SetKey> {
    let lower = fqdn.to_lowercase();
    let head = strip_apex(&lower, apex)?;
    if head.is_empty() {
        return None;
    }
    let parts: Vec<&str> = head.split('.').collect();
    if parts.len() < 2 || !parts.iter().all(|p| label_ok(p)) {
        return None;
    }
    let user = *parts.last()?;
    if !user_ok(user) {
        return None;
    }
    let leftmost = *parts.first()?;
    let (slug, author) = split_dash(leftmost).unwrap_or((leftmost, user));
    if !label_ok(slug) || !user_ok(author) {
        return None;
    }
    Some(SetKey {
        slug: slug.to_owned(),
        author: author.to_owned(),
        user: user.to_owned(),
    })
}

pub fn derivable_shorteneds(canonical: &str, apex: &str) -> Vec<String> {
    let lower = canonical.to_lowercase();
    let Some(head) = strip_apex(&lower, apex) else {
        return Vec::new();
    };
    if head.contains('*') {
        return Vec::new();
    }
    let parts: Vec<&str> = head.split('.').collect();
    if parts.len() < 3 {
        return Vec::new();
    }
    let (Some(leftmost), Some(user)) = (parts.first(), parts.last()) else {
        return Vec::new();
    };
    let host = parts
        .get(parts.len().saturating_sub(2))
        .copied()
        .unwrap_or_default();
    let mut out = vec![format!("{leftmost}.{user}.{apex}")];
    if let Some((slug, _)) = split_dash(leftmost) {
        out.push(format!("{slug}.{user}.{apex}"));
        out.push(format!("{slug}.{host}.{user}.{apex}"));
    }
    out
}

fn is_short_service_canonical(fqdn: &str, apex: &str) -> bool {
    let lower = fqdn.to_lowercase();
    let Some(head) = strip_apex(&lower, apex) else {
        return false;
    };
    if head.is_empty() || head.contains('*') {
        return false;
    }
    let parts: Vec<&str> = head.split('.').collect();
    parts.len() == 2
        && parts.iter().all(|p| label_ok(p))
        && parts.get(1).is_some_and(|u| user_ok(u))
}

impl Allocator {
    pub fn new(apex: &str) -> Self {
        Self {
            pods: HashMap::new(),
            sets: HashMap::new(),
            apex: apex.to_lowercase(),
        }
    }

    pub fn apex(&self) -> &str {
        &self.apex
    }

    fn set_entry(&mut self, key: &SetKey) -> &mut SetEntry {
        self.sets.entry(key.encode()).or_insert_with(|| SetEntry {
            key: key.clone(),
            members: OrderedMap::default(),
            slot_holders: OrderedMap::default(),
            candidate_queue: BTreeMap::new(),
        })
    }

    pub fn add_pod(
        &mut self,
        pod_canonical: &str,
        canonicals: &[String],
        now_ms: u64,
    ) -> AddPodResult {
        let pc = pod_canonical.to_lowercase();
        let mut ordered: Vec<String> = Vec::new();
        for c in canonicals {
            let l = c.to_lowercase();
            if !l.contains('*') && !ordered.contains(&l) {
                ordered.push(l);
            }
        }
        if !ordered.contains(&pc) {
            ordered.push(pc.clone());
        }
        let first = self.pods.get(&pc).map_or(now_ms, |p| p.first_registered_at);
        let mut derivable: Vec<String> = Vec::new();
        for c in &ordered {
            for sh in derivable_shorteneds(c, &self.apex) {
                if !derivable.contains(&sh) {
                    derivable.push(sh);
                }
            }
        }
        let mut entry = PodEntry {
            first_registered_at: first,
            canonicals: ordered.iter().cloned().collect(),
            derivable: derivable.iter().cloned().collect(),
            set_keys: Vec::new(),
        };
        let mut affected: Vec<String> = Vec::new();
        let mut held = Vec::new();
        let apex = self.apex.clone();
        for canonical in &ordered {
            let Some(key) = parse_set_key(canonical, &apex) else {
                continue;
            };
            let ks = key.encode();
            let set = self.set_entry(&key);
            if !set.members.contains(&pc) {
                set.members.set(&pc, canonical);
            }
            enqueue(set, canonical, &pc);
            if canonical != &pc
                && is_short_service_canonical(canonical, &apex)
                && !set.slot_holders.contains(canonical)
            {
                set.slot_holders.set(canonical, &pc);
                held.push(canonical.clone());
            }
            push_unique(&mut entry.set_keys, &ks);
            push_unique(&mut affected, &ks);
        }
        for sh in &derivable {
            let Some(key) = parse_set_key(sh, &apex) else {
                continue;
            };
            let ks = key.encode();
            let set = self.set_entry(&key);
            if !set.members.contains(&pc) {
                set.members.set(&pc, sh);
            }
            enqueue(set, sh, &pc);
            if !set.slot_holders.contains(sh) {
                set.slot_holders.set(sh, &pc);
                held.push(sh.clone());
            }
            push_unique(&mut entry.set_keys, &ks);
            push_unique(&mut affected, &ks);
        }
        self.pods.insert(pc, entry);
        AddPodResult {
            affected_sets: affected
                .iter()
                .filter_map(|k| self.sets.get(k).map(|s| s.key.clone()))
                .collect(),
            shorteneds_held: held,
        }
    }

    pub fn request_transfer(
        &mut self,
        pod_canonical: &str,
        fqdn: &str,
    ) -> Result<(SetKey, Option<String>), TransferError> {
        let pc = pod_canonical.to_lowercase();
        let fq = fqdn.to_lowercase();
        let pod = self.pods.get(&pc).ok_or(TransferError::PodNotRegistered)?;
        let key = parse_set_key(&fq, &self.apex).ok_or(TransferError::NotParseable)?;
        if !pod.derivable.contains(&fq) && !pod.canonicals.contains(&fq) {
            return Err(TransferError::NotDerivable);
        }
        let set = self
            .sets
            .get_mut(&key.encode())
            .ok_or(TransferError::NotParseable)?;
        let previous = set.slot_holders.get(&fq).cloned();
        let q = set.candidate_queue.entry(fq.clone()).or_default();
        q.retain(|p| p != &pc);
        q.insert(0, pc.clone());
        set.slot_holders.set(&fq, &pc);
        Ok((key, previous))
    }

    pub fn remove_pod(&mut self, pod_canonical: &str) -> RemovePodResult {
        let pc = pod_canonical.to_lowercase();
        let Some(pod) = self.pods.get(&pc) else {
            return RemovePodResult::default();
        };
        let keys = pod.set_keys.clone();
        let mut out = RemovePodResult::default();
        let mut affected = Vec::new();
        for ks in keys {
            let Some(set) = self.sets.get_mut(&ks) else {
                continue;
            };
            set.members.delete(&pc);
            push_unique(&mut affected, &ks);
            set.candidate_queue.retain(|_, q| {
                q.retain(|p| p != &pc);
                !q.is_empty()
            });
            let held: Vec<String> = set
                .slot_holders
                .iter()
                .filter(|(_, h)| **h == pc)
                .map(|(s, _)| s.clone())
                .collect();
            for slot in held {
                let heir = pick_heir(&self.pods, &pc, set, &slot);
                match heir {
                    Some(h) => {
                        set.slot_holders.set(&slot, &h);
                        out.redistributed.push(Redistributed {
                            fqdn: slot,
                            from: pc.clone(),
                            to: Some(h),
                        });
                    }
                    None => {
                        set.slot_holders.delete(&slot);
                        out.redistributed.push(Redistributed {
                            fqdn: slot,
                            from: pc.clone(),
                            to: None,
                        });
                    }
                }
            }
            if set.members.len() == 0 && set.slot_holders.len() == 0 {
                self.sets.remove(&ks);
            }
        }
        self.pods.remove(&pc);
        out.affected_sets = affected
            .iter()
            .filter_map(|k| self.sets.get(k).map(|s| s.key.clone()))
            .collect();
        out
    }

    pub fn find_holder(&self, fqdn: &str) -> Option<String> {
        let lower = fqdn.to_lowercase();
        if self.pods.contains_key(&lower) {
            return Some(lower);
        }
        let key = parse_set_key(&lower, &self.apex)?;
        self.sets
            .get(&key.encode())?
            .slot_holders
            .get(&lower)
            .cloned()
    }

    pub fn snapshot_by_key(&self, key: &SetKey) -> Option<Snapshot> {
        self.sets.get(&key.encode()).map(|s| self.snapshot_set(s))
    }

    pub fn members_of(&self, key: &SetKey) -> Vec<String> {
        self.sets
            .get(&key.encode())
            .map(|s| s.members.iter().map(|(k, _)| k.clone()).collect())
            .unwrap_or_default()
    }

    pub fn candidates_for(&self, key: &SetKey, slot: &str) -> Vec<String> {
        self.sets
            .get(&key.encode())
            .and_then(|s| s.candidate_queue.get(slot).cloned())
            .unwrap_or_default()
    }

    pub fn pod_count(&self) -> usize {
        self.pods.len()
    }

    pub fn set_count(&self) -> usize {
        self.sets.len()
    }

    fn snapshot_set(&self, set: &SetEntry) -> Snapshot {
        let mut members: Vec<SnapshotMember> = set
            .members
            .iter()
            .map(|(pc, cfs)| SnapshotMember {
                pod_canonical: pc.clone(),
                canonical_for_set: cfs.clone(),
                joined_at: self.pods.get(pc).map_or(0, |p| p.first_registered_at),
            })
            .collect();
        members.sort_by(|a, b| {
            a.joined_at
                .cmp(&b.joined_at)
                .then_with(|| a.pod_canonical.cmp(&b.pod_canonical))
        });
        let mut slot_holders: Vec<(String, String)> = set
            .slot_holders
            .iter()
            .map(|(a, b)| (a.clone(), b.clone()))
            .collect();
        slot_holders.sort_by(|a, b| a.0.cmp(&b.0));
        Snapshot {
            key: set.key.clone(),
            members,
            slot_holders,
        }
    }
}

fn push_unique(v: &mut Vec<String>, s: &str) {
    if !v.iter().any(|x| x == s) {
        v.push(s.to_owned());
    }
}

fn enqueue(set: &mut SetEntry, slot: &str, pod: &str) {
    let q = set.candidate_queue.entry(slot.to_owned()).or_default();
    if !q.iter().any(|p| p == pod) {
        q.push(pod.to_owned());
    }
}

/// The pod being removed is still in `pods` while heirs are picked (as in TS), so it is
/// excluded explicitly through `members`, from which it was already deleted.
fn pick_heir(
    pods: &HashMap<String, PodEntry>,
    _leaving: &str,
    set: &SetEntry,
    slot: &str,
) -> Option<String> {
    if let Some(q) = set.candidate_queue.get(slot)
        && let Some(c) = q
            .iter()
            .find(|c| pods.contains_key(*c) && set.members.contains(c))
    {
        return Some(c.clone());
    }
    let mut best: Option<(&String, u64)> = None;
    for (m, _) in set.members.iter() {
        let Some(p) = pods.get(m) else {
            continue;
        };
        best = match best {
            None => Some((m, p.first_registered_at)),
            Some((b, at))
                if p.first_registered_at < at || (p.first_registered_at == at && m < b) =>
            {
                Some((m, p.first_registered_at))
            }
            keep => keep,
        };
    }
    best.map(|(m, _)| m.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = DEFAULT_APEX;

    #[test]
    fn set_keys_and_shorteneds() {
        assert_eq!(
            parse_set_key("chess-bob.home.alice.flagship.services", A),
            Some(SetKey {
                slug: "chess".into(),
                author: "bob".into(),
                user: "alice".into()
            })
        );
        assert_eq!(
            derivable_shorteneds("chess-bob.home.alice.flagship.services", A),
            vec![
                "chess-bob.alice.flagship.services".to_owned(),
                "chess.alice.flagship.services".to_owned(),
                "chess.home.alice.flagship.services".to_owned(),
            ]
        );
        assert_eq!(parse_set_key("alice.flagship.services", A), None);
    }

    #[test]
    fn fcfs_then_heir_on_removal() {
        let mut a = Allocator::new(A);
        a.add_pod(
            "home.alice.flagship.services",
            &["chess.home.alice.flagship.services".into()],
            1,
        );
        a.add_pod(
            "cabin.alice.flagship.services",
            &["chess.cabin.alice.flagship.services".into()],
            2,
        );
        assert_eq!(
            a.find_holder("chess.alice.flagship.services").as_deref(),
            Some("home.alice.flagship.services")
        );
        let r = a.remove_pod("home.alice.flagship.services");
        assert!(
            r.redistributed
                .iter()
                .any(|x| x.fqdn == "chess.alice.flagship.services"
                    && x.to.as_deref() == Some("cabin.alice.flagship.services"))
        );
        assert_eq!(
            a.find_holder("chess.alice.flagship.services").as_deref(),
            Some("cabin.alice.flagship.services")
        );
    }

    #[test]
    fn transfer_requires_derivable() {
        let mut a = Allocator::new(A);
        a.add_pod(
            "home.alice.flagship.services",
            &["chess.home.alice.flagship.services".into()],
            1,
        );
        a.add_pod(
            "cabin.alice.flagship.services",
            &["chess.cabin.alice.flagship.services".into()],
            2,
        );
        assert!(
            a.request_transfer(
                "cabin.alice.flagship.services",
                "chess.alice.flagship.services"
            )
            .is_ok()
        );
        assert_eq!(
            a.find_holder("chess.alice.flagship.services").as_deref(),
            Some("cabin.alice.flagship.services")
        );
        assert_eq!(
            a.request_transfer(
                "cabin.alice.flagship.services",
                "notes.alice.flagship.services"
            ),
            Err(TransferError::NotDerivable)
        );
    }
}
