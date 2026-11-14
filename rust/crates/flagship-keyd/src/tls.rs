//! TLS leaf keys held by keyd, the same semantics and on-disk files as `tls.ts`: a P-256 key
//! made here, a CSR for exactly the names it was made for, and handshake signatures only once a
//! certificate for that key is installed.

use std::fs;
use std::path::{Path, PathBuf};

use p256::ecdsa::SigningKey;
use p256::ecdsa::signature::hazmat::PrehashSigner;
use p256::elliptic_curve::sec1::ToSec1Point;
use serde_json::Value;
use x509_cert::Certificate;
use x509_cert::der::Decode;
use x509_cert::ext::pkix::SubjectAltName;
use x509_cert::ext::pkix::name::GeneralName;
use zeroize::{Zeroize, Zeroizing};

use crate::crypto::{random, sha256};
use crate::der::{
    OID_EC_PUBLIC_KEY, OID_P256, bit_string, int0, octets, oid, p256_spki, seq, set, tlv, utf8,
};
use crate::files::{ensure_dir, write_atomic};
use crate::obj;
use crate::wire::{KeydError, KeydResult, decode_hex, js_is_space, to_hex};

const MAX_NAMES: usize = 8;
const MAX_KEYS: usize = 8;
/// Direct names a box may serve (`MAX_DIRECT_NAMES` in tls.ts), and keys for them (one serving, one renewing).
pub const MAX_DIRECT_NAMES: usize = 16;
const MAX_DIRECT_KEYS: usize = 2 * MAX_DIRECT_NAMES;
pub const DIRECT_APEX: &str = "fshp.app";
const DAY_MS: i64 = 24 * 3600 * 1000;

pub type Clock = Box<dyn Fn() -> i64 + Send>;

pub fn system_clock() -> Clock {
    Box::new(now_ms)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

struct StoredKey {
    names: Vec<String>,
    secret: p256::SecretKey,
    spki_hex: String,
    created_at: i64,
    chain_pem: Option<String>,
    not_before: Option<i64>,
    not_after: Option<i64>,
    legacy: bool,
}

impl std::fmt::Debug for StoredKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredKey")
            .field("names", &self.names)
            .field("spki_hex", &self.spki_hex)
            .finish_non_exhaustive()
    }
}

/// `^[0-9a-f]{32}$`
fn is_handle(h: &str) -> bool {
    h.len() == 32 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`
pub fn is_dns_name(n: &str) -> bool {
    let rest = n.strip_prefix("*.").unwrap_or(n);
    let labels: Vec<&str> = rest.split('.').collect();
    let Some((tld, inner)) = labels.split_last() else {
        return false;
    };
    if inner.is_empty()
        || !(2..=63).contains(&tld.len())
        || !tld.bytes().all(|b| b.is_ascii_lowercase())
    {
        return false;
    }
    inner.iter().all(|l| {
        let b = l.as_bytes();
        let alnum = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
        (1..=63).contains(&b.len())
            && b.first().is_some_and(alnum)
            && b.last().is_some_and(alnum)
            && b.iter().all(|c| alnum(c) || *c == b'-')
    })
}

fn uncompressed(secret: &p256::SecretKey) -> Vec<u8> {
    secret.public_key().to_sec1_point(false).as_bytes().to_vec()
}

/// DER ECDSA over a prehash, low-S like noble's default.
pub fn sign_prehash_der(secret: &p256::SecretKey, prehash: &[u8]) -> KeydResult<Vec<u8>> {
    let sk = SigningKey::from(secret);
    let sig: p256::ecdsa::Signature = sk
        .sign_prehash(prehash)
        .map_err(|_| KeydError::failed("internal error"))?;
    Ok(sig.normalize_s().to_der().as_bytes().to_vec())
}

pub fn generate_secret() -> KeydResult<p256::SecretKey> {
    for _ in 0..16 {
        let bytes =
            Zeroizing::new(random::<32>().map_err(|_| KeydError::failed("internal error"))?);
        if let Ok(k) = p256::SecretKey::from_slice(bytes.as_ref()) {
            return Ok(k);
        }
    }
    Err(KeydError::failed("internal error"))
}

/// The certificate blocks of a PEM chain, as the TS regex finds them.
pub fn pem_certificates(chain: &str) -> Vec<&str> {
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(start) = chain
        .get(from..)
        .and_then(|s| s.find(BEGIN))
        .map(|i| i.saturating_add(from))
    {
        let body_start = start.saturating_add(BEGIN.len());
        // `[\s\S]+?` needs at least one character before the END marker.
        let search = body_start.saturating_add(
            chain
                .get(body_start..)
                .and_then(|s| s.chars().next())
                .map_or(1, char::len_utf8),
        );
        let Some(end) = chain
            .get(search..)
            .and_then(|s| s.find(END))
            .map(|i| i.saturating_add(search))
        else {
            break;
        };
        let stop = end.saturating_add(END.len());
        if let Some(block) = chain.get(start..stop) {
            out.push(block);
        }
        from = stop;
    }
    out
}

/// Parse one PEM certificate block (header, base64 body, footer).
pub fn parse_pem_certificate(block: &str) -> Option<Certificate> {
    let body = block
        .strip_prefix("-----BEGIN CERTIFICATE-----")?
        .strip_suffix("-----END CERTIFICATE-----")?;
    let b64: String = body.chars().filter(|c| !js_is_space(*c)).collect();
    let der = crate::crypto::b64_decode(&b64)?;
    Certificate::from_der(&der).ok()
}

/// The certificate's key as the canonical P-256 SPKI hex, if it is a P-256 key.
pub fn certificate_spki_hex(cert: &Certificate) -> Option<String> {
    let spki = cert.tbs_certificate().subject_public_key_info();
    if spki.algorithm.oid.to_string() != OID_EC_PUBLIC_KEY {
        return None;
    }
    let params = spki.algorithm.parameters.as_ref()?;
    let curve: x509_cert::der::asn1::ObjectIdentifier = params.decode_as().ok()?;
    if curve.to_string() != OID_P256 {
        return None;
    }
    let point = p256::PublicKey::from_sec1_bytes(spki.subject_public_key.raw_bytes()).ok()?;
    Some(to_hex(&p256_spki(point.to_sec1_point(false).as_bytes())))
}

/// An unreadable or repeated subject-alternative-name extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BadSan;

/// Subject alternative names, `DNS:` names as-is and anything else as `None`.
pub fn certificate_sans(cert: &Certificate) -> Result<Vec<Option<String>>, BadSan> {
    match cert.tbs_certificate().get_extension::<SubjectAltName>() {
        Ok(None) => Ok(Vec::new()),
        Ok(Some((_, san))) => Ok(san
            .0
            .iter()
            .map(|g| match g {
                GeneralName::DnsName(n) => Some(n.to_string()),
                _ => None,
            })
            .collect()),
        Err(_) => Err(BadSan),
    }
}

fn unix_ms(t: x509_cert::time::Time) -> i64 {
    i64::try_from(t.to_unix_duration().as_millis()).unwrap_or(i64::MAX)
}

fn num(v: Option<&Value>) -> Option<i64> {
    let v = v?;
    v.as_i64()
        .or_else(|| v.as_f64().filter(|f| f.is_finite()).map(|f| f as i64))
}

/// Where a key serves beside the default certificate, so a frontend can choose by SNI: the
/// box's own name gets the `control` certificate, app names the `apps` one (`TLS_SLOTS` in tls.ts).
pub const TLS_SLOTS: [&str; 2] = ["control", "apps"];

/// Where `tls.activate` puts a key: a slot of `TLS_SLOTS`, or the slot of the one direct name it was made for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivateSlot {
    Slot(usize),
    Direct,
}

/// `^[a-z0-9](?:-?[a-z0-9]){0,29}$`
fn is_direct_slug(s: &str) -> bool {
    let b = s.as_bytes();
    let alnum = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    let mut count = 0usize;
    let mut prev_dash = true;
    for c in b {
        if *c == b'-' {
            if prev_dash {
                return false;
            }
            prev_dash = true;
        } else if alnum(c) {
            count = count.saturating_add(1);
            prev_dash = false;
        } else {
            return false;
        }
    }
    !b.is_empty() && !prev_dash && count <= 30
}

/// `^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$`
fn is_direct_user(s: &str) -> bool {
    let b = s.as_bytes();
    let alnum = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    (3..=30).contains(&b.len())
        && b.first().is_some_and(alnum)
        && b.last().is_some_and(alnum)
        && b.iter().all(|c| alnum(c) || *c == b'-')
}

/// The account of a box's allowed names: `<user>` of its own name `<server>.<user>.<apex>`.
fn account_of(allowed: &[String]) -> Option<&str> {
    allowed
        .iter()
        .find(|n| !n.starts_with("*."))
        .and_then(|n| n.split('.').nth(1))
}

/// `directNameProblem` in tls.ts: `<slug>--<account>.fshp.app` only.
fn direct_name_problem(name: &str, account: Option<&str>) -> Option<KeydError> {
    let label = name
        .strip_suffix(DIRECT_APEX)
        .and_then(|l| l.strip_suffix('.'))
        .unwrap_or("");
    let parts: Vec<&str> = label.split("--").collect();
    let shape = match parts.as_slice() {
        [slug, user] => is_direct_slug(slug) && is_direct_user(user) && !user.contains("--"),
        _ => false,
    };
    if !shape {
        return Some(KeydError::bad_request("not a direct name"));
    }
    if parts.get(1).copied() != account {
        return Some(KeydError::forbidden(
            "a direct name must be one of this box's account",
        ));
    }
    None
}

fn is_direct_key(names: &[String]) -> bool {
    matches!(names, [n] if n.ends_with(&format!(".{DIRECT_APEX}")))
}

pub struct TlsKeys {
    allowed: Vec<String>,
    dir: Option<PathBuf>,
    keys: Vec<(String, StoredKey)>,
    active: Option<String>,
    slots: [Option<String>; 2],
    direct: Vec<String>,
    /// Direct name -> the key serving it, sorted by name.
    direct_slots: Vec<(String, String)>,
    now: Clock,
}

impl std::fmt::Debug for TlsKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TlsKeys")
            .field("allowed", &self.allowed)
            .field("keys", &self.keys.len())
            .field("active", &self.active)
            .field("slots", &self.slots)
            .finish_non_exhaustive()
    }
}

impl TlsKeys {
    pub fn new(allowed: Vec<String>, dir: Option<PathBuf>, now: Clock) -> Self {
        let mut t = Self {
            allowed,
            dir: dir.clone(),
            keys: Vec::new(),
            active: None,
            slots: [None, None],
            direct: Vec::new(),
            direct_slots: Vec::new(),
            now,
        };
        if let Some(d) = dir {
            t.load(&d);
        }
        t
    }

    fn load(&mut self, dir: &Path) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        let mut files: Vec<String> = entries
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .collect();
        files.sort();
        for f in files {
            let Some(handle) = f.strip_suffix(".json").filter(|h| is_handle(h)) else {
                continue;
            };
            // A damaged key file is ignored; the box issues a new key.
            if let Some(k) = Self::read_stored(&dir.join(&f)) {
                self.keys.push((handle.to_owned(), k));
            }
        }
        if let Ok(text) = fs::read_to_string(dir.join("active")) {
            let h = text.trim();
            if self.find(h).is_some() {
                self.active = Some(h.to_owned());
            }
        }
        for (i, slot) in TLS_SLOTS.iter().enumerate() {
            if let Ok(text) = fs::read_to_string(dir.join(format!("active-{slot}"))) {
                let h = text.trim();
                if self.find(h).is_some_and(|k| k.chain_pem.is_some())
                    && let Some(s) = self.slots.get_mut(i)
                {
                    *s = Some(h.to_owned());
                }
            }
        }
        // None yet, or damaged: the daemon hands the names over again.
        if let Some(Value::Array(list)) = fs::read_to_string(dir.join("direct-names.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        {
            let account = account_of(&self.allowed).map(str::to_owned);
            let mut names: Vec<String> = list
                .iter()
                .filter_map(Value::as_str)
                .filter(|n| direct_name_problem(n, account.as_deref()).is_none())
                .map(str::to_owned)
                .collect();
            names.sort();
            names.truncate(MAX_DIRECT_NAMES);
            self.direct = names;
        }
        if let Some(Value::Object(map)) = fs::read_to_string(dir.join("active-direct.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        {
            for (name, h) in map {
                let Some(h) = h.as_str() else { continue };
                let ok = self.direct.contains(&name)
                    && self.find(h).is_some_and(|k| {
                        k.chain_pem.is_some()
                            && k.names.len() == 1
                            && k.names.first() == Some(&name)
                    });
                if ok {
                    self.direct_slots.push((name, h.to_owned()));
                }
            }
            self.direct_slots.sort();
        }
    }

    /// Whether the key is in service anywhere: the default certificate or a slot.
    fn serving(&self, handle: &str) -> bool {
        self.active.as_deref() == Some(handle)
            || self.slots.iter().any(|s| s.as_deref() == Some(handle))
            || self.direct_slots.iter().any(|(_, h)| h == handle)
    }

    fn write_state(&self, file: &str, value: &Value) -> KeydResult<()> {
        let Some(dir) = &self.dir else {
            return Ok(());
        };
        ensure_dir(dir, 0o700).map_err(io_failed)?;
        let text = serde_json::to_string(value).map_err(|_| KeydError::failed("internal error"))?;
        write_atomic(&dir.join(file), text.as_bytes(), 0o400).map_err(io_failed)
    }

    fn persist_direct_slots(&self) -> KeydResult<()> {
        let map: serde_json::Map<String, Value> = self
            .direct_slots
            .iter()
            .map(|(n, h)| (n.clone(), Value::from(h.clone())))
            .collect();
        self.write_state("active-direct.json", &Value::Object(map))
    }

    /// `setDirectNames`: the box's verified direct names, only `<slug>--<account>.fshp.app` of this box's
    /// account, at most 16. A name that goes loses its slot and every key made for it.
    pub fn set_direct_names(&mut self, names: &[String]) -> KeydResult<(Vec<String>, usize)> {
        if names.len() > MAX_DIRECT_NAMES {
            return Err(KeydError::bad_request("at most 16 direct names"));
        }
        let account = account_of(&self.allowed).map(str::to_owned);
        let mut next: Vec<String> = names.to_vec();
        next.sort();
        next.dedup();
        for n in &next {
            if let Some(e) = direct_name_problem(n, account.as_deref()) {
                return Err(e);
            }
        }
        let gone: Vec<String> = self
            .direct
            .iter()
            .filter(|n| !next.contains(n))
            .cloned()
            .collect();
        let mut removed = 0usize;
        for name in gone {
            self.direct_slots.retain(|(n, _)| *n != name);
            let handles: Vec<String> = self
                .keys
                .iter()
                .filter(|(_, k)| k.names.len() == 1 && k.names.first() == Some(&name))
                .map(|(h, _)| h.clone())
                .collect();
            for h in handles {
                self.keys.retain(|(x, _)| *x != h);
                if let Some(dir) = &self.dir {
                    match fs::remove_file(dir.join(format!("{h}.json"))) {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => return Err(io_failed(e)),
                    }
                }
                removed = removed.saturating_add(1);
            }
        }
        self.direct = next.clone();
        self.write_state("direct-names.json", &Value::from(next.clone()))?;
        self.persist_direct_slots()?;
        Ok((next, removed))
    }

    pub fn direct_names(&self) -> Vec<String> {
        self.direct.clone()
    }

    fn read_stored(path: &Path) -> Option<StoredKey> {
        let text = Zeroizing::new(fs::read_to_string(path).ok()?);
        let mut v: Value = serde_json::from_str(&text).ok()?;
        let obj = v.as_object_mut()?;
        let secret = match obj.get_mut("privHex") {
            Some(Value::String(s)) => {
                let bytes = Zeroizing::new(decode_hex(s).filter(|b| b.len() == 32));
                s.zeroize();
                p256::SecretKey::from_slice(bytes.as_deref()?).ok()?
            }
            _ => return None,
        };
        let names: Vec<String> = obj
            .get("names")?
            .as_array()?
            .iter()
            .map(|n| n.as_str().map(str::to_owned))
            .collect::<Option<_>>()?;
        let spki_hex = obj.get("spkiHex")?.as_str()?.to_owned();
        if spki_hex != to_hex(&p256_spki(&uncompressed(&secret))) || names.is_empty() {
            return None;
        }
        Some(StoredKey {
            names,
            secret,
            spki_hex,
            created_at: num(obj.get("createdAt")).unwrap_or(0),
            chain_pem: obj
                .get("chainPem")
                .and_then(Value::as_str)
                .map(str::to_owned),
            not_before: num(obj.get("notBefore")),
            not_after: num(obj.get("notAfter")),
            legacy: obj.get("legacy").and_then(Value::as_bool).unwrap_or(false),
        })
    }

    /// The TS `JSON.stringify(StoredKey)`, built so the private key never sits in a JSON value.
    fn serialize(k: &StoredKey) -> Zeroizing<String> {
        let mut s = Zeroizing::new(String::with_capacity(512));
        let q = |v: &str| serde_json::to_string(v).unwrap_or_else(|_| "\"\"".to_owned());
        s.push_str("{\"names\":");
        s.push_str(&serde_json::to_string(&k.names).unwrap_or_else(|_| "[]".to_owned()));
        s.push_str(",\"privHex\":\"");
        let priv_bytes = Zeroizing::new(k.secret.to_bytes().to_vec());
        s.push_str(&Zeroizing::new(to_hex(&priv_bytes)));
        s.push_str("\",\"spkiHex\":");
        s.push_str(&q(&k.spki_hex));
        s.push_str(&format!(",\"createdAt\":{}", k.created_at));
        if let Some(c) = &k.chain_pem {
            s.push_str(",\"chainPem\":");
            s.push_str(&q(c));
        }
        if let Some(n) = k.not_before {
            s.push_str(&format!(",\"notBefore\":{n}"));
        }
        if let Some(n) = k.not_after {
            s.push_str(&format!(",\"notAfter\":{n}"));
        }
        if k.legacy {
            s.push_str(",\"legacy\":true");
        }
        s.push('}');
        s
    }

    fn persist(&self, handle: &str) -> KeydResult<()> {
        let (Some(dir), Some(k)) = (&self.dir, self.find(handle)) else {
            return Ok(());
        };
        ensure_dir(dir, 0o700).map_err(io_failed)?;
        write_atomic(
            &dir.join(format!("{handle}.json")),
            Self::serialize(k).as_bytes(),
            0o400,
        )
        .map_err(io_failed)
    }

    fn find(&self, handle: &str) -> Option<&StoredKey> {
        self.keys.iter().find(|(h, _)| h == handle).map(|(_, k)| k)
    }

    fn find_mut(&mut self, handle: &str) -> Option<&mut StoredKey> {
        self.keys
            .iter_mut()
            .find(|(h, _)| h == handle)
            .map(|(_, k)| k)
    }

    fn get(&self, handle: &str) -> KeydResult<&StoredKey> {
        if !is_handle(handle) {
            return Err(KeydError::bad_request("bad key handle"));
        }
        self.find(handle)
            .ok_or_else(|| KeydError::bad_request("no such key"))
    }

    /// The names this box may ever have a certificate for.
    /// The names this keyd may make a certificate for, after the owner moved the box to another name in its account.
    pub fn set_allowed(&mut self, names: Vec<String>) {
        self.allowed = names;
    }

    pub fn names(&self) -> Vec<String> {
        self.allowed.clone()
    }

    pub fn create_key(&mut self, names: &[String]) -> KeydResult<(String, String)> {
        if names.is_empty() || names.len() > MAX_NAMES {
            return Err(KeydError::bad_request("between 1 and 8 names"));
        }
        let mut unique: Vec<String> = names.iter().map(|n| n.to_lowercase()).collect();
        unique.sort();
        unique.dedup();
        for n in &unique {
            if !is_dns_name(n) {
                return Err(KeydError::bad_request("not a valid DNS name"));
            }
            if !self.allowed.contains(n) && !self.direct.contains(n) {
                return Err(KeydError::forbidden(
                    "that name is not one this box may have a certificate for",
                ));
            }
        }
        let direct = unique.iter().any(|n| self.direct.contains(n));
        if direct && unique.len() != 1 {
            return Err(KeydError::forbidden(
                "a direct name's key is for that name alone",
            ));
        }
        // Old keys that never got a certificate, or were replaced, make room for new ones. Direct names have their
        // own budget.
        let max = if direct { MAX_DIRECT_KEYS } else { MAX_KEYS };
        let in_class = |t: &Self| {
            t.keys
                .iter()
                .filter(|(_, k)| is_direct_key(&k.names) == direct)
                .count()
        };
        if in_class(self) >= max {
            let now = (self.now)();
            let candidates: Vec<String> = self
                .keys
                .iter()
                .filter(|(h, k)| {
                    is_direct_key(&k.names) == direct
                        && !self.serving(h)
                        && k.not_after.is_none_or(|na| na == 0 || na < now)
                })
                .map(|(h, _)| h.clone())
                .collect();
            for h in candidates {
                self.remove(&h)?;
                if in_class(self) < max {
                    break;
                }
            }
            if in_class(self) >= max {
                return Err(KeydError::forbidden("too many TLS keys; remove one first"));
            }
        }
        let secret = generate_secret()?;
        let spki_hex = to_hex(&p256_spki(&uncompressed(&secret)));
        let handle = to_hex(&random::<16>().map_err(|_| KeydError::failed("internal error"))?);
        let created_at = (self.now)();
        self.keys.push((
            handle.clone(),
            StoredKey {
                names: unique,
                secret,
                spki_hex: spki_hex.clone(),
                created_at,
                chain_pem: None,
                not_before: None,
                not_after: None,
                legacy: false,
            },
        ));
        self.persist(&handle)?;
        Ok((handle, spki_hex))
    }

    /// PKCS#10 for exactly the names the key was created for.
    pub fn csr(&self, handle: &str) -> KeydResult<Vec<u8>> {
        let k = self.get(handle)?;
        let first = k
            .names
            .first()
            .ok_or_else(|| KeydError::failed("internal error"))?;
        let san_names: Vec<Vec<u8>> = k.names.iter().map(|n| tlv(0x82, n.as_bytes())).collect();
        let san_refs: Vec<&[u8]> = san_names.iter().map(Vec::as_slice).collect();
        let san = seq(&san_refs);
        let ext = seq(&[&seq(&[&oid("2.5.29.17"), &octets(&san)])]);
        let attrs = tlv(0xa0, &seq(&[&oid("1.2.840.113549.1.9.14"), &set(&[&ext])]));
        let subject = seq(&[&set(&[&seq(&[&oid("2.5.4.3"), &utf8(first)])])]);
        let spki = decode_hex(&k.spki_hex).ok_or_else(|| KeydError::failed("internal error"))?;
        let info = seq(&[&int0(), &subject, &spki, &attrs]);
        let sig = sign_prehash_der(&k.secret, &sha256(&info))?;
        Ok(seq(&[
            &info,
            &seq(&[&oid("1.2.840.10045.4.3.2")]),
            &bit_string(&sig),
        ]))
    }

    /// Accept the certificate chain for a key: the leaf must be this key's, for these names, and in date.
    pub fn install(
        &mut self,
        handle: &str,
        chain_pem: &str,
    ) -> KeydResult<(i64, i64, Vec<String>)> {
        let now = (self.now)();
        let k = self.get(handle)?;
        let certs = pem_certificates(chain_pem);
        if certs.is_empty() || certs.len() > 6 {
            return Err(KeydError::bad_request("expected a certificate chain"));
        }
        let leaf = certs
            .first()
            .and_then(|b| parse_pem_certificate(b))
            .ok_or_else(|| KeydError::bad_request("the leaf is not a certificate"))?;
        if certificate_spki_hex(&leaf).as_deref() != Some(k.spki_hex.as_str()) {
            return Err(KeydError::forbidden("the certificate is not for this key"));
        }
        let sans = certificate_sans(&leaf)
            .map_err(|_| KeydError::forbidden("only DNS names are allowed"))?;
        let mut got = Vec::with_capacity(sans.len());
        for s in sans {
            got.push(
                s.ok_or_else(|| KeydError::forbidden("only DNS names are allowed"))?
                    .to_lowercase(),
            );
        }
        got.sort();
        if got.is_empty() || got.iter().any(|n| !k.names.contains(n)) {
            return Err(KeydError::forbidden(
                "the certificate names more than this key was made for",
            ));
        }
        let validity = leaf.tbs_certificate().validity();
        let not_before = unix_ms(validity.not_before);
        let not_after = unix_ms(validity.not_after);
        if not_after <= now || not_before > now.saturating_add(DAY_MS) {
            return Err(KeydError::forbidden("the certificate is not valid now"));
        }
        let mut joined = certs.join("\n");
        joined.push('\n');
        if let Some(k) = self.find_mut(handle) {
            k.chain_pem = Some(joined);
            k.not_before = Some(not_before);
            k.not_after = Some(not_after);
        }
        self.persist(handle)?;
        Ok((not_before, not_after, got))
    }

    /// Put a key in service. Without a slot it becomes the one default certificate and every
    /// slot is cleared; with a slot (an index into `TLS_SLOTS`) it serves that class of names.
    pub fn activate(&mut self, handle: &str, slot: Option<ActivateSlot>) -> KeydResult<()> {
        let k = self.get(handle)?;
        if k.chain_pem.is_none() {
            return Err(KeydError::forbidden(
                "install a certificate before serving with this key",
            ));
        }
        let slot = match slot {
            Some(ActivateSlot::Direct) => {
                let name = match k.names.as_slice() {
                    [n] if self.direct.contains(n) => n.clone(),
                    _ => {
                        return Err(KeydError::forbidden(
                            "this key is not for one of this box's direct names",
                        ));
                    }
                };
                self.direct_slots.retain(|(n, _)| *n != name);
                self.direct_slots.push((name, handle.to_owned()));
                self.direct_slots.sort();
                return self.persist_direct_slots();
            }
            Some(ActivateSlot::Slot(i)) => Some(i),
            None => None,
        };
        let file = match slot {
            None => {
                self.active = Some(handle.to_owned());
                self.slots = [None, None];
                "active".to_owned()
            }
            Some(i) => {
                let (Some(s), Some(name)) = (self.slots.get_mut(i), TLS_SLOTS.get(i)) else {
                    return Err(KeydError::bad_request(
                        "slot must be control, apps or direct",
                    ));
                };
                *s = Some(handle.to_owned());
                format!("active-{name}")
            }
        };
        if let Some(dir) = &self.dir {
            ensure_dir(dir, 0o700).map_err(io_failed)?;
            write_atomic(&dir.join(&file), handle.as_bytes(), 0o400).map_err(io_failed)?;
            if slot.is_none() {
                for name in TLS_SLOTS {
                    match fs::remove_file(dir.join(format!("active-{name}"))) {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => return Err(io_failed(e)),
                    }
                }
            }
        }
        Ok(())
    }

    /// Every certificate in service, slots first (control, apps), then each direct name's (by name), then the
    /// default one.
    pub fn serving_certs(&self) -> Vec<Value> {
        let entry = |slot: &str, h: &str| {
            let k = self.find(h)?;
            let chain = k.chain_pem.as_ref()?;
            Some(Value::Object(obj! {
                "slot" => slot,
                "handle" => h,
                "chainPem" => chain.clone(),
                "notAfter" => k.not_after.unwrap_or(0),
                "names" => k.names.clone(),
                "legacy" => k.legacy,
            }))
        };
        let mut out: Vec<Value> = TLS_SLOTS
            .iter()
            .zip(self.slots.iter())
            .filter_map(|(name, h)| entry(name, h.as_deref()?))
            .collect();
        out.extend(self.direct.iter().filter_map(|n| {
            let (_, h) = self.direct_slots.iter().find(|(x, _)| x == n)?;
            entry("direct", h)
        }));
        if let Some(v) = self.active.as_deref().and_then(|h| entry("default", h)) {
            out.push(v);
        }
        out
    }

    pub fn active(&self) -> Value {
        let Some(h) = &self.active else {
            return Value::Null;
        };
        let Some(k) = self.find(h) else {
            return Value::Null;
        };
        let Some(chain) = &k.chain_pem else {
            return Value::Null;
        };
        Value::Object(obj! {
            "handle" => h.clone(),
            "chainPem" => chain.clone(),
            "notAfter" => k.not_after.unwrap_or(0),
            "names" => k.names.clone(),
            "legacy" => k.legacy,
        })
    }

    /// A TLS handshake signature over `digest`. Only for a key with a valid, installed certificate.
    /// `signHandshake`: ECDSA-P256-SHA256 over a TLS handshake input built by `tls13_server_signed_message`
    /// or `tls12_server_signed_message`, only for a key with a valid, installed certificate.
    pub fn sign_handshake(&self, handle: &str, message: &[u8]) -> KeydResult<Vec<u8>> {
        let k = self.get(handle)?;
        let not_after = match (&k.chain_pem, k.not_after) {
            (Some(_), Some(na)) if na != 0 => na,
            _ => return Err(KeydError::forbidden("this key has no certificate")),
        };
        if not_after < (self.now)().saturating_sub(7 * DAY_MS) {
            return Err(KeydError::forbidden("this key's certificate has expired"));
        }
        sign_prehash_der(&k.secret, &crate::crypto::sha256(message))
    }

    pub fn list(&self) -> Vec<Value> {
        self.keys
            .iter()
            .map(|(h, k)| {
                Value::Object(obj! {
                    "handle" => h.clone(),
                    "names" => k.names.clone(),
                    "spkiHex" => k.spki_hex.clone(),
                    "createdAt" => k.created_at,
                    "notAfter" => k.not_after.map_or(Value::Null, Value::from),
                    "active" => self.serving(h),
                    "legacy" => k.legacy,
                })
            })
            .collect()
    }

    pub fn remove(&mut self, handle: &str) -> KeydResult<()> {
        self.get(handle)?;
        if self.serving(handle) {
            return Err(KeydError::forbidden("the key in service cannot be removed"));
        }
        self.keys.retain(|(h, _)| h != handle);
        if let Some(dir) = &self.dir {
            match fs::remove_file(dir.join(format!("{handle}.json"))) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(io_failed(e)),
            }
        }
        Ok(())
    }

    /// Drop every key held in memory (each `SecretKey` zeroizes itself).
    pub fn destroy(&mut self) {
        self.keys.clear();
        self.active = None;
        self.slots = [None, None];
        self.direct.clear();
        self.direct_slots.clear();
    }
}

fn io_failed(_: std::io::Error) -> KeydError {
    KeydError::failed("internal error")
}

const TLS13_SERVER_CONTEXT: &[u8] = b"TLS 1.3, server CertificateVerify";

/// `tls13ServerSignedMessage` (RFC 8446 4.4.3): 64 spaces, the server context, 0, the transcript hash.
pub fn tls13_server_signed_message(transcript_hash: &[u8]) -> Vec<u8> {
    let mut out = vec![0x20u8; 64];
    out.extend_from_slice(TLS13_SERVER_CONTEXT);
    out.push(0);
    out.extend_from_slice(transcript_hash);
    out
}

/// `isEcdheParams`: ServerECDHParams of a named curve (RFC 8422 5.4) with a well-formed point.
pub fn is_ecdhe_params(params: &[u8]) -> bool {
    let [3, hi, lo, len, point @ ..] = params else {
        return false;
    };
    let want: usize = match u16::from_be_bytes([*hi, *lo]) {
        0x001d => 32,
        0x0017 => 65,
        0x0018 => 97,
        0x0019 => 133,
        _ => return false,
    };
    usize::from(*len) == want && point.len() == want && (want == 32 || point.first() == Some(&0x04))
}

/// `tls12ServerSignedMessage` (RFC 5246 7.4.3): client_random, server_random, params.
pub fn tls12_server_signed_message(
    client_random: &[u8],
    server_random: &[u8],
    params: &[u8],
) -> Vec<u8> {
    [client_random, server_random, params].concat()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn dns_name_rule_matches_the_ts_regex() {
        for ok in [
            "home.alice.flagship.services",
            "*.home.alice.flagship.services",
            "a.bc",
            "a-1.b2.co",
        ] {
            assert!(is_dns_name(ok), "{ok}");
        }
        for bad in [
            "",
            "com",
            "a.b",
            "-a.com",
            "a-.com",
            "*.*.a.com",
            "A.com",
            "a..com",
            "a.c0m",
            "a b.com",
            "*.com",
            &format!("{}.com", "a".repeat(64)),
        ] {
            assert!(!is_dns_name(bad), "{bad}");
        }
    }

    #[test]
    fn pem_blocks_are_found_like_the_lazy_regex() {
        let c = "x-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----B-----END CERTIFICATE-----";
        assert_eq!(pem_certificates(c).len(), 2);
        assert!(
            pem_certificates("-----BEGIN CERTIFICATE----------END CERTIFICATE-----").is_empty()
        );
    }

    #[test]
    fn builds_only_tls_server_inputs() {
        let m = tls13_server_signed_message(&[7; 32]);
        assert_eq!(m.len(), 64 + 33 + 1 + 32);
        assert!(m.starts_with(&[0x20; 64]));
        assert_eq!(
            m.get(64..97),
            Some(&b"TLS 1.3, server CertificateVerify"[..])
        );
        assert_eq!(m.get(97), Some(&0));
        let mut p256 = vec![3, 0x00, 0x17, 65, 4];
        p256.extend_from_slice(&[1; 64]);
        assert!(is_ecdhe_params(&p256));
        let mut x25519 = vec![3, 0x00, 0x1d, 32];
        x25519.extend_from_slice(&[1; 32]);
        assert!(is_ecdhe_params(&x25519));
        let mut compressed = p256.clone();
        if let Some(b) = compressed.get_mut(4) {
            *b = 2;
        }
        assert!(!is_ecdhe_params(&compressed));
        x25519.push(0);
        assert!(!is_ecdhe_params(&x25519));
        assert!(!is_ecdhe_params(&[3, 0x11, 0x11, 1, 0]));
        assert!(!is_ecdhe_params(b"flagship/x/v1|sign me"));
        assert_eq!(
            tls12_server_signed_message(&[1; 32], &[2; 32], &p256).len(),
            64 + p256.len()
        );
    }

    #[test]
    fn a_box_may_ask_for_the_accounts_wildcard_and_nothing_wider() {
        let fqdn = "home.alice.flagship.services";
        let names = crate::files::names_for(fqdn);
        assert_eq!(
            names,
            vec![
                fqdn.to_owned(),
                format!("*.{fqdn}"),
                "*.alice.flagship.services".to_owned()
            ]
        );
        let mut t = TlsKeys::new(names, None, system_clock());
        assert!(
            t.create_key(&[format!("*.{fqdn}"), "*.alice.flagship.services".into()])
                .is_ok()
        );
        for wider in [
            "*.flagship.services",
            "*.bob.flagship.services",
            "x.alice.flagship.services",
        ] {
            assert_eq!(
                t.create_key(&[wider.into()]).unwrap_err().code,
                crate::wire::ErrorCode::Forbidden
            );
        }
    }

    #[test]
    fn a_box_name_of_any_other_shape_gives_no_names() {
        use crate::files::names_for;
        for bad in [
            "flagship.services",
            "alice.flagship.services",
            "x.home.alice.flagship.services",
            "home.alice.example.com",
            "home.a--b.flagship.services",
            "home.alice.flagship.services.evil.com",
        ] {
            assert!(names_for(bad).is_empty(), "{bad}");
        }
        assert_eq!(
            names_for("home.alice.gym.flagship.services"),
            vec![
                "home.alice.gym.flagship.services".to_owned(),
                "*.home.alice.gym.flagship.services".to_owned(),
                "*.alice.gym.flagship.services".to_owned()
            ]
        );
        assert_eq!(
            names_for("home.gym.flagship.services")
                .last()
                .map(String::as_str),
            Some("*.gym.flagship.services")
        );
    }

    #[test]
    fn direct_names_are_this_accounts_derived_names_only() {
        let fqdn = "home.alice.flagship.services";
        let mut t = TlsKeys::new(crate::files::names_for(fqdn), None, system_clock());
        for (bad, code) in [
            ("game--bob.fshp.app", crate::wire::ErrorCode::Forbidden),
            ("game.fshp.app", crate::wire::ErrorCode::BadRequest),
            ("a--b--alice.fshp.app", crate::wire::ErrorCode::BadRequest),
            ("a---alice.fshp.app", crate::wire::ErrorCode::BadRequest),
            ("ga--me--alice.fshp.app", crate::wire::ErrorCode::BadRequest),
            (
                "game--alice.fshp.app.evil.com",
                crate::wire::ErrorCode::BadRequest,
            ),
            ("game--alicefshp.app", crate::wire::ErrorCode::BadRequest),
        ] {
            assert_eq!(
                t.set_direct_names(&[bad.into()]).unwrap_err().code,
                code,
                "{bad}"
            );
        }
        let many: Vec<String> = (0..17).map(|i| format!("a{i}--alice.fshp.app")).collect();
        assert!(t.set_direct_names(&many).is_err());
        let (names, removed) = t
            .set_direct_names(&["game--alice.fshp.app".into(), "a-b--alice.fshp.app".into()])
            .unwrap();
        assert_eq!(names, vec!["a-b--alice.fshp.app", "game--alice.fshp.app"]);
        assert_eq!(removed, 0);
        assert!(
            t.create_key(&["game--alice.fshp.app".into(), fqdn.into()])
                .is_err()
        );
        let (h, _) = t.create_key(&["game--alice.fshp.app".into()]).unwrap();
        assert!(t.activate(&h, Some(ActivateSlot::Direct)).is_err());
        let (_, removed) = t.set_direct_names(&[]).unwrap();
        assert_eq!(removed, 1);
        assert!(t.create_key(&["game--alice.fshp.app".into()]).is_err());
    }

    #[test]
    fn csr_is_signed_and_lists_exactly_the_names() {
        let fqdn = "home.alice.flagship.services";
        let mut t = TlsKeys::new(vec![fqdn.into(), format!("*.{fqdn}")], None, system_clock());
        let (h, spki) = t.create_key(&[fqdn.to_uppercase(), fqdn.into()]).unwrap();
        assert_eq!(spki.len(), 91 * 2);
        let csr = t.csr(&h).unwrap();
        assert_eq!(csr.first(), Some(&0x30));
        assert!(
            t.sign_handshake(&h, &tls13_server_signed_message(&[0; 32]))
                .is_err()
        );
        assert!(t.activate(&h, None).is_err());
        // Slots need an installed certificate too; serving and removal rules are pinned against
        // the TS backend in packages/keyd/tests/rustBackend.test.ts.
        assert!(t.activate(&h, Some(ActivateSlot::Slot(1))).is_err());
        assert!(t.serving_certs().is_empty());
        assert!(t.remove(&h).is_ok());
        assert_eq!(
            t.create_key(&["evil.example.com".into()]).unwrap_err().code,
            crate::wire::ErrorCode::Forbidden
        );
        assert_eq!(
            t.create_key(&["not a name".into()]).unwrap_err().code,
            crate::wire::ErrorCode::BadRequest
        );
        assert_eq!(
            t.create_key(&[]).unwrap_err().code,
            crate::wire::ErrorCode::BadRequest
        );
    }
}
