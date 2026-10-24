//! `flagship/pq-session/v1`: a PQ-authenticated channel inside the box's TLS
//! connection (`docs/architecture-v2/pq-suites.md` §13). Draft, pending Q01
//! external cryptographic review. TypeScript twin:
//! `packages/protocol/src/pqSession.ts`.
//!
//! hello (initiator: bound key id, pinned responder key id, ephemeral X-Wing
//! key, nonce, time) → accept (encapsulation, nonce, time, the responder's
//! hybrid signature, a key confirmation MAC) → finish (the initiator's hybrid
//! signature and MAC). Records are AES-256-GCM, one key per direction, the
//! sequence number in the nonce; a response reuses its request's number.

use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{AeadInOut, KeyInit, Nonce, Tag};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha512};
use x_wing::{
    Ciphertext, DecapsulationKeyRejectNonContrib, Decapsulator, Encapsulate, KeyExport,
    TryDecapsulate,
};
use zeroize::{Zeroize, Zeroizing};

use crate::rng::BufRng;
use crate::seal::{ENC_LEN, HybridSealPublicKey, PUBLIC_KEY_LEN};
use crate::sig::SIGNATURE_LEN;
use crate::trust::{Role, VerifiedBinding};

pub const TAG_SESSION: &str = "flagship/pq-session/v1";
pub const TAG_HELLO: &str = "flagship/pq-session-hello/v1";
pub const TAG_ACCEPT: &str = "flagship/pq-session-accept/v1";
pub const TAG_FINISH: &str = "flagship/pq-session-finish/v1";
pub const TAG_KEYS: &str = "flagship/pq-session-keys/v1";
pub const TAG_RECORD: &str = "flagship/pq-session-record/v1";

pub const MAX_SKEW_MS: u64 = 5 * 60 * 1000;
pub const MAX_RECORD: usize = 16 * 1024 * 1024;
pub const REPLAY_WINDOW: u64 = 1024;
pub const IDLE_MS: u64 = 15 * 60 * 1000;
pub const MAX_LIFETIME_MS: u64 = 12 * 3600 * 1000;
pub const DIR_INITIATOR: u8 = 1;
pub const DIR_RESPONDER: u8 = 2;

const TAG_LEN: usize = 16;

/// Every refusal; `code()` matches the TypeScript port and the vectors.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionError {
    Malformed,
    Stale,
    ResponderMismatch,
    UnknownInitiator,
    BadPublicKey,
    BadSignature,
    ConfirmFailed,
    DecryptFailed,
    Replay,
    RecordTooLarge,
    Expired,
    Randomness,
}

impl SessionError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Malformed => "session-malformed",
            Self::Stale => "session-stale",
            Self::ResponderMismatch => "responder-mismatch",
            Self::UnknownInitiator => "unknown-initiator",
            Self::BadPublicKey => "bad-public-key",
            Self::BadSignature => "bad-signature",
            Self::ConfirmFailed => "confirm-failed",
            Self::DecryptFailed => "decrypt-failed",
            Self::Replay => "replay",
            Self::RecordTooLarge => "record-too-large",
            Self::Expired => "session-expired",
            Self::Randomness => "randomness",
        }
    }
}

impl core::fmt::Display for SessionError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for SessionError {}

fn subject_ok(s: &str) -> bool {
    let b = s.as_bytes();
    let Some((first, rest)) = b.split_first() else {
        return false;
    };
    b.len() <= 253
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && rest.iter().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b':' | b'@' | b'-')
        })
}

fn lp8(out: &mut Vec<u8>, v: &[u8]) -> Result<(), SessionError> {
    out.push(u8::try_from(v.len()).map_err(|_| SessionError::Malformed)?);
    out.extend_from_slice(v);
    Ok(())
}

fn sha512(parts: &[&[u8]]) -> [u8; 64] {
    let mut h = Sha512::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// Which initiator roles may open a session (the responder is a `box-stk`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InitiatorRole {
    Device,
    BoxStk,
}

impl InitiatorRole {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Device => "device",
            Self::BoxStk => "box-stk",
        }
    }

    /// # Errors
    /// [`SessionError::Malformed`] for any other role.
    pub fn parse(s: &str) -> Result<Self, SessionError> {
        match s {
            "device" => Ok(Self::Device),
            "box-stk" => Ok(Self::BoxStk),
            _ => Err(SessionError::Malformed),
        }
    }

    const fn role(self) -> Role {
        match self {
            Self::Device => Role::Device,
            Self::BoxStk => Role::BoxStk,
        }
    }
}

/// The hello as decoded from its wire (lengths already checked by the decoder).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hello {
    pub responder: String,
    pub initiator_role: InitiatorRole,
    pub initiator_subject: String,
    pub initiator_key_id: [u8; 32],
    pub responder_key_id: [u8; 32],
    pub ephemeral_pub: Vec<u8>,
    pub nonce: [u8; 32],
    pub issued_at: u64,
}

impl Hello {
    /// The canonical bytes whose SHA-512 opens the transcript.
    ///
    /// # Errors
    /// [`SessionError::Malformed`].
    pub fn to_bytes(&self) -> Result<Vec<u8>, SessionError> {
        if !subject_ok(&self.responder)
            || !subject_ok(&self.initiator_subject)
            || self.ephemeral_pub.len() != PUBLIC_KEY_LEN
            || self.issued_at > MAX_SAFE_INTEGER
        {
            return Err(SessionError::Malformed);
        }
        let mut out = Vec::with_capacity(1600);
        lp8(&mut out, TAG_HELLO.as_bytes())?;
        lp8(&mut out, self.responder.as_bytes())?;
        lp8(&mut out, self.initiator_role.as_str().as_bytes())?;
        lp8(&mut out, self.initiator_subject.as_bytes())?;
        out.extend_from_slice(&self.initiator_key_id);
        out.extend_from_slice(&self.responder_key_id);
        out.extend_from_slice(&self.ephemeral_pub);
        out.extend_from_slice(&self.nonce);
        out.extend_from_slice(&self.issued_at.to_be_bytes());
        Ok(out)
    }
}

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Accept {
    pub enc: Vec<u8>,
    pub nonce: [u8; 32],
    pub issued_at: u64,
    pub signature: Vec<u8>,
    pub confirm: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finish {
    pub signature: Vec<u8>,
    pub confirm: [u8; 32],
}

/// What the responder signs, in the v1 text form keyd's purpose check reads:
/// `flagship/pq-session-accept/v1|<responder>|<hex SHA-512(SHA-512(hello) || enc || nonce || time)>`.
#[must_use]
pub fn accept_tbs(
    hello_bytes: &[u8],
    responder: &str,
    enc: &[u8],
    nonce: &[u8; 32],
    issued_at: u64,
) -> Vec<u8> {
    let core = sha512(&[
        &sha512(&[hello_bytes]),
        enc,
        nonce,
        &issued_at.to_be_bytes(),
    ]);
    format!("{TAG_ACCEPT}|{responder}|{}", crate::trust::hex(&core)).into_bytes()
}

/// What the initiator signs.
#[must_use]
pub fn finish_tbs(
    tbs_a: &[u8],
    sig_r: &[u8],
    confirm_r: &[u8],
    initiator_subject: &str,
) -> Vec<u8> {
    let d = sha512(&[tbs_a, sig_r, confirm_r]);
    format!("{TAG_FINISH}|{initiator_subject}|{}", crate::trust::hex(&d)).into_bytes()
}

struct Prk(Hkdf<Sha512>);

impl Prk {
    fn new(ss: &[u8]) -> Self {
        Self(Hkdf::<Sha512>::new(Some(TAG_SESSION.as_bytes()), ss))
    }

    fn expand(&self, label: &str, th: &[u8]) -> Result<Zeroizing<[u8; 32]>, SessionError> {
        let mut info = Vec::with_capacity(128);
        lp8(&mut info, TAG_KEYS.as_bytes())?;
        lp8(&mut info, label.as_bytes())?;
        info.extend_from_slice(th);
        let mut out = Zeroizing::new([0u8; 32]);
        self.0
            .expand(&info, out.as_mut())
            .map_err(|_| SessionError::Malformed)?;
        Ok(out)
    }

    fn confirm(&self, label: &str, th: &[u8]) -> Result<[u8; 32], SessionError> {
        let k = self.expand(label, th)?;
        let mut mac = <Hmac<Sha512> as hmac::KeyInit>::new_from_slice(k.as_ref())
            .map_err(|_| SessionError::Malformed)?;
        mac.update(th);
        let full = mac.finalize().into_bytes();
        let mut out = [0u8; 32];
        out.copy_from_slice(full.get(..32).ok_or(SessionError::Malformed)?);
        Ok(out)
    }

    fn traffic(&self, th4: &[u8]) -> Result<Keys, SessionError> {
        Ok(Keys {
            session_id: *self.expand("session-id", th4)?,
            i2r: self.expand("initiator-to-responder", th4)?,
            r2i: self.expand("responder-to-initiator", th4)?,
        })
    }
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/// A signer for the identity's hybrid key (keyd, a test key).
pub type Signer<'a> = &'a dyn Fn(&str, &[u8]) -> Result<Vec<u8>, SessionError>;

/// The initiator between hello and accept.
pub struct Initiator {
    hello: Hello,
    hello_bytes: Vec<u8>,
    responder: VerifiedBinding,
    ephemeral: DecapsulationKeyRejectNonContrib,
}

impl core::fmt::Debug for Initiator {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Initiator")
            .field("hello", &self.hello)
            .finish_non_exhaustive()
    }
}

impl Initiator {
    /// Opens a session to `responder` (a box), as `identity`.
    ///
    /// # Errors
    /// [`SessionError::ResponderMismatch`], [`SessionError::UnknownInitiator`],
    /// [`SessionError::Randomness`].
    pub fn start(
        responder: &VerifiedBinding,
        role: InitiatorRole,
        identity: &VerifiedBinding,
        now: u64,
        fixed: Option<([u8; 32], [u8; 32])>,
    ) -> Result<Self, SessionError> {
        if responder.role() != Role::BoxStk || !subject_ok(responder.subject_id()) {
            return Err(SessionError::ResponderMismatch);
        }
        if identity.role() != role.role() {
            return Err(SessionError::UnknownInitiator);
        }
        let (mut seed, nonce) = match fixed {
            Some(f) => f,
            None => {
                let mut s = [0u8; 32];
                let mut n = [0u8; 32];
                getrandom::fill(&mut s).map_err(|_| SessionError::Randomness)?;
                getrandom::fill(&mut n).map_err(|_| SessionError::Randomness)?;
                (s, n)
            }
        };
        let ephemeral = DecapsulationKeyRejectNonContrib::from(seed);
        seed.zeroize();
        let hello = Hello {
            responder: responder.subject_id().to_owned(),
            initiator_role: role,
            initiator_subject: identity.subject_id().to_owned(),
            initiator_key_id: identity.hybrid_key().key_id(),
            responder_key_id: responder.hybrid_key().key_id(),
            ephemeral_pub: ephemeral.encapsulation_key().to_bytes().as_slice().to_vec(),
            nonce,
            issued_at: now,
        };
        let hello_bytes = hello.to_bytes()?;
        Ok(Self {
            hello,
            hello_bytes,
            responder: responder.clone(),
            ephemeral,
        })
    }

    #[must_use]
    pub const fn hello(&self) -> &Hello {
        &self.hello
    }

    /// Checks the accept and answers with the finish. Consumes the ephemeral key.
    ///
    /// # Errors
    /// [`SessionError::Malformed`], [`SessionError::Stale`],
    /// [`SessionError::BadSignature`], [`SessionError::ConfirmFailed`].
    pub fn finish(
        self,
        a: &Accept,
        now: u64,
        sign: Signer<'_>,
    ) -> Result<(Finish, Channel), SessionError> {
        if a.enc.len() != ENC_LEN
            || a.signature.len() != SIGNATURE_LEN
            || a.issued_at > MAX_SAFE_INTEGER
        {
            return Err(SessionError::Malformed);
        }
        if a.issued_at.abs_diff(now) > MAX_SKEW_MS {
            return Err(SessionError::Stale);
        }
        let tbs_a = accept_tbs(
            &self.hello_bytes,
            &self.hello.responder,
            &a.enc,
            &a.nonce,
            a.issued_at,
        );
        self.responder
            .hybrid_key()
            .verify(TAG_ACCEPT, &tbs_a, &a.signature)
            .map_err(|_| SessionError::BadSignature)?;
        let enc =
            Ciphertext::try_from(a.enc.as_slice()).map_err(|_| SessionError::ConfirmFailed)?;
        let mut ss = self
            .ephemeral
            .try_decapsulate(&enc)
            .map_err(|_| SessionError::ConfirmFailed)?;
        let prk = Prk::new(ss.as_slice());
        ss.zeroize();
        let th1 = sha512(&[&tbs_a, &a.signature]);
        if !ct_eq(&prk.confirm("responder-confirm", &th1)?, &a.confirm) {
            return Err(SessionError::ConfirmFailed);
        }
        let tbs_f = finish_tbs(
            &tbs_a,
            &a.signature,
            &a.confirm,
            &self.hello.initiator_subject,
        );
        let sig_i = sign(TAG_FINISH, &tbs_f)?;
        if sig_i.len() != SIGNATURE_LEN {
            return Err(SessionError::BadSignature);
        }
        let th3 = sha512(&[&tbs_f, &sig_i]);
        let confirm = prk.confirm("initiator-confirm", &th3)?;
        let keys = prk.traffic(&sha512(&[&tbs_f, &sig_i, &confirm]))?;
        Ok((
            Finish {
                signature: sig_i,
                confirm,
            },
            Channel::new(Side::Initiator, keys, now, self.responder),
        ))
    }
}

/// The responder between accept and finish.
pub struct Pending {
    initiator: VerifiedBinding,
    created_at: u64,
    tbs_f: Vec<u8>,
    prk: Prk,
}

impl core::fmt::Debug for Pending {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Pending")
            .field("created_at", &self.created_at)
            .finish_non_exhaustive()
    }
}

/// Finds the bound key the responder trusts for an initiator.
pub type Lookup<'a> = &'a dyn Fn(InitiatorRole, &str, &[u8; 32]) -> Option<VerifiedBinding>;

/// Answers a hello as `identity` (this box's STK binding).
///
/// # Errors
/// [`SessionError::ResponderMismatch`], [`SessionError::Stale`],
/// [`SessionError::UnknownInitiator`], [`SessionError::BadPublicKey`],
/// [`SessionError::Randomness`], or the signer's error.
pub fn accept(
    h: &Hello,
    identity: &VerifiedBinding,
    lookup: Lookup<'_>,
    now: u64,
    sign: Signer<'_>,
    fixed: Option<([u8; 64], [u8; 32])>,
) -> Result<(Accept, Pending), SessionError> {
    let hello_bytes = h.to_bytes()?;
    if identity.role() != Role::BoxStk || h.responder != identity.subject_id() {
        return Err(SessionError::ResponderMismatch);
    }
    if h.responder_key_id != identity.hybrid_key().key_id() {
        return Err(SessionError::ResponderMismatch);
    }
    if h.issued_at.abs_diff(now) > MAX_SKEW_MS {
        return Err(SessionError::Stale);
    }
    let initiator = lookup(h.initiator_role, &h.initiator_subject, &h.initiator_key_id)
        .filter(|b| {
            b.role() == h.initiator_role.role()
                && b.subject_id() == h.initiator_subject
                && b.hybrid_key().key_id() == h.initiator_key_id
        })
        .ok_or(SessionError::UnknownInitiator)?;
    let ek = HybridSealPublicKey::from_bytes(&h.ephemeral_pub)
        .map_err(|_| SessionError::BadPublicKey)?;
    let (eseed, nonce) = match fixed {
        Some(f) => f,
        None => {
            let mut e = [0u8; 64];
            let mut n = [0u8; 32];
            getrandom::fill(&mut e).map_err(|_| SessionError::Randomness)?;
            getrandom::fill(&mut n).map_err(|_| SessionError::Randomness)?;
            (e, n)
        }
    };
    let mut rng = BufRng::new(eseed);
    let (enc, mut ss) = ek.ek().encapsulate_with_rng(&mut rng);
    if !rng.exactly_consumed() {
        ss.zeroize();
        return Err(SessionError::Randomness);
    }
    drop(rng);
    let prk = Prk::new(ss.as_slice());
    ss.zeroize();
    let enc = enc.as_slice().to_vec();
    let tbs_a = accept_tbs(&hello_bytes, &h.responder, &enc, &nonce, now);
    let signature = sign(TAG_ACCEPT, &tbs_a)?;
    if signature.len() != SIGNATURE_LEN {
        return Err(SessionError::BadSignature);
    }
    let confirm = prk.confirm("responder-confirm", &sha512(&[&tbs_a, &signature]))?;
    let tbs_f = finish_tbs(&tbs_a, &signature, &confirm, &h.initiator_subject);
    Ok((
        Accept {
            enc,
            nonce,
            issued_at: now,
            signature,
            confirm,
        },
        Pending {
            initiator,
            created_at: now,
            tbs_f,
            prk,
        },
    ))
}

impl Pending {
    /// Checks the finish; consumes the pending state (single use).
    ///
    /// # Errors
    /// [`SessionError::Stale`], [`SessionError::Malformed`],
    /// [`SessionError::BadSignature`], [`SessionError::ConfirmFailed`].
    pub fn complete(self, f: &Finish, now: u64) -> Result<Channel, SessionError> {
        if now.abs_diff(self.created_at) > MAX_SKEW_MS {
            return Err(SessionError::Stale);
        }
        if f.signature.len() != SIGNATURE_LEN {
            return Err(SessionError::Malformed);
        }
        self.initiator
            .hybrid_key()
            .verify(TAG_FINISH, &self.tbs_f, &f.signature)
            .map_err(|_| SessionError::BadSignature)?;
        let th3 = sha512(&[&self.tbs_f, &f.signature]);
        if !ct_eq(&self.prk.confirm("initiator-confirm", &th3)?, &f.confirm) {
            return Err(SessionError::ConfirmFailed);
        }
        let keys = self
            .prk
            .traffic(&sha512(&[&self.tbs_f, &f.signature, &f.confirm]))?;
        Ok(Channel::new(Side::Responder, keys, now, self.initiator))
    }
}

struct Keys {
    session_id: [u8; 32],
    i2r: Zeroizing<[u8; 32]>,
    r2i: Zeroizing<[u8; 32]>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Initiator,
    Responder,
}

fn record_nonce(dir: u8, seq: u64) -> [u8; 12] {
    let s = seq.to_be_bytes();
    [0, 0, 0, dir, s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]
}

fn record_aad(session_id: &[u8; 32], dir: u8, seq: u64) -> Vec<u8> {
    let mut a = Vec::with_capacity(71);
    a.push(29);
    a.extend_from_slice(TAG_RECORD.as_bytes());
    a.extend_from_slice(session_id);
    a.push(dir);
    a.extend_from_slice(&seq.to_be_bytes());
    a
}

/// Seals one record: `u64be(seq) || ciphertext || tag`.
///
/// # Errors
/// [`SessionError::RecordTooLarge`] or [`SessionError::DecryptFailed`].
pub fn seal_record(
    key: &[u8; 32],
    session_id: &[u8; 32],
    dir: u8,
    seq: u64,
    plaintext: &[u8],
) -> Result<Vec<u8>, SessionError> {
    if plaintext.len() > MAX_RECORD {
        return Err(SessionError::RecordTooLarge);
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| SessionError::DecryptFailed)?;
    let mut buf = plaintext.to_vec();
    let tag = cipher
        .encrypt_inout_detached(
            &Nonce::<Aes256Gcm>::from(record_nonce(dir, seq)),
            &record_aad(session_id, dir, seq),
            buf.as_mut_slice().into(),
        )
        .map_err(|_| SessionError::RecordTooLarge)?;
    let mut out = Vec::with_capacity(buf.len().saturating_add(24));
    out.extend_from_slice(&seq.to_be_bytes());
    out.extend_from_slice(&buf);
    out.extend_from_slice(tag.as_slice());
    Ok(out)
}

/// Opens one record; returns its sequence number and plaintext.
///
/// # Errors
/// [`SessionError::DecryptFailed`] or [`SessionError::RecordTooLarge`].
pub fn open_record(
    key: &[u8; 32],
    session_id: &[u8; 32],
    dir: u8,
    record: &[u8],
) -> Result<(u64, Zeroizing<Vec<u8>>), SessionError> {
    let (seq, rest) = record
        .split_at_checked(8)
        .ok_or(SessionError::DecryptFailed)?;
    let ct_len = rest
        .len()
        .checked_sub(TAG_LEN)
        .ok_or(SessionError::DecryptFailed)?;
    if ct_len > MAX_RECORD {
        return Err(SessionError::RecordTooLarge);
    }
    let seq =
        u64::from_be_bytes(<[u8; 8]>::try_from(seq).map_err(|_| SessionError::DecryptFailed)?);
    if seq > MAX_SAFE_INTEGER {
        return Err(SessionError::DecryptFailed);
    }
    let (ct, tag) = rest
        .split_at_checked(ct_len)
        .ok_or(SessionError::DecryptFailed)?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| SessionError::DecryptFailed)?;
    let tag = Tag::<Aes256Gcm>::try_from(tag).map_err(|_| SessionError::DecryptFailed)?;
    let mut buf = Zeroizing::new(ct.to_vec());
    cipher
        .decrypt_inout_detached(
            &Nonce::<Aes256Gcm>::from(record_nonce(dir, seq)),
            &record_aad(session_id, dir, seq),
            buf.as_mut_slice().into(),
            &tag,
        )
        .map_err(|_| SessionError::DecryptFailed)?;
    Ok((seq, buf))
}

/// One established session.
pub struct Channel {
    side: Side,
    keys: Keys,
    established_at: u64,
    last_used: u64,
    next_seq: u64,
    max_seen: Option<u64>,
    seen: std::collections::BTreeSet<u64>,
    peer: VerifiedBinding,
}

impl core::fmt::Debug for Channel {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Channel")
            .field("side", &self.side)
            .finish_non_exhaustive()
    }
}

impl Channel {
    fn new(side: Side, keys: Keys, now: u64, peer: VerifiedBinding) -> Self {
        Self {
            side,
            keys,
            established_at: now,
            last_used: now,
            next_seq: 0,
            max_seen: None,
            seen: std::collections::BTreeSet::new(),
            peer,
        }
    }

    #[must_use]
    pub const fn session_id(&self) -> &[u8; 32] {
        &self.keys.session_id
    }

    #[must_use]
    pub const fn peer(&self) -> &VerifiedBinding {
        &self.peer
    }

    #[must_use]
    pub const fn expired(&self, now: u64) -> bool {
        now.saturating_sub(self.last_used) > IDLE_MS
            || now.saturating_sub(self.established_at) > MAX_LIFETIME_MS
    }

    fn live(&mut self, now: u64) -> Result<(), SessionError> {
        if self.expired(now) {
            return Err(SessionError::Expired);
        }
        self.last_used = now;
        Ok(())
    }

    /// # Errors
    /// [`SessionError::Malformed`] on the responder, or a record error.
    pub fn seal_request(
        &mut self,
        plaintext: &[u8],
        now: u64,
    ) -> Result<(u64, Vec<u8>), SessionError> {
        if self.side != Side::Initiator {
            return Err(SessionError::Malformed);
        }
        self.live(now)?;
        let seq = self.next_seq;
        self.next_seq = seq.checked_add(1).ok_or(SessionError::Expired)?;
        let r = seal_record(
            &self.keys.i2r,
            &self.keys.session_id,
            DIR_INITIATOR,
            seq,
            plaintext,
        )?;
        Ok((seq, r))
    }

    /// # Errors
    /// [`SessionError::Replay`] when the answer is for another request.
    pub fn open_response(
        &self,
        seq: u64,
        record: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, SessionError> {
        if self.side != Side::Initiator {
            return Err(SessionError::Malformed);
        }
        let (got, pt) = open_record(&self.keys.r2i, &self.keys.session_id, DIR_RESPONDER, record)?;
        if got != seq {
            return Err(SessionError::Replay);
        }
        Ok(pt)
    }

    /// # Errors
    /// [`SessionError::Replay`] for a repeated or too old number, or a record error.
    pub fn open_request(
        &mut self,
        record: &[u8],
        now: u64,
    ) -> Result<(u64, Zeroizing<Vec<u8>>), SessionError> {
        if self.side != Side::Responder {
            return Err(SessionError::Malformed);
        }
        self.live(now)?;
        let (seq, pt) = open_record(&self.keys.i2r, &self.keys.session_id, DIR_INITIATOR, record)?;
        let too_old = self
            .max_seen
            .is_some_and(|m| seq.saturating_add(REPLAY_WINDOW) <= m);
        if self.seen.contains(&seq) || too_old {
            return Err(SessionError::Replay);
        }
        self.seen.insert(seq);
        if self.max_seen.is_none_or(|m| seq > m) {
            self.max_seen = Some(seq);
            if let Some(floor) = seq.checked_sub(REPLAY_WINDOW) {
                self.seen = self.seen.split_off(&floor.saturating_add(1));
            }
        }
        Ok((seq, pt))
    }

    /// # Errors
    /// A record error.
    pub fn seal_response(&self, seq: u64, plaintext: &[u8]) -> Result<Vec<u8>, SessionError> {
        if self.side != Side::Responder {
            return Err(SessionError::Malformed);
        }
        seal_record(
            &self.keys.r2i,
            &self.keys.session_id,
            DIR_RESPONDER,
            seq,
            plaintext,
        )
    }
}
