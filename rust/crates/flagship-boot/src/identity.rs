//! The box's Ed25519 key as a PKCS#8 PEM: on a box today the boot key,
//! `/boot/flagship-boot-key.pem` (the STK is no longer on /boot; see
//! packages/protocol/src/bootKey.ts). The premount reads it with
//! `openssl pkey`; this parses the same DER directly.

use base64ct::{Base64, Encoding};
use core::fmt;
use ed25519_dalek::{Signer, SigningKey};
use zeroize::Zeroizing;

/// PKCS#8 v1 (RFC 8410) prefix for an Ed25519 private key: 16 bytes then the seed.
const PKCS8_V1_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];
/// PKCS#8 v2 (OneAsymmetricKey with the public key) prefix, as some tools write it.
const PKCS8_V2_PREFIX: [u8; 16] = [
    0x30, 0x51, 0x02, 0x01, 0x01, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];
const PKCS8_V2_PUB_TAG: [u8; 3] = [0x81, 0x21, 0x00];

/// Why the identity key could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityError {
    /// No `PRIVATE KEY` PEM block.
    NotPem,
    /// The PEM body is not base64.
    Base64,
    /// The DER is not an Ed25519 PKCS#8 key.
    NotEd25519Pkcs8,
    /// A v2 key whose embedded public key does not match its seed.
    PublicKeyMismatch,
}

impl fmt::Display for IdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NotPem => "identity key is not a PEM PRIVATE KEY block",
            Self::Base64 => "identity key PEM body is not valid base64",
            Self::NotEd25519Pkcs8 => "identity key is not an Ed25519 PKCS#8 private key",
            Self::PublicKeyMismatch => "identity key's embedded public key does not match its seed",
        })
    }
}

impl std::error::Error for IdentityError {}

/// An Ed25519 box key (the boot key at boot). The seed is zeroized on drop (with `SigningKey`'s own zeroize).
pub struct BoxIdentity {
    key: SigningKey,
    pub_hex: String,
}

impl fmt::Debug for BoxIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BoxIdentity")
            .field("pub_hex", &self.pub_hex)
            .finish_non_exhaustive()
    }
}

impl BoxIdentity {
    /// From the 32-byte Ed25519 seed (`Keypair.privateKey` in the TS protocol).
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        let key = SigningKey::from_bytes(seed);
        let pub_hex = crate::gohex::encode(key.verifying_key().as_bytes());
        Self { key, pub_hex }
    }

    /// From PKCS#8 PEM text (v1, or v2 with a matching public key).
    pub fn from_pkcs8_pem(pem: &[u8]) -> Result<Self, IdentityError> {
        let der = pem_body(pem)?;
        let seed = seed_from_der(&der)?;
        let id = Self::from_seed(&seed);
        if let Some(embedded) = v2_public_key(&der)
            && embedded != id.key.verifying_key().as_bytes().as_slice()
        {
            return Err(IdentityError::PublicKeyMismatch);
        }
        Ok(id)
    }

    /// Lowercase hex of the public key.
    pub fn pub_hex(&self) -> &str {
        &self.pub_hex
    }

    /// The seed, for opening sealed blobs.
    pub fn seed(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.key.to_bytes())
    }

    /// Ed25519 (RFC 8032) signature, as `openssl pkeyutl -sign -rawin` makes.
    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.key.sign(message).to_bytes()
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// The Go helper's `SeedFromPKCS8PEM`, refusal for refusal: the first BEGIN
/// and the first END marker anywhere, space/tab/CR/LF removed, padded
/// standard base64, exactly a 48-byte PKCS#8 v1 Ed25519 key.
pub fn seed_from_pkcs8_pem_go(pem: &[u8]) -> Result<Zeroizing<[u8; 32]>, IdentityError> {
    const BEGIN: &[u8] = b"-----BEGIN PRIVATE KEY-----";
    const END: &[u8] = b"-----END PRIVATE KEY-----";
    let (Some(i), Some(j)) = (find(pem, BEGIN), find(pem, END)) else {
        return Err(IdentityError::NotPem);
    };
    if j < i {
        return Err(IdentityError::NotPem);
    }
    // Go slices s[i+len(begin):j] and panics when the END marker overlaps the
    // BEGIN marker's dashes; refusing the key is the safe equivalent.
    let body = pem
        .get(i.saturating_add(BEGIN.len())..j)
        .ok_or(IdentityError::NotEd25519Pkcs8)?;
    let compact: Zeroizing<Vec<u8>> = Zeroizing::new(
        body.iter()
            .copied()
            .filter(|b| !matches!(b, b' ' | b'\n' | b'\r' | b'\t'))
            .collect(),
    );
    let der = core::str::from_utf8(&compact)
        .ok()
        .and_then(|t| Base64::decode_vec(t).ok())
        .map(Zeroizing::new)
        .ok_or(IdentityError::NotEd25519Pkcs8)?;
    match der.split_first_chunk::<16>() {
        Some((prefix, seed)) if *prefix == PKCS8_V1_PREFIX && seed.len() == 32 => {
            let mut out = Zeroizing::new([0u8; 32]);
            out.copy_from_slice(seed);
            Ok(out)
        }
        _ => Err(IdentityError::NotEd25519Pkcs8),
    }
}

fn pem_body(pem: &[u8]) -> Result<Zeroizing<Vec<u8>>, IdentityError> {
    const BEGIN: &str = "-----BEGIN PRIVATE KEY-----";
    const END: &str = "-----END PRIVATE KEY-----";
    let text = core::str::from_utf8(pem).map_err(|_| IdentityError::NotPem)?;
    let start = text.find(BEGIN).ok_or(IdentityError::NotPem)?;
    let after = text
        .get(start.saturating_add(BEGIN.len())..)
        .ok_or(IdentityError::NotPem)?;
    let end = after.find(END).ok_or(IdentityError::NotPem)?;
    let body = after.get(..end).ok_or(IdentityError::NotPem)?;
    let compact: Zeroizing<String> =
        Zeroizing::new(body.chars().filter(|c| !c.is_ascii_whitespace()).collect());
    Base64::decode_vec(&compact)
        .map(Zeroizing::new)
        .map_err(|_| IdentityError::Base64)
}

fn seed_from_der(der: &[u8]) -> Result<Zeroizing<[u8; 32]>, IdentityError> {
    let (prefix, rest) = der
        .split_first_chunk::<16>()
        .ok_or(IdentityError::NotEd25519Pkcs8)?;
    let (seed, tail) = rest
        .split_first_chunk::<32>()
        .ok_or(IdentityError::NotEd25519Pkcs8)?;
    let ok = if *prefix == PKCS8_V1_PREFIX {
        tail.is_empty()
    } else if *prefix == PKCS8_V2_PREFIX {
        tail.len() == 35 && tail.starts_with(&PKCS8_V2_PUB_TAG)
    } else {
        false
    };
    if !ok {
        return Err(IdentityError::NotEd25519Pkcs8);
    }
    Ok(Zeroizing::new(*seed))
}

fn v2_public_key(der: &[u8]) -> Option<&[u8]> {
    if der.len() == 83 && der.starts_with(&PKCS8_V2_PREFIX) {
        der.get(51..)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::indexing_slicing,
        clippy::arithmetic_side_effects
    )]
    use super::*;

    fn pem(der: &[u8]) -> String {
        format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            Base64::encode_string(der)
        )
    }

    #[test]
    fn reads_the_install_paths_pem() {
        let seed = [0x0bu8; 32];
        let mut der = PKCS8_V1_PREFIX.to_vec();
        der.extend_from_slice(&seed);
        let id = BoxIdentity::from_pkcs8_pem(pem(&der).as_bytes()).unwrap();
        assert_eq!(*id.seed(), seed);
        assert_eq!(id.pub_hex(), BoxIdentity::from_seed(&seed).pub_hex());
    }

    #[test]
    fn checks_a_v2_public_key() {
        let seed = [0x0bu8; 32];
        let good = BoxIdentity::from_seed(&seed);
        let mut der = PKCS8_V2_PREFIX.to_vec();
        der.extend_from_slice(&seed);
        der.extend_from_slice(&PKCS8_V2_PUB_TAG);
        der.extend_from_slice(&crate::gohex::decode(good.pub_hex().as_bytes()).unwrap());
        assert!(BoxIdentity::from_pkcs8_pem(pem(&der).as_bytes()).is_ok());
        let last = der.len() - 1;
        der[last] ^= 1;
        assert_eq!(
            BoxIdentity::from_pkcs8_pem(pem(&der).as_bytes()).unwrap_err(),
            IdentityError::PublicKeyMismatch
        );
    }

    #[test]
    fn reads_a_pem_like_the_go_helper() {
        let seed = [0x1bu8; 32];
        let mut der = PKCS8_V1_PREFIX.to_vec();
        der.extend_from_slice(&seed);
        let text = pem(&der).replace('\n', "\r\n \t");
        assert_eq!(*seed_from_pkcs8_pem_go(text.as_bytes()).unwrap(), seed);
        let mut v2 = PKCS8_V2_PREFIX.to_vec();
        v2.extend_from_slice(&seed);
        assert_eq!(
            seed_from_pkcs8_pem_go(pem(&v2).as_bytes()).unwrap_err(),
            IdentityError::NotEd25519Pkcs8
        );
        assert_eq!(
            seed_from_pkcs8_pem_go(b"-----END PRIVATE KEY----------BEGIN PRIVATE KEY-----")
                .unwrap_err(),
            IdentityError::NotPem
        );
        assert_eq!(
            seed_from_pkcs8_pem_go(b"-----BEGIN PRIVATE KEY-----END PRIVATE KEY-----").unwrap_err(),
            IdentityError::NotEd25519Pkcs8
        );
    }

    #[test]
    fn refuses_other_keys() {
        assert_eq!(
            BoxIdentity::from_pkcs8_pem(b"nope").unwrap_err(),
            IdentityError::NotPem
        );
        assert_eq!(
            BoxIdentity::from_pkcs8_pem(pem(&[0u8; 48]).as_bytes()).unwrap_err(),
            IdentityError::NotEd25519Pkcs8
        );
    }
}
