//! Signed boot-worker requests, byte for byte with the shell flow
//! (`installer/boot-stage.sh` and the Debian initramfs premount in
//! `packages/flagship-builder/src/userdata.ts`) and the TS protocol
//! (`bootAuth.ts`, `phoneEndpoint.ts`), which the worker verifies
//! (`packages/boot-core/src/gate.ts`, `routes.ts`).
//!
//! ```text
//! secret-request: flagship/secret-request/v1|<serverDomain>|<hex stkPub>|<purpose>|<hex nonce>|<issuedAt>
//! box-auth:       flagship/boot-auth/v1|box|<serverDomain>|<METHOD>|<path>|<hex pub>|<hex nonce>|<issuedAt>
//! Authorization:  Flagship-Boot-v1 base64url-nopad(JSON envelope)
//! ```

use crate::gohex;
use crate::identity::BoxIdentity;
use base64ct::{Base64UrlUnpadded, Encoding};
use core::fmt;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

/// `TAG_SECRET_REQUEST`.
pub const TAG_SECRET_REQUEST: &str = "flagship/secret-request/v1";
/// `TAG_BOOT_AUTH`.
pub const TAG_BOOT_AUTH: &str = "flagship/boot-auth/v1";
/// `BOOT_AUTH_SCHEME`.
pub const BOOT_AUTH_SCHEME: &str = "Flagship-Boot-v1";
/// The worker's freshness window on a signed `issuedAt` (`DEFAULT_MAX_AGE_MS`).
pub const WORKER_MAX_AGE_MS: u64 = 5 * 60_000;

/// A field the canonical encoding cannot carry unambiguously.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldError {
    /// Which field.
    pub field: &'static str,
    /// Why.
    pub reason: String,
}

impl fmt::Display for FieldError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.field, self.reason)
    }
}

impl std::error::Error for FieldError {}

/// `fieldGuard`: no separator, no control characters.
pub fn field_guard(field: &'static str, value: &str) -> Result<(), FieldError> {
    for (i, c) in value.char_indices() {
        if c == '|' {
            return Err(FieldError {
                field,
                reason: format!("contains separator '|' at index {i}"),
            });
        }
        if c <= '\u{1f}' || c == '\u{7f}' {
            return Err(FieldError {
                field,
                reason: format!("contains control char 0x{:x} at index {i}", u32::from(c)),
            });
        }
    }
    Ok(())
}

/// A server domain the shell flow interpolates into URLs, JSON and signed
/// bytes without escaping. Only host characters keep all three unambiguous.
pub fn check_server_domain(domain: &str) -> Result<(), FieldError> {
    let ok = !domain.is_empty()
        && domain.len() <= 253
        && domain
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(FieldError {
            field: "serverDomain",
            reason: "must be a host name (letters, digits, '.', '-')".into(),
        })
    }
}

/// `canonicalSecretRequest`.
pub fn canonical_secret_request(
    server_domain: &str,
    stk_pub_hex: &str,
    purpose: &str,
    nonce_hex: &str,
    issued_at: u64,
) -> Result<String, FieldError> {
    field_guard("serverDomain", server_domain)?;
    Ok(format!(
        "{TAG_SECRET_REQUEST}|{server_domain}|{stk_pub_hex}|{purpose}|{nonce_hex}|{issued_at}"
    ))
}

/// `canonicalBootAuth` (method upper-cased, hex lower-cased, as the TS does).
pub fn canonical_boot_auth(
    role: &str,
    server_domain: &str,
    method: &str,
    path: &str,
    pub_hex: &str,
    nonce_hex: &str,
    issued_at: u64,
) -> String {
    format!(
        "{TAG_BOOT_AUTH}|{role}|{server_domain}|{}|{path}|{}|{}|{issued_at}",
        method.to_ascii_uppercase(),
        pub_hex.to_ascii_lowercase(),
        nonce_hex.to_ascii_lowercase()
    )
}

/// The `Authorization` header value for a box (STK) request. The JSON is the
/// shell's `printf` output exactly: same key order, no whitespace.
pub fn box_auth_header(
    id: &BoxIdentity,
    server_domain: &str,
    method: &str,
    path: &str,
    nonce_hex: &str,
    issued_at: u64,
) -> Result<String, FieldError> {
    check_server_domain(server_domain)?;
    check_path(path)?;
    let canon = canonical_boot_auth(
        "box",
        server_domain,
        method,
        path,
        id.pub_hex(),
        nonce_hex,
        issued_at,
    );
    let sig = gohex::encode(&id.sign(canon.as_bytes()));
    let json = format!(
        "{{\"role\":\"box\",\"serverDomain\":\"{server_domain}\",\"method\":\"{method}\",\"path\":\"{path}\",\"pubKeyHex\":\"{}\",\"nonceHex\":\"{nonce_hex}\",\"issuedAt\":{issued_at},\"signatureHex\":\"{sig}\"}}",
        id.pub_hex()
    );
    Ok(format!(
        "{BOOT_AUTH_SCHEME} {}",
        Base64UrlUnpadded::encode_string(json.as_bytes())
    ))
}

fn check_path(path: &str) -> Result<(), FieldError> {
    let ok = path.starts_with('/')
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'-' | b'_'));
    if ok {
        Ok(())
    } else {
        Err(FieldError {
            field: "path",
            reason: "must be a plain absolute path".into(),
        })
    }
}

/// The body of `POST /api/boot/request`: the shell's `printf` output exactly.
/// Built once per boot and re-sent unchanged on every heartbeat, as today.
pub fn secret_request_body(
    id: &BoxIdentity,
    server_domain: &str,
    purpose: &str,
    nonce_hex: &str,
    issued_at: u64,
) -> Result<String, FieldError> {
    check_server_domain(server_domain)?;
    let canon =
        canonical_secret_request(server_domain, id.pub_hex(), purpose, nonce_hex, issued_at)?;
    let sig = gohex::encode(&id.sign(canon.as_bytes()));
    Ok(format!(
        "{{\"request\":{{\"serverDomain\":\"{server_domain}\",\"stkPub\":\"{}\",\"purpose\":\"{purpose}\",\"nonce\":\"{nonce_hex}\",\"issuedAt\":{issued_at}}},\"signature\":\"{sig}\"}}",
        id.pub_hex()
    ))
}

/// A decoded `Authorization` envelope (what the worker's gate parses).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootAuthEnvelope {
    /// `box`, `owner`, `delegate` or `share`.
    pub role: String,
    /// The box FQDN the request is scoped to.
    pub server_domain: String,
    /// HTTP method.
    pub method: String,
    /// Request path, no query.
    pub path: String,
    /// Signer public key, hex.
    pub pub_key_hex: String,
    /// Per-request nonce, hex.
    pub nonce_hex: String,
    /// Signed wall-clock ms.
    pub issued_at: u64,
    /// Signature, hex.
    pub signature_hex: String,
}

/// Why a signed request was refused, in the worker's words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestRefusal {
    /// Not a well-formed envelope.
    Malformed,
    /// Bound to another server, method or path.
    Binding(&'static str),
    /// Outside the freshness window.
    Stale,
    /// Signature does not verify under the claimed key.
    BadSignature,
    /// Signed by a key other than the one expected for the server.
    WrongKey,
}

/// Parse an `Authorization` value the way `gate.ts` `parseAuthHeader` does.
pub fn parse_box_auth_header(header: &str) -> Option<BootAuthEnvelope> {
    let (scheme, payload) = header.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case(BOOT_AUTH_SCHEME) {
        return None;
    }
    let raw = Base64UrlUnpadded::decode_vec(payload.trim()).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    let s = |k: &str| {
        v.get(k)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    Some(BootAuthEnvelope {
        role: s("role")?,
        server_domain: s("serverDomain")?,
        method: s("method")?,
        path: s("path")?,
        pub_key_hex: s("pubKeyHex")?,
        nonce_hex: s("nonceHex")?,
        issued_at: v.get("issuedAt").and_then(serde_json::Value::as_u64)?,
        signature_hex: s("signatureHex")?,
    })
}

fn verify_hex_sig(pub_hex: &str, sig_hex: &str, message: &[u8]) -> bool {
    let (Ok(pk), Ok(sig)) = (
        gohex::decode(pub_hex.as_bytes()),
        gohex::decode(sig_hex.as_bytes()),
    ) else {
        return false;
    };
    let (Ok(pk), Ok(sig)) = (
        <[u8; 32]>::try_from(pk.as_slice()),
        <[u8; 64]>::try_from(sig.as_slice()),
    ) else {
        return false;
    };
    VerifyingKey::from_bytes(&pk)
        .is_ok_and(|k| k.verify(message, &Signature::from_bytes(&sig)).is_ok())
}

/// The worker gate's rules 1 to 3 for a box request, used by this crate's
/// tests as an oracle (the worker itself stays in TypeScript).
pub fn verify_box_auth(
    header: &str,
    expected_stk_hex: &str,
    server_domain: &str,
    method: &str,
    path: &str,
    now_ms: u64,
) -> Result<BootAuthEnvelope, RequestRefusal> {
    let e = parse_box_auth_header(header).ok_or(RequestRefusal::Malformed)?;
    if e.role != "box" {
        return Err(RequestRefusal::Binding("wrong principal for this route"));
    }
    if !e.server_domain.eq_ignore_ascii_case(server_domain) {
        return Err(RequestRefusal::Binding("serverDomain binding mismatch"));
    }
    if !e.method.eq_ignore_ascii_case(method) {
        return Err(RequestRefusal::Binding("method binding mismatch"));
    }
    if e.path != path {
        return Err(RequestRefusal::Binding("path binding mismatch"));
    }
    if now_ms.abs_diff(e.issued_at) > WORKER_MAX_AGE_MS {
        return Err(RequestRefusal::Stale);
    }
    let canon = canonical_boot_auth(
        &e.role,
        &e.server_domain,
        &e.method,
        &e.path,
        &e.pub_key_hex,
        &e.nonce_hex,
        e.issued_at,
    );
    if !verify_hex_sig(&e.pub_key_hex, &e.signature_hex, canon.as_bytes()) {
        return Err(RequestRefusal::BadSignature);
    }
    if !e.pub_key_hex.eq_ignore_ascii_case(expected_stk_hex) {
        return Err(RequestRefusal::WrongKey);
    }
    Ok(e)
}

/// `verifySecretRequest`.
pub fn verify_secret_request(
    server_domain: &str,
    stk_pub_hex: &str,
    purpose: &str,
    nonce_hex: &str,
    issued_at: u64,
    signature_hex: &str,
) -> bool {
    canonical_secret_request(server_domain, stk_pub_hex, purpose, nonce_hex, issued_at)
        .is_ok_and(|c| verify_hex_sig(stk_pub_hex, signature_hex, c.as_bytes()))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn signs_what_the_gate_accepts() {
        let id = BoxIdentity::from_seed(&[0x0b; 32]);
        let nonce = "11".repeat(32);
        let h = box_auth_header(
            &id,
            "home.alice.flagship.services",
            "GET",
            "/api/boot/lease/home.alice.flagship.services",
            &nonce,
            1_760_000_000_000,
        )
        .unwrap();
        let path = "/api/boot/lease/home.alice.flagship.services";
        assert!(
            verify_box_auth(
                &h,
                id.pub_hex(),
                "home.alice.flagship.services",
                "GET",
                path,
                1_760_000_000_000
            )
            .is_ok()
        );
        assert_eq!(
            verify_box_auth(
                &h,
                id.pub_hex(),
                "home.alice.flagship.services",
                "POST",
                path,
                1_760_000_000_000
            )
            .unwrap_err(),
            RequestRefusal::Binding("method binding mismatch")
        );
        assert_eq!(
            verify_box_auth(
                &h,
                id.pub_hex(),
                "home.bob.flagship.services",
                "GET",
                path,
                1_760_000_000_000
            )
            .unwrap_err(),
            RequestRefusal::Binding("serverDomain binding mismatch")
        );
        assert_eq!(
            verify_box_auth(
                &h,
                id.pub_hex(),
                "home.alice.flagship.services",
                "GET",
                path,
                1_760_000_000_000 + WORKER_MAX_AGE_MS + 1
            )
            .unwrap_err(),
            RequestRefusal::Stale
        );
        let other = BoxIdentity::from_seed(&[0x0c; 32]);
        assert_eq!(
            verify_box_auth(
                &h,
                other.pub_hex(),
                "home.alice.flagship.services",
                "GET",
                path,
                1_760_000_000_000
            )
            .unwrap_err(),
            RequestRefusal::WrongKey
        );
    }

    #[test]
    fn guards_fields() {
        assert!(field_guard("x", "a|b").is_err());
        assert!(field_guard("x", "a\nb").is_err());
        assert!(check_server_domain("home.alice.flagship.services").is_ok());
        assert!(check_server_domain("evil\",\"x").is_err());
        assert!(check_server_domain("").is_err());
    }
}
