//! The per-box ACME account key, the same semantics as `acme.ts`: keyd builds each JWS itself by
//! request kind, only to Let's Encrypt over https, only for the box's names, only with a CSR
//! keyd made, only to revoke the box's own certificates.

use std::path::PathBuf;

use p256::ecdsa::SigningKey;
use p256::ecdsa::signature::hazmat::PrehashSigner;
use p256::elliptic_curve::sec1::ToSec1Point;
use serde_json::{Map, Value};
use x509_cert::Certificate;
use x509_cert::der::Decode;
use zeroize::Zeroizing;

use crate::crypto::{b64u, sha256};
use crate::files::{ensure_dir, read_hex_key, write_atomic};
use crate::obj;
use crate::tls::{TlsKeys, certificate_sans, generate_secret};
use crate::wire::{KeydError, KeydResult, js_is_space, js_len, to_hex};

pub const LETS_ENCRYPT_HOSTS: &[&str] = &[
    "acme-v02.api.letsencrypt.org",
    "acme-staging-v02.api.letsencrypt.org",
];

#[derive(Debug, Clone)]
pub enum AcmeRequest {
    NewAccount {
        url: String,
        nonce: String,
        contact: String,
    },
    NewOrder {
        url: String,
        nonce: String,
        kid: String,
        names: Vec<String>,
    },
    PostAsGet {
        url: String,
        nonce: String,
        kid: String,
    },
    Challenge {
        url: String,
        nonce: String,
        kid: String,
    },
    Finalize {
        url: String,
        nonce: String,
        kid: String,
        handle: String,
    },
    Revoke {
        url: String,
        nonce: String,
        kid: String,
        certificate_der: Vec<u8>,
        reason: f64,
    },
}

pub struct AcmeAccount {
    secret: Option<p256::SecretKey>,
    hosts: Vec<String>,
    file: Option<PathBuf>,
}

impl std::fmt::Debug for AcmeAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcmeAccount")
            .field("present", &self.secret.is_some())
            .field("hosts", &self.hosts)
            .finish_non_exhaustive()
    }
}

fn not_this_server() -> KeydError {
    KeydError::forbidden("that ACME server is not one this box talks to")
}

/// The ACME URL rule: https, no credentials or port, a directory host. This accepts the
/// canonical form only (`https://<host>[:443]/<path>[?<query>]`, lowercase host, no
/// percent-escapes, backslashes or dot segments) and refuses the rest, where `new URL` in the TS
/// backend would normalise first. Returns the pathname.
pub fn check_url<'a>(
    url: &'a str,
    hosts: &[String],
    path_prefix: Option<&str>,
) -> KeydResult<&'a str> {
    let (scheme, rest) = url
        .split_once(':')
        .ok_or_else(|| KeydError::bad_request("bad URL"))?;
    let scheme_ok = scheme
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphabetic)
        && scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-'));
    if !scheme_ok {
        return Err(KeydError::bad_request("bad URL"));
    }
    if !scheme.eq_ignore_ascii_case("https") {
        return Err(not_this_server());
    }
    let rest = rest.strip_prefix("//").ok_or_else(not_this_server)?;
    let split = rest.find(['/', '?', '#', '\\']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at_checked(split).ok_or_else(not_this_server)?;
    if authority.contains('@') {
        return Err(not_this_server());
    }
    let host = match authority.rsplit_once(':') {
        Some((h, port)) if port.is_empty() || port == "443" => h,
        Some(_) => return Err(not_this_server()),
        None => authority,
    };
    if !hosts.iter().any(|h| h.eq_ignore_ascii_case(host))
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
    {
        return Err(not_this_server());
    }
    let safe = |b: u8| b.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@/".contains(&b);
    let (path, query) = tail.split_once('?').unwrap_or((tail, ""));
    if !path.bytes().all(safe) || !query.bytes().all(|b| safe(b) || b == b'?') {
        return Err(not_this_server());
    }
    let path = if path.is_empty() { "/" } else { path };
    if path.split('/').any(|seg| seg == "." || seg == "..") {
        return Err(not_this_server());
    }
    if let Some(prefix) = path_prefix
        && !path.starts_with(prefix)
    {
        return Err(KeydError::forbidden("that ACME resource is not allowed"));
    }
    Ok(path)
}

/// `^[A-Za-z0-9_-]{8,128}$`
fn nonce_ok(n: &str) -> bool {
    (8..=128).contains(&n.len())
        && n.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `^mailto:[^\s@,;<>]{1,64}@[A-Za-z0-9.-]{1,200}$` (UTF-16 units, as a non-`u` JS regex counts).
fn contact_ok(c: &str) -> bool {
    let Some(rest) = c.strip_prefix("mailto:") else {
        return false;
    };
    let Some((local, domain)) = rest.split_once('@') else {
        return false;
    };
    let local_ok = (1..=64).contains(&js_len(local))
        && !local
            .chars()
            .any(|ch| js_is_space(ch) || matches!(ch, '@' | ',' | ';' | '<' | '>'));
    let domain_ok = (1..=200).contains(&domain.len())
        && domain
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    local_ok && domain_ok
}

fn json(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

impl AcmeAccount {
    /// Loads the key from `file` if it exists (lowercase hex, as `acme.ts` writes it).
    pub fn new(hosts: Vec<String>, file: Option<PathBuf>) -> Result<Self, String> {
        let mut a = Self {
            secret: None,
            hosts,
            file,
        };
        if let Some(f) = &a.file
            && f.exists()
        {
            let raw = read_hex_key(f).map_err(|e| e.to_string())?;
            a.secret = Some(
                p256::SecretKey::from_slice(raw.as_ref())
                    .map_err(|_| format!("{} is not a P-256 key", f.display()))?,
            );
        }
        Ok(a)
    }

    pub fn present(&self) -> bool {
        self.secret.is_some()
    }

    fn secret(&self) -> KeydResult<&p256::SecretKey> {
        self.secret
            .as_ref()
            .ok_or_else(|| KeydError::not_provisioned("no ACME account key"))
    }

    fn coords(&self) -> KeydResult<(String, String)> {
        let point = self.secret()?.public_key().to_sec1_point(false);
        let b = point.as_bytes();
        let x = b
            .get(1..33)
            .ok_or_else(|| KeydError::failed("internal error"))?;
        let y = b
            .get(33..65)
            .ok_or_else(|| KeydError::failed("internal error"))?;
        Ok((b64u(x), b64u(y)))
    }

    pub fn jwk(&self) -> KeydResult<Value> {
        let (x, y) = self.coords()?;
        Ok(Value::Object(
            obj! { "kty" => "EC", "crv" => "P-256", "x" => x, "y" => y },
        ))
    }

    /// RFC 7638 thumbprint, base64url.
    pub fn thumbprint(&self) -> KeydResult<String> {
        let (x, y) = self.coords()?;
        let canonical = json(&Value::Object(
            obj! { "crv" => "P-256", "kty" => "EC", "x" => x, "y" => y },
        ));
        Ok(b64u(&sha256(canonical.as_bytes())))
    }

    fn store(&mut self, secret: p256::SecretKey) -> KeydResult<()> {
        if let Some(f) = &self.file {
            if let Some(parent) = f.parent() {
                ensure_dir(parent, 0o700).map_err(|_| KeydError::failed("internal error"))?;
            }
            let mut text = Zeroizing::new(to_hex(&Zeroizing::new(secret.to_bytes().to_vec())));
            text.push('\n');
            write_atomic(f, text.as_bytes(), 0o400)
                .map_err(|_| KeydError::failed("internal error"))?;
        }
        self.secret = Some(secret);
        Ok(())
    }

    pub fn create(&mut self) -> KeydResult<()> {
        if self.secret.is_some() {
            return Err(KeydError::forbidden("an ACME account key already exists"));
        }
        let s = generate_secret()?;
        self.store(s)
    }

    /// An account key the owner granted (PKCS#8 or SEC1 EC P-256 PEM, already opened by keyd).
    pub fn import_pem(&mut self, pem: &str) -> KeydResult<()> {
        if self.secret.is_some() {
            return Err(KeydError::forbidden("an ACME account key already exists"));
        }
        let secret = parse_ec_private_pem(pem).ok_or_else(|| {
            KeydError::bad_request("the account key must be an EC P-256 private key")
        })?;
        self.store(secret)
    }

    /// Build and sign the JWS for one request of a known kind.
    pub fn sign(&self, req: &AcmeRequest, tls: &TlsKeys) -> KeydResult<Map<String, Value>> {
        let secret = self.secret()?;
        let (url, nonce) = match req {
            AcmeRequest::NewAccount { url, nonce, .. }
            | AcmeRequest::NewOrder { url, nonce, .. }
            | AcmeRequest::PostAsGet { url, nonce, .. }
            | AcmeRequest::Challenge { url, nonce, .. }
            | AcmeRequest::Finalize { url, nonce, .. }
            | AcmeRequest::Revoke { url, nonce, .. } => (url, nonce),
        };
        if !nonce_ok(nonce) {
            return Err(KeydError::bad_request("bad nonce"));
        }
        check_url(url, &self.hosts, None)?;
        let mut header = obj! { "alg" => "ES256", "nonce" => nonce.clone(), "url" => url.clone() };
        let payload = match req {
            AcmeRequest::NewAccount { contact, .. } => {
                if !contact_ok(contact) {
                    return Err(KeydError::bad_request("bad contact"));
                }
                check_url(url, &self.hosts, Some("/acme/new-acct"))?;
                header.insert("jwk".into(), self.jwk()?);
                b64u(
                    json(&Value::Object(
                        obj! { "termsOfServiceAgreed" => true, "contact" => vec![contact.clone()] },
                    ))
                    .as_bytes(),
                )
                .into_bytes()
            }
            other => self.kid_payload(other, url, &mut header, tls)?,
        };
        let protected = b64u(json(&Value::Object(header)).as_bytes());
        let mut input = protected.clone().into_bytes();
        input.push(b'.');
        input.extend_from_slice(&payload);
        let sk = SigningKey::from(secret);
        let sig: p256::ecdsa::Signature = sk
            .sign_prehash(&sha256(&input))
            .map_err(|_| KeydError::failed("internal error"))?;
        let payload =
            String::from_utf8(payload).map_err(|_| KeydError::failed("internal error"))?;
        Ok(
            obj! { "protected" => protected, "payload" => payload, "signature" => b64u(&sig.normalize_s().to_bytes()) },
        )
    }

    fn kid_payload(
        &self,
        req: &AcmeRequest,
        url: &str,
        header: &mut Map<String, Value>,
        tls: &TlsKeys,
    ) -> KeydResult<Vec<u8>> {
        let kid = match req {
            AcmeRequest::NewOrder { kid, .. }
            | AcmeRequest::PostAsGet { kid, .. }
            | AcmeRequest::Challenge { kid, .. }
            | AcmeRequest::Finalize { kid, .. }
            | AcmeRequest::Revoke { kid, .. } => kid,
            AcmeRequest::NewAccount { .. } => return Err(KeydError::failed("internal error")),
        };
        check_url(kid, &self.hosts, Some("/acme/acct/"))?;
        header.insert("kid".into(), Value::from(kid.clone()));
        let allowed = tls.names();
        Ok(match req {
            AcmeRequest::NewOrder { names, .. } => {
                check_url(url, &self.hosts, Some("/acme/new-order"))?;
                let mut uniq: Vec<String> = Vec::new();
                for n in names.iter().map(|n| n.to_lowercase()) {
                    if !uniq.contains(&n) {
                        uniq.push(n);
                    }
                }
                if uniq.is_empty() || uniq.len() > 8 || uniq.iter().any(|n| !allowed.contains(n)) {
                    return Err(KeydError::forbidden(
                        "that order names something this box may not have a certificate for",
                    ));
                }
                let ids: Vec<Value> = uniq
                    .into_iter()
                    .map(|value| Value::Object(obj! { "type" => "dns", "value" => value }))
                    .collect();
                b64u(json(&Value::Object(obj! { "identifiers" => ids })).as_bytes()).into_bytes()
            }
            AcmeRequest::PostAsGet { .. } => Vec::new(),
            AcmeRequest::Challenge { .. } => {
                check_url(url, &self.hosts, Some("/acme/chall"))?;
                b64u(b"{}").into_bytes()
            }
            AcmeRequest::Finalize { handle, .. } => {
                check_url(url, &self.hosts, Some("/acme/finalize/"))?;
                let csr = tls.csr(handle)?;
                b64u(json(&Value::Object(obj! { "csr" => b64u(&csr) })).as_bytes()).into_bytes()
            }
            AcmeRequest::Revoke {
                certificate_der,
                reason,
                ..
            } => {
                check_url(url, &self.hosts, Some("/acme/revoke-cert"))?;
                let r = *reason;
                if ![0.0, 1.0, 4.0, 5.0].contains(&r) {
                    return Err(KeydError::bad_request("bad revocation reason"));
                }
                let cert = Certificate::from_der(certificate_der)
                    .map_err(|_| KeydError::bad_request("not a certificate"))?;
                let sans = certificate_sans(&cert).map_err(|_| {
                    KeydError::forbidden("that is not one of this box's certificates")
                })?;
                let mine = !sans.is_empty()
                    && sans.iter().all(|s| {
                        s.as_ref()
                            .is_some_and(|n| allowed.contains(&n.to_lowercase()))
                    });
                if !mine {
                    return Err(KeydError::forbidden(
                        "that is not one of this box's certificates",
                    ));
                }
                let reason_int = if r == 0.0 {
                    0u8
                } else if r == 1.0 {
                    1
                } else if r == 4.0 {
                    4
                } else {
                    5
                };
                b64u(
                    json(&Value::Object(
                        obj! { "certificate" => b64u(certificate_der), "reason" => reason_int },
                    ))
                    .as_bytes(),
                )
                .into_bytes()
            }
            AcmeRequest::NewAccount { .. } => return Err(KeydError::failed("internal error")),
        })
    }

    pub fn destroy(&mut self) {
        self.secret = None;
    }
}

/// The first `PRIVATE KEY` (PKCS#8) or `EC PRIVATE KEY` (SEC1) block of a PEM text, for P-256.
pub fn parse_ec_private_pem(pem: &str) -> Option<p256::SecretKey> {
    use p256::pkcs8::DecodePrivateKey;
    for (label, pkcs8) in [("PRIVATE KEY", true), ("EC PRIVATE KEY", false)] {
        let begin = format!("-----BEGIN {label}-----");
        let end = format!("-----END {label}-----");
        let Some(start) = pem.find(&begin) else {
            continue;
        };
        let body_start = start.saturating_add(begin.len());
        let Some(stop) = pem.get(body_start..).and_then(|s| s.find(&end)) else {
            continue;
        };
        let body = pem.get(body_start..body_start.saturating_add(stop))?;
        let b64: Zeroizing<String> =
            Zeroizing::new(body.chars().filter(|c| !js_is_space(*c)).collect());
        let der = Zeroizing::new(crate::crypto::b64_decode(&b64)?);
        let key = if pkcs8 {
            p256::SecretKey::from_pkcs8_der(&der).ok()
        } else {
            p256::SecretKey::from_sec1_der(&der).ok()
        };
        if key.is_some() {
            return key;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn hosts() -> Vec<String> {
        LETS_ENCRYPT_HOSTS.iter().map(|h| (*h).to_owned()).collect()
    }

    #[test]
    fn url_rule() {
        let h = hosts();
        assert_eq!(
            check_url(
                "https://acme-v02.api.letsencrypt.org/acme/new-order",
                &h,
                Some("/acme/new-order")
            )
            .unwrap(),
            "/acme/new-order"
        );
        assert!(
            check_url(
                "https://ACME-v02.api.letsencrypt.org:443/acme/acct/1",
                &h,
                Some("/acme/acct/")
            )
            .is_ok()
        );
        assert!(check_url("https://acme-v02.api.letsencrypt.org", &h, None).is_ok());
        assert_eq!(check_url("nope", &h, None).unwrap_err().message, "bad URL");
        for bad in [
            "http://acme-v02.api.letsencrypt.org/acme/new-order",
            "https://evil.example/acme/new-order",
            "https://acme-v02.api.letsencrypt.org:8443/acme/new-order",
            "https://u:p@acme-v02.api.letsencrypt.org/acme/new-order",
            "https://acme-v02.api.letsencrypt.org./acme/new-order",
            "https://acme-v02.api.letsencrypt.org/acme/new-order/../x",
            "https://acme-v02.api.letsencrypt.org/acme/%6eew-order",
            "https://acme-v02.api.letsencrypt.org\\acme/new-order",
            "https://acme-v02.api.letsencrypt.org/acme/new-order#x",
        ] {
            assert_eq!(
                check_url(bad, &h, Some("/acme/new-order"))
                    .unwrap_err()
                    .code,
                crate::wire::ErrorCode::Forbidden,
                "{bad}"
            );
        }
        assert_eq!(
            check_url(
                "https://acme-v02.api.letsencrypt.org/other",
                &h,
                Some("/acme/acct/")
            )
            .unwrap_err()
            .message,
            "that ACME resource is not allowed"
        );
    }

    #[test]
    fn contact_rule() {
        assert!(contact_ok("mailto:ops@example.com"));
        for bad in [
            "mailto:a@b.c\nmailto:x@y.z",
            "ops@example.com",
            "mailto:@x.com",
            "mailto:a b@x.com",
            "mailto:a@x_y.com",
            "mailto:a,b@x.com",
            &format!("mailto:{}@x.com", "a".repeat(65)),
        ] {
            assert!(!contact_ok(bad), "{bad}");
        }
    }

    #[test]
    fn nonce_rule() {
        assert!(nonce_ok("abcdefgh"));
        assert!(!nonce_ok("abc"));
        assert!(!nonce_ok("abcdefg="));
    }
}
