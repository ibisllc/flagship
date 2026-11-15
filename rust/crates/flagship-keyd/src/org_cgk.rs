//! keyd adopting a rotated org CGK: the Rust twin of `packages/keyd/src/orgCgk.ts`
//! (docs/enterprise-accounts.md "keyd and the org CGK").
//!
//! keyd changes its CGK only on evidence it verifies itself: the org is pinned in keyd's state
//! (`org.json`), the daemon hands it the org's authority chain from genesis, a `cgk` key-ring
//! version and the key it opened, and keyd replays the chain under a narrower rule than the box's
//! full verifier (genesis with every admin's consent, then `direct` transitions only), checks one
//! approval of the ring by an org admin of the record it names, that the version is above the one it
//! holds and names this box, and that the key matches the ring's commitment. Both backends read
//! `packages/protocol/test-vectors/keyd-org-cgk/vectors.json`.

use crate::crypto::{from_hex, sha256};
use crate::service::safe_integer;
use crate::wire::to_hex;
use flagship_crypto::HybridVerifyingKey;
use serde_json::{Map, Value};

const TAG_ORG_AUTHORITY: &str = "flagship/org-authority/v1";
const TAG_ORG_ADMINS: &str = "flagship/org-admins/v1";
const TAG_ORG_BYLAWS: &str = "flagship/org-bylaws/v1";
const TAG_ORG_APPROVAL: &str = "flagship/org-approval/v1";
const TAG_ORG_KEY_RING: &str = "flagship/org-key-ring/v1";
const TAG_ORG_KEY_RECIPIENTS: &str = "flagship/org-key-recipients/v1";
const TAG_ORG_KEY_COMMIT: &str = "flagship/org-key-commit/v1";
const TAG_PQ_KEY_BINDING: &str = "flagship/pq-key-binding/v1";
const MAX_SKEW_MS: u64 = 5 * 60 * 1000;
const APPROVAL_MAX_LIFETIME_MS: u64 = 7 * 24 * 3_600_000;
const K_MAX: u64 = 7;
const MAX_ADMINS: usize = 32;
const MAX_RECIPIENTS: usize = 256;
const MAX_SEALED_HEX: usize = 2 * 4096;

/// What keyd pins for its org (`org.json`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrgCgkPin {
    pub org_id: String,
    pub genesis_hash: String,
    pub server_domain: String,
    pub cgk_version: u64,
}

/// A refusal: the code both backends agree on, and a detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrgCgkError {
    pub code: &'static str,
    pub detail: String,
}

impl std::fmt::Display for OrgCgkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.detail.is_empty() {
            f.write_str(self.code)
        } else {
            write!(f, "{}: {}", self.code, self.detail)
        }
    }
}

type R<T> = Result<T, OrgCgkError>;

fn fail<T>(code: &'static str, detail: impl Into<String>) -> R<T> {
    Err(OrgCgkError {
        code,
        detail: detail.into(),
    })
}

fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn is_domain(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 253
        && b.first()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'.' || *c == b'-')
}

fn is_purpose(s: &str) -> bool {
    // ^flagship/[a-z0-9/-]+/v[1-9][0-9]*$
    let Some(rest) = s.strip_prefix("flagship/") else {
        return false;
    };
    let Some(idx) = rest.rfind("/v") else {
        return false;
    };
    let (mid, ver) = rest.split_at(idx);
    let ver = ver.get(2..).unwrap_or("");
    !mid.is_empty()
        && mid
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'/' || c == b'-')
        && ver
            .bytes()
            .next()
            .is_some_and(|c| (b'1'..=b'9').contains(&c))
        && ver.bytes().all(|c| c.is_ascii_digit())
}

fn sha_hex(b: &[u8]) -> String {
    to_hex(&sha256(b))
}

fn obj<'a>(v: Option<&'a Value>, what: &str) -> R<&'a Map<String, Value>> {
    match v {
        Some(Value::Object(m)) => Ok(m),
        _ => fail("malformed", what),
    }
}

fn s<'a>(o: &'a Map<String, Value>, k: &str) -> R<&'a str> {
    o.get(k)
        .and_then(Value::as_str)
        .map_or_else(|| fail("malformed", k), Ok)
}

fn u(o: &Map<String, Value>, k: &str) -> R<u64> {
    safe_integer(o.get(k)).map_or_else(|| fail("malformed", k), Ok)
}

fn keys_are(o: &Map<String, Value>, want: &str) -> bool {
    let mut k: Vec<&str> = o.keys().map(String::as_str).collect();
    k.sort_unstable();
    k.join(",") == want
}

/// Checks `org.json`.
///
/// # Errors
/// `malformed` on any field out of shape.
pub fn check_pin(v: &Value) -> R<OrgCgkPin> {
    let o = obj(Some(v), "pin")?;
    let org_id = s(o, "orgId")?;
    let genesis_hash = s(o, "genesisHash")?;
    let server_domain = s(o, "serverDomain")?;
    if !is_lower_hex(org_id, 32) {
        return fail("malformed", "orgId");
    }
    if !is_lower_hex(genesis_hash, 64) {
        return fail("malformed", "genesisHash");
    }
    if !is_domain(server_domain) {
        return fail("malformed", "serverDomain");
    }
    let cgk_version = u(o, "cgkVersion")?;
    Ok(OrgCgkPin {
        org_id: org_id.into(),
        genesis_hash: genesis_hash.into(),
        server_domain: server_domain.into(),
        cgk_version,
    })
}

#[must_use]
pub fn pin_json(p: &OrgCgkPin) -> String {
    serde_json::json!({ "orgId": p.org_id, "genesisHash": p.genesis_hash, "serverDomain": p.server_domain, "cgkVersion": p.cgk_version }).to_string()
}

// ── the record ──────────────────────────────────────────────────────────

#[derive(Clone)]
struct Admin {
    seat: String,
    kind: String,
    ed: String,
    ml: String,
    binding: Map<String, Value>,
}

#[derive(Clone)]
struct Record {
    org_id: String,
    version: u64,
    prev_hash: String,
    admins: Vec<Admin>,
    overturn_seats: Option<Vec<String>>,
    overturn_k: u64,
    veto_k: u64,
    founder: String,
    k_gov: u64,
    k_grant: u64,
    k_destroy: u64,
    k_site: u64,
    issued_at: u64,
    canonical: Vec<u8>,
    bylaws_sha: String,
}

impl Record {
    fn hash(&self) -> String {
        sha_hex(&self.canonical)
    }
    fn authority_count(&self) -> u64 {
        self.admins.iter().filter(|a| a.kind == "admin").count() as u64
    }
    fn overturn_set(&self) -> Vec<String> {
        self.overturn_seats.clone().unwrap_or_else(|| {
            self.admins
                .iter()
                .filter(|a| a.kind == "admin")
                .map(|a| a.seat.clone())
                .collect()
        })
    }
    fn overturn_threshold(&self) -> u64 {
        let n = self.overturn_set().len() as u64;
        if self.overturn_k == 0 {
            (n / 2).saturating_add(1)
        } else {
            self.overturn_k
        }
    }
    fn bylaws_threshold(&self) -> u64 {
        let n = self.authority_count();
        let two_thirds = n.saturating_mul(2).div_ceil(3);
        n.min(
            self.k_gov
                .max(self.k_destroy)
                .max(self.k_site)
                .max(self.overturn_threshold())
                .max(two_thirds),
        )
    }
    fn admin(&self, seat: &str) -> Option<&Admin> {
        self.admins.iter().find(|a| a.seat == seat)
    }
}

/// Parses a record and applies `checkOrgAuthorityShape`. Every refusal here is `malformed`.
fn record(v: Option<&Value>) -> R<Record> {
    let o = obj(v, "record")?;
    let org_id = s(o, "orgId")?.to_owned();
    let prev_hash = s(o, "prevHash")?.to_owned();
    let founder = s(o, "founderSeatId")?.to_owned();
    if !is_lower_hex(&org_id, 32) || !is_lower_hex(&prev_hash, 64) || !is_lower_hex(&founder, 32) {
        return fail("malformed", "record ids");
    }
    let version = u(o, "version")?;
    let k_gov = u(o, "kGov")?;
    let k_grant = u(o, "kGrant")?;
    let k_destroy = u(o, "kDestroy")?;
    let k_site = u(o, "kSite")?;
    let issued_at = u(o, "issuedAt")?;
    let Some(Value::Array(list)) = o.get("admins") else {
        return fail("malformed", "admins");
    };
    let mut admins = Vec::new();
    let mut lines = Vec::new();
    for a in list {
        let a = obj(Some(a), "admin")?;
        let seat = s(a, "seatId")?.to_owned();
        let kind = s(a, "kind")?.to_owned();
        let b = obj(a.get("binding"), "binding")?;
        let ed = b
            .get("ed25519PubHex")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let ml = b
            .get("mldsaPubHex")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if !is_lower_hex(&seat, 32)
            || !matches!(kind.as_str(), "admin" | "board" | "recovery")
            || !is_lower_hex(&ed, 64)
            || !is_lower_hex(&ml, 3904)
        {
            return fail("malformed", "admin");
        }
        lines.push(format!("{seat}:{kind}:{ed}:{ml}"));
        admins.push(Admin {
            seat,
            kind,
            ed,
            ml,
            binding: b.clone(),
        });
    }
    lines.sort();
    let admins_sha = sha_hex(format!("{TAG_ORG_ADMINS}|{}", lines.join(",")).as_bytes());
    let by = obj(o.get("bylaws"), "bylaws")?;
    let overturn_k = u(by, "overturnK")?;
    let veto_k = u(by, "vetoK")?;
    let overturn_seats = match by.get("overturnSeats") {
        Some(Value::String(x)) if x == "*" => None,
        Some(Value::Array(xs)) if !xs.is_empty() => {
            let mut out = Vec::new();
            for x in xs {
                match x.as_str() {
                    Some(t) if is_lower_hex(t, 32) => out.push(t.to_owned()),
                    _ => return fail("malformed", "overturnSeats"),
                }
            }
            Some(out)
        }
        _ => return fail("malformed", "overturnSeats"),
    };
    let seats_text = overturn_seats.as_ref().map_or_else(
        || "*".to_owned(),
        |v| {
            let mut v = v.clone();
            v.sort();
            v.join(",")
        },
    );
    let bylaws_sha =
        sha_hex(format!("{TAG_ORG_BYLAWS}|{overturn_k}|{seats_text}|{veto_k}").as_bytes());
    let canonical = format!(
        "{TAG_ORG_AUTHORITY}|{org_id}|{version}|{prev_hash}|{admins_sha}|{bylaws_sha}|{founder}|{k_gov}|{k_grant}|{k_destroy}|{k_site}|{issued_at}"
    )
    .into_bytes();
    let r = Record {
        org_id,
        version,
        prev_hash,
        admins,
        overturn_seats,
        overturn_k,
        veto_k,
        founder,
        k_gov,
        k_grant,
        k_destroy,
        k_site,
        issued_at,
        canonical,
        bylaws_sha,
    };
    shape(&r)?;
    Ok(r)
}

fn shape(r: &Record) -> R<()> {
    if r.admins.is_empty() || r.admins.len() > MAX_ADMINS {
        return fail("malformed", "admins");
    }
    let mut seats = std::collections::BTreeSet::new();
    let mut eds = std::collections::BTreeSet::new();
    for a in &r.admins {
        if !seats.insert(a.seat.clone()) || !eds.insert(a.ed.clone()) {
            return fail("malformed", "duplicate");
        }
    }
    let n = r.authority_count();
    if n == 0 || r.admin(&r.founder).is_none_or(|f| f.kind != "admin") {
        return fail("malformed", "founder");
    }
    let floor = n.min(2);
    for k in [r.k_gov, r.k_grant, r.k_destroy, r.k_site] {
        if k < 1 || k > n || k > K_MAX {
            return fail("malformed", "thresholds");
        }
    }
    if r.k_gov < floor || r.k_destroy < floor {
        return fail("malformed", "floor");
    }
    if let Some(set) = &r.overturn_seats {
        let uniq: std::collections::BTreeSet<_> = set.iter().collect();
        if uniq.len() != set.len()
            || set
                .iter()
                .any(|x| r.admin(x).is_none_or(|a| a.kind == "recovery"))
        {
            return fail("malformed", "bylaws");
        }
    }
    let size = r.overturn_set().len() as u64;
    let t = r.overturn_threshold();
    if size == 0 || t > size || t > K_MAX || r.veto_k < 1 || r.veto_k > K_MAX {
        return fail("malformed", "bylaws");
    }
    Ok(())
}

struct Key {
    vk: HybridVerifyingKey,
    key_id: String,
}

/// The admin's binding, self-signed with its own hybrid key.
fn admin_key(r: &Record, a: &Admin, now: u64) -> R<Key> {
    let b = &a.binding;
    let subject = format!("{}:{}", r.org_id, a.seat);
    let issued_at = safe_integer(b.get("issuedAt"));
    let sig = b.get("signature").and_then(Value::as_str).unwrap_or("");
    let ok_shape = b.get("v").and_then(Value::as_u64) == Some(1)
        && b.get("role").and_then(Value::as_str) == Some("org-seat-admin")
        && b.get("subjectId").and_then(Value::as_str) == Some(subject.as_str())
        && issued_at.is_some_and(|t| t <= now.saturating_add(MAX_SKEW_MS))
        && is_lower_hex(sig, 6746);
    if !ok_shape {
        return fail("binding", a.seat.clone());
    }
    let pk = from_hex(&format!("{}{}", a.ed, a.ml)).unwrap_or_default();
    let vk = HybridVerifyingKey::from_bytes(&pk).or_else(|_| fail("binding", a.seat.clone()))?;
    let msg = format!(
        "{TAG_PQ_KEY_BINDING}|org-seat-admin|{subject}|{}|{}|{}",
        a.ed,
        a.ml,
        issued_at.unwrap_or(0)
    );
    let sig = from_hex(sig).unwrap_or_default();
    if vk.verify(TAG_PQ_KEY_BINDING, msg.as_bytes(), &sig).is_err() {
        return fail("binding", a.seat.clone());
    }
    let key_id = to_hex(&vk.key_id());
    Ok(Key { vk, key_id })
}

const APPROVAL_KEYS: &str =
    "adminKeyId,issuedAt,notAfter,oarVersion,orderSha256,orgId,purposeTag,seatId,signature";

fn purpose_of(order: &[u8]) -> String {
    match order.iter().position(|c| *c == b'|') {
        Some(i) if i > 0 => std::str::from_utf8(order.get(..i).unwrap_or(&[]))
            .unwrap_or("")
            .to_owned(),
        _ => String::new(),
    }
}

/// Checks approvals of `order` under version `oar`; returns signer seat ids.
fn approvals(
    list: &[Value],
    org_id: &str,
    oar: u64,
    order: &[u8],
    now: u64,
    key_of: &dyn Fn(&str) -> R<Option<Key>>,
) -> R<Vec<String>> {
    let purpose = purpose_of(order);
    let digest = sha_hex(order);
    let mut seen: Vec<String> = Vec::new();
    for raw in list {
        let a = obj(Some(raw), "approval")?;
        if !keys_are(a, APPROVAL_KEYS) {
            return fail("malformed", "approval keys");
        }
        let sig = s(a, "signature")?;
        if !is_lower_hex(sig, 6746) {
            return fail("malformed", "approval signature");
        }
        let a_org = s(a, "orgId")?;
        let a_sha = s(a, "orderSha256")?;
        let a_seat = s(a, "seatId")?;
        let a_key = s(a, "adminKeyId")?;
        let a_purpose = s(a, "purposeTag")?;
        let a_oar = u(a, "oarVersion")?;
        let not_after = u(a, "notAfter")?;
        let issued_at = u(a, "issuedAt")?;
        if !is_lower_hex(a_org, 32)
            || !is_lower_hex(a_sha, 64)
            || !is_lower_hex(a_seat, 32)
            || !is_lower_hex(a_key, 64)
            || !is_purpose(a_purpose)
        {
            return fail("malformed", "approval");
        }
        if a_org != org_id {
            return fail("wrong-org", "");
        }
        if a_oar != oar {
            return fail("stale-oar", "");
        }
        if a_purpose != purpose || a_sha != digest {
            return fail("order-mismatch", "");
        }
        if issued_at > now.saturating_add(MAX_SKEW_MS) {
            return fail("future", "");
        }
        if not_after < issued_at || not_after.saturating_sub(issued_at) > APPROVAL_MAX_LIFETIME_MS {
            return fail("malformed", "notAfter");
        }
        if seen.iter().any(|x| x == a_seat) {
            return fail("duplicate-signer", "");
        }
        seen.push(a_seat.to_owned());
        let Some(k) = key_of(a_seat)? else {
            return fail("unknown-signer", a_seat);
        };
        if k.key_id != a_key {
            return fail("unknown-signer", a_seat);
        }
        let msg = format!(
            "{TAG_ORG_APPROVAL}|{a_org}|{a_oar}|{a_purpose}|{a_sha}|{a_seat}|{a_key}|{not_after}|{issued_at}"
        );
        if k.vk
            .verify(
                TAG_ORG_APPROVAL,
                msg.as_bytes(),
                &from_hex(sig).unwrap_or_default(),
            )
            .is_err()
        {
            return fail("bad-signature", a_seat);
        }
    }
    Ok(seen)
}

fn list(v: Option<&Value>, what: &str) -> R<Vec<Value>> {
    match v {
        Some(Value::Array(xs)) => Ok(xs.clone()),
        _ => fail("malformed", what),
    }
}

/// Replays the chain under keyd's rule.
fn verify_chain(chain: Option<&Value>, pin: &OrgCgkPin, now: u64) -> R<Vec<Record>> {
    let entries = list(chain, "chain")?;
    if entries.is_empty() || entries.len() > 4096 {
        return fail("malformed", "chain");
    }
    let mut records: Vec<Record> = Vec::new();
    let mut keys: std::collections::BTreeMap<String, (HybridVerifyingKey, String)> =
        std::collections::BTreeMap::new();
    for raw in &entries {
        let e = obj(Some(raw), "entry")?;
        let r = record(e.get("record"))?;
        if r.issued_at > now.saturating_add(MAX_SKEW_MS) {
            return fail("future", "");
        }
        let mut mine: std::collections::BTreeMap<String, (HybridVerifyingKey, String)> =
            std::collections::BTreeMap::new();
        for a in &r.admins {
            let k = admin_key(&r, a, now)?;
            mine.insert(a.seat.clone(), (k.vk, k.key_id));
        }
        let from = |m: &std::collections::BTreeMap<String, (HybridVerifyingKey, String)>,
                    seat: &str|
         -> Option<Key> {
            m.get(seat).map(|(vk, id)| Key {
                vk: vk.clone(),
                key_id: id.clone(),
            })
        };
        let via = e.get("via").and_then(Value::as_str).unwrap_or("");
        let apps = list(e.get("approvals"), "approvals")?;
        if let Some(p) = records.last() {
            if via != "direct" {
                return fail("not-direct", via);
            }
            if r.org_id != p.org_id {
                return fail("wrong-org", "");
            }
            if r.version != p.version.saturating_add(1)
                || r.prev_hash != p.hash()
                || r.issued_at <= p.issued_at
            {
                return fail("chain", "");
            }
            let removed: Vec<&str> = p
                .admins
                .iter()
                .filter(|a| r.admin(&a.seat).is_none())
                .map(|a| a.seat.as_str())
                .collect();
            let newcomers: Vec<String> = r
                .admins
                .iter()
                .filter(|a| {
                    p.admin(&a.seat)
                        .is_none_or(|o| o.ed != a.ed || o.ml != a.ml)
                })
                .map(|a| a.seat.clone())
                .collect();
            let is_consent = |x: &Value| {
                x.as_object().is_some_and(|o| {
                    o.get("seatId")
                        .and_then(Value::as_str)
                        .is_some_and(|s| newcomers.iter().any(|n| n == s))
                        && safe_integer(o.get("oarVersion")) == Some(r.version)
                })
            };
            let consent: Vec<Value> = apps.iter().filter(|x| is_consent(x)).cloned().collect();
            let ordinary: Vec<Value> = apps.iter().filter(|x| !is_consent(x)).cloned().collect();
            let consenting =
                approvals(&consent, &r.org_id, r.version, &r.canonical, now, &|seat| {
                    Ok(from(&mine, seat))
                })?;
            for n in &newcomers {
                if !consenting.contains(n) {
                    return fail("consent-missing", n.clone());
                }
            }
            let founder_moved = p.founder != r.founder;
            if founder_moved
                && !newcomers.contains(&r.founder)
                && !ordinary
                    .iter()
                    .any(|x| x.get("seatId").and_then(Value::as_str) == Some(r.founder.as_str()))
            {
                return fail("consent-missing", "new founder");
            }
            let pv = p.version;
            let signers = approvals(&ordinary, &r.org_id, pv, &r.canonical, now, &|seat| {
                Ok(keys.get(&format!("{pv}:{seat}")).map(|(vk, id)| Key {
                    vk: vk.clone(),
                    key_id: id.clone(),
                }))
            })?;
            for sgn in &signers {
                if p.admin(sgn).is_none_or(|a| a.kind != "admin") {
                    return fail("not-an-admin", sgn.clone());
                }
                if removed.contains(&sgn.as_str()) {
                    return fail("removed-signer", sgn.clone());
                }
            }
            let bylaws_changed = p.bylaws_sha != r.bylaws_sha;
            let k = if bylaws_changed || founder_moved {
                p.bylaws_threshold()
            } else {
                p.k_gov
            };
            if (signers.len() as u64) < k {
                return fail("threshold", format!("{} of {k}", signers.len()));
            }
        } else {
            if via != "genesis" || r.version != 0 || r.prev_hash != "0".repeat(64) {
                return fail("genesis", "");
            }
            if r.org_id != pin.org_id {
                return fail("wrong-org", "");
            }
            if r.hash() != pin.genesis_hash {
                return fail("genesis", "");
            }
            let signers = approvals(&apps, &r.org_id, 0, &r.canonical, now, &|seat| {
                Ok(from(&mine, seat))
            })?;
            for a in &r.admins {
                if !signers.contains(&a.seat) {
                    return fail("consent-missing", a.seat.clone());
                }
            }
        }
        for (seat, k) in mine {
            keys.insert(format!("{}:{seat}", r.version), k);
        }
        records.push(r);
    }
    Ok(records)
}

const RING_KEYS: &str =
    "issuedAt,keyCommitment,kind,oarVersion,orgId,prevSha256,recipientsHash,retired,scope,version";

fn recipient_ok(r: &str) -> bool {
    if let Some(seat) = r.strip_prefix("seat:") {
        return is_lower_hex(seat, 32);
    }
    r.strip_prefix("box:").is_some_and(is_domain)
}

/// The whole check: the 32-byte CGK to adopt and its version.
///
/// # Errors
/// [`OrgCgkError`] with the same code the TypeScript backend gives.
pub fn verify_adoption(args: &Map<String, Value>, pin: &OrgCgkPin, now: u64) -> R<([u8; 32], u64)> {
    let records = verify_chain(args.get("chain"), pin, now)?;
    let ring = obj(args.get("ring"), "ring")?;
    if !keys_are(ring, RING_KEYS) {
        return fail("malformed", "ring keys");
    }
    let org_id = s(ring, "orgId")?;
    let kind = s(ring, "kind")?;
    let scope = s(ring, "scope")?;
    let prev = s(ring, "prevSha256")?;
    let commitment = s(ring, "keyCommitment")?;
    let recipients_hash = s(ring, "recipientsHash")?;
    let version = u(ring, "version")?;
    let oar = u(ring, "oarVersion")?;
    let issued_at = u(ring, "issuedAt")?;
    let Some(Value::Array(retired)) = ring.get("retired") else {
        return fail("malformed", "retired");
    };
    let retired: Vec<&str> = retired.iter().map(|x| x.as_str().unwrap_or("")).collect();
    let mut sorted = retired.clone();
    sorted.sort_unstable();
    sorted.dedup();
    let org_wide = kind == "cgk" || kind == "directory-key";
    let ring_ok = is_lower_hex(org_id, 32)
        && matches!(kind, "cgk" | "directory-key" | "archive-keys" | "disk-key")
        && (if org_wide {
            scope == "*"
        } else {
            is_domain(scope)
        })
        && version >= 1
        && is_lower_hex(prev, 64)
        && is_lower_hex(commitment, 64)
        && is_lower_hex(recipients_hash, 64)
        && retired.len() <= MAX_RECIPIENTS
        && retired.iter().all(|x| is_lower_hex(x, 32))
        && sorted == retired;
    if !ring_ok {
        return fail("malformed", "ring");
    }
    let order = format!(
        "{TAG_ORG_KEY_RING}|{org_id}|{kind}|{scope}|{version}|{prev}|{commitment}|{recipients_hash}|{}|{oar}|{issued_at}",
        retired.join(",")
    );
    if org_id != pin.org_id {
        return fail("wrong-org", "");
    }
    if kind != "cgk" {
        return fail("not-cgk", "");
    }
    if version <= pin.cgk_version {
        return fail(
            "stale",
            format!("v{version} is not above v{}", pin.cgk_version),
        );
    }
    if issued_at > now.saturating_add(MAX_SKEW_MS) {
        return fail("future", "");
    }
    let recips = list(args.get("recipients"), "recipients")?;
    let mut lines = Vec::new();
    let mut names = Vec::new();
    for x in &recips {
        let o = obj(Some(x), "recipient")?;
        if !keys_are(o, "kemKeyId,recipient,sealedHex") {
            return fail("malformed", "recipient keys");
        }
        let (r, k, sealed) = (s(o, "recipient")?, s(o, "kemKeyId")?, s(o, "sealedHex")?);
        let bytes = from_hex(sealed).filter(|b| {
            !b.is_empty()
                && sealed.len() <= MAX_SEALED_HEX
                && sealed.bytes().all(|c| !c.is_ascii_uppercase())
        });
        let Some(bytes) = bytes else {
            return fail("malformed", "recipients");
        };
        if !recipient_ok(r) || !is_lower_hex(k, 64) {
            return fail("malformed", "recipients");
        }
        lines.push(format!("{r}:{k}:{}", sha_hex(&bytes)));
        names.push(r.to_owned());
    }
    let mut uniq = names.clone();
    uniq.sort();
    uniq.dedup();
    if recips.is_empty() || recips.len() > MAX_RECIPIENTS || uniq.len() != names.len() {
        return fail("malformed", "recipients");
    }
    lines.sort();
    if sha_hex(format!("{TAG_ORG_KEY_RECIPIENTS}|{}", lines.join(";")).as_bytes())
        != recipients_hash
    {
        return fail("recipients", "");
    }
    let me = format!("box:{}", pin.server_domain);
    if !names.contains(&me) {
        return fail("not-recipient", "");
    }
    let Some(at) = records.iter().find(|r| r.version == oar) else {
        return fail("stale-oar", "");
    };
    let apps = list(args.get("approvals"), "approvals")?;
    let signers = approvals(
        &apps,
        org_id,
        oar,
        order.as_bytes(),
        now,
        &|seat| match at.admin(seat) {
            Some(a) => admin_key(at, a, now).map(Some),
            None => Ok(None),
        },
    )?;
    if signers.is_empty() {
        return fail("threshold", "no approvals");
    }
    for sgn in &signers {
        if at.admin(sgn).is_none_or(|a| a.kind != "admin") {
            return fail("not-an-admin", sgn.clone());
        }
    }
    let key_hex = args.get("key").and_then(Value::as_str).unwrap_or("");
    if !is_lower_hex(key_hex, 64) {
        return fail("malformed", "key");
    }
    let expect =
        sha_hex(format!("{TAG_ORG_KEY_COMMIT}|{org_id}|cgk|*|{version}|{key_hex}").as_bytes());
    if expect != commitment {
        return fail("commitment", "");
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&from_hex(key_hex).unwrap_or_default());
    Ok((key, version))
}
