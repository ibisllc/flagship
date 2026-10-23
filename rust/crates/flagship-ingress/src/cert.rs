//! The certificate in service: keyd's PEM chain parsed once, its leaf checked to be P-256,
//! and the name check flagship-tlsd does with `x509.Certificate.VerifyHostname`.

use std::fmt;

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, DnsName, ServerName};

use crate::keyd::ActiveCert;

/// `SEQUENCE { SEQUENCE { id-ecPublicKey, prime256v1 }, BIT STRING (0 unused bits) ... }`.
pub const P256_SPKI_PREFIX: [u8; 26] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];
const MAX_CHAIN_PEM: usize = 64 * 1024;
const MAX_CHAIN_CERTS: usize = 8;

#[derive(Debug, PartialEq, Eq)]
pub enum CertError {
    TooLarge,
    NoCertificate,
    BadLeaf,
    NotP256,
}

impl fmt::Display for CertError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::TooLarge => "the chain is larger than keyd allows",
            Self::NoCertificate => "keyd gave no certificate",
            Self::BadLeaf => "the leaf certificate does not parse",
            Self::NotP256 => "the serving key is not ECDSA P-256",
        })
    }
}

impl std::error::Error for CertError {}

#[derive(Debug, Clone)]
pub struct ServingCert {
    pub handle: String,
    pub chain: Vec<CertificateDer<'static>>,
    /// The leaf's SubjectPublicKeyInfo DER (91 bytes).
    pub spki: Vec<u8>,
}

impl ServingCert {
    pub fn from_active(a: &ActiveCert) -> Result<Self, CertError> {
        if a.chain_pem.len() > MAX_CHAIN_PEM {
            return Err(CertError::TooLarge);
        }
        let mut chain = Vec::new();
        for c in CertificateDer::pem_slice_iter(a.chain_pem.as_bytes()) {
            let c = c.map_err(|_| CertError::NoCertificate)?;
            if chain.len() >= MAX_CHAIN_CERTS {
                return Err(CertError::TooLarge);
            }
            chain.push(c);
        }
        let leaf = chain.first().ok_or(CertError::NoCertificate)?;
        let ee = webpki::EndEntityCert::try_from(leaf).map_err(|_| CertError::BadLeaf)?;
        let spki = ee.subject_public_key_info().as_ref().to_vec();
        if spki.len() != P256_SPKI_PREFIX.len().saturating_add(65)
            || !spki.starts_with(&P256_SPKI_PREFIX)
        {
            return Err(CertError::NotP256);
        }
        if spki.get(P256_SPKI_PREFIX.len()) != Some(&0x04) {
            return Err(CertError::NotP256);
        }
        Ok(Self {
            handle: a.handle.clone(),
            chain,
            spki,
        })
    }

    /// The uncompressed P-256 point (65 bytes, `04 || x || y`).
    pub fn public_point(&self) -> &[u8] {
        self.spki.get(P256_SPKI_PREFIX.len()..).unwrap_or_default()
    }

    /// True only for a DNS name the leaf covers: exact, or one left-most label under a wildcard.
    pub fn covers(&self, name: &str) -> bool {
        let Some(leaf) = self.chain.first() else {
            return false;
        };
        let Ok(ee) = webpki::EndEntityCert::try_from(leaf) else {
            return false;
        };
        let Ok(dns) = DnsName::try_from(name.to_ascii_lowercase()) else {
            return false;
        };
        ee.verify_is_valid_for_subject_name(&ServerName::DnsName(dns))
            .is_ok()
    }
}
