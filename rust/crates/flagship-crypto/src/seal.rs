//! `flagship/hybrid-seal/v1`: X-Wing (draft-connolly-cfrg-xwing-kem-11)
//! encapsulation to the recipient, HKDF-SHA-512 over the X-Wing secret and the
//! full transcript, AES-256-GCM over the payload. One encapsulation per
//! message, so each AES key encrypts exactly one plaintext.
//!
//! Wire: `header || enc (1120) || ciphertext || tag (16)` where the header is
//! a `flagship/envelope/v2` header with suite 0x0001, the recipient's key id
//! and `body_len = 1120 + len(plaintext) + 16`. Not sender-authenticated:
//! the sender key id is bound, not proven.

use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{AeadInOut, KeyInit, Nonce, Tag};
use flagship_protocol::envelope::KEY_ID_LEN;
use flagship_protocol::parse::{TagNamespace, validate_purpose_tag};
use flagship_protocol::{EnvelopeHeader, ProtocolError, SuiteId};
use hkdf::Hkdf;
use sha2::Sha512;
use x_wing::{
    Ciphertext, DecapsulationKeyRejectNonContrib, Decapsulator, Encapsulate, EncapsulationKey,
    KeyExport, TryDecapsulate,
};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

use crate::error::CryptoError;
use crate::key_id::key_id;
use crate::rng::BufRng;

pub const PUBLIC_KEY_LEN: usize = 1216;
pub const SECRET_KEY_LEN: usize = 32;
pub const ENC_LEN: usize = 1120;
pub const TAG_LEN: usize = 16;
pub const ENCAPSULATION_RANDOMNESS_LEN: usize = 64;
pub const MAX_PLAINTEXT_LEN: usize = 1_048_576;
pub const MAX_CONTEXT_FIELDS: usize = 16;
pub const MAX_CONTEXT_FIELD_LEN: usize = 1024;

const SUITE: SuiteId = SuiteId::HybridSealV1;
const ML_KEM_PK_LEN: usize = 1184;
const X25519_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const AES_KEY_LEN: usize = 32;
const OKM_LEN: usize = 44;

/// A recipient's X-Wing encapsulation key, validated at parse time.
#[derive(Clone, Debug)]
pub struct HybridSealPublicKey {
    bytes: Vec<u8>,
    ek: EncapsulationKey,
    id: [u8; KEY_ID_LEN],
}

impl HybridSealPublicKey {
    /// Parses a 1216-byte X-Wing encapsulation key. Refuses an ML-KEM key that
    /// fails the FIPS 203 §7.2 modulus check and an X25519 key in the
    /// small-order subgroup (its shared secret would be all zero).
    ///
    /// # Errors
    /// [`CryptoError::BadPublicKey`].
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CryptoError> {
        if bytes.len() != PUBLIC_KEY_LEN {
            return Err(CryptoError::BadPublicKey);
        }
        let x = bytes
            .get(ML_KEM_PK_LEN..)
            .and_then(|s| <[u8; X25519_LEN]>::try_from(s).ok())
            .ok_or(CryptoError::BadPublicKey)?;
        if !x25519_contributory(&x) {
            return Err(CryptoError::BadPublicKey);
        }
        let ek = EncapsulationKey::try_from(bytes).map_err(|_| CryptoError::BadPublicKey)?;
        Ok(Self {
            bytes: bytes.to_vec(),
            ek,
            id: key_id(SUITE, bytes),
        })
    }

    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    #[must_use]
    pub const fn key_id(&self) -> [u8; KEY_ID_LEN] {
        self.id
    }
}

// A clamped scalar is a multiple of 8 and below 8 * l, so X25519 with it
// returns zero exactly when the point lies in the small-order subgroup.
fn x25519_contributory(point: &[u8; X25519_LEN]) -> bool {
    let probe = StaticSecret::from([0x5a; X25519_LEN]);
    probe
        .diffie_hellman(&PublicKey::from(*point))
        .was_contributory()
}

/// A recipient's X-Wing decapsulation key (the 32-byte seed).
pub struct HybridSealSecretKey {
    dk: DecapsulationKeyRejectNonContrib,
    public: HybridSealPublicKey,
}

impl core::fmt::Debug for HybridSealSecretKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("HybridSealSecretKey")
            .field("key_id", &self.public.id)
            .finish_non_exhaustive()
    }
}

impl HybridSealSecretKey {
    /// Expands a 32-byte X-Wing decapsulation seed.
    ///
    /// # Errors
    /// [`CryptoError::BadSecretKey`] if the derived public key fails validation.
    pub fn from_seed(seed: &[u8; SECRET_KEY_LEN]) -> Result<Self, CryptoError> {
        let dk = DecapsulationKeyRejectNonContrib::from(*seed);
        let pk = dk.encapsulation_key().to_bytes();
        let public = HybridSealPublicKey::from_bytes(&pk).map_err(|_| CryptoError::BadSecretKey)?;
        Ok(Self { dk, public })
    }

    /// A new key from the operating system's RNG.
    ///
    /// # Errors
    /// [`CryptoError::Randomness`] or [`CryptoError::BadSecretKey`].
    pub fn generate() -> Result<Self, CryptoError> {
        let mut seed = Zeroizing::new([0u8; SECRET_KEY_LEN]);
        getrandom::fill(seed.as_mut()).map_err(|_| CryptoError::Randomness)?;
        Self::from_seed(&seed)
    }

    #[must_use]
    pub const fn public_key(&self) -> &HybridSealPublicKey {
        &self.public
    }

    /// The 32-byte seed, for storage under the custody service's wrapping.
    #[must_use]
    pub fn to_seed(&self) -> Zeroizing<[u8; SECRET_KEY_LEN]> {
        let mut out = Zeroizing::new([0u8; SECRET_KEY_LEN]);
        let mut k = self.dk.to_bytes();
        out.copy_from_slice(k.as_slice());
        k.zeroize();
        out
    }
}

/// Header fields the sender chooses. Suite, recipient key id and body
/// length are filled in by [`seal`].
#[derive(Clone, Debug)]
pub struct SealOptions<'a> {
    pub purpose: &'a str,
    pub sender_key_id: [u8; KEY_ID_LEN],
    pub issued_at: u64,
    pub expires_at: Option<u64>,
    pub installation_id: Option<[u8; 16]>,
    pub authority_generation: Option<u64>,
    pub session_nonce: Option<[u8; 32]>,
    pub policy_digest: Option<[u8; 64]>,
}

/// An opened seal: the authenticated header and the plaintext.
pub struct Opened {
    pub header: EnvelopeHeader,
    pub plaintext: Zeroizing<Vec<u8>>,
}

impl core::fmt::Debug for Opened {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Opened")
            .field("header", &self.header)
            .field("plaintext_len", &self.plaintext.len())
            .finish()
    }
}

/// Seals `plaintext` to `recipient` with fresh OS randomness.
///
/// # Errors
/// [`CryptoError::BadPurpose`], [`CryptoError::ContextTooLarge`],
/// [`CryptoError::PlaintextTooLarge`], header errors, or
/// [`CryptoError::Randomness`].
pub fn seal(
    recipient: &HybridSealPublicKey,
    opts: &SealOptions<'_>,
    context: &[&[u8]],
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let rng =
        BufRng::<ENCAPSULATION_RANDOMNESS_LEN>::from_os().map_err(|_| CryptoError::Randomness)?;
    seal_inner(recipient, opts, context, plaintext, rng)
}

/// [`seal`] with caller-supplied encapsulation randomness (`eseed`, laid out
/// as in the X-Wing draft: ML-KEM coins then the X25519 ephemeral secret).
/// Exists for the cross-language vectors; reusing an `eseed` reuses the AES
/// key and nonce, which destroys confidentiality and integrity.
///
/// # Errors
/// As [`seal`].
#[doc(hidden)]
pub fn seal_with_randomness(
    recipient: &HybridSealPublicKey,
    opts: &SealOptions<'_>,
    context: &[&[u8]],
    plaintext: &[u8],
    eseed: &[u8; ENCAPSULATION_RANDOMNESS_LEN],
) -> Result<Vec<u8>, CryptoError> {
    seal_inner(recipient, opts, context, plaintext, BufRng::new(*eseed))
}

fn check_inputs(purpose: &str, context: &[&[u8]]) -> Result<(), CryptoError> {
    validate_purpose_tag(purpose, TagNamespace::Flagship).map_err(|_| CryptoError::BadPurpose)?;
    if context.len() > MAX_CONTEXT_FIELDS || context.iter().any(|c| c.len() > MAX_CONTEXT_FIELD_LEN)
    {
        return Err(CryptoError::ContextTooLarge);
    }
    Ok(())
}

fn seal_inner(
    recipient: &HybridSealPublicKey,
    opts: &SealOptions<'_>,
    context: &[&[u8]],
    plaintext: &[u8],
    mut rng: BufRng<ENCAPSULATION_RANDOMNESS_LEN>,
) -> Result<Vec<u8>, CryptoError> {
    check_inputs(opts.purpose, context)?;
    if plaintext.len() > MAX_PLAINTEXT_LEN {
        return Err(CryptoError::PlaintextTooLarge);
    }
    let body_len = ENC_LEN
        .checked_add(plaintext.len())
        .and_then(|n| n.checked_add(TAG_LEN))
        .and_then(|n| u32::try_from(n).ok())
        .ok_or(CryptoError::PlaintextTooLarge)?;
    let header = EnvelopeHeader {
        purpose: String::from(opts.purpose),
        suite: SUITE,
        sender_key_id: opts.sender_key_id,
        recipient_key_id: Some(recipient.id),
        installation_id: opts.installation_id,
        authority_generation: opts.authority_generation,
        session_nonce: opts.session_nonce,
        policy_digest: opts.policy_digest,
        issued_at: opts.issued_at,
        expires_at: opts.expires_at,
        body_len,
    };
    let header_bytes = header.encode()?;

    let (enc, mut ss) = recipient.ek.encapsulate_with_rng(&mut rng);
    if !rng.exactly_consumed() {
        ss.zeroize();
        return Err(CryptoError::Randomness);
    }
    drop(rng);
    let derived = derive(&ss, &header_bytes, &header, context, enc.as_slice());
    ss.zeroize();
    let (key, nonce) = derived?;

    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| CryptoError::DecryptFailed)?;
    let aad = concat(&header_bytes, enc.as_slice());
    let mut buf = plaintext.to_vec();
    let tag = cipher
        .encrypt_inout_detached(
            &Nonce::<Aes256Gcm>::from(nonce),
            &aad,
            buf.as_mut_slice().into(),
        )
        .map_err(|_| CryptoError::PlaintextTooLarge)?;

    let mut out = Vec::with_capacity(
        header_bytes
            .len()
            .saturating_add(usize::try_from(body_len).unwrap_or(0)),
    );
    out.extend_from_slice(&header_bytes);
    out.extend_from_slice(enc.as_slice());
    out.extend_from_slice(&buf);
    out.extend_from_slice(tag.as_slice());
    Ok(out)
}

/// Opens a seal addressed to `recipient` for `expected_purpose`, binding the
/// same caller `context` the sender used. Header-level refusals name their
/// cause; every failure after the header (decapsulation, wrong context, any
/// tampering) is the single [`CryptoError::DecryptFailed`].
///
/// # Errors
/// See above.
pub fn open(
    recipient: &HybridSealSecretKey,
    expected_purpose: &str,
    context: &[&[u8]],
    sealed: &[u8],
) -> Result<Opened, CryptoError> {
    check_inputs(expected_purpose, context)?;
    let (header, header_bytes, body) = EnvelopeHeader::decode_envelope(sealed)?;
    if header.suite != SUITE {
        return Err(CryptoError::SuiteMismatch);
    }
    if header.purpose != expected_purpose {
        return Err(CryptoError::PurposeMismatch);
    }
    if header.recipient_key_id != Some(recipient.public.id) {
        return Err(CryptoError::RecipientMismatch);
    }
    let (enc, rest) = body
        .split_at_checked(ENC_LEN)
        .ok_or(CryptoError::Protocol(ProtocolError::BodyLength))?;
    let ct_len = rest
        .len()
        .checked_sub(TAG_LEN)
        .ok_or(CryptoError::Protocol(ProtocolError::BodyLength))?;
    if ct_len > MAX_PLAINTEXT_LEN {
        return Err(CryptoError::PlaintextTooLarge);
    }
    let (ct, tag) = rest
        .split_at_checked(ct_len)
        .ok_or(CryptoError::Protocol(ProtocolError::BodyLength))?;

    let enc_arr = Ciphertext::try_from(enc).map_err(|_| CryptoError::DecryptFailed)?;
    let mut ss = recipient
        .dk
        .try_decapsulate(&enc_arr)
        .map_err(|_| CryptoError::DecryptFailed)?;
    let derived = derive(&ss, header_bytes, &header, context, enc);
    ss.zeroize();
    let (key, nonce) = derived?;

    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| CryptoError::DecryptFailed)?;
    let tag = Tag::<Aes256Gcm>::try_from(tag).map_err(|_| CryptoError::DecryptFailed)?;
    let aad = concat(header_bytes, enc);
    let mut buf = Zeroizing::new(ct.to_vec());
    cipher
        .decrypt_inout_detached(
            &Nonce::<Aes256Gcm>::from(nonce),
            &aad,
            buf.as_mut_slice().into(),
            &tag,
        )
        .map_err(|_| CryptoError::DecryptFailed)?;
    Ok(Opened {
        header,
        plaintext: buf,
    })
}

fn concat(a: &[u8], b: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(a.len().saturating_add(b.len()));
    v.extend_from_slice(a);
    v.extend_from_slice(b);
    v
}

fn lp8(out: &mut Vec<u8>, v: &[u8]) {
    out.push(u8::try_from(v.len()).unwrap_or(u8::MAX));
    out.extend_from_slice(v);
}

/// `info = lp8(suite tag) || u16be(suite id) || lp8(purpose) || sender key id
/// || recipient key id || u32be(len header) || header || u8(n) || (u16be len
/// || field)^n || enc`. Every length here is bounded by the checks above.
pub(crate) fn kdf_info(
    header_bytes: &[u8],
    header: &EnvelopeHeader,
    context: &[&[u8]],
    enc: &[u8],
) -> Vec<u8> {
    let mut info = Vec::with_capacity(2048);
    lp8(&mut info, SUITE.tag().as_bytes());
    info.extend_from_slice(&SUITE.id().to_be_bytes());
    lp8(&mut info, header.purpose.as_bytes());
    info.extend_from_slice(&header.sender_key_id);
    info.extend_from_slice(&header.recipient_key_id.unwrap_or([0; KEY_ID_LEN]));
    info.extend_from_slice(
        &u32::try_from(header_bytes.len())
            .unwrap_or(u32::MAX)
            .to_be_bytes(),
    );
    info.extend_from_slice(header_bytes);
    info.push(u8::try_from(context.len()).unwrap_or(u8::MAX));
    for c in context {
        info.extend_from_slice(&u16::try_from(c.len()).unwrap_or(u16::MAX).to_be_bytes());
        info.extend_from_slice(c);
    }
    info.extend_from_slice(enc);
    info
}

fn derive(
    ss: &[u8],
    header_bytes: &[u8],
    header: &EnvelopeHeader,
    context: &[&[u8]],
    enc: &[u8],
) -> Result<(Zeroizing<[u8; AES_KEY_LEN]>, [u8; NONCE_LEN]), CryptoError> {
    let info = kdf_info(header_bytes, header, context, enc);
    let hk = Hkdf::<Sha512>::new(Some(SUITE.tag().as_bytes()), ss);
    let mut okm = Zeroizing::new([0u8; OKM_LEN]);
    hk.expand(&info, okm.as_mut())
        .map_err(|_| CryptoError::DecryptFailed)?;
    let mut key = Zeroizing::new([0u8; AES_KEY_LEN]);
    let mut nonce = [0u8; NONCE_LEN];
    let (k, n) = okm.split_at(AES_KEY_LEN);
    key.copy_from_slice(k);
    nonce.copy_from_slice(n);
    Ok((key, nonce))
}
