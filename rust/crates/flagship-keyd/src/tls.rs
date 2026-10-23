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

pub struct TlsKeys {
    allowed: Vec<String>,
    dir: Option<PathBuf>,
    keys: Vec<(String, StoredKey)>,
    active: Option<String>,
    now: Clock,
}

impl std::fmt::Debug for TlsKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TlsKeys")
            .field("allowed", &self.allowed)
            .field("keys", &self.keys.len())
            .field("active", &self.active)
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
            if !self.allowed.contains(n) {
                return Err(KeydError::forbidden(
                    "that name is not one this box may have a certificate for",
                ));
            }
        }
        // Old keys that never got a certificate, or were replaced, make room for new ones.
        if self.keys.len() >= MAX_KEYS {
            let now = (self.now)();
            let candidates: Vec<String> = self
                .keys
                .iter()
                .filter(|(h, k)| {
                    Some(h) != self.active.as_ref()
                        && k.not_after.is_none_or(|na| na == 0 || na < now)
                })
                .map(|(h, _)| h.clone())
                .collect();
            for h in candidates {
                self.remove(&h)?;
                if self.keys.len() < MAX_KEYS {
                    break;
                }
            }
            if self.keys.len() >= MAX_KEYS {
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

    pub fn activate(&mut self, handle: &str) -> KeydResult<()> {
        if self.get(handle)?.chain_pem.is_none() {
            return Err(KeydError::forbidden(
                "install a certificate before serving with this key",
            ));
        }
        self.active = Some(handle.to_owned());
        if let Some(dir) = &self.dir {
            ensure_dir(dir, 0o700).map_err(io_failed)?;
            write_atomic(&dir.join("active"), handle.as_bytes(), 0o400).map_err(io_failed)?;
        }
        Ok(())
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
    pub fn sign(&self, handle: &str, digest: &[u8]) -> KeydResult<Vec<u8>> {
        let k = self.get(handle)?;
        let not_after = match (&k.chain_pem, k.not_after) {
            (Some(_), Some(na)) if na != 0 => na,
            _ => return Err(KeydError::forbidden("this key has no certificate")),
        };
        if not_after < (self.now)().saturating_sub(7 * DAY_MS) {
            return Err(KeydError::forbidden("this key's certificate has expired"));
        }
        if digest.len() != 32 && digest.len() != 48 {
            return Err(KeydError::bad_request("digest must be 32 or 48 bytes"));
        }
        sign_prehash_der(&k.secret, digest)
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
                    "active" => Some(h) == self.active.as_ref(),
                    "legacy" => k.legacy,
                })
            })
            .collect()
    }

    pub fn remove(&mut self, handle: &str) -> KeydResult<()> {
        self.get(handle)?;
        if self.active.as_deref() == Some(handle) {
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
    }
}

fn io_failed(_: std::io::Error) -> KeydError {
    KeydError::failed("internal error")
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
    fn csr_is_signed_and_lists_exactly_the_names() {
        let fqdn = "home.alice.flagship.services";
        let mut t = TlsKeys::new(vec![fqdn.into(), format!("*.{fqdn}")], None, system_clock());
        let (h, spki) = t.create_key(&[fqdn.to_uppercase(), fqdn.into()]).unwrap();
        assert_eq!(spki.len(), 91 * 2);
        let csr = t.csr(&h).unwrap();
        assert_eq!(csr.first(), Some(&0x30));
        assert!(t.sign(&h, &[0; 32]).is_err());
        assert!(t.activate(&h).is_err());
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
