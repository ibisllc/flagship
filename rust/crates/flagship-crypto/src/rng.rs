//! Feeds a fixed buffer of randomness to provider APIs that draw from an RNG,
//! so OS-randomness failure is a returned error (never a panic) and the
//! vector tests can supply the same bytes the TypeScript port uses.

use core::convert::Infallible;
use rand_core::{TryCryptoRng, TryRng, utils};
use zeroize::Zeroize;

pub(crate) struct BufRng<const N: usize> {
    buf: [u8; N],
    pos: usize,
    overrun: bool,
}

impl<const N: usize> BufRng<N> {
    pub(crate) const fn new(buf: [u8; N]) -> Self {
        Self {
            buf,
            pos: 0,
            overrun: false,
        }
    }

    pub(crate) fn from_os() -> Result<Self, getrandom::Error> {
        let mut buf = [0u8; N];
        getrandom::fill(&mut buf)?;
        Ok(Self::new(buf))
    }

    /// True when the provider drew exactly the `N` bytes this suite specifies.
    pub(crate) const fn exactly_consumed(&self) -> bool {
        !self.overrun && self.pos == N
    }
}

impl<const N: usize> Drop for BufRng<N> {
    fn drop(&mut self) {
        self.buf.zeroize();
    }
}

impl<const N: usize> TryRng for BufRng<N> {
    type Error = Infallible;

    fn try_next_u32(&mut self) -> Result<u32, Infallible> {
        utils::next_word_via_fill(self)
    }

    fn try_next_u64(&mut self) -> Result<u64, Infallible> {
        utils::next_word_via_fill(self)
    }

    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), Infallible> {
        let end = self.pos.checked_add(dest.len());
        match end.and_then(|e| self.buf.get(self.pos..e).map(|s| (e, s))) {
            Some((e, src)) => {
                dest.copy_from_slice(src);
                self.pos = e;
            }
            None => {
                self.overrun = true;
                dest.fill(0);
            }
        }
        Ok(())
    }
}

impl<const N: usize> TryCryptoRng for BufRng<N> {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrun_and_underrun_are_detected() {
        let mut r = BufRng::new([7u8; 4]);
        let mut a = [0u8; 4];
        assert!(r.try_fill_bytes(&mut a).is_ok());
        assert_eq!(a, [7; 4]);
        assert!(r.exactly_consumed());
        let mut b = [1u8; 1];
        assert!(r.try_fill_bytes(&mut b).is_ok());
        assert_eq!(b, [0]);
        assert!(!r.exactly_consumed());
        let mut short = BufRng::new([7u8; 4]);
        let mut c = [0u8; 3];
        assert!(short.try_fill_bytes(&mut c).is_ok());
        assert!(!short.exactly_consumed());
    }
}
