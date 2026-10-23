//! A rustls `SigningKey` whose private key stays in keyd. The signer is bound three ways so
//! it cannot become a general signing oracle through the ingress:
//!
//! - **scheme**: ECDSA P-256 with SHA-256 only, and only when the peer offered it;
//! - **context**: the bytes rustls hands over must be a TLS 1.3 server CertificateVerify
//!   input or a TLS 1.2 ServerKeyExchange input, nothing else;
//! - **key**: only for the handle keyd says is active (or the one it just replaced, for a
//!   handshake already in flight), and keyd's answer must verify under the leaf's key.
//!
//! keyd's `tls.sign` still takes a bare digest, so a compromised ingress could ask it to
//! sign anything; closing that needs keyd to take the structured input (README, "Left").

use std::sync::{Arc, PoisonError, RwLock};
use std::time::{Duration, Instant};

use aws_lc_rs::digest;
use aws_lc_rs::signature::{self, UnparsedPublicKey};
use rustls::pki_types::SubjectPublicKeyInfoDer;
use rustls::sign::{Signer, SigningKey};
use rustls::{SignatureAlgorithm, SignatureScheme};

use crate::keyd::KeydClient;

pub const SCHEME: SignatureScheme = SignatureScheme::ECDSA_NISTP256_SHA256;

const TLS13_SERVER_CONTEXT: &[u8] = b"TLS 1.3, server CertificateVerify\0";

/// Which key handles may sign right now.
#[derive(Debug)]
pub struct ActiveHandles {
    grace: Duration,
    state: RwLock<HandlesState>,
}

#[derive(Debug, Default)]
struct HandlesState {
    active: Option<String>,
    previous: Option<(String, Instant)>,
}

impl ActiveHandles {
    /// `grace` is how long the replaced handle may still finish a handshake that chose it.
    pub fn new(grace: Duration) -> Self {
        Self {
            grace,
            state: RwLock::new(HandlesState::default()),
        }
    }

    pub fn switch_to(&self, handle: &str) {
        let mut s = self.state.write().unwrap_or_else(PoisonError::into_inner);
        if s.active.as_deref() == Some(handle) {
            return;
        }
        s.previous = s.active.take().map(|h| (h, Instant::now()));
        s.active = Some(handle.to_owned());
    }

    pub fn permits(&self, handle: &str) -> bool {
        let s = self.state.read().unwrap_or_else(PoisonError::into_inner);
        if s.active.as_deref() == Some(handle) {
            return true;
        }
        matches!(&s.previous, Some((h, at)) if h == handle && at.elapsed() < self.grace)
    }
}

/// True for exactly the two inputs a TLS server signs.
pub fn is_server_handshake_input(message: &[u8]) -> bool {
    // TLS 1.3 (RFC 8446 4.4.3): 64 spaces, the server context string, the transcript hash.
    if let Some(rest) = message.strip_prefix(&[0x20u8; 64][..])
        && let Some(hash) = rest.strip_prefix(TLS13_SERVER_CONTEXT)
    {
        return hash.len() == 32 || hash.len() == 48;
    }
    // TLS 1.2 (RFC 8422 5.4): client_random, server_random, ServerECDHParams of a named curve.
    let Some(params) = message.get(64..) else {
        return false;
    };
    match params {
        [3, hi, lo, len, point @ ..] => {
            let group = u16::from_be_bytes([*hi, *lo]);
            let want = match group {
                0x001d => 32,
                0x0017 => 65,
                0x0018 => 97,
                _ => return false,
            };
            usize::from(*len) == want && point.len() == want
        }
        _ => false,
    }
}

/// Run a blocking keyd round trip without stalling the async workers.
pub fn run_blocking<T>(f: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(h) if h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(f)
        }
        _ => f(),
    }
}

#[derive(Debug, Clone)]
pub struct KeydSigningKey {
    keyd: Arc<KeydClient>,
    handles: Arc<ActiveHandles>,
    handle: String,
    spki: Vec<u8>,
    point: Vec<u8>,
}

impl KeydSigningKey {
    pub fn new(
        keyd: Arc<KeydClient>,
        handles: Arc<ActiveHandles>,
        handle: String,
        spki: Vec<u8>,
        point: Vec<u8>,
    ) -> Self {
        Self {
            keyd,
            handles,
            handle,
            spki,
            point,
        }
    }
}

impl SigningKey for KeydSigningKey {
    fn choose_scheme(&self, offered: &[SignatureScheme]) -> Option<Box<dyn Signer>> {
        offered
            .contains(&SCHEME)
            .then(|| Box::new(KeydSigner(self.clone())) as Box<dyn Signer>)
    }

    fn public_key(&self) -> Option<SubjectPublicKeyInfoDer<'_>> {
        Some(SubjectPublicKeyInfoDer::from(self.spki.as_slice()))
    }

    fn algorithm(&self) -> SignatureAlgorithm {
        SignatureAlgorithm::ECDSA
    }
}

#[derive(Debug)]
pub struct KeydSigner(KeydSigningKey);

impl Signer for KeydSigner {
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, rustls::Error> {
        let k = &self.0;
        if !is_server_handshake_input(message) {
            return Err(rustls::Error::General(
                "refusing to sign a non-handshake message".into(),
            ));
        }
        if !k.handles.permits(&k.handle) {
            return Err(rustls::Error::General(
                "the key is no longer in service".into(),
            ));
        }
        let d = digest::digest(&digest::SHA256, message);
        let sig = run_blocking(|| k.keyd.sign(&k.handle, d.as_ref()))
            .map_err(|e| rustls::Error::General(format!("keyd could not sign: {e}")))?;
        // A signature by any other key would only fail at the client; refuse it here.
        UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_ASN1, &k.point)
            .verify(message, &sig)
            .map_err(|_| {
                rustls::Error::General("keyd's signature does not match the certificate".into())
            })?;
        Ok(sig)
    }

    fn scheme(&self) -> SignatureScheme {
        SCHEME
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_server_handshake_inputs() {
        let mut t13 = vec![0x20u8; 64];
        t13.extend_from_slice(TLS13_SERVER_CONTEXT);
        assert!(!is_server_handshake_input(&t13));
        t13.extend_from_slice(&[7u8; 32]);
        assert!(is_server_handshake_input(&t13));
        let mut client = vec![0x20u8; 64];
        client.extend_from_slice(b"TLS 1.3, client CertificateVerify\0");
        client.extend_from_slice(&[7u8; 32]);
        assert!(!is_server_handshake_input(&client));

        let mut t12 = vec![9u8; 64];
        t12.extend_from_slice(&[3, 0x00, 0x1d, 32]);
        t12.extend_from_slice(&[1u8; 32]);
        assert!(is_server_handshake_input(&t12));
        t12.push(0);
        assert!(!is_server_handshake_input(&t12));
        assert!(!is_server_handshake_input(
            b"flagship/anything/v1|please sign"
        ));
        assert!(!is_server_handshake_input(&[0u8; 200]));
    }

    #[test]
    fn previous_handle_signs_only_within_grace() {
        let h = ActiveHandles::new(Duration::from_millis(30));
        assert!(!h.permits("a"));
        h.switch_to("a");
        assert!(h.permits("a"));
        h.switch_to("b");
        assert!(h.permits("a") && h.permits("b"));
        std::thread::sleep(Duration::from_millis(50));
        assert!(!h.permits("a") && h.permits("b"));
        assert!(!h.permits("c"));
    }

    #[test]
    fn chooses_only_p256_sha256() {
        let k = KeydSigningKey::new(
            Arc::new(KeydClient::new("/nonexistent", "t", Duration::from_secs(1))),
            Arc::new(ActiveHandles::new(Duration::from_secs(1))),
            "h".into(),
            vec![],
            vec![],
        );
        assert!(
            k.choose_scheme(&[
                SignatureScheme::ECDSA_NISTP384_SHA384,
                SignatureScheme::RSA_PSS_SHA256
            ])
            .is_none()
        );
        let s = k
            .choose_scheme(&[SignatureScheme::ED25519, SCHEME])
            .unwrap();
        assert_eq!(s.scheme(), SCHEME);
        // Not active: refused before keyd is asked.
        let mut t13 = vec![0x20u8; 64];
        t13.extend_from_slice(TLS13_SERVER_CONTEXT);
        t13.extend_from_slice(&[7u8; 32]);
        assert!(s.sign(&t13).is_err());
    }
}
