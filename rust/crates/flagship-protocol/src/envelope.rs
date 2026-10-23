//! The v2 envelope header (`flagship/envelope/v2`): a typed, versioned,
//! deterministic binary header that binds a message's purpose, suite, key ids
//! and context. See `docs/architecture-v2/pq-suites.md` §3.
//!
//! Wire form: `0x14 "flagship/envelope/v2" || u16be tlv_len || TLV*`, each
//! TLV `u8 type || u16be len || value`. Types appear in strictly ascending
//! order, at most once; any type not in the table below is refused (there is
//! no extension range: a new field needs a new header tag). Optional fields
//! are absent, never empty. Decoding re-encodes and compares, so exactly one
//! byte string exists for each header.

use crate::error::ProtocolError;
use crate::parse::{MAX_PURPOSE_LEN, MAX_SAFE_INTEGER, TagNamespace, validate_purpose_tag};
use crate::suite::SuiteId;

/// Header tag, written length-prefixed at the start of every v2 envelope.
pub const ENVELOPE_V2_TAG: &str = "flagship/envelope/v2";
/// Largest encoded header, magic and length included.
pub const MAX_HEADER_LEN: usize = 1024;
/// Largest body any v2 envelope may declare: 1 MiB of payload plus 4 KiB of suite overhead.
pub const MAX_BODY_LEN: u32 = 1_048_576 + 4096;
/// Key ids are 32 bytes everywhere.
pub const KEY_ID_LEN: usize = 32;
/// Installation ids are 16 bytes.
pub const INSTALLATION_ID_LEN: usize = 16;
/// Session nonces are 32 bytes.
pub const SESSION_NONCE_LEN: usize = 32;
/// Policy digests are SHA-512 outputs.
pub const POLICY_DIGEST_LEN: usize = 64;

const T_PURPOSE: u8 = 0x01;
const T_SUITE: u8 = 0x02;
const T_SENDER: u8 = 0x03;
const T_RECIPIENT: u8 = 0x04;
const T_INSTALLATION: u8 = 0x05;
const T_GENERATION: u8 = 0x06;
const T_SESSION: u8 = 0x07;
const T_POLICY: u8 = 0x08;
const T_ISSUED: u8 = 0x09;
const T_EXPIRES: u8 = 0x0a;
const T_BODY_LEN: u8 = 0x0b;

/// A decoded, validated v2 envelope header.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvelopeHeader {
    pub purpose: String,
    pub suite: SuiteId,
    pub sender_key_id: [u8; KEY_ID_LEN],
    pub recipient_key_id: Option<[u8; KEY_ID_LEN]>,
    pub installation_id: Option<[u8; INSTALLATION_ID_LEN]>,
    pub authority_generation: Option<u64>,
    pub session_nonce: Option<[u8; SESSION_NONCE_LEN]>,
    pub policy_digest: Option<[u8; POLICY_DIGEST_LEN]>,
    pub issued_at: u64,
    pub expires_at: Option<u64>,
    pub body_len: u32,
}

impl EnvelopeHeader {
    /// Semantic checks shared by encode and decode.
    ///
    /// # Errors
    /// [`ProtocolError::HeaderFieldLength`] for an empty or over-long purpose,
    /// [`ProtocolError::HeaderBadValue`] for a bad purpose, an integer above
    /// `MAX_SAFE_INTEGER`, `expires_at <= issued_at` or an over-large body,
    /// [`ProtocolError::HeaderMissingField`] for a seal without a recipient.
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.purpose.is_empty() || self.purpose.len() > MAX_PURPOSE_LEN {
            return Err(ProtocolError::HeaderFieldLength);
        }
        validate_purpose_tag(&self.purpose, TagNamespace::Flagship)
            .map_err(|_| ProtocolError::HeaderBadValue)?;
        let ints = [
            Some(self.issued_at),
            self.expires_at,
            self.authority_generation,
        ];
        if ints.iter().flatten().any(|v| *v > MAX_SAFE_INTEGER) {
            return Err(ProtocolError::HeaderBadValue);
        }
        if let Some(exp) = self.expires_at
            && exp <= self.issued_at
        {
            return Err(ProtocolError::HeaderBadValue);
        }
        if self.body_len > MAX_BODY_LEN {
            return Err(ProtocolError::HeaderBadValue);
        }
        if self.suite == SuiteId::HybridSealV1 && self.recipient_key_id.is_none() {
            return Err(ProtocolError::HeaderMissingField);
        }
        Ok(())
    }

    /// The canonical encoding.
    ///
    /// # Errors
    /// Any [`EnvelopeHeader::validate`] error, or
    /// [`ProtocolError::HeaderTooLarge`].
    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        self.validate()?;
        let mut tlv = Vec::with_capacity(256);
        put(&mut tlv, T_PURPOSE, self.purpose.as_bytes())?;
        put(&mut tlv, T_SUITE, &self.suite.id().to_be_bytes())?;
        put(&mut tlv, T_SENDER, &self.sender_key_id)?;
        if let Some(v) = &self.recipient_key_id {
            put(&mut tlv, T_RECIPIENT, v)?;
        }
        if let Some(v) = &self.installation_id {
            put(&mut tlv, T_INSTALLATION, v)?;
        }
        if let Some(v) = self.authority_generation {
            put(&mut tlv, T_GENERATION, &v.to_be_bytes())?;
        }
        if let Some(v) = &self.session_nonce {
            put(&mut tlv, T_SESSION, v)?;
        }
        if let Some(v) = &self.policy_digest {
            put(&mut tlv, T_POLICY, v)?;
        }
        put(&mut tlv, T_ISSUED, &self.issued_at.to_be_bytes())?;
        if let Some(v) = self.expires_at {
            put(&mut tlv, T_EXPIRES, &v.to_be_bytes())?;
        }
        put(&mut tlv, T_BODY_LEN, &self.body_len.to_be_bytes())?;

        let tlv_len = u16::try_from(tlv.len()).map_err(|_| ProtocolError::HeaderTooLarge)?;
        let mut out = Vec::with_capacity(MAX_HEADER_LEN);
        out.extend_from_slice(&magic());
        out.extend_from_slice(&tlv_len.to_be_bytes());
        out.extend_from_slice(&tlv);
        if out.len() > MAX_HEADER_LEN {
            return Err(ProtocolError::HeaderTooLarge);
        }
        Ok(out)
    }

    /// Decodes a header at the start of `bytes`; returns it and its encoded length.
    ///
    /// # Errors
    /// Every `Header*` error; see the module docs for the check order.
    pub fn decode_prefix(bytes: &[u8]) -> Result<(Self, usize), ProtocolError> {
        let m = magic();
        let mut r = Reader::new(bytes);
        let head = r.take(m.len())?;
        if head != m.as_slice() {
            return Err(ProtocolError::HeaderBadMagic);
        }
        let tlv_len = usize::from(r.u16()?);
        let total = m
            .len()
            .checked_add(2)
            .and_then(|x| x.checked_add(tlv_len))
            .ok_or(ProtocolError::HeaderTooLarge)?;
        if total > MAX_HEADER_LEN {
            return Err(ProtocolError::HeaderTooLarge);
        }
        let mut t = Reader::new(r.take(tlv_len)?);

        let mut b = Builder::default();
        let mut prev: u8 = 0;
        while !t.is_empty() {
            let ty = t.u8()?;
            let len = usize::from(t.u16()?);
            let value = t.take(len)?;
            if !(T_PURPOSE..=T_BODY_LEN).contains(&ty) {
                return Err(ProtocolError::HeaderUnknownField);
            }
            if ty == prev {
                return Err(ProtocolError::HeaderDuplicateField);
            }
            if ty < prev {
                return Err(ProtocolError::HeaderFieldOrder);
            }
            prev = ty;
            b.set(ty, value)?;
        }
        let header = b.finish()?;
        header.validate()?;
        if bytes.get(..total) != Some(header.encode()?.as_slice()) {
            return Err(ProtocolError::HeaderBadValue);
        }
        Ok((header, total))
    }

    /// Decodes `header || body` and requires the body to be exactly `body_len` bytes.
    ///
    /// # Errors
    /// Every `Header*` error, or [`ProtocolError::BodyLength`].
    pub fn decode_envelope(bytes: &[u8]) -> Result<(Self, &[u8], &[u8]), ProtocolError> {
        let (header, used) = Self::decode_prefix(bytes)?;
        let (head, body) = bytes
            .split_at_checked(used)
            .ok_or(ProtocolError::HeaderTruncated)?;
        let want = usize::try_from(header.body_len).map_err(|_| ProtocolError::BodyLength)?;
        if body.len() != want {
            return Err(ProtocolError::BodyLength);
        }
        Ok((header, head, body))
    }
}

fn magic() -> Vec<u8> {
    let mut m = Vec::with_capacity(ENVELOPE_V2_TAG.len().saturating_add(1));
    m.push(u8::try_from(ENVELOPE_V2_TAG.len()).unwrap_or(0));
    m.extend_from_slice(ENVELOPE_V2_TAG.as_bytes());
    m
}

fn put(out: &mut Vec<u8>, ty: u8, value: &[u8]) -> Result<(), ProtocolError> {
    let len = u16::try_from(value.len()).map_err(|_| ProtocolError::HeaderTooLarge)?;
    out.push(ty);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(value);
    Ok(())
}

struct Reader<'a> {
    rest: &'a [u8],
}

impl<'a> Reader<'a> {
    const fn new(rest: &'a [u8]) -> Self {
        Self { rest }
    }

    const fn is_empty(&self) -> bool {
        self.rest.is_empty()
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], ProtocolError> {
        let (a, b) = self
            .rest
            .split_at_checked(n)
            .ok_or(ProtocolError::HeaderTruncated)?;
        self.rest = b;
        Ok(a)
    }

    fn u8(&mut self) -> Result<u8, ProtocolError> {
        let [v] = fixed::<1>(self.take(1)?)?;
        Ok(v)
    }

    fn u16(&mut self) -> Result<u16, ProtocolError> {
        Ok(u16::from_be_bytes(fixed(self.take(2)?)?))
    }
}

fn fixed<const N: usize>(v: &[u8]) -> Result<[u8; N], ProtocolError> {
    <[u8; N]>::try_from(v).map_err(|_| ProtocolError::HeaderFieldLength)
}

#[derive(Default)]
struct Builder {
    purpose: Option<String>,
    suite: Option<SuiteId>,
    sender: Option<[u8; KEY_ID_LEN]>,
    recipient: Option<[u8; KEY_ID_LEN]>,
    installation: Option<[u8; INSTALLATION_ID_LEN]>,
    generation: Option<u64>,
    session: Option<[u8; SESSION_NONCE_LEN]>,
    policy: Option<[u8; POLICY_DIGEST_LEN]>,
    issued: Option<u64>,
    expires: Option<u64>,
    body_len: Option<u32>,
}

impl Builder {
    fn set(&mut self, ty: u8, v: &[u8]) -> Result<(), ProtocolError> {
        match ty {
            T_PURPOSE => {
                if v.is_empty() || v.len() > MAX_PURPOSE_LEN {
                    return Err(ProtocolError::HeaderFieldLength);
                }
                let s = core::str::from_utf8(v).map_err(|_| ProtocolError::HeaderBadValue)?;
                self.purpose = Some(String::from(s));
            }
            T_SUITE => {
                let id = u16::from_be_bytes(fixed(v)?);
                self.suite = Some(SuiteId::from_id(id).map_err(|_| ProtocolError::HeaderBadValue)?);
            }
            T_SENDER => self.sender = Some(fixed(v)?),
            T_RECIPIENT => self.recipient = Some(fixed(v)?),
            T_INSTALLATION => self.installation = Some(fixed(v)?),
            T_GENERATION => self.generation = Some(u64::from_be_bytes(fixed(v)?)),
            T_SESSION => self.session = Some(fixed(v)?),
            T_POLICY => self.policy = Some(fixed(v)?),
            T_ISSUED => self.issued = Some(u64::from_be_bytes(fixed(v)?)),
            T_EXPIRES => self.expires = Some(u64::from_be_bytes(fixed(v)?)),
            T_BODY_LEN => self.body_len = Some(u32::from_be_bytes(fixed(v)?)),
            _ => return Err(ProtocolError::HeaderUnknownField),
        }
        Ok(())
    }

    fn finish(self) -> Result<EnvelopeHeader, ProtocolError> {
        let missing = ProtocolError::HeaderMissingField;
        Ok(EnvelopeHeader {
            purpose: self.purpose.ok_or(missing)?,
            suite: self.suite.ok_or(missing)?,
            sender_key_id: self.sender.ok_or(missing)?,
            recipient_key_id: self.recipient,
            installation_id: self.installation,
            authority_generation: self.generation,
            session_nonce: self.session,
            policy_digest: self.policy,
            issued_at: self.issued.ok_or(missing)?,
            expires_at: self.expires,
            body_len: self.body_len.ok_or(missing)?,
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn sample() -> EnvelopeHeader {
        EnvelopeHeader {
            purpose: String::from("flagship/boot-unlock-response/v2"),
            suite: SuiteId::HybridSealV1,
            sender_key_id: [1; 32],
            recipient_key_id: Some([2; 32]),
            installation_id: Some([3; 16]),
            authority_generation: Some(7),
            session_nonce: Some([4; 32]),
            policy_digest: None,
            issued_at: 1_760_000_000_000,
            expires_at: Some(1_760_000_060_000),
            body_len: 1136,
        }
    }

    #[test]
    fn round_trip_is_canonical() {
        let h = sample();
        let enc = h.encode().unwrap();
        let (d, used) = EnvelopeHeader::decode_prefix(&enc).unwrap();
        assert_eq!(d, h);
        assert_eq!(used, enc.len());
        assert_eq!(enc[0], 20);
        assert_eq!(&enc[1..21], ENVELOPE_V2_TAG.as_bytes());
    }

    #[test]
    fn refusals() {
        let enc = sample().encode().unwrap();
        let mut bad = enc.clone();
        bad[1] = b'F';
        assert_eq!(
            EnvelopeHeader::decode_prefix(&bad),
            Err(ProtocolError::HeaderBadMagic)
        );
        assert_eq!(
            EnvelopeHeader::decode_prefix(&enc[..enc.len() - 1]),
            Err(ProtocolError::HeaderTruncated)
        );
        let mut no_recipient = sample();
        no_recipient.recipient_key_id = None;
        assert_eq!(
            no_recipient.encode(),
            Err(ProtocolError::HeaderMissingField)
        );
        let mut expired = sample();
        expired.expires_at = Some(expired.issued_at);
        assert_eq!(expired.encode(), Err(ProtocolError::HeaderBadValue));
        let mut big = sample();
        big.issued_at = MAX_SAFE_INTEGER + 1;
        big.expires_at = None;
        assert_eq!(big.encode(), Err(ProtocolError::HeaderBadValue));
        let mut purpose = sample();
        purpose.purpose = String::from("pb/announce/v1");
        assert_eq!(purpose.encode(), Err(ProtocolError::HeaderBadValue));
    }

    #[test]
    fn every_prefix_and_byte_flip_is_handled_without_panic() {
        let enc = sample().encode().unwrap();
        for n in 0..enc.len() {
            assert!(EnvelopeHeader::decode_prefix(&enc[..n]).is_err());
        }
        for i in 0..enc.len() {
            for bit in 0..8u8 {
                let mut m = enc.clone();
                m[i] ^= 1 << bit;
                if let Ok((h, used)) = EnvelopeHeader::decode_prefix(&m) {
                    assert_eq!(h.encode().unwrap(), m[..used].to_vec());
                }
            }
        }
    }
}
