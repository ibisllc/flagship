//! `flagship/hybrid-sig/ed25519-mldsa65/v1`: Ed25519 AND ML-DSA-65 over one
//! domain-separated message that binds the suite and both public keys, then
//! the purpose and payload. Verification needs both components; neither
//! component signs anything a classical-only verifier would accept.
//!
//! `M' = lp8(suite tag) || u16be(0x0002) || ed25519_pk (32) || mldsa65_pk
//! (1952) || lp8(purpose) || u32be(len payload) || payload`. Ed25519 signs
//! `M'`; ML-DSA-65 signs `M'` with context string = the suite tag.
//! Public key `ed || mldsa` (1984 bytes), signature `ed || mldsa` (3373),
//! secret key two independent 32-byte seeds.

use ed25519_dalek::{SigningKey as EdSigningKey, VerifyingKey as EdVerifyingKey};
use flagship_protocol::SuiteId;
use flagship_protocol::parse::{TagNamespace, validate_purpose_tag};
use ml_dsa::{EncodedVerifyingKey, MlDsa65, Signature as MlDsaSignature, SigningKey, VerifyingKey};
use zeroize::Zeroizing;

use crate::ed25519_strict;
use crate::error::CryptoError;
use crate::key_id::key_id;
use crate::rng::BufRng;

pub const ED25519_PK_LEN: usize = 32;
pub const MLDSA65_PK_LEN: usize = 1952;
pub const PUBLIC_KEY_LEN: usize = 1984;
pub const ED25519_SIG_LEN: usize = 64;
pub const MLDSA65_SIG_LEN: usize = 3309;
pub const SIGNATURE_LEN: usize = 3373;
pub const SEED_LEN: usize = 32;
pub const MAX_PAYLOAD_LEN: usize = 1_048_576;

const SUITE: SuiteId = SuiteId::HybridSigEd25519MlDsa65V1;

/// A hybrid verifying key: both components, validated at parse time.
#[derive(Clone, Debug)]
pub struct HybridVerifyingKey {
    bytes: Vec<u8>,
    ed: EdVerifyingKey,
    mldsa: VerifyingKey<MlDsa65>,
    id: [u8; 32],
}

impl HybridVerifyingKey {
    /// Parses `ed25519_pk || mldsa65_pk`. The Ed25519 part must be canonical,
    /// torsion-free and not the identity.
    ///
    /// # Errors
    /// [`CryptoError::BadPublicKey`].
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CryptoError> {
        if bytes.len() != PUBLIC_KEY_LEN {
            return Err(CryptoError::BadPublicKey);
        }
        let (ed_b, ml_b) = bytes
            .split_at_checked(ED25519_PK_LEN)
            .ok_or(CryptoError::BadPublicKey)?;
        let ed_arr =
            <[u8; ED25519_PK_LEN]>::try_from(ed_b).map_err(|_| CryptoError::BadPublicKey)?;
        let ed = ed25519_strict::parse_public(&ed_arr).ok_or(CryptoError::BadPublicKey)?;
        let enc = EncodedVerifyingKey::<MlDsa65>::try_from(ml_b)
            .map_err(|_| CryptoError::BadPublicKey)?;
        let mldsa = VerifyingKey::<MlDsa65>::decode(&enc);
        Ok(Self {
            bytes: bytes.to_vec(),
            ed,
            mldsa,
            id: key_id(SUITE, bytes),
        })
    }

    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    #[must_use]
    pub const fn key_id(&self) -> [u8; 32] {
        self.id
    }

    /// Verifies a hybrid signature. Both components must verify.
    ///
    /// # Errors
    /// [`CryptoError::BadPurpose`], [`CryptoError::PayloadTooLarge`] or
    /// [`CryptoError::BadSignature`].
    pub fn verify(
        &self,
        purpose: &str,
        payload: &[u8],
        signature: &[u8],
    ) -> Result<(), CryptoError> {
        let m = message(&self.bytes, purpose, payload)?;
        if signature.len() != SIGNATURE_LEN {
            return Err(CryptoError::BadSignature);
        }
        let (ed_sig, ml_sig) = signature
            .split_at_checked(ED25519_SIG_LEN)
            .ok_or(CryptoError::BadSignature)?;
        let ed_sig =
            <[u8; ED25519_SIG_LEN]>::try_from(ed_sig).map_err(|_| CryptoError::BadSignature)?;
        let ed_ok = ed25519_strict::verify(&self.ed, &m, &ed_sig);
        let ml_ok = MlDsaSignature::<MlDsa65>::try_from(ml_sig).is_ok_and(|s| {
            self.mldsa
                .verify_with_context(&m, SUITE.tag().as_bytes(), &s)
        });
        if ed_ok && ml_ok {
            Ok(())
        } else {
            Err(CryptoError::BadSignature)
        }
    }
}

/// A hybrid signing key. Both components zeroize on drop.
pub struct HybridSigningKey {
    ed: EdSigningKey,
    mldsa: SigningKey<MlDsa65>,
    public: HybridVerifyingKey,
}

impl core::fmt::Debug for HybridSigningKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("HybridSigningKey")
            .field("key_id", &self.public.id)
            .finish_non_exhaustive()
    }
}

impl HybridSigningKey {
    /// Builds the key from two independent seeds: an RFC 8032 Ed25519 secret
    /// key and an ML-DSA-65 `KeyGen_internal` seed. Neither is derived from
    /// the other.
    ///
    /// # Errors
    /// [`CryptoError::BadSecretKey`] if the derived public key fails validation.
    pub fn from_seeds(
        ed_seed: &[u8; SEED_LEN],
        mldsa_seed: &[u8; SEED_LEN],
    ) -> Result<Self, CryptoError> {
        let ed = EdSigningKey::from_bytes(ed_seed);
        let mldsa = SigningKey::<MlDsa65>::from_seed(&(*mldsa_seed).into());
        let mut pk = Vec::with_capacity(PUBLIC_KEY_LEN);
        pk.extend_from_slice(ed.verifying_key().as_bytes());
        pk.extend_from_slice(mldsa.expanded_key().verifying_key().encode().as_slice());
        let public = HybridVerifyingKey::from_bytes(&pk).map_err(|_| CryptoError::BadSecretKey)?;
        Ok(Self { ed, mldsa, public })
    }

    /// A new key from the operating system's RNG.
    ///
    /// # Errors
    /// [`CryptoError::Randomness`] or [`CryptoError::BadSecretKey`].
    pub fn generate() -> Result<Self, CryptoError> {
        let mut seeds = Zeroizing::new([0u8; 64]);
        getrandom::fill(seeds.as_mut()).map_err(|_| CryptoError::Randomness)?;
        let (a, b) = seeds.split_at(SEED_LEN);
        let a = Zeroizing::new(<[u8; SEED_LEN]>::try_from(a).map_err(|_| CryptoError::Randomness)?);
        let b = Zeroizing::new(<[u8; SEED_LEN]>::try_from(b).map_err(|_| CryptoError::Randomness)?);
        Self::from_seeds(&a, &b)
    }

    #[must_use]
    pub const fn verifying_key(&self) -> &HybridVerifyingKey {
        &self.public
    }

    /// Signs with hedged ML-DSA (32 bytes of OS randomness per signature).
    ///
    /// # Errors
    /// [`CryptoError::BadPurpose`], [`CryptoError::PayloadTooLarge`] or
    /// [`CryptoError::Randomness`].
    pub fn sign(&self, purpose: &str, payload: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let rng = BufRng::<32>::from_os().map_err(|_| CryptoError::Randomness)?;
        self.sign_with(purpose, payload, rng)
    }

    /// Signs with the deterministic ML-DSA variant (rnd = 32 zero bytes);
    /// used for the shared vectors. Verification is identical.
    ///
    /// # Errors
    /// As [`HybridSigningKey::sign`].
    pub fn sign_deterministic(
        &self,
        purpose: &str,
        payload: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        self.sign_with(purpose, payload, BufRng::new([0u8; 32]))
    }

    fn sign_with(
        &self,
        purpose: &str,
        payload: &[u8],
        mut rng: BufRng<32>,
    ) -> Result<Vec<u8>, CryptoError> {
        let m = message(&self.public.bytes, purpose, payload)?;
        let ed_sig = ed25519_strict::sign(&self.ed, &m);
        let ml_sig = self
            .mldsa
            .expanded_key()
            .sign_randomized(&m, SUITE.tag().as_bytes(), &mut rng)
            .map_err(|_| CryptoError::Randomness)?;
        if !rng.exactly_consumed() {
            return Err(CryptoError::Randomness);
        }
        let mut out = Vec::with_capacity(SIGNATURE_LEN);
        out.extend_from_slice(&ed_sig);
        out.extend_from_slice(ml_sig.encode().as_slice());
        Ok(out)
    }
}

/// The signed message representative `M'` (see the module docs).
///
/// # Errors
/// [`CryptoError::BadPurpose`] or [`CryptoError::PayloadTooLarge`].
pub fn message(public_key: &[u8], purpose: &str, payload: &[u8]) -> Result<Vec<u8>, CryptoError> {
    validate_purpose_tag(purpose, TagNamespace::Flagship).map_err(|_| CryptoError::BadPurpose)?;
    if payload.len() > MAX_PAYLOAD_LEN {
        return Err(CryptoError::PayloadTooLarge);
    }
    let tag = SUITE.tag().as_bytes();
    let mut m = Vec::with_capacity(payload.len().saturating_add(2200));
    m.push(u8::try_from(tag.len()).map_err(|_| CryptoError::BadPurpose)?);
    m.extend_from_slice(tag);
    m.extend_from_slice(&SUITE.id().to_be_bytes());
    m.extend_from_slice(public_key);
    m.push(u8::try_from(purpose.len()).map_err(|_| CryptoError::BadPurpose)?);
    m.extend_from_slice(purpose.as_bytes());
    m.extend_from_slice(
        &u32::try_from(payload.len())
            .map_err(|_| CryptoError::PayloadTooLarge)?
            .to_be_bytes(),
    );
    m.extend_from_slice(payload);
    Ok(m)
}
